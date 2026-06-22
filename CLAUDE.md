# CLAUDE.md — engineering guide for AI agents

Read this before changing code. It encodes the constraints and conventions that aren't
obvious from any single file.

## What this is

A control plane that turns "open a PR → tell Claude Code to review it" into an
event-driven, stateful loop, **consuming the user's Claude subscription (OAuth), never
the paid API.** Split into a **control plane** (always-on orchestration) and **runners**
(on the user's machines, where Claude is logged in).

## The inviolable constraint (do not violate)

**Claude/OpenCode subscription credentials run only where the OAuth login lives — the
runner. The control plane never holds them.** Everything else follows from this:

- Compute (the `claude -p` call) happens on the **runner**, never the control plane.
- Runners connect **outbound** (short-poll); the control plane never dials in. This is
  why the queue is pull-based, not a push/WebSocket dispatch.
- The control plane holds the *GitHub* credentials (App key) and posts the review, so
  GitHub creds also stay off the runner. The runner only gets a short-lived,
  single-repo token at lease time.

## Architecture

```
GitHub ──webhook(HMAC)──▶ control-plane ──┐  posts review (Reviews API)
                          (Fastify+PG)    └──▶ GitHub
   runner ──short-poll /api/runners/lease─▶ control-plane   (lease: FOR UPDATE SKIP LOCKED)
   runner ──POST result/error────────────▶ control-plane   (idempotent on leaseId)
   runner: git worktree checkout → claude -p --output-format json → findings + cost
   Cloud Scheduler ──POST /internal/sweep─▶ control-plane   (requeue dead leases; scale-to-zero)
```

## Packages (pnpm workspace, ESM, TypeScript)

- **`packages/shared`** — the **contract spine**. Zod schemas are the single source of
  truth; types are inferred from them. `enums.ts` exports the canonical enum tuples that
  BOTH Zod and the Drizzle `pgEnum`s import (so DB and app can't drift).
  - `enums.ts` (value tuples), `domain.ts` (entities), `contracts.ts` (wire DTOs +
    `ReviewOutputSchema`, the JSON shape the agent must emit).
  - ⚠️ Internal imports here are **extensionless** (`./enums`, not `./enums.js`) so
    drizzle-kit can load the schema. Keep it that way.
- **`packages/control-plane`** — Fastify API on `:8080`.
  - `config.ts` (Zod-validated env; `githubConfigured` gate), `db/schema.ts` (Drizzle;
    enums from shared), `db/client.ts`, `db/migrate.ts` (`runMigrations`, auto-run on boot
    unless `AUTO_MIGRATE=false`).
  - `queue.ts` — **the heart**: `enqueueReview`, `leaseNextJob` (SKIP LOCKED + runner
    affinity), `persistResult` (txn), `recordError`, `sweepExpiredLeases`,
    `autoReviewBlockedReason` (spend guard).
  - `github/app.ts` (`mintRepoToken` 1h/single-repo, `postReview` w/ inline→summary
    fallback, `getPrRefs`), `github/sync.ts` (mirror installs/repos).
  - `review-service.ts` — `triggerReviewForPr`, the ONE entry point for auto / manual /
    command triggers (draft-skip + spend cap apply to `auto` only).
  - `webhook.ts` (HMAC via `crypto.timingSafeEqual`; routes pull_request, issue_comment,
    installation*), `auth.ts` (GitHub App user-OAuth login, single-login allowlist,
    signed cookie, non-prod `/auth/dev-login`), `routes/*` (repos, runners, jobs, usage),
    `server.ts`, `index.ts`.
- **`packages/runner`** — the daemon. `main.ts` (enroll → poll → handle job),
  `client.ts`, `checkout.ts` (git fetch via `http.extraheader` so the token stays out of
  URLs/logs), `exec-claude.ts` (builds the prompt, spawns `claude -p`, parses the JSON
  wrapper + the agent's `ReviewOutput`, refuses if `ANTHROPIC_API_KEY` is set).
- **`packages/dashboard`** — Vite + React SPA. `api.ts` (typed client, `credentials:
  include`), `App.tsx` (Repos / Runners / Activity / Usage tabs).

## Data model (Postgres, `db/schema.ts`)

`users` (single-login allowlist), `installations`, `repos` (`autoReviewEnabled` = the
per-repo toggle, default false; `provider`, `model`, `dailyCostCapUsd`), `runners`
(`tokenHash`, capabilities), **`jobs`** (the queue: `state`, `leaseId`, `leasedByRunner`,
`leaseExpiresAt`, `round`, `preferredRunnerId`, `claudeSessionId`), `reviews`,
`findings` (`prevFindingId` links the same issue across rounds), `usage_events`
(append-only; analytics + spend cap are SUM/GROUP-BY over this).

## Job lifecycle

1. Trigger (`webhook` auto / `/review` comment / dashboard button) → `triggerReviewForPr`
   → `enqueueReview` inserts a `queued` job (superseding any active job for that PR).
   Re-reviews set `round = max+1`, `preferredRunnerId` + `claudeSessionId` from the last job.
2. Runner short-polls `/api/runners/lease` (returns immediately; sleeps `POLL_INTERVAL_MS`
   and retries when empty) → `leaseNextJob` atomically claims a job (`leased`,
   `leaseExpiresAt`). Affinity: jobs preferred for this runner first.
3. Control plane assembles a `LeaseJob`: mints a 1h single-repo token, attaches prior
   findings (round > 1) and `resumeSessionId`.
4. Runner checks out the PR diff, runs `claude -p`, POSTs `JobResult` (idempotent on
   `leaseId`). `persistResult` writes review+findings+usage and flips job to `succeeded`.
5. Control plane posts the review to GitHub (it holds the App key) and stores the review id.
6. Crash safety: `sweepExpiredLeases` requeues `leased` jobs past their TTL. Triggered by
   the in-process 30s timer locally/on the VM (`ENABLE_INPROCESS_SWEEP`), or by Cloud
   Scheduler → `POST /internal/sweep` on Cloud Run (where the timer can't fire at zero).

## Conventions

- **Contract spine:** define a shape once in `shared` (Zod), infer the type, import
  everywhere. Never hand-maintain a parallel type.
- **Parse at boundaries:** `Schema.safeParse(req.body)` on input, `Schema.parse(...)` on
  responses you consume; never `as`.
- **Error envelope:** `{ error: { code, message, fields? } }` (see `ApiErrorSchema`).
- **Auth:** dashboard routes use `requireUser` (signed cookie + allowlist); runner routes
  use `requireRunner` (bearer token → `sha256` → `runners.tokenHash`). Secrets compared
  with `safeEqualHex` / `timingSafeEqual`.
- **Scope every query** to the right owner; never return another principal's data.

## Commands

```bash
pnpm install
pnpm -r typecheck          # all packages
pnpm -r build              # tsup (cp/runner/shared) + vite (dashboard)
pnpm db:up                 # Postgres in Docker
pnpm db:generate           # regenerate drizzle/*.sql after editing db/schema.ts
pnpm db:migrate            # apply migrations manually (also auto-runs on control-plane boot)
pnpm dev:cp | dev:dash | dev:runner
```

After editing `db/schema.ts`, **always** `pnpm db:generate` and commit the new
`packages/control-plane/drizzle/*.sql`.

## Gotchas (these caused real design decisions)

- **`ANTHROPIC_API_KEY` precedence trap:** if set, `claude -p` bills the API, not the
  subscription. The runner asserts it is unset and refuses otherwise. Never set it in the
  runner env / systemd unit.
- **No quota-remaining API:** the dashboard reports MEASURED spend (`usage_events`) +
  links to the Claude Console. Do not invent a "% remaining" number.
- **Session resume is best-effort:** `--resume` across headless runs is unverified, so
  re-reviews **re-feed prior findings** as the primary mechanism; resume + runner affinity
  is an optimization with fallback. Don't make features depend on resume.
- **`claude` is not always on the non-interactive PATH** on the runner host → the runner
  uses an absolute `CLAUDE_BIN`.
- **OpenCode ≠ Claude subscription** (Anthropic ToS). The `opencode` provider is a stub
  (`provider !== "claude_code"` throws). Implementing it = a free non-Claude backend only.
- **Submitted GitHub reviews can't be edited** → every re-review is a NEW review object
  (`reviews.round`).
- **pnpm build approval:** esbuild's build script must be approved (`allowBuilds: esbuild:
  true` in `pnpm-workspace.yaml`) or `pnpm install` hard-fails under the supply-chain policy.
- **Scale-to-zero kills the in-process sweep timer:** on Cloud Run the frozen instance can't
  fire `setInterval`, so prod lease recovery is Cloud Scheduler → `POST /internal/sweep`
  (gated by `ENABLE_INPROCESS_SWEEP=false` + an `INTERNAL_API_TOKEN` bearer). Don't add other
  background timers expecting them to run between requests on Cloud Run.
- **Don't long-poll the lease endpoint:** the runner short-polls (returns immediately, sleeps
  `POLL_INTERVAL_MS`, retries). A held connection bills Cloud Run for the whole duration and
  would cost more than the VM's IP — the reason the long-poll was removed.

## Extending

- **New API route:** add `src/routes/<x>.ts`, register in `server.ts`, guard with
  `requireUser`. Validate input with a Zod schema; return the error envelope on failure.
- **New trigger surface:** call `triggerReviewForPr` — don't re-implement enqueue logic.
- **OpenCode provider (Phase 6):** add `exec-opencode.ts` mirroring `exec-claude.ts`
  (`opencode run --model <provider/model> --output-format json` or `opencode serve`),
  branch on `job.provider` in `runner/main.ts`. Keep the same `JobResult` contract.
- **Re-review resolved/regressed (Phase 3):** enrich `persistResult` to diff against the
  prior round's findings and set `findings.status` + `prevFindingId`.

## Verification

Local: `pnpm -r typecheck && pnpm -r build`, `pnpm db:up`, boot the control plane, then
the smoke checks (enroll runner, dev-login, list endpoints). End-to-end (needs the GitHub
App + a real PR, consumes quota): see `deploy/gcp/SETUP.md` §7. The negative check that
matters: a runner with `ANTHROPIC_API_KEY` set must REFUSE to run.

## Deploy (topology)

- **Control plane → GCP Cloud Run** (scale-to-zero, ~$0): public HTTPS `*.run.app` URL with
  managed TLS — **no external IP, no Caddy, no domain**. Shipped by
  `.github/workflows/deploy.yml` on push to `main` (`gcloud run deploy --source .` → Cloud
  Build builds the repo-root `Dockerfile`). **Neon** free Postgres (external — set
  `DATABASE_URL`; SSL auto for remote hosts). Cloud Scheduler hits `POST /internal/sweep`
  every minute to recover dead leases. Always-on/public, never depends on the runner box.
  See `deploy/gcp/SETUP.md`. *(The e2-micro VM + Caddy path is kept as an appendix fallback;
  it costs ~$3.65/mo for the IPv4.)*
- **Runner → your machine** (where Claude is logged in): systemd user service, short-polls
  the control plane's public `*.run.app` URL. See `deploy/runner/SETUP.md`.
- The root `docker-compose.yml` (Postgres + control-plane) is for **local dev** only.
