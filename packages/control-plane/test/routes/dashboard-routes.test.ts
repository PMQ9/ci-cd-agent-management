import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { installDbLifecycle, type DbHolder } from "../harness/setup-db.js";
import {
  makeFinding,
  makeJob,
  makePrompt,
  makeRepo,
  makeReview,
  makeTemplate,
  makeUsageEvent,
} from "../harness/factories.js";
import { getSessionCookie } from "../harness/http.js";
import { pullRequests, repos, templates } from "../../src/db/schema.js";

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
  getPrRefs: vi.fn(async () => ({
    headSha: "x".repeat(40),
    baseSha: "y".repeat(40),
    cloneUrl: "https://github.com/o/r.git",
    draft: false,
  })),
  mintRepoToken: vi.fn(),
  postReview: vi.fn(),
  listOpenPrs: vi.fn(async () => ({ pulls: [], capped: false })),
  getApp: vi.fn(() => {
    throw new Error("getApp() should not be called");
  }),
}));
vi.mock("../../src/github/app.js", () => gh);

installDbLifecycle(holder);

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
let cookie: string;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  cookie = await getSessionCookie(app);
  gh.getPrRefs.mockClear();
});

const auth = () => ({ cookie });

describe("requireUser guards every dashboard route", () => {
  it.each([
    ["GET", "/api/repos"],
    ["GET", "/api/jobs"],
    ["GET", "/api/usage/summary"],
    ["GET", "/api/pulls"],
    ["GET", "/api/templates"],
    ["GET", "/api/prompts"],
    ["GET", "/api/installations"],
  ])("%s %s → 401 without a session", async (method, url) => {
    const res = await app.inject({ method: method as any, url });
    expect(res.statusCode).toBe(401);
  });
});

describe("/api/repos", () => {
  it("lists repos with dailyCostCapUsd as a number (or null)", async () => {
    await makeRepo(holder.db, { fullName: "o/capped", dailyCostCapUsd: "1.5000" });
    await makeRepo(holder.db, { fullName: "o/uncapped", dailyCostCapUsd: null });
    const res = await app.inject({ method: "GET", url: "/api/repos", headers: auth() });
    expect(res.statusCode).toBe(200);
    const byName = Object.fromEntries(res.json().map((r: any) => [r.fullName, r]));
    expect(byName["o/capped"].dailyCostCapUsd).toBe(1.5);
    expect(byName["o/uncapped"].dailyCostCapUsd).toBeNull();
  });

  it("PATCH updates autoReviewEnabled / model / dailyCostCapUsd", async () => {
    const repo = await makeRepo(holder.db);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/repos/${repo.id}`,
      headers: auth(),
      payload: { autoReviewEnabled: true, model: "claude-opus-4-8", dailyCostCapUsd: 2.5 },
    });
    expect(res.statusCode).toBe(200);
    const [after] = await holder.db.select().from(repos).where(eq(repos.id, repo.id));
    expect(after.autoReviewEnabled).toBe(true);
    expect(after.model).toBe("claude-opus-4-8");
    expect(after.dailyCostCapUsd).toBe("2.5000");
  });

  it("PATCH 400 on an invalid body (negative cap)", async () => {
    const repo = await makeRepo(holder.db);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/repos/${repo.id}`,
      headers: auth(),
      payload: { dailyCostCapUsd: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH 404 for an unknown repo id", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/repos/${crypto.randomUUID()}`,
      headers: auth(),
      payload: { autoReviewEnabled: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /api/repos/:id/review triggers a manual review", async () => {
    const repo = await makeRepo(holder.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/repos/${repo.id}/review`,
      headers: auth(),
      payload: { prNumber: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("queued");
  });

  it("POST /api/repos/:id/review 400 when prNumber is missing/invalid", async () => {
    const repo = await makeRepo(holder.db);
    const res = await app.inject({ method: "POST", url: `/api/repos/${repo.id}/review`, headers: auth(), payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("/api/templates", () => {
  it("activating a pr_review template demotes the previously-active one (single active rubric)", async () => {
    const a = await makeTemplate(holder.db, { slug: "rubric-a", kind: "pr_review", isActive: true });
    const b = await makeTemplate(holder.db, { slug: "rubric-b", kind: "pr_review", isActive: false });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/templates/${b.id}`,
      headers: auth(),
      payload: { isActive: true },
    });
    expect(res.statusCode).toBe(200);

    const [aAfter] = await holder.db.select().from(templates).where(eq(templates.id, a.id));
    const [bAfter] = await holder.db.select().from(templates).where(eq(templates.id, b.id));
    expect(aAfter.isActive).toBe(false);
    expect(bAfter.isActive).toBe(true);
    // exactly one active pr_review remains (the partial unique index would reject otherwise)
    const actives = (await holder.db.select().from(templates)).filter(
      (t: any) => t.kind === "pr_review" && t.isActive,
    );
    expect(actives).toHaveLength(1);
  });

  it("PATCH 400 on invalid body (empty content) and 404 on unknown id", async () => {
    const t = await makeTemplate(holder.db);
    const bad = await app.inject({ method: "PATCH", url: `/api/templates/${t.id}`, headers: auth(), payload: { content: "" } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "PATCH",
      url: `/api/templates/${crypto.randomUUID()}`,
      headers: auth(),
      payload: { description: "x" },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("/api/prompts", () => {
  it("lists editable prompts plus the read-only output-contract entry", async () => {
    await makePrompt(holder.db, { key: "reviewer.persona", editable: true });
    const res = await app.inject({ method: "GET", url: "/api/prompts", headers: auth() });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    const contract = rows.find((r: any) => r.key === "reviewer.output_contract");
    expect(contract).toBeTruthy();
    expect(contract.editable).toBe(false);
  });

  it("PATCH updates an editable prompt", async () => {
    await makePrompt(holder.db, { key: "reviewer.rules", editable: true, content: "old" });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/prompts/reviewer.rules",
      headers: auth(),
      payload: { content: "new rules" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("PATCH 400 (read_only) when the prompt is not editable", async () => {
    await makePrompt(holder.db, { key: "reviewer.locked", editable: false });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/prompts/reviewer.locked",
      headers: auth(),
      payload: { content: "hack" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("read_only");
  });

  it("GET /api/prompts/preview returns the assembled instruction (== what the lease handler builds)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/prompts/preview", headers: auth() });
    expect(res.statusCode).toBe(200);
    const { instruction, templateName } = res.json();
    expect(instruction).toContain("Reviewing PR #42");
    expect(instruction).toContain("Respond with ONLY a JSON object");
    // a real (seed-fallback) template name must be present, and its block must be in
    // the assembled instruction — proves the active-template lookup actually resolved.
    expect(templateName.length).toBeGreaterThan(0);
    expect(instruction).toContain(`REVIEW TEMPLATE: "${templateName}"`);
  });
});

describe("/api/jobs", () => {
  it("lists recent jobs joined to their repo and returns a job detail with reviews+findings", async () => {
    const repo = await makeRepo(holder.db, { fullName: "o/jobs" });
    const job = await makeJob(holder.db, { repoId: repo.id, prNumber: 3 });
    const review = await makeReview(holder.db, job.id);
    await makeFinding(holder.db, review.id, { title: "f1" });

    const list = await app.inject({ method: "GET", url: "/api/jobs", headers: auth() });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((j: any) => j.id === job.id && j.repoFullName === "o/jobs")).toBe(true);

    const detail = await app.inject({ method: "GET", url: `/api/jobs/${job.id}`, headers: auth() });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().reviews[0].findings[0].title).toBe("f1");

    const missing = await app.inject({ method: "GET", url: `/api/jobs/${crypto.randomUUID()}`, headers: auth() });
    expect(missing.statusCode).toBe(404);
  });
});

describe("/api/usage/summary", () => {
  it("aggregates measured spend and run counts, partitioning the today/7d/30d windows", async () => {
    const repo = await makeRepo(holder.db);
    const job = await makeJob(holder.db, { repoId: repo.id });
    await makeUsageEvent(holder.db, { jobId: job.id, costUsd: "1.0000" });
    await makeUsageEvent(holder.db, { jobId: job.id, costUsd: "2.5000" });
    // An older event (10 days ago) — counts toward 30d but NOT today/7d.
    await makeUsageEvent(holder.db, {
      jobId: job.id,
      costUsd: "4.0000",
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });

    const res = await app.inject({ method: "GET", url: "/api/usage/summary", headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalRuns).toBe(3);
    expect(body.totalCost).toBeCloseTo(7.5);
    expect(body.today).toBeCloseTo(3.5);
    expect(body.last7d).toBeCloseTo(3.5);
    expect(body.last30d).toBeCloseTo(7.5);
    // the window filters genuinely differ — the old event is excluded from today
    expect(body.today).toBeLessThan(body.last30d);
    expect(body.claudeConsoleUrl).toContain("claude");
  });
});

describe("/api/pulls", () => {
  it("returns the open-PR inbox joined to repo, and sync backfills (mocked listOpenPrs)", async () => {
    const repo = await makeRepo(holder.db, { fullName: "o/inbox" });
    await holder.db.insert(pullRequests).values({
      repoId: repo.id,
      number: 21,
      title: "Open PR",
      state: "open",
      htmlUrl: "https://github.com/o/inbox/pull/21",
    });

    const res = await app.inject({ method: "GET", url: "/api/pulls", headers: auth() });
    expect(res.statusCode).toBe(200);
    const row = res.json().find((r: any) => r.number === 21);
    expect(row.repoFullName).toBe("o/inbox");

    const sync = await app.inject({ method: "POST", url: "/api/pulls/sync", headers: auth(), payload: {} });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().ok).toBe(true);
    expect(gh.listOpenPrs).toHaveBeenCalled();
  });
});
