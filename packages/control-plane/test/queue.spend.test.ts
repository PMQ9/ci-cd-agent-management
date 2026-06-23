import { describe, expect, it, vi } from "vitest";
import { installDbLifecycle, type DbHolder } from "./harness/setup-db.js";
import { makeJob, makeRepo, makeUsageEvent } from "./harness/factories.js";

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

const { autoReviewBlockedReason } = await import("../src/queue.js");

// Insert today-dated spend for a repo (usage event must join to a job in that repo).
async function addSpend(repoId: string, cost: string, createdAt?: Date) {
  const job = await makeJob(holder.db, { repoId });
  await makeUsageEvent(holder.db, { jobId: job.id, costUsd: cost, ...(createdAt ? { createdAt } : {}) });
}

describe("autoReviewBlockedReason — per-repo daily cap", () => {
  it("returns null when the repo has no cap (dailyCostCapUsd = null), regardless of spend", async () => {
    const repo = await makeRepo(holder.db);
    await addSpend(repo.id, "100.0000");
    expect(await autoReviewBlockedReason({ id: repo.id, dailyCostCapUsd: null })).toBeNull();
  });

  it("treats a cap of 0 as 'no limit' (skips the check)", async () => {
    const repo = await makeRepo(holder.db);
    await addSpend(repo.id, "5.0000");
    expect(await autoReviewBlockedReason({ id: repo.id, dailyCostCapUsd: "0" })).toBeNull();
  });

  it("blocks when today's spend exceeds the cap", async () => {
    const repo = await makeRepo(holder.db);
    await addSpend(repo.id, "0.6000");
    const reason = await autoReviewBlockedReason({ id: repo.id, dailyCostCapUsd: "0.5" });
    expect(reason).toBe("repo daily cost cap $0.5 reached");
  });

  it("blocks at exactly the cap (>= boundary)", async () => {
    const repo = await makeRepo(holder.db);
    await addSpend(repo.id, "0.5000");
    const reason = await autoReviewBlockedReason({ id: repo.id, dailyCostCapUsd: "0.5" });
    expect(reason).toBe("repo daily cost cap $0.5 reached");
  });

  it("allows when spend is below the cap", async () => {
    const repo = await makeRepo(holder.db);
    await addSpend(repo.id, "0.4000");
    expect(await autoReviewBlockedReason({ id: repo.id, dailyCostCapUsd: "0.5" })).toBeNull();
  });

  it("ignores a non-numeric cap (NaN → skips the check)", async () => {
    const repo = await makeRepo(holder.db);
    await addSpend(repo.id, "100.0000");
    expect(await autoReviewBlockedReason({ id: repo.id, dailyCostCapUsd: "not-a-number" })).toBeNull();
  });

  it("only counts a repo's own spend (other repos do not push it over)", async () => {
    const repo = await makeRepo(holder.db);
    const other = await makeRepo(holder.db);
    await addSpend(other.id, "100.0000");
    await addSpend(repo.id, "0.1000");
    expect(await autoReviewBlockedReason({ id: repo.id, dailyCostCapUsd: "0.5" })).toBeNull();
  });

  it("only counts TODAY's spend (yesterday's spend does not count)", async () => {
    const repo = await makeRepo(holder.db);
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    await addSpend(repo.id, "100.0000", yesterday);
    expect(await autoReviewBlockedReason({ id: repo.id, dailyCostCapUsd: "0.5" })).toBeNull();
  });
});
