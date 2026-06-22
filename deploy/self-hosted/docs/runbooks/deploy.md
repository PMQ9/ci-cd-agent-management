# Runbook: deploy / update the control plane

**Owner:** you (solo) · **Last reviewed:** 2026-06-22

## When to use
Shipping new code to your self-hosted host, or recovering after a reboot.

## Procedure
1. `cd ~/agentpr && git pull`
2. Rebuild + restart the control plane (migrations run automatically on boot):
   ```bash
   docker compose --profile prod up -d --build
   docker compose logs -f control-plane     # expect "[migrate] done" then "Server listening"
   curl -s http://localhost:8080/health     # {"ok":true}
   ```
3. Update the runner if it changed:
   ```bash
   pnpm install && pnpm --filter @agentpr/runner build
   systemctl --user restart agentpr-runner
   journalctl --user -u agentpr-runner -n 30
   ```
4. Verify the dashboard loads over the Funnel URL and the runner shows **online**.

## If a step fails
- **control-plane crash-loops:** `docker compose logs control-plane` — usually a bad env
  var (Zod prints which) or DB unreachable (`docker compose ps postgres`).
- **migration error:** the DB and code disagree. Do NOT force; see rollback.md.
- **runner won't start:** `journalctl --user -u agentpr-runner` — wrong `CLAUDE_BIN`/node
  path, or `ANTHROPIC_API_KEY` is set (the runner refuses — unset it).

## Recovery
Roll back to the previous image: `git checkout <prev-sha> && docker compose --profile prod up -d --build`. Migrations are additive (expand/contract); a code rollback is safe against the current schema as long as you didn't run a new contract migration.
