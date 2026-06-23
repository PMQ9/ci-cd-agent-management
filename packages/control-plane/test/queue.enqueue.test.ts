import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { installDbLifecycle, type DbHolder } from "./harness/setup-db.js";
import { makeJob, makeRepo } from "./harness/factories.js";
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
installDbLifecycle(holder);

const { enqueueReview, getMaxRoundForPr, supersedeActiveForPr } = await import("../src/queue.js");

const ACTIVE = ["queued", "leased", "running"] as const;

describe("enqueueReview", () => {
  it("inserts a queued job carrying the supplied fields", async () => {
    const repo = await makeRepo(holder.db);
    const job = await enqueueReview({
      repoId: repo.id,
      prNumber: 42,
      headSha: "h".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "command",
      round: 1,
      preferredRunnerId: null,
      claudeSessionId: "sess-1",
    });
    expect(job.state).toBe("queued");
    expect(job.prNumber).toBe(42);
    expect(job.trigger).toBe("command");
    expect(job.round).toBe(1);
    expect(job.claudeSessionId).toBe("sess-1");
    expect(job.attempts).toBe(0);
  });

  it("defaults preferredRunnerId and claudeSessionId to null when omitted", async () => {
    const repo = await makeRepo(holder.db);
    const job = await enqueueReview({
      repoId: repo.id,
      prNumber: 1,
      headSha: "h".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "auto",
      round: 1,
    });
    expect(job.preferredRunnerId).toBeNull();
    expect(job.claudeSessionId).toBeNull();
  });

  it("supersedes the prior active job for the same PR (latest trigger wins)", async () => {
    const repo = await makeRepo(holder.db);
    const first = await enqueueReview({
      repoId: repo.id,
      prNumber: 5,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "auto",
      round: 1,
    });
    const second = await enqueueReview({
      repoId: repo.id,
      prNumber: 5,
      headSha: "c".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "auto",
      round: 2,
    });

    const [firstAfter] = await holder.db.select().from(jobs).where(eq(jobs.id, first.id));
    const [secondAfter] = await holder.db.select().from(jobs).where(eq(jobs.id, second.id));
    expect(firstAfter.state).toBe("superseded");
    expect(secondAfter.state).toBe("queued");
  });

  it("does not supersede jobs for a different PR or repo", async () => {
    const repo = await makeRepo(holder.db);
    const otherRepo = await makeRepo(holder.db);
    const keepOtherPr = await makeJob(holder.db, { repoId: repo.id, prNumber: 99, state: "queued" });
    const keepOtherRepo = await makeJob(holder.db, { repoId: otherRepo.id, prNumber: 5, state: "queued" });

    await enqueueReview({
      repoId: repo.id,
      prNumber: 5,
      headSha: "h".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "auto",
      round: 1,
    });

    const [a] = await holder.db.select().from(jobs).where(eq(jobs.id, keepOtherPr.id));
    const [b] = await holder.db.select().from(jobs).where(eq(jobs.id, keepOtherRepo.id));
    expect(a.state).toBe("queued");
    expect(b.state).toBe("queued");
  });
});

describe("supersedeActiveForPr", () => {
  it("flips queued/leased/running to superseded but leaves terminal states", async () => {
    const repo = await makeRepo(holder.db);
    const runner = await import("./harness/factories.js").then((m) => m.makeRunner(holder.db));
    const active = await Promise.all(
      ACTIVE.map((state) =>
        makeJob(holder.db, {
          repoId: repo.id,
          prNumber: 7,
          state,
          // leased/running need a runner for the leasedByRunner FK only if set; not required here
        }),
      ),
    );
    const succeeded = await makeJob(holder.db, { repoId: repo.id, prNumber: 7, state: "succeeded" });
    const failed = await makeJob(holder.db, { repoId: repo.id, prNumber: 7, state: "failed" });
    void runner;

    await supersedeActiveForPr(repo.id, 7);

    for (const j of active) {
      const [row] = await holder.db.select().from(jobs).where(eq(jobs.id, j.id));
      expect(row.state).toBe("superseded");
    }
    const [s] = await holder.db.select().from(jobs).where(eq(jobs.id, succeeded.id));
    const [f] = await holder.db.select().from(jobs).where(eq(jobs.id, failed.id));
    expect(s.state).toBe("succeeded");
    expect(f.state).toBe("failed");
  });

  it("excludes exceptJobId from being superseded", async () => {
    const repo = await makeRepo(holder.db);
    const keep = await makeJob(holder.db, { repoId: repo.id, prNumber: 8, state: "queued" });
    const other = await makeJob(holder.db, { repoId: repo.id, prNumber: 8, state: "queued" });

    await supersedeActiveForPr(repo.id, 8, keep.id);

    const [keepRow] = await holder.db.select().from(jobs).where(eq(jobs.id, keep.id));
    const [otherRow] = await holder.db.select().from(jobs).where(eq(jobs.id, other.id));
    expect(keepRow.state).toBe("queued");
    expect(otherRow.state).toBe("superseded");
  });
});

describe("getMaxRoundForPr", () => {
  it("returns 0 (coalesce) when the PR has no jobs", async () => {
    const repo = await makeRepo(holder.db);
    expect(await getMaxRoundForPr(repo.id, 123)).toBe(0);
  });

  it("returns the highest round across the PR's jobs", async () => {
    const repo = await makeRepo(holder.db);
    await makeJob(holder.db, { repoId: repo.id, prNumber: 3, round: 1 });
    await makeJob(holder.db, { repoId: repo.id, prNumber: 3, round: 2 });
    await makeJob(holder.db, { repoId: repo.id, prNumber: 3, round: 5 });
    // a different PR must not bleed into the max
    await makeJob(holder.db, { repoId: repo.id, prNumber: 4, round: 9 });
    expect(await getMaxRoundForPr(repo.id, 3)).toBe(5);
  });
});
