import { App } from "@octokit/app";
import type { AgentFinding, Severity, Verdict } from "@agentpr/shared";
import { env, githubConfigured, loadPrivateKey } from "../config.js";

let _app: App | null = null;

export function getApp(): App {
  if (!githubConfigured) throw new Error("github_not_configured");
  if (!_app) {
    _app = new App({
      appId: env.GITHUB_APP_ID!,
      privateKey: loadPrivateKey()!,
      oauth: {
        clientId: env.GITHUB_APP_CLIENT_ID!,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET!,
      },
      webhooks: { secret: env.GITHUB_WEBHOOK_SECRET! },
    });
  }
  return _app;
}

const VERDICT_EVENT: Record<Verdict, "APPROVE" | "REQUEST_CHANGES" | "COMMENT"> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
};

const VERDICT_LABEL: Record<Verdict, string> = {
  approve: "Approve",
  request_changes: "Request changes",
  comment: "Comment",
};

// The template buckets findings into 3 levels; our severity enum has 5. Map them so no
// severity silently vanishes from the rendered body.
const SEVERITY_BUCKET: Record<Severity, "high" | "medium" | "low"> = {
  critical: "high",
  high: "high",
  medium: "medium",
  low: "low",
  info: "low",
};

/**
 * Mint a fresh installation token scoped to ONE repo, valid ~1 hour. Handed to
 * the runner so it can clone exactly that repo and nothing else.
 */
export async function mintRepoToken(
  installationId: number,
  repoShortName: string,
): Promise<string> {
  const { data } = await getApp().octokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    {
      installation_id: installationId,
      repositories: [repoShortName],
      permissions: { pull_requests: "write", contents: "read", checks: "write" },
    },
  );
  return data.token;
}

function renderFindingLine(f: AgentFinding): string {
  const loc = f.line ? `${f.path}:${f.line}` : f.path;
  const body = f.body.replace(/\n/g, "\n  ");
  return `- **${f.title}** \`${loc}\`\n  ${body}`;
}

/**
 * Render the agent's structured output AS the filled-in pr_review template: Review
 * summary + Verdict, Findings bucketed 🔴/🟡/🟢, Concerns, Suggested fixes, and the
 * mandatory "Reviewed by: <model>" line (stamped by the control plane, never the agent).
 * Empty sections render "None." so the posted review always matches the template shape.
 */
export function renderTemplateBody(opts: {
  verdict: Verdict;
  summary: string;
  findings: AgentFinding[];
  concerns: string[];
  suggestedFixes: string[];
  modelName: string;
  round: number;
}): string {
  const buckets = { high: [] as AgentFinding[], medium: [] as AgentFinding[], low: [] as AgentFinding[] };
  for (const f of opts.findings) buckets[SEVERITY_BUCKET[f.severity]].push(f);

  const section = (items: AgentFinding[]) =>
    items.length ? items.map(renderFindingLine).join("\n") : "None.";

  const lines = [
    `## Review summary`,
    opts.summary,
    `**Verdict:** ${VERDICT_LABEL[opts.verdict]}`,
    ``,
    `## Findings`,
    ``,
    `### 🔴 High`,
    section(buckets.high),
    ``,
    `### 🟡 Medium`,
    section(buckets.medium),
    ``,
    `### 🟢 Low`,
    section(buckets.low),
    ``,
    `## Concerns`,
    opts.concerns.length ? opts.concerns.map((c) => `- ${c}`).join("\n") : "None.",
    ``,
    `## Suggested fixes`,
    opts.suggestedFixes.length
      ? opts.suggestedFixes.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "None.",
    ``,
    `---`,
    `**Reviewed by:** ${opts.modelName} · round ${opts.round} · ci-cd-agent-management (your Claude subscription)`,
  ];
  return lines.join("\n");
}

/**
 * Post a PR review. Tries inline comments first; if GitHub rejects a comment
 * position (line not in the diff), falls back to a plain summary review so a
 * review always lands. Returns the GitHub review id.
 */
export async function postReview(opts: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  verdict: Verdict;
  summary: string;
  findings: AgentFinding[];
  concerns: string[];
  suggestedFixes: string[];
  modelName: string;
  round: number;
}): Promise<number> {
  const octokit = await getApp().getInstallationOctokit(opts.installationId);
  const body = renderTemplateBody(opts);
  const event = VERDICT_EVENT[opts.verdict];

  const inline = opts.findings
    .filter((f) => typeof f.line === "number" && f.line! > 0)
    .map((f) => ({
      path: f.path,
      line: f.line!,
      side: "RIGHT" as const,
      body: `**[${f.severity}] ${f.title}**\n\n${f.body}`,
    }));

  const base = {
    owner: opts.owner,
    repo: opts.repo,
    pull_number: opts.prNumber,
    body,
    event,
  };

  try {
    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      inline.length ? { ...base, comments: inline } : base,
    );
    return data.id;
  } catch (err) {
    if (!inline.length) throw err;
    // Inline positions rejected — retry as a summary-only review.
    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      base,
    );
    return data.id;
  }
}

// A lightweight, app-agnostic view of an open PR (for the inbox registry).
export type GhPull = {
  number: number;
  title: string;
  author: string | null;
  headSha: string;
  baseSha: string;
  draft: boolean;
  htmlUrl: string;
  updatedAt: string | null;
};

/**
 * List a repo's open PRs via the installation token. Metadata only — this never
 * runs the agent, so it costs no review quota. Paged manually (the App's Octokit
 * core has no `.paginate`); capped to avoid unbounded calls.
 */
export async function listOpenPrs(
  installationId: number,
  owner: string,
  repo: string,
): Promise<{ pulls: GhPull[]; capped: boolean }> {
  const octokit = await getApp().getInstallationOctokit(installationId);
  const perPage = 100;
  const maxPages = 10;
  const pulls: GhPull[] = [];
  let capped = false;
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      state: "open",
      per_page: perPage,
      page,
      sort: "updated",
      direction: "desc",
    });
    for (const p of data) {
      pulls.push({
        number: p.number,
        title: p.title ?? "",
        author: p.user?.login ?? null,
        headSha: p.head?.sha ?? "",
        baseSha: p.base?.sha ?? "",
        draft: Boolean(p.draft),
        htmlUrl: p.html_url ?? "",
        updatedAt: p.updated_at ?? null,
      });
    }
    if (data.length < perPage) break;
    if (page === maxPages) capped = true;
  }
  return { pulls, capped };
}

/** Resolve the base/head SHAs and clone URL for a PR (used when enqueuing). */
export async function getPrRefs(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ headSha: string; baseSha: string; cloneUrl: string; draft: boolean }> {
  const octokit = await getApp().getInstallationOctokit(installationId);
  const { data } = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    { owner, repo, pull_number: prNumber },
  );
  return {
    headSha: data.head.sha,
    baseSha: data.base.sha,
    cloneUrl: data.base.repo.clone_url,
    draft: Boolean(data.draft),
  };
}
