# Agent PR Control Center

Open a pull request → a terminal AI agent (Claude Code) reviews it against a **structured
review template you control** and posts the filled-in result — **using your Claude
subscription, not the paid API.** Push fixes and it re-reviews, verifying what's resolved.
Manage everything (templates, the agent's system prompt, repos, runs) from one dashboard.

## Why this exists

Claude Code reviews PRs great, but doing it by hand (open PR → run `claude` → paste
feedback → push → re-run) is tedious, and the paid API would waste the weekly
subscription quota you've already got. This wires the whole loop together while keeping
the agent on **your own machine**, where it's logged in via OAuth.

## How it works

```
GitHub  ──webhook──▶  Control plane (GCP Cloud Run, scale-to-zero) ── Neon (Postgres)
                        • GitHub App + dashboard + job queue
                        • posts the review back to the PR
                              ▲ short-poll (outbound 443)  │ result
                              │                             ▼
                        Runner (your machine) ── runs `claude -p` on the PR diff
                        holds your Claude login; API key never used
```

- **Control plane** is always-on, catches webhooks, and serves the dashboard. It never
  holds your Claude credentials.
- **Runner(s)** live where Claude is logged in. They dial *out* (no inbound ports),
  check out the PR, run the agent, and return findings. Re-reviews route back to the
  same runner so the agent continues its prior session.
- **Auto-review is opt-in per repo** (manual is the default). Draft PRs are skipped.
  Trigger manually with a dashboard button or a `/review` PR comment. An optional daily
  spend cap auto-pauses auto-review.
- **Reviews are template-enforced, not freestyle.** The active *PR Review* template is the
  rubric the agent must fill; the posted review is rendered as that template (verdict,
  findings bucketed 🔴/🟡/🟢, concerns, suggested fixes, `Reviewed by: <model>`). Edit the
  template and the agent's system prompt live in the dashboard — no redeploy.

## Review templates & system prompts

Two dashboard tabs make the review fully yours to shape:

- **Review Templates** — the templates the system knows about (seeded from
  [gh-templates](https://github.com/PMQ9): PR Review, PR Description, Secure Code Review).
  The one marked *active rubric* is what every AI review must fill. Edit the markdown in
  place; the next review uses it.
- **System Prompts** — the reviewer's system prompt in editable pieces (persona,
  template-adherence rules, re-review addendum). The JSON output contract is shown
  read-only so the result parser can't be broken from the UI. "Preview assembled
  instruction" shows exactly what the runner sends to `claude -p`.

The prompt is assembled on the control plane (DB-backed, editable) and shipped to the
runner per job, so changes apply with no redeploy. The posted GitHub review is rendered
*as* the filled template, including a control-plane-stamped `Reviewed by: <model>` line.

## Quick start (local dev)

```bash
pnpm install
pnpm db:up                 # Postgres in Docker
cp .env.example .env       # set SESSION_SECRET + RUNNER_ENROLLMENT_SECRET (GitHub optional for now)
pnpm dev:cp                # control plane → http://localhost:8080 (auto-migrates)
pnpm dev:dash              # dashboard    → http://localhost:5173  (proxies the API)
pnpm dev:runner            # runner       → enrolls + polls for jobs
```

In the dashboard, click **Dev login** (local only). Connecting real repos needs a GitHub
App — see the deploy guides below.

### Preview the deployed site locally (before pushing)

`dev:dash` is hot-reload dev mode (Vite on `:5173`, API proxied). To debug the site **as
Cloud Run actually serves it** — production bundle, single origin, SPA fallback, pre-paint
theme script — run the one-command prod-preview instead:

```bash
pnpm preview:web           # builds the dashboard + serves it via the control plane on :8080
```

It starts Postgres (Docker), builds the dashboard (rebuilds on save), boots the control
plane with `DASHBOARD_DIST` set, waits for `/health`, and opens the browser. Ctrl-C stops
everything. In VS Code it's also a click: **Run & Debug → "Debug Web (local prod-preview)"**.
Flags: `--build` (compile the control plane too, max fidelity), `--no-watch`, `--no-db`,
`--no-open`.

## Deploy

- **Control plane → GCP Cloud Run** (scale-to-zero ~$0, managed HTTPS, no IP/domain) **+
  Neon free Postgres**: **[deploy/gcp/SETUP.md](deploy/gcp/SETUP.md)**. Always-on and
  public, so webhooks land even when your laptop is off.
- **Runner → your machine** (where Claude is logged in; dials out to the control plane):
  **[deploy/runner/SETUP.md](deploy/runner/SETUP.md)**.

## Layout

| Package | What it is |
|---|---|
| `packages/shared` | Zod schemas = the one source of truth for types & the wire contract |
| `packages/control-plane` | Fastify API, GitHub App, webhook, Postgres job queue, auth |
| `packages/runner` | The daemon that runs `claude -p` where you're logged in |
| `packages/dashboard` | React command center (repos, review templates, system prompts, runners, activity, usage) |

For architecture details and conventions, see [CLAUDE.md](CLAUDE.md).

## Status

**Live:** control plane deployed to GCP Cloud Run at
`https://control-plane-792029157879.us-central1.run.app` (project `agentpr-cp-ff3097`),
auto-deploys on push to `main`. Last step to go end-to-end: connect a runner on the
machine where Claude is logged in (**[deploy/runner/SETUP.md](deploy/runner/SETUP.md)**).

v1 = Claude Code, single user, multi-runner-ready. Deferred: OpenCode adapter (it can't
use a Claude subscription per Anthropic's ToS — it'd be a free non-Claude model),
multi-tenant, and true `--resume` session continuity (re-reviews currently re-feed prior
findings as context).
