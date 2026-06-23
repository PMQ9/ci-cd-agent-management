// Minimal row factories for DB-backed tests. Each inserts a valid row (satisfying
// NOT NULL + FK constraints) and returns it. Pass the harness `db` (drizzle).
import {
  agentPrompts,
  findings,
  installations,
  jobs,
  repos,
  reviews,
  runners,
  templates,
  usageEvents,
} from "../../src/db/schema.js";

let seq = 0;
const next = () => ++seq;

export async function makeInstallation(db: any, over: Partial<any> = {}) {
  const id = over.id ?? 1000 + next();
  const [row] = await db
    .insert(installations)
    .values({ id, accountLogin: over.accountLogin ?? "octocat", ...over })
    .returning();
  return row;
}

export async function makeRepo(db: any, over: Partial<any> = {}) {
  const installationId = over.installationId ?? (await makeInstallation(db)).id;
  const n = next();
  const [row] = await db
    .insert(repos)
    .values({
      githubRepoId: over.githubRepoId ?? 5000 + n,
      installationId,
      fullName: over.fullName ?? `octocat/repo-${n}`,
      isPrivate: over.isPrivate ?? false,
      autoReviewEnabled: over.autoReviewEnabled ?? false,
      provider: over.provider ?? "claude_code",
      model: over.model ?? null,
      dailyCostCapUsd: over.dailyCostCapUsd ?? null,
      ...over,
    })
    .returning();
  return row;
}

export async function makeRunner(db: any, over: Partial<any> = {}) {
  const n = next();
  const [row] = await db
    .insert(runners)
    .values({
      name: over.name ?? `runner-${n}`,
      tokenHash: over.tokenHash ?? `hash-${n}`,
      capabilities: over.capabilities ?? { providers: ["claude_code"], version: "0.2.0" },
      lastSeenAt: over.lastSeenAt ?? new Date(),
      ...over,
    })
    .returning();
  return row;
}

export async function makeJob(db: any, over: Partial<any> = {}) {
  const repoId = over.repoId ?? (await makeRepo(db)).id;
  const [row] = await db
    .insert(jobs)
    .values({
      repoId,
      prNumber: over.prNumber ?? 1,
      headSha: over.headSha ?? "head" + "0".repeat(36),
      baseSha: over.baseSha ?? "base" + "0".repeat(36),
      trigger: over.trigger ?? "auto",
      state: over.state ?? "queued",
      round: over.round ?? 1,
      ...over,
    })
    .returning();
  return row;
}

export async function makeReview(db: any, jobId: string, over: Partial<any> = {}) {
  const [row] = await db
    .insert(reviews)
    .values({
      jobId,
      round: over.round ?? 1,
      verdict: over.verdict ?? "comment",
      summary: over.summary ?? "summary",
      concerns: over.concerns ?? null,
      suggestedFixes: over.suggestedFixes ?? null,
      ...over,
    })
    .returning();
  return row;
}

export async function makeFinding(db: any, reviewId: string, over: Partial<any> = {}) {
  const [row] = await db
    .insert(findings)
    .values({
      reviewId,
      path: over.path ?? "src/a.ts",
      line: over.line ?? 10,
      severity: over.severity ?? "medium",
      title: over.title ?? "finding",
      body: over.body ?? "body",
      status: over.status ?? "open",
      ...over,
    })
    .returning();
  return row;
}

export async function makeUsageEvent(db: any, over: Partial<any> = {}) {
  const [row] = await db
    .insert(usageEvents)
    .values({
      jobId: over.jobId ?? null,
      runnerId: over.runnerId ?? null,
      model: over.model ?? null,
      costUsd: over.costUsd ?? "0",
      wallMs: over.wallMs ?? null,
      ...over,
    })
    .returning();
  return row;
}

export async function makeTemplate(db: any, over: Partial<any> = {}) {
  const n = next();
  const [row] = await db
    .insert(templates)
    .values({
      slug: over.slug ?? `tpl-${n}`,
      name: over.name ?? `Template ${n}`,
      kind: over.kind ?? "pr_review",
      description: over.description ?? "",
      content: over.content ?? "## Section\nfill me",
      isActive: over.isActive ?? false,
      ...over,
    })
    .returning();
  return row;
}

export async function makePrompt(db: any, over: Partial<any> = {}) {
  const n = next();
  const [row] = await db
    .insert(agentPrompts)
    .values({
      key: over.key ?? `prompt.${n}`,
      label: over.label ?? `Prompt ${n}`,
      description: over.description ?? "",
      content: over.content ?? "prompt content",
      editable: over.editable ?? true,
      ...over,
    })
    .returning();
  return row;
}
