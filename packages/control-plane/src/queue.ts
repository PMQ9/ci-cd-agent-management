import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { AgentFinding, JobResult, PriorFinding, TriggerSource, Verdict } from "@agentpr/shared";
import { env } from "./config.js";
import { db } from "./db/client.js";
import { findings, jobs, reviews, runners, usageEvents, type JobRow } from "./db/schema.js";

const ACTIVE: ("queued" | "leased" | "running")[] = ["queued", "leased", "running"];

/** Mark any non-terminal jobs for this PR as superseded (new push / re-trigger). */
export async function supersedeActiveForPr(
  repoId: string,
  prNumber: number,
  exceptJobId?: string,
): Promise<void> {
  await db
    .update(jobs)
    .set({ state: "superseded", updatedAt: new Date() })
    .where(
      and(
        eq(jobs.repoId, repoId),
        eq(jobs.prNumber, prNumber),
        inArray(jobs.state, ACTIVE),
        exceptJobId ? sql`${jobs.id} <> ${exceptJobId}` : undefined,
      ),
    );
}

export async function getMaxRoundForPr(repoId: string, prNumber: number): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${jobs.round}), 0)` })
    .from(jobs)
    .where(and(eq(jobs.repoId, repoId), eq(jobs.prNumber, prNumber)));
  return row?.max ?? 0;
}

export async function enqueueReview(input: {
  repoId: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  trigger: TriggerSource;
  round: number;
  preferredRunnerId?: string | null;
  claudeSessionId?: string | null;
}): Promise<JobRow> {
  await supersedeActiveForPr(input.repoId, input.prNumber);
  const [job] = await db
    .insert(jobs)
    .values({
      repoId: input.repoId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      baseSha: input.baseSha,
      trigger: input.trigger,
      round: input.round,
      preferredRunnerId: input.preferredRunnerId ?? null,
      claudeSessionId: input.claudeSessionId ?? null,
      state: "queued",
    })
    .returning();
  return job!;
}

/**
 * Atomically lease the next eligible job for a runner. Jobs preferred for this
 * runner come first (affinity for re-reviews), then unpreferred jobs, oldest
 * first. FOR UPDATE SKIP LOCKED makes concurrent runners safe.
 */
export async function leaseNextJob(runnerId: string): Promise<JobRow | null> {
  return db.transaction(async (tx) => {
    const candidate = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.state, "queued"),
          or(isNull(jobs.preferredRunnerId), eq(jobs.preferredRunnerId, runnerId)),
        ),
      )
      .orderBy(sql`(${jobs.preferredRunnerId} = ${runnerId}) desc nulls last`, asc(jobs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    const first = candidate[0];
    if (!first) return null;

    const [updated] = await tx
      .update(jobs)
      .set({
        state: "leased",
        leaseId: sql`gen_random_uuid()`,
        leasedByRunner: runnerId,
        leaseExpiresAt: sql`now() + make_interval(secs => ${env.LEASE_TTL_SECONDS})`,
        attempts: sql`${jobs.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, first.id))
      .returning();
    return updated ?? null;
  });
}

/** Requeue jobs whose lease expired (runner crashed/went offline mid-job). */
export async function sweepExpiredLeases(): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({
      state: "queued",
      leaseId: null,
      leasedByRunner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(jobs.state, "leased"), lt(jobs.leaseExpiresAt, new Date())))
    .returning({ id: jobs.id });
  return rows.length;
}

export async function findJobByLease(leaseId: string): Promise<JobRow | undefined> {
  const [job] = await db.select().from(jobs).where(eq(jobs.leaseId, leaseId)).limit(1);
  return job;
}

/** Prior round's findings, for re-review context. */
export async function priorFindingsForPr(
  repoId: string,
  prNumber: number,
): Promise<PriorFinding[]> {
  const rows = await db
    .select({
      path: findings.path,
      line: findings.line,
      severity: findings.severity,
      title: findings.title,
      body: findings.body,
    })
    .from(findings)
    .innerJoin(reviews, eq(findings.reviewId, reviews.id))
    .innerJoin(jobs, eq(reviews.jobId, jobs.id))
    .where(and(eq(jobs.repoId, repoId), eq(jobs.prNumber, prNumber)))
    .orderBy(asc(reviews.createdAt));
  return rows.map((r) => ({ ...r }));
}

/**
 * Persist a successful result transactionally: write the review + findings +
 * usage event and flip the job to succeeded. Returns the new review id and the
 * verdict/summary/findings so the caller can post to GitHub. Idempotent: if the
 * job is no longer leased/running (already handled or superseded) returns null.
 */
export async function persistResult(
  job: JobRow,
  result: JobResult,
): Promise<{ reviewId: string } | null> {
  if (job.state !== "leased" && job.state !== "running") return null;
  return db.transaction(async (tx) => {
    const [review] = await tx
      .insert(reviews)
      .values({
        jobId: job.id,
        round: job.round,
        verdict: result.verdict,
        summary: result.summary,
      })
      .returning({ id: reviews.id });

    if (result.findings.length) {
      await tx.insert(findings).values(
        result.findings.map((f: AgentFinding) => ({
          reviewId: review!.id,
          path: f.path,
          line: f.line ?? null,
          severity: f.severity,
          title: f.title,
          body: f.body,
          status: "open" as const,
        })),
      );
    }

    await tx.insert(usageEvents).values({
      jobId: job.id,
      runnerId: job.leasedByRunner,
      model: null,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.totalCostUsd.toFixed(4),
      wallMs: result.wallMs,
    });

    await tx
      .update(jobs)
      .set({
        state: "succeeded",
        claudeSessionId: result.sessionId ?? job.claudeSessionId,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));

    return { reviewId: review!.id };
  });
}

export async function setReviewGithubId(reviewId: string, githubReviewId: number): Promise<void> {
  await db.update(reviews).set({ githubReviewId }).where(eq(reviews.id, reviewId));
}

export async function recordError(
  job: JobRow,
  message: string,
  costUsd: number | null,
  wallMs: number | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (costUsd && costUsd > 0) {
      await tx.insert(usageEvents).values({
        jobId: job.id,
        runnerId: job.leasedByRunner,
        costUsd: costUsd.toFixed(4),
        wallMs,
      });
    }
    await tx
      .update(jobs)
      .set({ state: "failed", errorMessage: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(jobs.id, job.id));
  });
}

// ── Spend guard ───────────────────────────────────────────────────────────────
async function spendTodayUsd(repoId?: string): Promise<number> {
  const whereDay = sql`${usageEvents.createdAt} >= date_trunc('day', now())`;
  if (repoId) {
    const [row] = await db
      .select({ total: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)` })
      .from(usageEvents)
      .innerJoin(jobs, eq(usageEvents.jobId, jobs.id))
      .where(and(eq(jobs.repoId, repoId), whereDay));
    return Number(row?.total ?? 0);
  }
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)` })
    .from(usageEvents)
    .where(whereDay);
  return Number(row?.total ?? 0);
}

/** Soft daily cap: auto-review pauses when over the per-repo or global cap. */
export async function autoReviewBlockedReason(repo: {
  id: string;
  dailyCostCapUsd: string | null;
}): Promise<string | null> {
  if (repo.dailyCostCapUsd != null) {
    const cap = Number(repo.dailyCostCapUsd);
    if (cap > 0 && (await spendTodayUsd(repo.id)) >= cap) {
      return `repo daily cost cap $${cap} reached`;
    }
  }
  if (env.GLOBAL_DAILY_COST_CAP_USD && env.GLOBAL_DAILY_COST_CAP_USD > 0) {
    if ((await spendTodayUsd()) >= env.GLOBAL_DAILY_COST_CAP_USD) {
      return `global daily cost cap $${env.GLOBAL_DAILY_COST_CAP_USD} reached`;
    }
  }
  return null;
}

export async function touchRunner(runnerId: string): Promise<void> {
  await db.update(runners).set({ lastSeenAt: new Date() }).where(eq(runners.id, runnerId));
}

/** Most recent job for a PR — used to route a re-review back to the same runner/session. */
export async function lastJobForPr(
  repoId: string,
  prNumber: number,
): Promise<{ leasedByRunner: string | null; claudeSessionId: string | null } | undefined> {
  const [row] = await db
    .select({ leasedByRunner: jobs.leasedByRunner, claudeSessionId: jobs.claudeSessionId })
    .from(jobs)
    .where(and(eq(jobs.repoId, repoId), eq(jobs.prNumber, prNumber)))
    .orderBy(sql`${jobs.createdAt} desc`)
    .limit(1);
  return row;
}
