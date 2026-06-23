import type { TriggerSource } from "@agentpr/shared";
import type { RepoRow } from "./db/schema.js";
import { getPrRefs } from "./github/app.js";
import { autoReviewBlockedReason, enqueueReview, getMaxRoundForPr, lastJobForPr } from "./queue.js";

export type TriggerOutcome =
  | { status: "queued"; jobId: string; round: number }
  | { status: "skipped"; reason: string };

/**
 * Single entry point for starting a review, shared by the webhook (auto),
 * the `/review` PR comment (command), and the dashboard button (manual).
 *
 * Draft-skip and the spend cap apply ONLY to auto triggers — an explicit manual
 * or command trigger always runs (the user opted in by clicking / commenting).
 */
export async function triggerReviewForPr(opts: {
  repo: RepoRow;
  prNumber: number;
  trigger: TriggerSource;
  headSha?: string;
  baseSha?: string;
  draftHint?: boolean;
}): Promise<TriggerOutcome> {
  const { repo, prNumber, trigger } = opts;
  const [owner, name] = repo.fullName.split("/");
  if (!owner || !name) return { status: "skipped", reason: "bad repo full_name" };

  let headSha = opts.headSha;
  let baseSha = opts.baseSha;
  let draft = opts.draftHint;

  // Manual/command triggers (and any path missing SHAs) resolve refs from GitHub.
  if (!headSha || !baseSha || draft === undefined) {
    const refs = await getPrRefs(repo.installationId, owner, name, prNumber);
    headSha ??= refs.headSha;
    baseSha ??= refs.baseSha;
    draft ??= refs.draft;
  }

  if (trigger === "auto") {
    if (draft) return { status: "skipped", reason: "draft PR" };
    const blocked = await autoReviewBlockedReason(repo);
    if (blocked) return { status: "skipped", reason: blocked };
  }

  const round = (await getMaxRoundForPr(repo.id, prNumber)) + 1;
  const prior = round > 1 ? await lastJobForPr(repo.id, prNumber) : undefined;

  const job = await enqueueReview({
    repoId: repo.id,
    prNumber,
    headSha: headSha!,
    baseSha: baseSha!,
    trigger,
    round,
    preferredRunnerId: prior?.leasedByRunner ?? null,
    claudeSessionId: prior?.claudeSessionId ?? null,
  });

  return { status: "queued", jobId: job.id, round };
}
