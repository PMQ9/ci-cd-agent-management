import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { installDbLifecycle, type DbHolder } from "./harness/setup-db.js";
import { makeJob, makeRepo, makeRunner, makeUsageEvent } from "./harness/factories.js";
import { jobs } from "../src/db/schema.js";

const holder = vi.hoisted(() => ({}) as DbHolder);
vi.mock("../src/db/client.js", () => ({
  get db() {
    return holder.db;
  },
  get pool() {
    return holder.pool;
  },
}));

// review-service uses getPrRefs only — mock the github module so no Octokit/network.
const getPrRefs = vi.hoisted(() => vi.fn());
vi.mock("../src/github/app.js", () => ({ getPrRefs }));

installDbLifecycle(holder);

const { triggerReviewForPr } = await import("../src/review-service.js");

beforeEach(() => {
  getPrRefs.mockReset();
  getPrRefs.mockResolvedValue({
    headSha: "ghhead".padEnd(40, "0"),
    baseSha: "ghbase".padEnd(40, "0"),
    cloneUrl: "https://github.com/o/r.git",
    draft: false,
  });
});

const SHAS = { headSha: "h".repeat(40), baseSha: "b".repeat(40) };

describe("triggerReviewForPr", () => {
  it("skips when repo.fullName has no owner/name", async () => {
    const repo = await makeRepo(holder.db, { fullName: "noslash" });
    const out = await triggerReviewForPr({ repo, prNumber: 1, trigger: "manual", ...SHAS, draftHint: false });
    expect(out).toEqual({ status: "skipped", reason: "bad repo full_name" });
  });

  it("auto trigger on a draft PR is skipped and enqueues nothing", async () => {
    const repo = await makeRepo(holder.db);
    const out = await triggerReviewForPr({ repo, prNumber: 1, trigger: "auto", ...SHAS, draftHint: true });
    expect(out).toEqual({ status: "skipped", reason: "draft PR" });
    const jobsForPr = await holder.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.repoId, repo.id), eq(jobs.prNumber, 1)));
    expect(jobsForPr).toHaveLength(0);
  });

  it("auto trigger over the spend cap is skipped and enqueues nothing", async () => {
    const repo = await makeRepo(holder.db, { dailyCostCapUsd: "0.5" });
    const spendJob = await makeJob(holder.db, { repoId: repo.id, prNumber: 1 });
    await makeUsageEvent(holder.db, { jobId: spendJob.id, costUsd: "0.9000" });
    const out = await triggerReviewForPr({ repo, prNumber: 2, trigger: "auto", ...SHAS, draftHint: false });
    expect(out.status).toBe("skipped");
    expect((out as any).reason).toContain("cost cap");
    // No NEW job for the triggered PR (#2) — only the pre-existing spend job (#1) exists.
    const jobsForPr2 = await holder.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.repoId, repo.id), eq(jobs.prNumber, 2)));
    expect(jobsForPr2).toHaveLength(0);
  });

  it("manual trigger runs even on a draft PR (user opted in)", async () => {
    const repo = await makeRepo(holder.db);
    const out = await triggerReviewForPr({ repo, prNumber: 3, trigger: "manual", ...SHAS, draftHint: true });
    expect(out.status).toBe("queued");
  });

  it("command trigger runs even when over the spend cap", async () => {
    const repo = await makeRepo(holder.db, { dailyCostCapUsd: "0.5" });
    const job = await makeJob(holder.db, { repoId: repo.id });
    await makeUsageEvent(holder.db, { jobId: job.id, costUsd: "0.9000" });
    const out = await triggerReviewForPr({ repo, prNumber: 4, trigger: "command", ...SHAS, draftHint: false });
    expect(out.status).toBe("queued");
  });

  it("resolves SHAs from GitHub when not supplied, and uses them on the job", async () => {
    const repo = await makeRepo(holder.db);
    const out = await triggerReviewForPr({ repo, prNumber: 5, trigger: "manual" });
    expect(getPrRefs).toHaveBeenCalledWith(repo.installationId, expect.any(String), expect.any(String), 5);
    expect(out.status).toBe("queued");
    const [job] = await holder.db.select().from(jobs).where(eq(jobs.id, (out as any).jobId));
    expect(job.headSha).toBe("ghhead".padEnd(40, "0"));
    expect(job.baseSha).toBe("ghbase".padEnd(40, "0"));
  });

  it("does NOT call GitHub when SHAs and draft hint are all supplied", async () => {
    const repo = await makeRepo(holder.db);
    await triggerReviewForPr({ repo, prNumber: 6, trigger: "auto", ...SHAS, draftHint: false });
    expect(getPrRefs).not.toHaveBeenCalled();
  });

  it("increments the round and carries runner/session affinity from the last job (re-review)", async () => {
    const repo = await makeRepo(holder.db);
    const runner = await makeRunner(holder.db);
    // A prior round-1 job that ran on `runner` with a session id.
    await makeJob(holder.db, {
      repoId: repo.id,
      prNumber: 7,
      round: 1,
      state: "succeeded",
      leasedByRunner: runner.id,
      claudeSessionId: "sess-xyz",
    });

    const out = await triggerReviewForPr({ repo, prNumber: 7, trigger: "command", ...SHAS, draftHint: false });
    expect(out).toMatchObject({ status: "queued", round: 2 });
    const [job] = await holder.db.select().from(jobs).where(eq(jobs.id, (out as any).jobId));
    expect(job.preferredRunnerId).toBe(runner.id);
    expect(job.claudeSessionId).toBe("sess-xyz");
  });

  it("supersedes a prior active job for the same PR", async () => {
    const repo = await makeRepo(holder.db);
    const prior = await makeJob(holder.db, { repoId: repo.id, prNumber: 8, state: "queued" });
    await triggerReviewForPr({ repo, prNumber: 8, trigger: "manual", ...SHAS, draftHint: false });
    const [priorAfter] = await holder.db.select().from(jobs).where(eq(jobs.id, prior.id));
    expect(priorAfter.state).toBe("superseded");
  });
});
