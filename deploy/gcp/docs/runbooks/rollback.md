# Runbook: backup, restore, rollback (GCP + Neon)

**Owner:** you (solo) · **Last reviewed:** 2026-06-22

## Database (Neon)
Neon manages durability and point-in-time restore on the free tier — use the Neon console
to branch/restore. For an extra logical backup:
```bash
pg_dump "$DATABASE_URL" | gzip > agentpr-$(date +%F).sql.gz       # run anywhere with psql
```
Restore: `gunzip -c <file>.sql.gz | psql "$DATABASE_URL"`.

## Roll back a bad control-plane deploy
1. On the VM: `cd ~/agentpr && git checkout <previous-good-sha>`
2. `docker compose -f deploy/gcp/docker-compose.gcp.yml up -d --build`
3. `curl -s https://<your-host>/health`

Schema migrations are append-only (expand/contract): old code runs fine against a newer
schema, so a code-only rollback needs no DB change. Only a **contract** migration (dropping
a column) would also require a DB restore.

## Revoke a compromised runner
Dashboard → Runners → **revoke** (or `update runners set revoked_at = now() where name =
'<name>';` against Neon). Then rotate `RUNNER_ENROLLMENT_SECRET` on the VM, delete
`~/.agentpr/runner.json` on the runner, and re-enroll.

## Rotate GitHub App key / webhook secret / session secret
Generate new values (GitHub App settings / `openssl rand -hex 32`), update `.env` on the
VM, then `docker compose -f deploy/gcp/docker-compose.gcp.yml up -d` to restart.

## Secrets to back up out-of-band
GitHub App **private key**, **webhook secret**, `SESSION_SECRET`, `RUNNER_ENROLLMENT_SECRET`,
and the Neon `DATABASE_URL`. (Single VM is a SPOF; these let you rebuild it in minutes.)
