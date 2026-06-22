# Deploying the control plane on GCP (Always Free)

The **control plane** (API + GitHub App + webhook + dashboard) runs on a GCP
**e2-micro Always-Free** VM, fronted by **Caddy** for automatic HTTPS. Postgres is
**Neon** free tier (the 1 GB VM can't also run a database). Your own machine runs the
**runner** and points at this VM's public URL — see [../runner/SETUP.md](../runner/SETUP.md).

```
GitHub ──webhook──▶ GCP VM (Caddy → control-plane container) ──Neon (Postgres)
                         ▲ long-poll (outbound 443)
                         │
                    your box: the runner (Claude logged in)
```

## 1. Create the VM

GCP Console → Compute Engine → Create instance:
- **Machine:** `e2-micro`, region **us-west1 / us-central1 / us-east1** (Always-Free eligible)
- **Boot disk:** Ubuntu 24.04, ≤30 GB standard
- **Firewall:** allow **HTTP** and **HTTPS**
- Reserve a **static external IP** and attach it (so your hostname stays valid across reboots)

SSH in, then install Docker:
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
```

## 2. Public hostname (free)

Let's Encrypt won't issue for a bare IP, so get a hostname:
- Create a free subdomain at **duckdns.org** and point it at the VM's static IP.
- Put that hostname in `deploy/gcp/Caddyfile` (replace `your-host.duckdns.org`) and set
  a real email there.

## 3. Database (Neon free tier)

- Create a project at **neon.tech**, a database named `agentpr`.
- Copy the **pooled** connection string (host contains `-pooler`) → `DATABASE_URL`.

## 4. GitHub App

GitHub → Settings → Developer settings → **GitHub Apps → New**:
- **Callback URL:** `https://<your-host>/auth/callback` · **Webhook URL:** `https://<your-host>/webhook`
- **Webhook secret:** `openssl rand -hex 32`
- **Request user authorization (OAuth) during installation:** ✅ (dashboard login)
- **Repo permissions:** Pull requests R/W, Contents R, Checks R/W, Metadata R, Issues R/W
- **Events:** Pull request, Issue comment, Installation, Installation repositories
- Generate a private key; note App ID, slug, Client ID, Client secret. **Install** it on your repos.

## 5. Deploy

```bash
git clone <this-repo> ~/agentpr && cd ~/agentpr
cp deploy/gcp/control-plane.env.example .env
# Fill PUBLIC_URL (https://<your-host>), DATABASE_URL (Neon pooled), all GITHUB_*,
# ALLOWED_GITHUB_LOGIN, SESSION_SECRET, RUNNER_ENROLLMENT_SECRET.

docker compose -f deploy/gcp/docker-compose.gcp.yml up -d --build   # auto-migrates Neon on boot
docker compose -f deploy/gcp/docker-compose.gcp.yml logs -f
curl -s https://<your-host>/health        # {"ok":true}  (TLS issued by Caddy)
```

Open `https://<your-host>` → **Sign in with GitHub** → your installed repos appear
(click Sync if not). Reviews are **manual by default**; flip the per-repo toggle for auto.

## 6. Connect your runner

Follow [../runner/SETUP.md](../runner/SETUP.md) on your own machine, with
`CONTROL_PLANE_URL=https://<your-host>` and `RUNNER_ENROLLMENT_SECRET_CLIENT` equal to the
VM's `RUNNER_ENROLLMENT_SECRET`. It should appear **online** on the dashboard's Runners tab.

## 7. Smoke test

Open a non-draft PR on a connected repo → click **Review** (or comment `/review`). A
Claude review should post within a minute or two; Activity shows the job `succeeded` with a
cost. Confirm in the Claude Console that the spend hit your **subscription**, not the API.

## Notes
- **Backups:** Neon manages DB durability/backups. Keep out-of-band copies of the GitHub
  App private key, webhook secret, and `SESSION_SECRET` / `RUNNER_ENROLLMENT_SECRET`.
- **Egress:** the Always-Free VM includes ~1 GB/month egress from North America; this
  workload (webhooks + small JSON) stays well under it.
- See `docs/runbooks/` for deploy/rollback procedures.
