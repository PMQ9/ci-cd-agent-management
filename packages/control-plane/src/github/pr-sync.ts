import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { pullRequests, type RepoRow } from "../db/schema.js";
import { listOpenPrs } from "./app.js";

// The open-PR inbox registry. Detection is a side effect of events that already
// happen (webhooks) plus on-demand GitHub backfill — it never runs the agent, so
// it consumes no review quota. See review-service.ts for the actual review path.

export type PrUpsert = {
  repoId: string;
  number: number;
  title: string;
  author: string | null;
  headSha: string;
  baseSha: string;
  isDraft: boolean;
  htmlUrl: string;
  prUpdatedAt: Date | null;
};

/** Insert or refresh an open PR. Idempotent on (repoId, number). */
export async function upsertPullRequest(input: PrUpsert): Promise<void> {
  const now = new Date();
  await db
    .insert(pullRequests)
    .values({
      repoId: input.repoId,
      number: input.number,
      title: input.title,
      author: input.author,
      headSha: input.headSha,
      baseSha: input.baseSha,
      isDraft: input.isDraft,
      state: "open",
      htmlUrl: input.htmlUrl,
      prUpdatedAt: input.prUpdatedAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [pullRequests.repoId, pullRequests.number],
      set: {
        title: input.title,
        author: input.author,
        headSha: input.headSha,
        baseSha: input.baseSha,
        isDraft: input.isDraft,
        // Re-opening a closed PR returns it to the inbox.
        state: "open",
        htmlUrl: input.htmlUrl,
        prUpdatedAt: input.prUpdatedAt,
        updatedAt: now,
      },
    });
}

/** Drop a PR out of the inbox when it closes/merges. */
export async function markPullRequestClosed(
  repoId: string,
  number: number,
  merged: boolean,
): Promise<void> {
  await db
    .update(pullRequests)
    .set({ state: merged ? "merged" : "closed", updatedAt: new Date() })
    .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.number, number)));
}

/**
 * Backfill the inbox for one repo from GitHub. Upserts everything currently open
 * and demotes any row we still mark open that GitHub no longer lists (closed out
 * of band, e.g. before detection was enabled). Returns the open count.
 */
export async function syncOpenPullRequests(
  repo: RepoRow,
): Promise<{ open: number; capped: boolean }> {
  const [owner, name] = repo.fullName.split("/");
  if (!owner || !name) return { open: 0, capped: false };

  const { pulls, capped } = await listOpenPrs(repo.installationId, owner, name);
  const seen = new Set<number>();
  for (const p of pulls) {
    seen.add(p.number);
    await upsertPullRequest({
      repoId: repo.id,
      number: p.number,
      title: p.title,
      author: p.author,
      headSha: p.headSha,
      baseSha: p.baseSha,
      isDraft: p.draft,
      htmlUrl: p.htmlUrl,
      prUpdatedAt: p.updatedAt ? new Date(p.updatedAt) : null,
    });
  }

  // Reconcile: rows we think are open but GitHub didn't return are now closed.
  // (Skip when the listing was capped — we can't prove a missing PR is closed.)
  if (!capped) {
    const known = await db
      .select({ number: pullRequests.number })
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.state, "open")));
    for (const row of known) {
      if (!seen.has(row.number)) await markPullRequestClosed(repo.id, row.number, false);
    }
  }

  return { open: pulls.length, capped };
}
