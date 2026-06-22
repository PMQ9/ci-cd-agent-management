# Agent PR Control Center

Open a pull request → a terminal AI agent (Claude Code) reviews it and posts feedback —
**using your Claude subscription, not the paid API.** Push fixes and it re-reviews,
verifying what's resolved. Manage everything from one dashboard.

## Why this exists

Claude Code reviews PRs great, but doing it by hand (open PR → run `claude` → paste
feedback → push → re-run) is tedious, and the paid API would waste the weekly
subscription quota you've already got. This wires the whole loop together while keeping
the agent on **your own machine**, where it's logged in via OAuth.

## How it works

```
GitHub  ──webhook──▶  Control plane (your self-hosted host, public via Tailscale Funnel)
                        • GitHub App + dashboard + Postgres job queue
                        • posts the review back to the PR
                              ▲ long-poll (outbound)   │ result
                              │                         ▼
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
App — see **[deploy/self-hosted/SETUP.md](deploy/self-hosted/SETUP.md)**.

## Deploy

Runs on any always-on box you control: control plane + Postgres + dashboard in Docker
Compose, the runner as a systemd service, public URL via Tailscale Funnel. Full guide:
**[deploy/self-hosted/SETUP.md](deploy/self-hosted/SETUP.md)**.

## Layout

| Package | What it is |
|---|---|
| `packages/shared` | Zod schemas = the one source of truth for types & the wire contract |
| `packages/control-plane` | Fastify API, GitHub App, webhook, Postgres job queue, auth |
| `packages/runner` | The daemon that runs `claude -p` where you're logged in |
| `packages/dashboard` | React command center (repos, runners, activity, usage) |

For architecture details and conventions, see [CLAUDE.md](CLAUDE.md).

## Status

v1 = Claude Code, single user, multi-runner-ready. Deferred: OpenCode adapter (it can't
use a Claude subscription per Anthropic's ToS — it'd be a free non-Claude model),
multi-tenant, and true `--resume` session continuity (re-reviews currently re-feed prior
findings as context).
