// Pins the behavior of the thin typed client in src/api.ts:
//   - `req` always sends credentials + JSON content-type.
//   - 401/403 → AuthError; other non-ok → Error with path + status; ok → parsed JSON.
//   - the api.* methods hit the correct path/method/body.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError, api } from "../src/api.js";

// A fetch stub that records the call args and returns a configurable Response-like.
function makeFetch(opts: {
  status?: number;
  ok?: boolean;
  json?: unknown;
}) {
  const status = opts.status ?? 200;
  const ok = opts.ok ?? (status >= 200 && status < 300);
  return vi.fn(async () => ({
    status,
    ok,
    json: async () => opts.json ?? {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("req — request shape", () => {
  it("always sends credentials:'include' and content-type application/json", async () => {
    const fetchMock = makeFetch({ json: [] });
    vi.stubGlobal("fetch", fetchMock);

    await api.repos();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  it("preserves the content-type header even when the caller passes a method + body", async () => {
    const fetchMock = makeFetch({ json: { ok: true } });
    vi.stubGlobal("fetch", fetchMock);

    await api.updateRepo("repo-1", { autoReviewEnabled: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    expect(init.method).toBe("PATCH");
  });
});

describe("req — error handling", () => {
  it("throws AuthError on a 401 response", async () => {
    vi.stubGlobal("fetch", makeFetch({ status: 401, ok: false }));
    await expect(api.me()).rejects.toBeInstanceOf(AuthError);
  });

  it("throws AuthError on a 403 response", async () => {
    vi.stubGlobal("fetch", makeFetch({ status: 403, ok: false }));
    await expect(api.repos()).rejects.toBeInstanceOf(AuthError);
  });

  it("AuthError carries the 'unauthenticated' message and is an Error subclass", async () => {
    vi.stubGlobal("fetch", makeFetch({ status: 401, ok: false }));
    const err = await api.me().catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("unauthenticated");
  });

  it("throws a plain Error including the path and status on a 500", async () => {
    vi.stubGlobal("fetch", makeFetch({ status: 500, ok: false }));
    const err = await api.repos().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AuthError);
    expect((err as Error).message).toContain("/api/repos");
    expect((err as Error).message).toContain("500");
  });

  it("throws a plain Error (not AuthError) on a 404", async () => {
    vi.stubGlobal("fetch", makeFetch({ status: 404, ok: false }));
    const err = await api.jobs().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AuthError);
    expect((err as Error).message).toContain("404");
  });
});

describe("req — success", () => {
  it("returns the parsed JSON body on a 200", async () => {
    const payload = [{ id: "r1", fullName: "octo/hello" }];
    vi.stubGlobal("fetch", makeFetch({ status: 200, json: payload }));
    await expect(api.repos()).resolves.toEqual(payload);
  });

  it("treats a 204-ish ok response by returning whatever json() yields", async () => {
    vi.stubGlobal("fetch", makeFetch({ status: 200, json: { ok: true } }));
    await expect(api.logout()).resolves.toEqual({ ok: true });
  });
});

describe("api.* method routing", () => {
  let fetchMock: ReturnType<typeof makeFetch>;
  beforeEach(() => {
    fetchMock = makeFetch({ json: {} });
    vi.stubGlobal("fetch", fetchMock);
  });

  const lastCall = () => fetchMock.mock.calls[0] as [string, RequestInit | undefined];

  it("api.repos() → GET /api/repos (no explicit method = browser default GET)", async () => {
    await api.repos();
    const [path, init] = lastCall();
    expect(path).toBe("/api/repos");
    // req does not set a method for GETs; absence means the fetch default (GET).
    expect(init?.method).toBeUndefined();
  });

  it("api.me() → GET /auth/me", async () => {
    await api.me();
    expect(lastCall()[0]).toBe("/auth/me");
  });

  it("api.updateRepo(id, patch) → PATCH /api/repos/:id with JSON-encoded patch body", async () => {
    const patch = { model: "claude-opus-4", autoReviewEnabled: false };
    await api.updateRepo("abc-123", patch);
    const [path, init] = lastCall();
    expect(path).toBe("/api/repos/abc-123");
    expect(init?.method).toBe("PATCH");
    expect(init?.body).toBe(JSON.stringify(patch));
  });

  it("api.reviewPr(id, prNumber) → POST /api/repos/:id/review with {prNumber} body", async () => {
    await api.reviewPr("repo-9", 42);
    const [path, init] = lastCall();
    expect(path).toBe("/api/repos/repo-9/review");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ prNumber: 42 }));
    expect(JSON.parse(init!.body as string)).toEqual({ prNumber: 42 });
  });

  it("api.devLogin() → POST /auth/dev-login", async () => {
    await api.devLogin();
    const [path, init] = lastCall();
    expect(path).toBe("/auth/dev-login");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
  });

  it("api.logout() → POST /auth/logout", async () => {
    await api.logout();
    const [path, init] = lastCall();
    expect(path).toBe("/auth/logout");
    expect(init?.method).toBe("POST");
  });

  it("api.updatePrompt(key, content) → PATCH /api/prompts/<encodeURIComponent(key)> with {content}", async () => {
    // A key that genuinely needs URL-encoding (slash + space + reserved chars).
    const key = "reviewer/persona prompt#1";
    await api.updatePrompt(key, "hello world");
    const [path, init] = lastCall();
    expect(path).toBe(`/api/prompts/${encodeURIComponent(key)}`);
    // sanity: the raw key is NOT used verbatim in the path
    expect(path).not.toContain(" ");
    expect(path).toContain("%2F"); // encoded slash
    expect(path).toContain("%20"); // encoded space
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init!.body as string)).toEqual({ content: "hello world" });
  });

  it("api.updateTemplate(id, patch) → PATCH /api/templates/:id with JSON body", async () => {
    await api.updateTemplate("tpl-1", { isActive: true });
    const [path, init] = lastCall();
    expect(path).toBe("/api/templates/tpl-1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init!.body as string)).toEqual({ isActive: true });
  });

  it("api.syncInstallation(id) → POST /api/installations/:id/sync", async () => {
    await api.syncInstallation(7);
    const [path, init] = lastCall();
    expect(path).toBe("/api/installations/7/sync");
    expect(init?.method).toBe("POST");
  });

  it("api.revokeRunner(id) → POST /api/runners/:id/revoke", async () => {
    await api.revokeRunner("run-xyz");
    const [path, init] = lastCall();
    expect(path).toBe("/api/runners/run-xyz/revoke");
    expect(init?.method).toBe("POST");
  });

  it("api.usage() → GET /api/usage/summary", async () => {
    await api.usage();
    expect(lastCall()[0]).toBe("/api/usage/summary");
  });

  it("api.syncPulls() → POST /api/pulls/sync", async () => {
    await api.syncPulls();
    const [path, init] = lastCall();
    expect(path).toBe("/api/pulls/sync");
    expect(init?.method).toBe("POST");
  });

  it("api.promptPreview() → GET /api/prompts/preview", async () => {
    await api.promptPreview();
    expect(lastCall()[0]).toBe("/api/prompts/preview");
  });
});
