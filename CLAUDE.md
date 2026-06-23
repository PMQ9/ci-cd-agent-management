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
    `ReviewOutputSchema`, the JSON shape the agent must emit, + `REVIEW_OUTPUT_CONTRACT_PROMPT`,
    the code-fixed "emit exactly this JSON" instruction co-located with the schema so prompt
    and parser can't drift).
  - ⚠️ Internal imports here are **extensionless** (`./enums`, not `./enums.js`) so
    drizzle-kit can load the schema. Keep it that way.
- **`packages/control-plane`** — Fastify API on `:8080`.
  - `config.ts` (Zod-validated env; `githubConfigured` gate), `db/schema.ts` (Drizzle;
    enums from shared), `db/client.ts`, `db/migrate.ts` (`runMigrations`, auto-run on boot
    unless `AUTO_MIGRATE=false`).
  - `queue.ts` — **the heart**: `enqueueReview`, `leaseNextJob` (SKIP LOCKED + runner
    affinity), `persistResult` (txn), `recordError`, `sweepExpiredLeases`,
    `autoReviewBlockedReason` (spend guard).
  - `github/app.ts` (`mintRepoToken` 1h/single-repo, `postReview` — renders the agent's
    structured output AS the filled-in PR Review template via `renderTemplateBody`
    (verdict, findings bucketed 🔴/🟡/🟢, concerns, suggested fixes, control-plane-stamped
    `Reviewed by: <model>`); still posts inline per-finding comments w/ summary fallback),
    `github/sync.ts` (mirror installs/repos).
  - `review-prompt.ts` — assembles the reviewer instruction (persona + template-adherence
    rules + the active `pr_review` template + prior findings + the fixed JSON contract) from
    DB-backed editable pieces. Pure `assembleReviewInstruction` shared by the lease handler
    and the `/api/prompts/preview` route, so preview == what runs.
  - `seed-data.ts` (template + prompt defaults, embedded as constants — the source files
    live in sibling repos not in the image) + `seed.ts` (`seedDefaults`, insert-if-absent
    on boot so dashboard edits aren't clobbered).
  - `review-service.ts` — `triggerReviewForPr`, the ONE entry point for auto / manual /
    command triggers (draft-skip + spend cap apply to `auto` only).
  - `webhook.ts` (HMAC via `crypto.timingSafeEqual`; routes pull_request, issue_comment,
    installation*), `auth.ts` (GitHub App user-OAuth login, single-login allowlist,
    signed cookie, non-prod `/auth/dev-login`), `routes/*` (repos, runners, jobs, usage,
    `templates`, `prompts`), `server.ts`, `index.ts`.
- **`packages/runner`** — the daemon. `main.ts` (enroll → poll → handle job),
  `client.ts`, `checkout.ts` (git fetch via `http.extraheader` so the token stays out of
  URLs/logs), `exec-claude.ts` (runs `leaseJob.reviewInstruction` assembled by the control
  plane — local `buildInstruction` is now only a fallback for an old control plane; spawns
  `claude -p`, parses the JSON wrapper + the agent's `ReviewOutput`, captures the resolved
  model from the wrapper, refuses if `ANTHROPIC_API_KEY` is set). Runner `capabilities.version`
  is `0.2.0` (template-aware); see the version-gating gotcha below.
- **`packages/dashboard`** — Vite + React SPA, styled as a terminal UI with
  **[WebTUI](https://webtui.ironclad.sh)** (`@webtui/css` + 5 theme plugins). `api.ts`
  (typed client, `credentials: include`), `App.tsx` (left sidebar + Repos / Review Templates /
  System Prompts / Pull Requests / Runners / Activity / Usage panels — the Templates and
  Prompts panels are edit-on-blur over `/api/templates` + `/api/prompts`, mirroring `RepoRow`),
  `ui.tsx` (`Panel`/`Badge`/`JobBadge` helpers),
  `theme.ts` + `ThemeSwitcher.tsx` (live theme switch, persisted to `localStorage`),
  `webtui.d.ts` (types WebTUI's `is-`/`box-`/`variant-`/`cap-`/`size-` attributes for JSX).
  - WebTUI is **attribute-styled** (`is-="badge"`, `box-="round"`, …) and **layer-based**:
    `styles.css` starts with `@layer base, utils, components, app;` (MUST be line 1) and puts
    all custom CSS in the trailing `@layer app` so it wins without `!important`.
  - ⚠️ **Accent color names differ per theme** (Catppuccin `--mauve`, Nord `--nord*`, Gruvbox
    `--gb-*`). Don't hardcode them — use the semantic `--acc-*` tokens (remapped per theme in
    `styles.css`) for badge/button colors. Badge `variant-` only supports `foreground*`/
    `background*`; colored badges set `--badge-color` via the `.b-*` classes.
  - Theme is applied to `<html data-webtui-theme>` pre-paint by an inline script in
    `index.html` (key/default mirror `theme.ts` — keep in sync).

## Data model (Postgres, `db/schema.ts`)

`users` (single-login allowlist), `installations`, `repos` (`autoReviewEnabled` = the
per-repo toggle, default false; `provider`, `model`, `dailyCostCapUsd`), `runners`
(`tokenHash`, capabilities), **`jobs`** (the queue: `state`, `leaseId`, `leasedByRunner`,
`leaseExpiresAt`, `round`, `preferredRunnerId`, `claudeSessionId`), `reviews` (now also
`concerns`/`suggestedFixes` jsonb — the template sections beyond findings), `findings`
(`prevFindingId` links the same issue across rounds), `usage_events` (append-only;
`model` is now the resolved model the runner reported; analytics + spend cap are
SUM/GROUP-BY over this), `templates` (review/contribution templates; one `pr_review` row
`isActive` = the enforced rubric, guarded by a partial unique index; global, not per-repo),
`agent_prompts` (editable reviewer system-prompt pieces, keyed by `key`; `editable=false`
rows are read-only).

## Job lifecycle

1. Trigger (`webhook` auto / `/review` comment / dashboard button) → `triggerReviewForPr`
   → `enqueueReview` inserts a `queued` job (superseding any active job for that PR).
   Re-reviews set `round = max+1`, `preferredRunnerId` + `claudeSessionId` from the last job.
2. Runner short-polls `/api/runners/lease` (returns immediately; sleeps `POLL_INTERVAL_MS`
   and retries when empty) → `leaseNextJob` atomically claims a job (`leased`,
   `leaseExpiresAt`). Affinity: jobs preferred for this runner first.
3. Control plane assembles a `LeaseJob`: mints a 1h single-repo token, attaches prior
   findings (round > 1), `resumeSessionId`, and `reviewInstruction` (the template-enforced
   prompt from `assembleReviewInstruction`).
4. Runner checks out the PR diff, runs `claude -p` with `reviewInstruction`, POSTs
   `JobResult` (idempotent on `leaseId`) incl. `concerns`/`suggestedFixes`/`modelUsed`.
   `persistResult` writes review+findings+usage and flips job to `succeeded`.
5. Control plane posts the review to GitHub (it holds the App key), rendered as the filled
   template, and stores the review id.
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
pnpm test                  # full Vitest suite (all 4 projects); pglite — no Docker needed
pnpm test:watch            # Vitest watch mode
pnpm test:cov              # with V8 coverage
npx vitest run --project control-plane queue   # filter: one project + path substring
pnpm db:up                 # Postgres in Docker
pnpm db:generate           # regenerate drizzle/*.sql after editing db/schema.ts
pnpm db:migrate            # apply migrations manually (also auto-runs on control-plane boot)
pnpm dev:cp | dev:dash | dev:runner
pnpm preview:web           # local prod-preview: build dashboard + control plane serves it
                           # on :8080 same-origin (like Cloud Run), to debug before pushing.
                           # scripts/preview-web.mjs; also VS Code "Debug Web (local prod-preview)".
```

After editing `db/schema.ts`, **always** `pnpm db:generate` and commit the new
`packages/control-plane/drizzle/*.sql`.

## Testing (MANDATORY — hard requirement)

**Every new feature or behavior change MUST ship with comprehensive tests in the same
change.** This is non-negotiable, not a follow-up. A PR that adds/changes behavior without
tests is incomplete. Concretely:

- New API route → route test (`app.inject`) covering the auth guard, the happy path,
  input-validation 400, and the error/404 paths.
- New/changed queue or persistence logic → a DB-backed integration test (state transitions,
  idempotency, transactionality, boundaries).
- New Zod contract / enum → round-trip parse + rejection of invalid input in
  `packages/shared/test`.
- New runner behavior → unit test; anything touching the `ANTHROPIC_API_KEY` refusal must
  keep that negative test passing.
- Bug fix → a regression test that fails before the fix and passes after.
- Run `pnpm test` (and `pnpm -r typecheck`) green before committing.

**Stack:** Vitest, one project per package (root `vitest.config.ts`, `test.projects`). Node env
for shared/control-plane/runner; jsdom + React Testing Library for dashboard. Tests live in
each package's `test/`.

- **DB tests run on pglite by default** (in-memory Postgres — no Docker), applying the SAME
  committed migrations the app ships. Each test file gets its own isolated instance, so files
  truncate freely in parallel. Harness: `packages/control-plane/test/harness/`
  (`db.ts`, `setup-db.ts`, `factories.ts`, `http.ts`). The `db/client.js` singleton is swapped
  via `vi.mock` + a hoisted holder + `installDbLifecycle(holder)`; GitHub (`github/app.js`) is
  mocked so no Octokit/network.
- **The SKIP LOCKED concurrency suite needs a real Postgres** (pglite is single-connection).
  It is opt-in **per file** via `createTestDb({ forceRealPg: true })` and gated on
  `TEST_DATABASE_URL`; it auto-skips otherwise. Do NOT make other DB suites depend on real PG —
  `forceRealPg` is the only switch (a shared real DB can't be truncated safely across parallel
  files). To run it: `pnpm db:up`, create `agentpr_test`, then
  `TEST_DATABASE_URL=postgres://agentpr:agentpr@localhost:5432/agentpr_test pnpm test`.
- **Testability via additive exports:** prefer adding an `export` (e.g. `renderTemplateBody`,
  the `exec-claude.ts` pure helpers, `handleJob`) over restructuring. `runner/main.ts` only
  starts its poll loop when it is the process entrypoint (`isEntrypoint()` guard), so the module
  is import-safe in tests — keep that guard.

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
- **Template enforcement is runner-version-gated.** The control plane sends the assembled
  `reviewInstruction`, but an older runner (Zod strips the unknown field) silently falls back
  to its local freestyle `buildInstruction` — no crash, but the template isn't enforced. The
  runner must be on `capabilities.version` `0.2.0`+ (check the Runners tab). New `JobResult`
  fields (`concerns`/`suggestedFixes`/`modelUsed`) are all **optional** for the same reason:
  a required field would 400 an un-upgraded runner's result and lose the review.
- **The `Reviewed by: <model>` name comes from the runner, not `repo.model`.** `exec-claude.ts`
  reads the resolved model from the `claude -p` JSON wrapper (`wrapper.model` → `wrapper.modelUsage`).
  ⚠️ That key is **unverified** against a live envelope — if absent, `modelUsed` is null and the
  control plane stamps `repo.model ?? "unknown model"`. Confirm the key before relying on it.
- **Don't make the JSON output contract user-editable.** `REVIEW_OUTPUT_CONTRACT_PROMPT` lives in
  `shared` and is always appended by the assembler; the `/api/prompts` route exposes it read-only
  (`editable=false`) so a dashboard edit can't break result parsing.
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
- **Changing the review prompt/template:** edit the `agent_prompts` rows / active `templates`
  row (dashboard or DB) — do NOT hardcode prompt text in the runner. Assembly lives in
  `review-prompt.ts`; the JSON contract stays in `shared`. Add new seed defaults to
  `seed-data.ts` (insert-if-absent, so existing rows aren't overwritten).
- **OpenCode provider (Phase 6):** add `exec-opencode.ts` mirroring `exec-claude.ts`
  (`opencode run --model <provider/model> --output-format json` or `opencode serve`),
  branch on `job.provider` in `runner/main.ts`. Keep the same `JobResult` contract.
- **Re-review resolved/regressed (Phase 3):** enrich `persistResult` to diff against the
  prior round's findings and set `findings.status` + `prevFindingId`.

## Verification

Local: `pnpm test` (full Vitest suite — pglite, no Docker) **and**
`pnpm -r typecheck && pnpm -r build`. For the SKIP LOCKED concurrency suite, additionally run
with a real Postgres (see Testing above). Then `pnpm db:up`, boot the control plane, and the
smoke checks (enroll runner, dev-login, list endpoints). End-to-end (needs the GitHub App + a
real PR, consumes quota): see `deploy/gcp/SETUP.md` §7. The negative check that matters: a
runner with `ANTHROPIC_API_KEY` set must REFUSE to run (pinned by
`packages/runner/test/exec-claude.guard.test.ts`).

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

## Deployment status (LIVE — first deployed 2026-06-22)

The control plane is deployed and serving. **Don't re-run the one-time SETUP.md steps** — they're done; `git push main` redeploys (env/secrets persist).

- **GCP project:** `agentpr-cp-ff3097` (project number `792029157879`) — a **dedicated** project. ⚠️ NOT `vu-ccc-ca-pmq9` (that's the unrelated CCC stack — do not touch it).
- **Region:** `us-central1`. **Service:** `control-plane`. **URL:** `https://control-plane-792029157879.us-central1.run.app` (stable across redeploys; it's also `PUBLIC_URL`).
- **Cloud Run shape:** `--min-instances 0 --max-instances 2 --cpu 1 --memory 512Mi --timeout 300 --allow-unauthenticated`, default CPU throttling (scale-to-zero, ~$0).
- **Runtime SA:** `cp-runtime@agentpr-cp-ff3097.iam.gserviceaccount.com` (least-privilege; `secretAccessor` granted per-secret — NOT the broad compute default SA). Preserved across redeploys.
- **Secrets (Secret Manager, names only):** `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_SECRET`, `SESSION_SECRET`, `RUNNER_ENROLLMENT_SECRET`, `DATABASE_URL`, `INTERNAL_API_TOKEN`. (Out-of-band backups still recommended — see SETUP §"Cost / free-tier notes".)
- **Env vars set on the service:** `NODE_ENV=production`, `AUTO_MIGRATE=true`, `ENABLE_INPROCESS_SWEEP=false`, `PUBLIC_URL=<run url>`, `GITHUB_APP_ID=4119526`, `GITHUB_APP_SLUG=ci-cd-agent-managment`, `GITHUB_APP_CLIENT_ID=Iv23liM3o6H7u2H6aJbR`, `ALLOWED_GITHUB_LOGIN=PMQ9`.
- **DB:** Neon, **pooled** endpoint (`...-pooler...`), `DATABASE_SSL=auto` (verified SSL for the remote host). Migrations already applied.
- **Sweep:** Cloud Scheduler job `sweep-leases` (us-central1), `* * * * *`, `POST /internal/sweep` with `Authorization: Bearer <INTERNAL_API_TOKEN>` (literal token, NOT Google OIDC — the route compares the raw token). Verified 200 with bearer / 401 without.
- **GitHub App:** id `4119526`, slug `ci-cd-agent-managment`, installed on account `PMQ9` (all repos). Callback `…/auth/callback` + webhook `…/webhook`.
- **CI:** `.github/workflows/deploy.yml` on push to `main`. Repo var `PROJECT_ID` + secret `GCP_SA_KEY` (`gh-deployer@…` key) are set on `PMQ9/ci-cd-agent-management`.
- **Pending (operator/runner-side):** connect a runner on the machine where Claude is logged in (`deploy/runner/SETUP.md`, `CONTROL_PLANE_URL=<run url>`, enrollment secret = the `RUNNER_ENROLLMENT_SECRET` value). Until a runner is online, jobs queue but nothing executes.
