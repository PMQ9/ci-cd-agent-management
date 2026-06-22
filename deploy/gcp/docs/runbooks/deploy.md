# Runbook: deploy / update the control plane (GCP)

**Owner:** you (solo) · **Last reviewed:** 2026-06-22

## When to use
Shipping new control-plane code to the GCP VM, or recovering after a VM reboot.

## Procedure
1. SSH to the VM: `cd ~/agentpr && git pull`
2. Rebuild + restart (migrations run automatically against Neon on boot):
   ```bash
   docker compose -f deploy/gcp/docker-compose.gcp.yml up -d --build
   docker compose -f deploy/gcp/docker-compose.gcp.yml logs -f control-plane
   curl -s https://<your-host>/health      # {"ok":true}
   ```
3. Verify the dashboard loads over HTTPS and your runner still shows **online**
   (the runner reconnects on its own; no redeploy needed unless runner code changed).

## If a step fails
- **control-plane crash-loops:** `docker compose -f deploy/gcp/docker-compose.gcp.yml logs
  control-plane` — usually a bad env var (Zod prints which) or Neon unreachable
  (check `DATABASE_URL` is the **pooled** string; try `DATABASE_SSL=no-verify` if TLS errors).
- **No HTTPS / cert error:** `docker compose ... logs caddy` — confirm the DuckDNS A record
  points at the VM's static IP and ports 80/443 are open in the GCP firewall.
- **Webhooks not arriving:** GitHub App → Advanced → Recent Deliveries shows the response;
  confirm the Webhook URL is `https://<your-host>/webhook`.

## Recovery
Roll back to the previous image: `git checkout <prev-sha> && docker compose -f
deploy/gcp/docker-compose.gcp.yml up -d --build`. Migrations are additive
(expand/contract), so a code rollback is safe against the current Neon schema.
