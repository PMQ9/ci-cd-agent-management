import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { installDbLifecycle, type DbHolder } from "../harness/setup-db.js";
import { getSessionCookie } from "../harness/http.js";

const holder = vi.hoisted(() => ({}) as DbHolder);
vi.mock("../../src/db/client.js", () => ({
  get db() {
    return holder.db;
  },
  get pool() {
    return holder.pool;
  },
}));

// getApp().oauth drives /auth/login and /auth/callback; Octokit fetches the user.
const oauth = vi.hoisted(() => ({
  getWebFlowAuthorizationUrl: vi.fn(({ state }: { state: string }) => ({
    url: `https://github.com/login/oauth/authorize?state=${state}`,
  })),
  createToken: vi.fn(async () => ({ authentication: { token: "gho_token" } })),
}));
const userLogin = vi.hoisted(() => ({ value: "testuser" }));
vi.mock("../../src/github/app.js", () => ({
  getApp: () => ({ oauth }),
  mintRepoToken: vi.fn(),
  postReview: vi.fn(),
  getPrRefs: vi.fn(),
  listOpenPrs: vi.fn(),
}));
vi.mock("@octokit/core", () => ({
  // Must be a class/function — vitest forbids arrow-fn mocks used with `new`.
  Octokit: class {
    request = vi.fn(async () => ({ data: { login: userLogin.value } }));
  },
}));

installDbLifecycle(holder);

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("GET /auth/config", () => {
  it("reports githubConfigured + devLoginAvailable", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ githubConfigured: true, devLoginAvailable: true });
  });
});

describe("requireUser (via /auth/me)", () => {
  it("401 when there is no session cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });

  it("401 for a cookie that fails signature verification", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: "session=forged-value" } });
    expect(res.statusCode).toBe(401);
  });

  it("403 for a validly-signed cookie whose login is not allowlisted", async () => {
    const signed = app.signCookie("intruder");
    const res = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: `session=${signed}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("returns the login for the allowlisted user", async () => {
    const cookie = await getSessionCookie(app);
    const res = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().login).toBe("testuser");
  });
});

describe("dev-login + logout", () => {
  it("dev-login issues a session for the allowlisted login", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/dev-login", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, login: "testuser" });
    expect(res.cookies.find((c) => c.name === "session")).toBeTruthy();
  });

  it("logout clears the session cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/logout", payload: {} });
    expect(res.statusCode).toBe(200);
    const cleared = res.cookies.find((c) => c.name === "session");
    expect(cleared?.value).toBe("");
  });
});

describe("OAuth login + callback", () => {
  it("/auth/login redirects to GitHub and sets a signed state cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/login" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("github.com/login/oauth/authorize");
    expect(res.cookies.find((c) => c.name === "oauth_state")).toBeTruthy();
  });

  it("/auth/callback rejects a missing/mismatched state with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/callback?code=abc&state=nope" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_oauth_state");
  });

  it("/auth/callback 403s when the GitHub user is not the allowlisted login", async () => {
    userLogin.value = "intruder";
    const login = await app.inject({ method: "GET", url: "/auth/login" });
    const stateCookie = login.cookies.find((c) => c.name === "oauth_state")!;
    const state = new URL(login.headers.location as string).searchParams.get("state")!;
    const res = await app.inject({
      method: "GET",
      url: `/auth/callback?code=abc&state=${state}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    });
    expect(res.statusCode).toBe(403);
    userLogin.value = "testuser";
  });

  it("/auth/callback signs in the allowlisted user and redirects home", async () => {
    userLogin.value = "testuser";
    const login = await app.inject({ method: "GET", url: "/auth/login" });
    const stateCookie = login.cookies.find((c) => c.name === "oauth_state")!;
    const state = new URL(login.headers.location as string).searchParams.get("state")!;
    const res = await app.inject({
      method: "GET",
      url: `/auth/callback?code=abc&state=${state}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
    expect(res.cookies.find((c) => c.name === "session")?.value).toBeTruthy();
  });
});
