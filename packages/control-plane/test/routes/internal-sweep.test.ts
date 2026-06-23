import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { installDbLifecycle, type DbHolder } from "../harness/setup-db.js";
import { makeJob, makeRepo, makeRunner } from "../harness/factories.js";

const holder = vi.hoisted(() => ({}) as DbHolder);
vi.mock("../../src/db/client.js", () => ({
  get db() {
    return holder.db;
  },
  get pool() {
    return holder.pool;
  },
}));
vi.mock("../../src/github/app.js", () => ({
  mintRepoToken: vi.fn(),
  postReview: vi.fn(),
  getPrRefs: vi.fn(),
  listOpenPrs: vi.fn(),
  getApp: vi.fn(),
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

const TOKEN = "test-internal-token"; // matches INTERNAL_API_TOKEN in the test env

describe("health endpoints", () => {
  it("GET /health and /readyz return ok", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: "/readyz" })).json()).toEqual({ ok: true });
  });
});

describe("POST /internal/sweep", () => {
  it("401 with no bearer token", async () => {
    const res = await app.inject({ method: "POST", url: "/internal/sweep", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("401 with a wrong bearer token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/sweep",
      headers: { authorization: "Bearer nope" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("401 with a SAME-LENGTH but wrong token (constant-time compare past the length short-circuit)", async () => {
    const sameLenWrong = TOKEN.slice(0, -1) + (TOKEN.endsWith("x") ? "y" : "x");
    expect(sameLenWrong.length).toBe(TOKEN.length);
    const res = await app.inject({
      method: "POST",
      url: "/internal/sweep",
      headers: { authorization: `Bearer ${sameLenWrong}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("200 with the correct token and requeues expired leases", async () => {
    const repo = await makeRepo(holder.db);
    const runner = await makeRunner(holder.db);
    await makeJob(holder.db, {
      repoId: repo.id,
      state: "leased",
      leasedByRunner: runner.id,
      leaseId: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    const res = await app.inject({
      method: "POST",
      url: "/internal/sweep",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, requeued: 1 });
  });
});
