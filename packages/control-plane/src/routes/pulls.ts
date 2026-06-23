import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import { githubConfigured } from "../config.js";
import { db } from "../db/client.js";
import { jobs, pullRequests, repos } from "../db/schema.js";
import { syncOpenPullRequests } from "../github/pr-sync.js";

export function registerPullRoutes(app: FastifyInstance): void {
  // Cross-repo open-PR inbox. Reads the registry only — cheap, no GitHub calls.
  app.get("/api/pulls", { preHandler: requireUser }, async () => {
    // Latest job per (repo, PR). Supersede always inserts a NEWER job, so the
    // newest createdAt is always the current attempt — `superseded` never wins.
    const latest = db
      .selectDistinctOn([jobs.repoId, jobs.prNumber], {
        repoId: jobs.repoId,
        prNumber: jobs.prNumber,
        jobId: jobs.id,
        jobState: jobs.state,
        jobRound: jobs.round,
        jobTrigger: jobs.trigger,
        jobErrorMessage: jobs.errorMessage,
        jobUpdatedAt: jobs.updatedAt,
      })
      .from(jobs)
      .orderBy(jobs.repoId, jobs.prNumber, desc(jobs.createdAt))
      .as("latest");

    const rows = await db
      .select({
        id: pullRequests.id,
        repoId: pullRequests.repoId,
        repoFullName: repos.fullName,
        number: pullRequests.number,
        title: pullRequests.title,
        author: pullRequests.author,
        isDraft: pullRequests.isDraft,
        htmlUrl: pullRequests.htmlUrl,
        autoReviewEnabled: repos.autoReviewEnabled,
        prUpdatedAt: pullRequests.prUpdatedAt,
        jobId: latest.jobId,
        jobState: latest.jobState,
        jobRound: latest.jobRound,
        jobTrigger: latest.jobTrigger,
        jobErrorMessage: latest.jobErrorMessage,
        jobUpdatedAt: latest.jobUpdatedAt,
      })
      .from(pullRequests)
      .innerJoin(repos, eq(pullRequests.repoId, repos.id))
      .leftJoin(
        latest,
        and(eq(latest.repoId, pullRequests.repoId), eq(latest.prNumber, pullRequests.number)),
      )
      .where(eq(pullRequests.state, "open"))
      // Most-recently-updated first; null update times sink to the bottom
      // (Postgres defaults to NULLS FIRST on DESC, which we don't want).
      .orderBy(sql`${pullRequests.prUpdatedAt} desc nulls last`, asc(repos.fullName));
    return rows.map((r) => ({
      ...r,
      prUpdatedAt: r.prUpdatedAt ? r.prUpdatedAt.toISOString() : null,
      jobUpdatedAt: r.jobUpdatedAt ? r.jobUpdatedAt.toISOString() : null,
    }));
  });

  // Backfill the inbox from GitHub for every connected repo. On-demand only
  // (button click) — never on a timer, so it can't break scale-to-zero.
  app.post("/api/pulls/sync", { preHandler: requireUser }, async (request, reply) => {
    if (!githubConfigured) {
      return reply
        .code(503)
        .send({ error: { code: "github_not_configured", message: "Configure GitHub first" } });
    }
    const repoRows = await db.select().from(repos);
    let open = 0;
    let cappedRepos = 0;
    for (const repo of repoRows) {
      try {
        const r = await syncOpenPullRequests(repo);
        open += r.open;
        if (r.capped) cappedRepos += 1;
      } catch (err) {
        request.log.error({ err, repo: repo.fullName }, "pull sync failed");
      }
    }
    return reply.send({ ok: true, open, repos: repoRows.length, cappedRepos });
  });
}
