import { describe, expect, it, vi } from "vitest";
import { installDbLifecycle, type DbHolder } from "./harness/setup-db.js";
import { makeFinding, makeJob, makeRepo, makeReview } from "./harness/factories.js";

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

const { priorFindingsForPr } = await import("../src/queue.js");

describe("priorFindingsForPr", () => {
  it("returns [] when the PR has no findings", async () => {
    const repo = await makeRepo(holder.db);
    expect(await priorFindingsForPr(repo.id, 1)).toEqual([]);
  });

  it("returns the PR's findings (path/line/severity/title/body) ordered by review createdAt asc", async () => {
    const repo = await makeRepo(holder.db);
    const job1 = await makeJob(holder.db, { repoId: repo.id, prNumber: 7, round: 1 });
    const job2 = await makeJob(holder.db, { repoId: repo.id, prNumber: 7, round: 2 });

    const review1 = await makeReview(holder.db, job1.id, { createdAt: new Date("2026-01-01T00:00:00Z") });
    const review2 = await makeReview(holder.db, job2.id, { createdAt: new Date("2026-01-02T00:00:00Z") });

    await makeFinding(holder.db, review2.id, { title: "second", path: "b.ts", line: null });
    await makeFinding(holder.db, review1.id, { title: "first", path: "a.ts", line: 3 });

    const prior = await priorFindingsForPr(repo.id, 7);
    expect(prior.map((p) => p.title)).toEqual(["first", "second"]);
    expect(prior[0]).toEqual({ path: "a.ts", line: 3, severity: "medium", title: "first", body: "body" });
    expect(prior[1]!.line).toBeNull();
  });

  it("scopes to the given PR (other PRs in the same repo are excluded)", async () => {
    const repo = await makeRepo(holder.db);
    const jobThisPr = await makeJob(holder.db, { repoId: repo.id, prNumber: 7 });
    const jobOtherPr = await makeJob(holder.db, { repoId: repo.id, prNumber: 8 });
    const r1 = await makeReview(holder.db, jobThisPr.id);
    const r2 = await makeReview(holder.db, jobOtherPr.id);
    await makeFinding(holder.db, r1.id, { title: "mine" });
    await makeFinding(holder.db, r2.id, { title: "theirs" });

    const prior = await priorFindingsForPr(repo.id, 7);
    expect(prior.map((p) => p.title)).toEqual(["mine"]);
  });
});
