import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { installDbLifecycle, type DbHolder } from "./harness/setup-db.js";
import { makeJob, makeRepo, makeRunner } from "./harness/factories.js";
import { jobs, usageEvents } from "../src/db/schema.js";

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

const { recordError } = await import("../src/queue.js");

describe("recordError", () => {
  it("marks the job failed and stores the error message", async () => {
    const repo = await makeRepo(holder.db);
    const job = await makeJob(holder.db, { repoId: repo.id, state: "leased" });
    await recordError(job, "agent exploded", null, 1234);
    const [after] = await holder.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after.state).toBe("failed");
    expect(after.errorMessage).toBe("agent exploded");
  });

  it("inserts a usage event when costUsd > 0", async () => {
    const repo = await makeRepo(holder.db);
    const runner = await makeRunner(holder.db);
    const job = await makeJob(holder.db, { repoId: repo.id, state: "leased", leasedByRunner: runner.id });
    await recordError(job, "partial then failed", 0.0501, 999);
    const usage = await holder.db.select().from(usageEvents).where(eq(usageEvents.jobId, job.id));
    expect(usage).toHaveLength(1);
    expect(usage[0].costUsd).toBe("0.0501");
    expect(usage[0].runnerId).toBe(runner.id);
    expect(usage[0].wallMs).toBe(999);
  });

  it("does NOT insert a usage event when costUsd is 0 or null", async () => {
    const repo = await makeRepo(holder.db);
    const jobZero = await makeJob(holder.db, { repoId: repo.id, prNumber: 1, state: "leased" });
    const jobNull = await makeJob(holder.db, { repoId: repo.id, prNumber: 2, state: "leased" });
    await recordError(jobZero, "x", 0, 10);
    await recordError(jobNull, "y", null, 10);
    const all = await holder.db.select().from(usageEvents);
    expect(all).toHaveLength(0);
  });

  it("truncates the error message to the first 2000 characters", async () => {
    const repo = await makeRepo(holder.db);
    const job = await makeJob(holder.db, { repoId: repo.id, state: "leased" });
    await recordError(job, "z".repeat(5000), null, null);
    const [after] = await holder.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after.errorMessage).toBe("z".repeat(2000)); // first 2000 chars, not last/constant
  });

  it("is idempotent: re-reporting an error for an already-terminal job is a no-op (no double-charge)", async () => {
    const repo = await makeRepo(holder.db);
    const job = await makeJob(holder.db, { repoId: repo.id, state: "leased" });
    await recordError(job, "first", 0.02, 100);
    // Re-fetch the now-failed job (as the route would via findJobByLease) and retry.
    const [failed] = await holder.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(failed.state).toBe("failed");
    await recordError(failed, "retry", 0.02, 100);
    const usage = await holder.db.select().from(usageEvents).where(eq(usageEvents.jobId, job.id));
    expect(usage).toHaveLength(1);
  });
});
