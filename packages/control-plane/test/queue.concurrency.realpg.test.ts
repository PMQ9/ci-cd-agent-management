import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, realPgAvailable, type TestDb } from "./harness/db.js";
import { makeRepo, makeRunner } from "./harness/factories.js";

// The SKIP LOCKED guarantee can only be exercised against a real, multi-connection
// Postgres (pglite is single-connection). Runs only when TEST_DATABASE_URL is set;
// otherwise the whole suite is skipped (and reported as such in the run output).
const RUN = realPgAvailable();
const holder = { current: undefined as unknown as TestDb };

vi.mock("../src/db/client.js", () => ({
  get db() {
    return holder.current.db;
  },
  get pool() {
    return holder.current.pool;
  },
}));

const { enqueueReview, leaseNextJob } = await import("../src/queue.js");

describe.skipIf(!RUN)("leaseNextJob concurrency — FOR UPDATE SKIP LOCKED (real Postgres)", () => {
  beforeAll(async () => {
    holder.current = await createTestDb({ forceRealPg: true });
  });
  afterAll(async () => {
    await holder.current?.close();
  });
  beforeEach(async () => {
    await holder.current.truncateAll();
  });

  it("never leases the same job twice when many runners race for fewer jobs", async () => {
    const repo = await makeRepo(holder.current.db);
    const runners = await Promise.all(Array.from({ length: 8 }, () => makeRunner(holder.current.db)));

    const JOB_COUNT = 5;
    for (let i = 0; i < JOB_COUNT; i++) {
      await enqueueReview({
        repoId: repo.id,
        prNumber: i + 1,
        headSha: "h".repeat(40),
        baseSha: "b".repeat(40),
        trigger: "auto",
        round: 1,
      });
    }

    const results = await Promise.all(runners.map((r) => leaseNextJob(r.id)));
    const leased = results.filter((j): j is NonNullable<typeof j> => j !== null);
    const ids = leased.map((j) => j.id);

    // No job handed to two runners.
    expect(new Set(ids).size).toBe(ids.length);
    // Exactly the available jobs were leased; the surplus runners got nothing.
    expect(leased.length).toBe(JOB_COUNT);
    expect(results.filter((r) => r === null).length).toBe(runners.length - JOB_COUNT);
  });

  it("SKIPS a row locked by another transaction instead of blocking on it (the SKIP LOCKED modifier)", async () => {
    // This is the test that actually distinguishes SKIP LOCKED from a plain
    // FOR UPDATE: with plain FOR UPDATE, leaseNextJob would BLOCK on the locked
    // oldest row until the holder commits; with SKIP LOCKED it skips to the next.
    const repo = await makeRepo(holder.current.db);
    const runner = await makeRunner(holder.current.db);
    const old = await enqueueReview({
      repoId: repo.id,
      prNumber: 1,
      headSha: "h".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "auto",
      round: 1,
    });
    await enqueueReview({
      repoId: repo.id,
      prNumber: 2,
      headSha: "h".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "auto",
      round: 1,
    });

    // Hold a row lock on the OLDEST queued job in a separate connection.
    const holdClient = await holder.current.pool.connect();
    await holdClient.query("BEGIN");
    await holdClient.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [old.id]);

    try {
      // leaseNextJob must return promptly with the OTHER job, not hang on the lock.
      const leased = await Promise.race([
        leaseNextJob(runner.id),
        new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), 3000)),
      ]);
      expect(leased).not.toBe("TIMEOUT"); // would TIMEOUT if it blocked (no SKIP LOCKED)
      expect(leased).not.toBeNull();
      expect((leased as { id: string }).id).not.toBe(old.id); // skipped the locked row
    } finally {
      await holdClient.query("ROLLBACK");
      holdClient.release();
    }
  });

  it("hands every job to exactly one runner when runners == jobs", async () => {
    const repo = await makeRepo(holder.current.db);
    const runners = await Promise.all(Array.from({ length: 6 }, () => makeRunner(holder.current.db)));
    for (let i = 0; i < runners.length; i++) {
      await enqueueReview({
        repoId: repo.id,
        prNumber: i + 1,
        headSha: "h".repeat(40),
        baseSha: "b".repeat(40),
        trigger: "auto",
        round: 1,
      });
    }
    const results = await Promise.all(runners.map((r) => leaseNextJob(r.id)));
    const ids = results.filter(Boolean).map((j) => j!.id);
    expect(new Set(ids).size).toBe(runners.length);
  });
});
