import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { installDbLifecycle, type DbHolder } from "../harness/setup-db.js";
import { makeJob, makeRepo } from "../harness/factories.js";
import { getSessionCookie } from "../harness/http.js";
import { reviews, runners, usageEvents } from "../../src/db/schema.js";
import { sha256 } from "../../src/util/crypto.js";

const holder = vi.hoisted(() => ({}) as DbHolder);
vi.mock("../../src/db/client.js", () => ({
  get db() {
    return holder.db;
  },
  get pool() {
    return holder.pool;
  },
}));

const gh = vi.hoisted(() => ({
  mintRepoToken: vi.fn(async () => "ghs_testtoken"),
  postReview: vi.fn(async () => 999),
  getPrRefs: vi.fn(),
  listOpenPrs: vi.fn(async () => ({ pulls: [], capped: false })),
  getApp: vi.fn(() => {
    throw new Error("getApp() should not be called in runner route tests");
  }),
}));
vi.mock("../../src/github/app.js", () => gh);

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
beforeEach(() => {
  gh.mintRepoToken.mockClear();
  gh.postReview.mockClear();
  gh.postReview.mockResolvedValue(999);
});

const ENROLL_SECRET = "test-enroll-secret";

async function enroll(name = "runner-x") {
  const res = await app.inject({
    method: "POST",
    url: "/api/runners/enroll",
    payload: { enrollmentSecret: ENROLL_SECRET, name, capabilities: { providers: ["claude_code"], version: "0.2.0" } },
  });
  return res;
}

function validResult(leaseId: string) {
  return {
    leaseId,
    sessionId: "sess-1",
    verdict: "comment",
    summary: "looks fine",
    findings: [],
    concerns: [],
    suggestedFixes: [],
    modelUsed: "claude-opus-4-8",
    totalCostUsd: 0.05,
    inputTokens: 100,
    outputTokens: 20,
    wallMs: 1000,
  };
}

describe("POST /api/runners/enroll", () => {
  it("rejects an invalid body with 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/runners/enroll", payload: { name: "x" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });

  it("rejects a wrong enrollment secret with 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/runners/enroll",
      payload: { enrollmentSecret: "wrong", name: "x", capabilities: { providers: ["claude_code"] } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("rejects a SAME-LENGTH but wrong secret with 403 (exercises the constant-time compare past the length short-circuit)", async () => {
    const sameLenWrong = ENROLL_SECRET.slice(0, -1) + (ENROLL_SECRET.endsWith("x") ? "y" : "x");
    expect(sameLenWrong.length).toBe(ENROLL_SECRET.length);
    const res = await app.inject({
      method: "POST",
      url: "/api/runners/enroll",
      payload: { enrollmentSecret: sameLenWrong, name: "x", capabilities: { providers: ["claude_code"] } },
    });
    expect(res.statusCode).toBe(403);
  });

  it("enrolls with the correct secret and stores only the sha256 of the token", async () => {
    const res = await enroll();
    expect(res.statusCode).toBe(200);
    const { runnerId, runnerToken } = res.json();
    expect(runnerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runnerToken).toBeTruthy();

    const [row] = await holder.db.select().from(runners).where(eq(runners.id, runnerId));
    expect(row.tokenHash).toBe(sha256(runnerToken));
    expect(row.tokenHash).not.toBe(runnerToken); // plaintext never stored
  });
});

describe("requireRunner guard", () => {
  it("401 when the Authorization header is missing", async () => {
    const res = await app.inject({ method: "POST", url: "/api/runners/lease", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("401 for an unknown bearer token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/runners/lease",
      headers: { authorization: "Bearer not-a-real-token" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("401 for a revoked runner", async () => {
    const { runnerId, runnerToken } = (await enroll()).json();
    await holder.db.update(runners).set({ revokedAt: new Date() }).where(eq(runners.id, runnerId));
    const res = await app.inject({
      method: "POST",
      url: "/api/runners/lease",
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/runners/lease", () => {
  it("returns { job: null } when there is no work", async () => {
    const { runnerToken } = (await enroll()).json();
    const res = await app.inject({
      method: "POST",
      url: "/api/runners/lease",
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ job: null });
  });

  it("leases a queued job: mints a repo token, assembles the review instruction, updates lastSeenAt", async () => {
    const { runnerId, runnerToken } = (await enroll()).json();
    const repo = await makeRepo(holder.db, { fullName: "octocat/hello" });
    await makeJob(holder.db, { repoId: repo.id, prNumber: 11, round: 1, state: "queued" });

    const res = await app.inject({
      method: "POST",
      url: "/api/runners/lease",
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const { job } = res.json();
    expect(job).not.toBeNull();
    expect(job.repoFullName).toBe("octocat/hello");
    expect(job.cloneUrl).toBe("https://github.com/octocat/hello.git");
    expect(job.githubToken).toBe("ghs_testtoken");
    expect(typeof job.reviewInstruction).toBe("string");
    expect(job.reviewInstruction).toContain("Reviewing PR #11");
    expect(gh.mintRepoToken).toHaveBeenCalledWith(repo.installationId, "hello");

    const [runner] = await holder.db.select().from(runners).where(eq(runners.id, runnerId));
    expect(runner.lastSeenAt).not.toBeNull();
  });
});

describe("POST /api/runners/result", () => {
  async function leaseOne(runnerToken: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/runners/lease",
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: {},
    });
    return res.json().job;
  }

  it("400 on an invalid result body", async () => {
    const { runnerToken } = (await enroll()).json();
    const res = await app.inject({
      method: "POST",
      url: "/api/runners/result",
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { leaseId: "not-a-uuid" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404 when the lease belongs to a different runner", async () => {
    const a = (await enroll("a")).json();
    const b = (await enroll("b")).json();
    const repo = await makeRepo(holder.db);
    await makeJob(holder.db, { repoId: repo.id, state: "queued" });
    const job = await leaseOne(a.runnerToken);

    const res = await app.inject({
      method: "POST",
      url: "/api/runners/result",
      headers: { authorization: `Bearer ${b.runnerToken}` },
      payload: validResult(job.leaseId),
    });
    expect(res.statusCode).toBe(404);
  });

  it("persists the review, posts it to GitHub, and stores the github review id", async () => {
    const { runnerToken } = (await enroll()).json();
    const repo = await makeRepo(holder.db, { fullName: "octocat/hello" });
    await makeJob(holder.db, { repoId: repo.id, prNumber: 9, state: "queued" });
    const job = await leaseOne(runnerToken);

    const res = await app.inject({
      method: "POST",
      url: "/api/runners/result",
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: validResult(job.leaseId),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.reviewId).toBeTruthy();
    expect(body.githubReviewId).toBe(999);
    expect(gh.postReview).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a duplicate result POST returns { idempotent: true } and does not double-post", async () => {
    const { runnerToken } = (await enroll()).json();
    const repo = await makeRepo(holder.db);
    await makeJob(holder.db, { repoId: repo.id, state: "queued" });
    const job = await leaseOne(runnerToken);

    const first = await app.inject({
      method: "POST",
      url: "/api/runners/result",
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: validResult(job.leaseId),
    });
    expect(first.json().ok).toBe(true);
    expect(first.json().reviewId).toBeTruthy();

    const second = await app.inject({
      method: "POST",
      url: "/api/runners/result",
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: validResult(job.leaseId),
    });
    expect(second.json()).toEqual({ ok: true, idempotent: true });
    expect(gh.postReview).toHaveBeenCalledTimes(1); // not re-posted

    // And no double WRITE: exactly one review + one usage row for the job.
    const reviewRows = await holder.db.select().from(reviews).where(eq(reviews.jobId, job.jobId));
    const usageRows = await holder.db.select().from(usageEvents).where(eq(usageEvents.jobId, job.jobId));
    expect(reviewRows).toHaveLength(1);
    expect(usageRows).toHaveLength(1);
  });

  it("still succeeds (200 with reviewId) when posting to GitHub throws", async () => {
    gh.postReview.mockRejectedValueOnce(new Error("github 422"));
    const { runnerToken } = (await enroll()).json();
    const repo = await makeRepo(holder.db);
    await makeJob(holder.db, { repoId: repo.id, state: "queued" });
    const job = await leaseOne(runnerToken);

    const res = await app.inject({
      method: "POST",
      url: "/api/runners/result",
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: validResult(job.leaseId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reviewId).toBeTruthy();
    expect(res.json().githubReviewId).toBeNull();
  });
});

describe("POST /api/runners/error", () => {
  async function leaseOne(runnerToken: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/runners/lease",
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: {},
    });
    return res.json().job;
  }

  it("records the error and 404s on an unknown lease", async () => {
    const { runnerToken } = (await enroll()).json();
    const res = await app.inject({
      method: "POST",
      url: "/api/runners/error",
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: { leaseId: crypto.randomUUID(), message: "boom", totalCostUsd: null, wallMs: null },
    });
    expect(res.statusCode).toBe(404);
  });

  it("is idempotent: a retried error POST (with cost) does NOT double-charge a usage event", async () => {
    const { runnerToken } = (await enroll()).json();
    const repo = await makeRepo(holder.db);
    await makeJob(holder.db, { repoId: repo.id, state: "queued" });
    const job = await leaseOne(runnerToken);
    const body = { leaseId: job.leaseId, message: "agent failed", totalCostUsd: 0.03, wallMs: 500 };

    const first = await app.inject({
      method: "POST",
      url: "/api/runners/error",
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/api/runners/error",
      headers: { authorization: `Bearer ${runnerToken}` },
      payload: body,
    });
    expect(second.statusCode).toBe(200);

    const usageRows = await holder.db.select().from(usageEvents).where(eq(usageEvents.jobId, job.jobId));
    expect(usageRows).toHaveLength(1); // charged once, not twice
  });
});

describe("GET /api/runners + revoke (requireUser)", () => {
  it("401 without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/runners" });
    expect(res.statusCode).toBe(401);
  });

  it("lists runners with online/offline status and supports revoke", async () => {
    const cookie = await getSessionCookie(app);
    const { runnerId } = (await enroll("online-one")).json();
    // freshly enrolled → lastSeenAt now → online
    let res = await app.inject({ method: "GET", url: "/api/runners", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const online = res.json().find((r: any) => r.id === runnerId);
    expect(online.status).toBe("online");

    await app.inject({ method: "POST", url: `/api/runners/${runnerId}/revoke`, headers: { cookie }, payload: {} });
    res = await app.inject({ method: "GET", url: "/api/runners", headers: { cookie } });
    const revoked = res.json().find((r: any) => r.id === runnerId);
    expect(revoked.status).toBe("offline");
    expect(revoked.revokedAt).not.toBeNull();
  });
});
