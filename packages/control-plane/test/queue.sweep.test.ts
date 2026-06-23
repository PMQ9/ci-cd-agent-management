import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { jobs } from "../src/db/schema.js";
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

const { sweepExpiredLeases } = await import("../src/queue.js");

const past = new Date(Date.now() - 60_000);
const future = new Date(Date.now() + 600_000);

describe("sweepExpiredLeases", () => {
  it("requeues leased jobs whose lease has expired, clearing the lease fields", async () => {
    const repo = await makeRepo(holder.db);
    const runner = await makeRunner(holder.db);
    const expired = await makeJob(holder.db, {
      repoId: repo.id,
      prNumber: 1,
      state: "leased",
      leasedByRunner: runner.id,
      leaseId: crypto.randomUUID(),
      leaseExpiresAt: past,
    });

    const count = await sweepExpiredLeases();
    expect(count).toBe(1);

    const [after] = await holder.db.select().from(jobs).where(eq(jobs.id, expired.id));
    expect(after.state).toBe("queued");
    expect(after.leaseId).toBeNull();
    expect(after.leasedByRunner).toBeNull();
    expect(after.leaseExpiresAt).toBeNull();
  });

  it("leaves unexpired leases and non-leased jobs untouched", async () => {
    const repo = await makeRepo(holder.db);
    const runner = await makeRunner(holder.db);
    const fresh = await makeJob(holder.db, {
      repoId: repo.id,
      prNumber: 1,
      state: "leased",
      leasedByRunner: runner.id,
      leaseId: crypto.randomUUID(),
      leaseExpiresAt: future,
    });
    const queued = await makeJob(holder.db, { repoId: repo.id, prNumber: 2, state: "queued" });
    const succeeded = await makeJob(holder.db, {
      repoId: repo.id,
      prNumber: 3,
      state: "succeeded",
    });

    const count = await sweepExpiredLeases();
    expect(count).toBe(0);

    const [a] = await holder.db.select().from(jobs).where(eq(jobs.id, fresh.id));
    const [b] = await holder.db.select().from(jobs).where(eq(jobs.id, queued.id));
    const [c] = await holder.db.select().from(jobs).where(eq(jobs.id, succeeded.id));
    expect(a.state).toBe("leased");
    expect(b.state).toBe("queued");
    expect(c.state).toBe("succeeded");
  });

  it("returns the number of jobs requeued across several expired leases", async () => {
    const repo = await makeRepo(holder.db);
    const runner = await makeRunner(holder.db);
    for (let i = 0; i < 3; i++) {
      await makeJob(holder.db, {
        repoId: repo.id,
        prNumber: i + 1,
        state: "leased",
        leasedByRunner: runner.id,
        leaseId: crypto.randomUUID(),
        leaseExpiresAt: past,
      });
    }
    expect(await sweepExpiredLeases()).toBe(3);
  });
});
