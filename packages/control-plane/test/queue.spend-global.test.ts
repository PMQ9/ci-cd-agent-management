import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./harness/db.js";
import { makeJob, makeRepo, makeUsageEvent } from "./harness/factories.js";

// The global cap is read from config's import-time `env.GLOBAL_DAILY_COST_CAP_USD`.
// Stub it BEFORE the first import of config (which queue.js pulls in), so the
// global-cap branch is exercised. This must run before the dynamic import below.
vi.stubEnv("GLOBAL_DAILY_COST_CAP_USD", "1.0");

const holder = { current: undefined as unknown as TestDb };
vi.mock("../src/db/client.js", () => ({
  get db() {
    return holder.current.db;
  },
  get pool() {
    return holder.current.pool;
  },
}));

beforeAll(async () => {
  holder.current = await createTestDb();
});
afterAll(async () => {
  await holder.current.close();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await holder.current.truncateAll();
});

const { autoReviewBlockedReason } = await import("../src/queue.js");

async function addGlobalSpend(cost: string) {
  const repo = await makeRepo(holder.current.db);
  const job = await makeJob(holder.current.db, { repoId: repo.id });
  await makeUsageEvent(holder.current.db, { jobId: job.id, costUsd: cost });
}

describe("autoReviewBlockedReason — global daily cap", () => {
  it("blocks when total spend across all repos reaches the global cap", async () => {
    await addGlobalSpend("0.7000");
    await addGlobalSpend("0.5000"); // total 1.2 >= 1.0
    const repo = await makeRepo(holder.current.db);
    const reason = await autoReviewBlockedReason({ id: repo.id, dailyCostCapUsd: null });
    expect(reason).toBe("global daily cost cap $1 reached");
  });

  it("allows when total spend is below the global cap", async () => {
    await addGlobalSpend("0.3000");
    const repo = await makeRepo(holder.current.db);
    expect(await autoReviewBlockedReason({ id: repo.id, dailyCostCapUsd: null })).toBeNull();
  });
});
