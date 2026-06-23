import { describe, expect, it, vi } from "vitest";
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

const { leaseNextJob } = await import("../src/queue.js");

describe("leaseNextJob", () => {
  it("returns null when there is no queued work", async () => {
    const runner = await makeRunner(holder.db);
    expect(await leaseNextJob(runner.id)).toBeNull();
  });

  it("leases a queued job: sets leased state, a lease id, an expiry ~LEASE_TTL ahead, and increments attempts", async () => {
    const repo = await makeRepo(holder.db);
    const runner = await makeRunner(holder.db);
    await makeJob(holder.db, { repoId: repo.id, prNumber: 1, state: "queued" });

    const before = Date.now();
    const leased = await leaseNextJob(runner.id);
    expect(leased).not.toBeNull();
    expect(leased!.state).toBe("leased");
    expect(leased!.leasedByRunner).toBe(runner.id);
    expect(leased!.leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(leased!.attempts).toBe(1);
    // LEASE_TTL_SECONDS=900 in the test env → expiry roughly 15 min out.
    const ttlMs = leased!.leaseExpiresAt!.getTime() - before;
    expect(ttlMs).toBeGreaterThan(880_000);
    expect(ttlMs).toBeLessThan(920_000);
  });

  it("never leases terminal or already-leased jobs", async () => {
    const repo = await makeRepo(holder.db);
    const runner = await makeRunner(holder.db);
    for (const state of [
      "leased",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "superseded",
    ] as const) {
      await makeJob(holder.db, { repoId: repo.id, prNumber: 1, state });
    }
    expect(await leaseNextJob(runner.id)).toBeNull();
  });

  it("serves the oldest queued job first (FIFO) within the same affinity tier", async () => {
    const repo = await makeRepo(holder.db);
    const runner = await makeRunner(holder.db);
    const older = await makeJob(holder.db, {
      repoId: repo.id,
      prNumber: 1,
      state: "queued",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await makeJob(holder.db, {
      repoId: repo.id,
      prNumber: 2,
      state: "queued",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    const leased = await leaseNextJob(runner.id);
    expect(leased!.id).toBe(older.id);
  });

  it("prefers jobs pinned to this runner over unpinned ones (affinity)", async () => {
    const repo = await makeRepo(holder.db);
    const runnerA = await makeRunner(holder.db);
    const runnerB = await makeRunner(holder.db);

    // Unpinned job is OLDER; the pinned one is newer — affinity must still win.
    await makeJob(holder.db, {
      repoId: repo.id,
      prNumber: 1,
      state: "queued",
      preferredRunnerId: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const pinnedToA = await makeJob(holder.db, {
      repoId: repo.id,
      prNumber: 2,
      state: "queued",
      preferredRunnerId: runnerA.id,
      createdAt: new Date("2026-01-03T00:00:00Z"),
    });
    void runnerB;

    const leased = await leaseNextJob(runnerA.id);
    expect(leased!.id).toBe(pinnedToA.id);
  });

  it("does not lease a job pinned to a different runner", async () => {
    const repo = await makeRepo(holder.db);
    const runnerA = await makeRunner(holder.db);
    const runnerB = await makeRunner(holder.db);
    await makeJob(holder.db, {
      repoId: repo.id,
      prNumber: 1,
      state: "queued",
      preferredRunnerId: runnerB.id,
    });
    // A sees no eligible work (the only job is pinned to B).
    expect(await leaseNextJob(runnerA.id)).toBeNull();
  });

  it("falls back to an unpinned job when none are pinned to this runner", async () => {
    const repo = await makeRepo(holder.db);
    const runnerA = await makeRunner(holder.db);
    const unpinned = await makeJob(holder.db, {
      repoId: repo.id,
      prNumber: 1,
      state: "queued",
      preferredRunnerId: null,
    });
    const leased = await leaseNextJob(runnerA.id);
    expect(leased!.id).toBe(unpinned.id);
  });
});
