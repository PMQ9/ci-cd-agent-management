import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import { findings, jobs, repos, reviews } from "../db/schema.js";

export function registerJobRoutes(app: FastifyInstance): void {
  // Triage list: most recent jobs with their repo + outcome.
  app.get<{ Querystring: { limit?: string } }>(
    "/api/jobs",
    { preHandler: requireUser },
    async (request) => {
      const limit = Math.min(Number(request.query.limit ?? 50) || 50, 200);
      const rows = await db
        .select({
          id: jobs.id,
          repoFullName: repos.fullName,
          prNumber: jobs.prNumber,
          state: jobs.state,
          trigger: jobs.trigger,
          round: jobs.round,
          headSha: jobs.headSha,
          leasedByRunner: jobs.leasedByRunner,
          errorMessage: jobs.errorMessage,
          createdAt: jobs.createdAt,
          updatedAt: jobs.updatedAt,
        })
        .from(jobs)
        .innerJoin(repos, eq(jobs.repoId, repos.id))
        .orderBy(desc(jobs.createdAt))
        .limit(limit);
      return rows;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/jobs/:id",
    { preHandler: requireUser },
    async (request, reply) => {
      const [job] = await db.select().from(jobs).where(eq(jobs.id, request.params.id)).limit(1);
      if (!job)
        return reply.code(404).send({ error: { code: "not_found", message: "Job not found" } });

      const reviewRows = await db
        .select()
        .from(reviews)
        .where(eq(reviews.jobId, job.id))
        .orderBy(reviews.createdAt);
      const detail = [];
      for (const rv of reviewRows) {
        const fnd = await db.select().from(findings).where(eq(findings.reviewId, rv.id));
        detail.push({ ...rv, findings: fnd });
      }
      return { job, reviews: detail };
    },
  );
}
