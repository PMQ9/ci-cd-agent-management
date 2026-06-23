import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  EnrollRequestSchema,
  JobErrorSchema,
  JobResultSchema,
  type LeaseJob,
  type LeaseResponse,
} from "@agentpr/shared";
import { env } from "../config.js";
import { db } from "../db/client.js";
import { repos, runners, type RunnerRow } from "../db/schema.js";
import { postReview } from "../github/app.js";
import { mintRepoToken } from "../github/app.js";
import {
  findJobByLease,
  leaseNextJob,
  persistResult,
  priorFindingsForPr,
  recordError,
  setReviewGithubId,
  touchRunner,
} from "../queue.js";
import { assembleReviewInstruction, loadReviewPromptParts } from "../review-prompt.js";
import { requireUser } from "../auth.js";
import { safeEqualHex, sha256, randomToken } from "../util/crypto.js";

type WithRunner = FastifyRequest & { runner?: RunnerRow };

async function requireRunner(request: WithRunner, reply: FastifyReply): Promise<void> {
  const auth = request.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    await reply.code(401).send({ error: { code: "unauthenticated", message: "Missing runner token" } });
    return;
  }
  const [runner] = await db
    .select()
    .from(runners)
    .where(and(eq(runners.tokenHash, sha256(token)), isNull(runners.revokedAt)))
    .limit(1);
  if (!runner) {
    await reply.code(401).send({ error: { code: "unauthenticated", message: "Invalid runner token" } });
    return;
  }
  request.runner = runner;
}

export function registerRunnerRoutes(app: FastifyInstance): void {
  // ── Enrollment (presents the shared bootstrap secret once) ───────────────────
  app.post("/api/runners/enroll", async (request, reply) => {
    const parsed = EnrollRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: "Invalid enrollment" } });
    }
    if (!safeEqualHex(parsed.data.enrollmentSecret, env.RUNNER_ENROLLMENT_SECRET)) {
      return reply.code(403).send({ error: { code: "forbidden", message: "Bad enrollment secret" } });
    }
    const runnerToken = randomToken(32);
    const [runner] = await db
      .insert(runners)
      .values({
        name: parsed.data.name,
        tokenHash: sha256(runnerToken),
        capabilities: parsed.data.capabilities,
        lastSeenAt: new Date(),
      })
      .returning({ id: runners.id });
    return reply.send({ runnerId: runner!.id, runnerToken });
  });

  // ── Short-poll for the next job (returns immediately) ────────────────────────
  // Returns immediately with a job or `{ job: null }`; the runner sleeps and
  // re-polls (see runner POLL_INTERVAL_MS). Long-poll was removed so the control
  // plane holds no long-lived connections and can run on Cloud Run scale-to-zero.
  app.post("/api/runners/lease", { preHandler: requireRunner }, async (request, reply) => {
    const runner = (request as WithRunner).runner!;
    await touchRunner(runner.id);

    const job = await leaseNextJob(runner.id);
    if (!job) return reply.send({ job: null } satisfies LeaseResponse);

    const [repo] = await db.select().from(repos).where(eq(repos.id, job.repoId)).limit(1);
    if (!repo) {
      return reply.send({ job: null } satisfies LeaseResponse);
    }
    const [owner, name] = repo.fullName.split("/");
    const githubToken = await mintRepoToken(repo.installationId, name!);
    const priorFindings = job.round > 1 ? await priorFindingsForPr(repo.id, job.prNumber) : [];
    const reviewInstruction = assembleReviewInstruction(await loadReviewPromptParts(), {
      repoFullName: repo.fullName,
      prNumber: job.prNumber,
      baseSha: job.baseSha,
      headSha: job.headSha,
      round: job.round,
      priorFindings,
    });
    const leaseJob: LeaseJob = {
      jobId: job.id,
      leaseId: job.leaseId!,
      repoFullName: repo.fullName,
      cloneUrl: `https://github.com/${owner}/${name}.git`,
      prNumber: job.prNumber,
      headSha: job.headSha,
      baseSha: job.baseSha,
      provider: repo.provider,
      model: repo.model,
      round: job.round,
      githubToken,
      reviewInstruction,
      resumeSessionId: job.claudeSessionId,
      priorFindings,
    };
    return reply.send({ job: leaseJob } satisfies LeaseResponse);
  });

  // ── Report a successful review ───────────────────────────────────────────────
  app.post("/api/runners/result", { preHandler: requireRunner }, async (request, reply) => {
    const runner = (request as WithRunner).runner!;
    const parsed = JobResultSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: "Invalid result" } });
    }
    const job = await findJobByLease(parsed.data.leaseId);
    if (!job || job.leasedByRunner !== runner.id) {
      return reply.code(404).send({ error: { code: "not_found", message: "Lease not found" } });
    }
    const persisted = await persistResult(job, parsed.data);
    if (!persisted) return reply.send({ ok: true, idempotent: true });

    // Post the review from the control plane (it holds the GitHub App key).
    const [repo] = await db.select().from(repos).where(eq(repos.id, job.repoId)).limit(1);
    let githubReviewId: number | null = null;
    if (repo) {
      const [owner, name] = repo.fullName.split("/");
      try {
        githubReviewId = await postReview({
          installationId: repo.installationId,
          owner: owner!,
          repo: name!,
          prNumber: job.prNumber,
          verdict: parsed.data.verdict,
          summary: parsed.data.summary,
          findings: parsed.data.findings,
          concerns: parsed.data.concerns,
          suggestedFixes: parsed.data.suggestedFixes,
          modelName: parsed.data.modelUsed ?? repo.model ?? "unknown model",
          round: job.round,
        });
        await setReviewGithubId(persisted.reviewId, githubReviewId);
      } catch (err) {
        request.log.error({ err, job: job.id }, "failed to post review to GitHub");
      }
    }
    return reply.send({ ok: true, reviewId: persisted.reviewId, githubReviewId });
  });

  // ── Report a failed review ───────────────────────────────────────────────────
  app.post("/api/runners/error", { preHandler: requireRunner }, async (request, reply) => {
    const runner = (request as WithRunner).runner!;
    const parsed = JobErrorSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "bad_request", message: "Invalid error report" } });
    }
    const job = await findJobByLease(parsed.data.leaseId);
    if (!job || job.leasedByRunner !== runner.id) {
      return reply.code(404).send({ error: { code: "not_found", message: "Lease not found" } });
    }
    await recordError(job, parsed.data.message, parsed.data.totalCostUsd, parsed.data.wallMs);
    return reply.send({ ok: true });
  });

  // ── Dashboard: list / revoke runners ─────────────────────────────────────────
  app.get("/api/runners", { preHandler: requireUser }, async () => {
    const rows = await db.select().from(runners).orderBy(desc(runners.createdAt));
    const offlineMs = env.RUNNER_OFFLINE_SECONDS * 1000;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      capabilities: r.capabilities,
      lastSeenAt: r.lastSeenAt,
      revokedAt: r.revokedAt,
      status:
        r.revokedAt || !r.lastSeenAt || Date.now() - r.lastSeenAt.getTime() > offlineMs
          ? "offline"
          : "online",
    }));
  });

  app.post<{ Params: { id: string } }>(
    "/api/runners/:id/revoke",
    { preHandler: requireUser },
    async (request) => {
      await db.update(runners).set({ revokedAt: new Date() }).where(eq(runners.id, request.params.id));
      return { ok: true };
    },
  );
}
