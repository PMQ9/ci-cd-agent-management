import { createHmac } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { env, githubConfigured } from "./config.js";
import { markPullRequestClosed, upsertPullRequest } from "./github/pr-sync.js";
import {
  findRepoByGithubId,
  removeInstallation,
  removeRepoByGithubId,
  syncInstallationRepos,
  upsertInstallation,
} from "./github/sync.js";
import { triggerReviewForPr } from "./review-service.js";
import { safeEqualHex } from "./util/crypto.js";

// Loose view of the GitHub payloads we touch (validated structurally as we read).
type Payload = Record<string, any>;

function verifySignature(request: FastifyRequest): boolean {
  const sig = request.headers["x-hub-signature-256"];
  const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
  if (typeof sig !== "string" || !raw) return false;
  const expected =
    "sha256=" + createHmac("sha256", env.GITHUB_WEBHOOK_SECRET!).update(raw).digest("hex");
  return safeEqualHex(sig, expected);
}

// Per-route rate limit for the public webhook endpoint. Generous enough that
// legitimate GitHub deliveries (spread across GitHub's source IPs) never trip it,
// while a single IP flooding bad-signature requests is capped. Keyed by client IP
// (trustProxy is on, so that's the real X-Forwarded-For address behind Cloud Run).
export const WEBHOOK_RATE_LIMIT = { max: 300, timeWindow: "1 minute" } as const;

export function registerWebhook(app: FastifyInstance): void {
  app.post("/webhook", { config: { rateLimit: WEBHOOK_RATE_LIMIT } }, async (request, reply) => {
    if (!githubConfigured)
      return reply.code(503).send({ ok: false, reason: "github_not_configured" });
    if (!verifySignature(request))
      return reply.code(401).send({ ok: false, reason: "bad_signature" });

    const event = request.headers["x-github-event"];
    const payload = request.body as Payload;

    try {
      switch (event) {
        case "installation":
          await handleInstallation(payload, request);
          break;
        case "installation_repositories":
          await handleInstallationRepos(payload, request);
          break;
        case "pull_request":
          return reply.send(await handlePullRequest(payload, request));
        case "issue_comment":
          return reply.send(await handleIssueComment(payload, request));
        default:
          break;
      }
    } catch (err) {
      request.log.error({ err, event }, "webhook handler failed");
      return reply.code(500).send({ ok: false });
    }
    return reply.send({ ok: true });
  });
}

async function handleInstallation(payload: Payload, request: FastifyRequest): Promise<void> {
  const id = payload.installation?.id as number;
  const action = payload.action as string;
  if (!id) return;
  if (action === "deleted") {
    await removeInstallation(id);
    return;
  }
  await upsertInstallation({
    id,
    accountLogin: payload.installation?.account?.login ?? "unknown",
    repoSelection: payload.installation?.repository_selection,
    suspendedAt: action === "suspend" ? new Date() : null,
  });
  if (action === "created" || action === "unsuspend") {
    const n = await syncInstallationRepos(id);
    request.log.info({ installationId: id, repos: n }, "installation synced");
  }
}

async function handleInstallationRepos(payload: Payload, request: FastifyRequest): Promise<void> {
  const id = payload.installation?.id as number;
  if (!id) return;
  for (const r of (payload.repositories_removed ?? []) as Payload[]) {
    await removeRepoByGithubId(r.id);
  }
  if ((payload.repositories_added ?? []).length) {
    const n = await syncInstallationRepos(id);
    request.log.info({ installationId: id, repos: n }, "installation repos synced");
  }
}

// Actions worth (re)enqueueing an auto-review for.
const REVIEW_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);
// Actions that should refresh the open-PR inbox — superset of REVIEW_ACTIONS.
// Detection runs regardless of the auto-review toggle; it costs no review quota.
const REGISTRY_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "converted_to_draft",
  "synchronize",
  "edited",
]);

async function handlePullRequest(payload: Payload, request: FastifyRequest) {
  const action = payload.action as string;
  const repo = await findRepoByGithubId(payload.repository?.id);
  if (!repo) return { ok: true, ignored: "repo_not_connected" };

  const pr = payload.pull_request;

  // 1) Keep the open-PR inbox fresh on every relevant event. This is the
  //    "auto-detect" path — pure metadata, independent of the review toggle.
  //    `edited` (and friends) can fire on an already closed/merged PR, so trust
  //    the payload's state rather than force-opening the row back into the inbox.
  if (action === "closed" || (REGISTRY_ACTIONS.has(action) && pr.state !== "open")) {
    await markPullRequestClosed(repo.id, pr.number, Boolean(pr.merged));
  } else if (REGISTRY_ACTIONS.has(action)) {
    await upsertPullRequest({
      repoId: repo.id,
      number: pr.number,
      title: pr.title ?? "",
      author: pr.user?.login ?? null,
      headSha: pr.head?.sha ?? "",
      baseSha: pr.base?.sha ?? "",
      isDraft: Boolean(pr.draft),
      htmlUrl: pr.html_url ?? "",
      prUpdatedAt: pr.updated_at ? new Date(pr.updated_at) : null,
    });
  }

  // 2) Auto-review enqueue — still gated on review-worthy actions + the toggle.
  if (!REVIEW_ACTIONS.has(action)) return { ok: true, ignored: action };
  if (!repo.autoReviewEnabled) return { ok: true, ignored: "auto_review_off" };

  const outcome = await triggerReviewForPr({
    repo,
    prNumber: pr.number,
    trigger: "auto",
    headSha: pr.head?.sha,
    baseSha: pr.base?.sha,
    draftHint: Boolean(pr.draft),
  });
  request.log.info({ repo: repo.fullName, pr: pr.number, action, outcome }, "pull_request handled");
  return { ok: true, ...outcome };
}

async function handleIssueComment(payload: Payload, request: FastifyRequest) {
  if (payload.action !== "created") return { ok: true, ignored: "not_created" };
  if (!payload.issue?.pull_request) return { ok: true, ignored: "not_a_pr" };

  const body: string = (payload.comment?.body ?? "").trim();
  if (!/^\/review\b/i.test(body)) return { ok: true, ignored: "no_command" };

  // Only the allowlisted user may spend your quota via a comment.
  const commenter = payload.comment?.user?.login;
  if (env.ALLOWED_GITHUB_LOGIN && commenter !== env.ALLOWED_GITHUB_LOGIN) {
    return { ok: true, ignored: "commenter_not_allowed" };
  }

  const repo = await findRepoByGithubId(payload.repository?.id);
  if (!repo) return { ok: true, ignored: "repo_not_connected" };

  const outcome = await triggerReviewForPr({
    repo,
    prNumber: payload.issue.number,
    trigger: "command",
  });
  request.log.info({ repo: repo.fullName, pr: payload.issue.number, outcome }, "/review handled");
  return { ok: true, ...outcome };
}
