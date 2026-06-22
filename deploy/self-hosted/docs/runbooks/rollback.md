# Runbook: backup, restore, and rollback

**Owner:** you (solo) · **Last reviewed:** 2026-06-22

## Backup the database (run on a schedule, e.g. nightly cron)
```bash
docker compose exec -T postgres pg_dump -U agentpr agentpr | gzip > ~/agentpr-backups/agentpr-$(date +%F).sql.gz
```
An untested backup is a hope, not a backup — restore one into a throwaway DB occasionally.

## Restore
```bash
gunzip -c ~/agentpr-backups/agentpr-YYYY-MM-DD.sql.gz | docker compose exec -T postgres psql -U agentpr agentpr
```

## Roll back a bad deploy
1. `cd ~/agentpr && git checkout <previous-good-sha>`
2. `docker compose --profile prod up -d --build`
3. `curl -s http://localhost:8080/health`

Schema migrations are append-only (expand/contract): old code runs fine against a
newer schema, so a code-only rollback needs no DB change. Only if you applied a
**contract** migration (dropping a column) do you also need to restore the DB.

## Revoke a compromised runner
Dashboard → Runners → **revoke**, or:
`docker compose exec postgres psql -U agentpr agentpr -c "update runners set revoked_at = now() where name = 'my-runner';"`
Then rotate `RUNNER_ENROLLMENT_SECRET`, delete `~/.agentpr/runner.json`, and re-enroll.

## Rotate the GitHub App key / webhook secret
Generate new values in the GitHub App settings, update `.env`, then
`docker compose --profile prod up -d` to restart with the new secrets.
