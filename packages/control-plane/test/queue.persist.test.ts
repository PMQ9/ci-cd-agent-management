import type { JobResult } from "@agentpr/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { findings, jobs, reviews, usageEvents } from "../src/db/schema.js";
import { makeJob, makeRepo, makeRunner } from "./harness/factories.js";
import { type DbHolder, installDbLifecycle } from "./harness/setup-db.js";

const holder = vi.hoisted(() => ({}) as DbHolder);
vi.mock("../src/db/client.js", () => ({
  get db() {
    return holder.db;
  },
  get pool() {
    return holder.pool;
  },
}));
installDbLifecycle(holder);

const { persistResult } = await import("../src/queue.js");

function baseResult(over: Partial<JobResult> = {}): JobResult {
  return {
    leaseId: crypto.randomUUID(),
    sessionId: "sess-after",
    verdict: "request_changes",
    summary: "Found issues",
    findings: [],
    concerns: [],
    suggestedFixes: [],
    modelUsed: "claude-opus-4-8",
    totalCostUsd: 0.1234,
    inputTokens: 1000,
    outputTokens: 200,
    wallMs: 4321,
    ...over,
  };
}

describe("persistResult", () => {
  it("writes review + findings + usage and flips the job to succeeded (happy path)", async () => {
    const repo = await makeRepo(holder.db);
    const runner = await makeRunner(holder.db);
    const job = await makeJob(holder.db, {
      repoId: repo.id,
      state: "leased",
      leasedByRunner: runner.id,
      round: 2,
      claudeSessionId: "old-sess",
    });

    const result = baseResult({
      findings: [
        { path: "a.ts", line: 10, severity: "high", title: "bug", body: "fix it" },
        { path: "b.ts", line: null, severity: "info", title: "nit", body: "consider" },
      ],
      concerns: ["is this intended?"],
      suggestedFixes: ["do X", "do Y"],
    });

    const out = await persistResult(job, result);
    expect(out).not.toBeNull();

    const [review] = await holder.db.select().from(reviews).where(eq(reviews.id, out!.reviewId));
    expect(review.verdict).toBe("request_changes");
    expect(review.summary).toBe("Found issues");
    expect(review.round).toBe(2);
    expect(review.concerns).toEqual(["is this intended?"]);
    expect(review.suggestedFixes).toEqual(["do X", "do Y"]);

    const findingRows = await holder.db
      .select()
      .from(findings)
      .where(eq(findings.reviewId, out!.reviewId));
    expect(findingRows).toHaveLength(2);
    expect(findingRows.every((f: any) => f.status === "open")).toBe(true);

    const usage = await holder.db.select().from(usageEvents).where(eq(usageEvents.jobId, job.id));
    expect(usage).toHaveLength(1);
    expect(usage[0].costUsd).toBe("0.1234"); // numeric stored as fixed(4) string
    expect(usage[0].runnerId).toBe(runner.id);
    expect(usage[0].model).toBe("claude-opus-4-8");

    const [jobAfter] = await holder.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(jobAfter.state).toBe("succeeded");
    expect(jobAfter.claudeSessionId).toBe("sess-after"); // updated from result
  });

  it("is idempotent: a job not in leased/running returns null and writes nothing", async () => {
    const repo = await makeRepo(holder.db);
    const job = await makeJob(holder.db, { repoId: repo.id, state: "succeeded" });

    const out = await persistResult(job, baseResult());
    expect(out).toBeNull();

    const allReviews = await holder.db.select().from(reviews);
    const allUsage = await holder.db.select().from(usageEvents);
    expect(allReviews).toHaveLength(0);
    expect(allUsage).toHaveLength(0);
  });

  it("re-persisting after success (re-fetched job, now succeeded) is a no-op — the route-level idempotency guard", async () => {
    const repo = await makeRepo(holder.db);
    const runner = await makeRunner(holder.db);
    const job = await makeJob(holder.db, {
      repoId: repo.id,
      state: "leased",
      leasedByRunner: runner.id,
    });

    const first = await persistResult(job, baseResult());
    expect(first).not.toBeNull();

    // Simulate the route re-fetching the job (now succeeded) before a duplicate POST.
    const [refetched] = await holder.db.select().from(jobs).where(eq(jobs.id, job.id));
    const second = await persistResult(refetched, baseResult());
    expect(second).toBeNull();

    const allReviews = await holder.db.select().from(reviews);
    expect(allReviews).toHaveLength(1); // not duplicated
  });

  it("records a usage event even when there are no findings", async () => {
    const repo = await makeRepo(holder.db);
    const job = await makeJob(holder.db, { repoId: repo.id, state: "running" });
    const out = await persistResult(job, baseResult({ findings: [] }));
    expect(out).not.toBeNull();
    const findingRows = await holder.db
      .select()
      .from(findings)
      .where(eq(findings.reviewId, out!.reviewId));
    expect(findingRows).toHaveLength(0);
    const usage = await holder.db.select().from(usageEvents).where(eq(usageEvents.jobId, job.id));
    expect(usage).toHaveLength(1);
  });

  it("stores empty concerns/suggestedFixes as NULL (not empty array)", async () => {
    const repo = await makeRepo(holder.db);
    const job = await makeJob(holder.db, { repoId: repo.id, state: "leased" });
    const out = await persistResult(job, baseResult({ concerns: [], suggestedFixes: [] }));
    const [review] = await holder.db.select().from(reviews).where(eq(reviews.id, out!.reviewId));
    expect(review.concerns).toBeNull();
    expect(review.suggestedFixes).toBeNull();
  });

  it("preserves the prior claudeSessionId when the result carries none", async () => {
    const repo = await makeRepo(holder.db);
    const job = await makeJob(holder.db, {
      repoId: repo.id,
      state: "leased",
      claudeSessionId: "keep-me",
    });
    const out = await persistResult(job, baseResult({ sessionId: null }));
    expect(out).not.toBeNull();
    const [jobAfter] = await holder.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(jobAfter.claudeSessionId).toBe("keep-me");
  });
});
