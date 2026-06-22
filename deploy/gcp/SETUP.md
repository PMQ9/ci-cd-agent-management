# Deploying the control plane on GCP Cloud Run (~$0)

The **control plane** (API + GitHub App + webhook + dashboard) runs on **GCP Cloud Run
with `--min-instances 0` (scale-to-zero)**: a public HTTPS `*.run.app` URL with managed
TLS, **no external IP, no Caddy, no domain** — so it stays within the free tier at ~$0.
Postgres is **Neon** free tier (external). Your own machine runs the **runner** and points
at the `*.run.app` URL — see [../runner/SETUP.md](../runner/SETUP.md).

```
GitHub ──webhook──▶ Cloud Run: control-plane (scale-to-zero, *.run.app HTTPS) ──▶ Neon (Postgres)
   runner (your box) ──short-poll /api/runners/lease (sleep+retry)──▶ Cloud Run
   Cloud Scheduler ──POST /internal/sweep (every minute)──▶ Cloud Run   (requeue dead leases)
   git push main ──▶ .github/workflows/deploy.yml: gcloud run deploy --source (Cloud Build builds + ships)
```

> Why Cloud Run and not an e2-micro VM? A standard GCP VM's in-use external IPv4 bills
> **~$3.65/mo** (Always-Free includes no free IP). Cloud Run removes the IP entirely. The
> VM path still works and is kept as an **[Appendix](#appendix-vm-fallback-e2-micro--caddy)**.

## Prerequisites

- `gcloud` CLI installed + `gcloud auth login`.
- `gh` CLI installed + authenticated (to set the repo secret/variable).
- A GCP project with **billing linked** (required even for the free tier). Recommend a
  dedicated project; free tiers (Cloud Run, Cloud Build, Scheduler) are per-billing-account.

Throughout, set:
```bash
export PROJECT_ID="<your-project-id>"
export REGION="us-central1"
export DEPLOY_SA="gh-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud config set project "$PROJECT_ID"
```

## 1. Database (Neon free tier)

- Create a project at **neon.tech**, a database named `agentpr`.
- Copy the **pooled** connection string (host contains `-pooler`) → you'll store it as the
  `DATABASE_URL` secret in §4. (Pooled matters: Cloud Run may run multiple instances.)

## 2. GitHub App

GitHub → Settings → Developer settings → **GitHub Apps → New**. Set the **Callback URL** and
**Webhook URL** to placeholders for now — you'll point them at the real `*.run.app` URL in §6.
- **Webhook secret:** `openssl rand -hex 32`
- **Request user authorization (OAuth) during installation:** ✅ (dashboard login)
- **Repo permissions:** Pull requests R/W, Contents R, Checks R/W, Metadata R, Issues R/W
- **Events:** Pull request, Issue comment, Installation, Installation repositories
- Generate a private key (download the `.pem`); note App ID, slug, Client ID, Client secret.
  **Install** it on your repos.

## 3. GCP one-time setup (APIs + deploy service account)

```bash
# Enable the APIs the pipeline uses.
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com

# Service account GitHub Actions deploys as.
gcloud iam service-accounts create gh-deployer --display-name "GitHub Actions deployer"

# Roles: deploy to Cloud Run, act as the runtime SA, run Cloud Build, stage the
# source upload, and push the built image to Artifact Registry.
for ROLE in roles/run.admin roles/iam.serviceAccountUser \
            roles/cloudbuild.builds.editor roles/storage.admin \
            roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOY_SA}" --role="$ROLE" >/dev/null
done

# Key for GitHub Actions → store as a repo secret, then delete the local copy.
gcloud iam service-accounts keys create ./gh-deployer-key.json --iam-account "$DEPLOY_SA"
gh variable set PROJECT_ID --body "$PROJECT_ID"
gh secret   set GCP_SA_KEY --body "$(cat ./gh-deployer-key.json)"
rm -f ./gh-deployer-key.json
```

> The SA JSON key is a long-lived credential. It matches the sibling project's pattern.
> A future hardening is Workload Identity Federation (keyless) — out of scope here.

## 4. Secrets (Secret Manager)

Create one secret per sensitive value, then grant the **Cloud Run runtime SA** read access.
Generate any missing tokens with `openssl rand -hex 32`.

```bash
printf '%s' "$GITHUB_APP_CLIENT_SECRET" | gcloud secrets create GITHUB_APP_CLIENT_SECRET --data-file=-
printf '%s' "$GITHUB_WEBHOOK_SECRET"    | gcloud secrets create GITHUB_WEBHOOK_SECRET    --data-file=-
printf '%s' "$SESSION_SECRET"           | gcloud secrets create SESSION_SECRET           --data-file=-
printf '%s' "$RUNNER_ENROLLMENT_SECRET" | gcloud secrets create RUNNER_ENROLLMENT_SECRET --data-file=-
printf '%s' "$DATABASE_URL"             | gcloud secrets create DATABASE_URL             --data-file=-
printf '%s' "$INTERNAL_API_TOKEN"       | gcloud secrets create INTERNAL_API_TOKEN       --data-file=-
# The PEM is multiline — load it from the downloaded file (config reads real newlines):
gcloud secrets create GITHUB_APP_PRIVATE_KEY --data-file=./your-app.private-key.pem

# Grant the runtime SA (Compute default SA) secretAccessor on each secret.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for S in GITHUB_APP_CLIENT_SECRET GITHUB_WEBHOOK_SECRET SESSION_SECRET \
         RUNNER_ENROLLMENT_SECRET DATABASE_URL INTERNAL_API_TOKEN GITHUB_APP_PRIVATE_KEY; do
  gcloud secrets add-iam-policy-binding "$S" \
    --member="serviceAccount:${RUNTIME_SA}" --role="roles/secretmanager.secretAccessor" >/dev/null
done
```

## 5. First deploy (sets all config once)

Run from the repo root. This sets the service shape + every env var + secret. `PUBLIC_URL`
is a placeholder fixed in §6. **Cloud Run preserves this config on later redeploys**, so the
CI workflow (§8) never has to pass it again.

```bash
gcloud run deploy control-plane --source . --region "$REGION" \
  --min-instances 0 --max-instances 2 --cpu 1 --memory 512Mi --timeout 300 \
  --allow-unauthenticated \
  --set-env-vars "NODE_ENV=production,AUTO_MIGRATE=true,ENABLE_INPROCESS_SWEEP=false,PUBLIC_URL=https://PLACEHOLDER,GITHUB_APP_ID=${GITHUB_APP_ID},GITHUB_APP_SLUG=${GITHUB_APP_SLUG},GITHUB_APP_CLIENT_ID=${GITHUB_APP_CLIENT_ID},ALLOWED_GITHUB_LOGIN=${ALLOWED_GITHUB_LOGIN}" \
  --set-secrets "GITHUB_APP_PRIVATE_KEY=GITHUB_APP_PRIVATE_KEY:latest,GITHUB_WEBHOOK_SECRET=GITHUB_WEBHOOK_SECRET:latest,GITHUB_APP_CLIENT_SECRET=GITHUB_APP_CLIENT_SECRET:latest,SESSION_SECRET=SESSION_SECRET:latest,RUNNER_ENROLLMENT_SECRET=RUNNER_ENROLLMENT_SECRET:latest,DATABASE_URL=DATABASE_URL:latest,INTERNAL_API_TOKEN=INTERNAL_API_TOKEN:latest"
```

Flag notes:
- `--allow-unauthenticated` — required (webhooks, OAuth callback, dashboard hit it anonymously
  at the HTTP layer; the app does its own HMAC / cookie / bearer auth).
- `--min-instances 0` + default CPU throttling — what makes it ~$0. **Do not** use
  `--no-cpu-throttling` (always-allocated CPU breaks scale-to-zero billing).
- `ENABLE_INPROCESS_SWEEP=false` — the in-process timer can't fire when the instance is
  scaled to zero; Cloud Scheduler (§7) drives the sweep instead.
- The build runs on Cloud Build (no e2-micro OOM); first build creates a
  `cloud-run-source-deploy` Artifact Registry repo automatically.

## 6. Point PUBLIC_URL + the GitHub App at the live URL

```bash
RUN_URL="$(gcloud run services describe control-plane --region "$REGION" \
  --format 'value(status.url)')"
echo "$RUN_URL"   # e.g. https://control-plane-abc123-uc.a.run.app
```
- In the GitHub App settings, set **Callback URL** = `${RUN_URL}/auth/callback` and
  **Webhook URL** = `${RUN_URL}/webhook`.
- Update the service's `PUBLIC_URL` (preserves all other config):
  ```bash
  gcloud run services update control-plane --region "$REGION" \
    --update-env-vars "PUBLIC_URL=${RUN_URL}"
  ```
The `*.run.app` URL is stable across redeploys, so this is one-time. Verify:
`curl -s "$RUN_URL/health"` → `{"ok":true}`.

## 7. Cloud Scheduler sweep (replaces the in-process timer)

```bash
# If the project has no Scheduler location yet, create one first:
#   gcloud app create --region=us-central
gcloud scheduler jobs create http sweep-leases --location "$REGION" \
  --schedule "* * * * *" \
  --uri "${RUN_URL}/internal/sweep" \
  --http-method POST \
  --headers "Authorization=Bearer ${INTERNAL_API_TOKEN}" \
  --attempt-deadline 30s --time-zone "Etc/UTC"
```
Every-minute cadence is plenty against the 900s (`LEASE_TTL_SECONDS`) lease. Free tier covers
it (3 jobs/mo; this is 1). The endpoint is idempotent.

## 8. Continuous deploy

`.github/workflows/deploy.yml` runs `gcloud run deploy control-plane --source .` on every push
to `main` (and via **Run workflow**). It rebuilds + ships the image only — env/secrets persist
from §5. Push to `main` and watch the Actions tab.

## 9. Connect your runner

Follow [../runner/SETUP.md](../runner/SETUP.md) on your machine, with
`CONTROL_PLANE_URL=${RUN_URL}` and `RUNNER_ENROLLMENT_SECRET_CLIENT` equal to the value you put
in the `RUNNER_ENROLLMENT_SECRET` secret. It should appear **online** on the Runners tab. The
runner short-polls every ~25s (`POLL_INTERVAL_MS`); enqueue→pickup latency is up to that.

## 10. Smoke test

Open `${RUN_URL}` → **Sign in with GitHub** → your installed repos appear (Sync if not).
Open a non-draft PR on a connected repo → click **Review** (or comment `/review`). A Claude
review should post within ~a minute or two; Activity shows the job `succeeded` with a cost.
Confirm in the Claude Console the spend hit your **subscription**, not the API.

## Cost / free-tier notes

- **~$0:** scale-to-zero between polls + within Cloud Run free tier (2M req, 360k GiB-s,
  180k vCPU-s/mo) + **no external IP**. Cloud Build 120 build-min/day free. Scheduler 3 jobs free.
- **Artifact Registry** free tier is 0.5 GB; each image is a few hundred MB, so prune old
  versions (or set a cleanup policy on `cloud-run-source-deploy`) to stay free.
- **Neon** autosuspends when idle; the minutely sweep keeps it warm-ish. Use the **pooled** URL.
- **Backups:** Neon manages DB durability. Keep out-of-band copies of the GitHub App private
  key, webhook secret, `SESSION_SECRET`, `RUNNER_ENROLLMENT_SECRET`, `INTERNAL_API_TOKEN`.
- See `docs/runbooks/` for deploy/rollback procedures.

---

# Appendix: VM fallback (e2-micro + Caddy)

The original VM design still works if you ever want it. Tradeoff: the in-use external IPv4
bills **~$3.65/mo**. It runs the same image (`./Dockerfile`) via `deploy/gcp/docker-compose.gcp.yml`
+ `deploy/gcp/Caddyfile`, with the in-process sweep timer enabled (leave `ENABLE_INPROCESS_SWEEP`
unset/`true`, and the runner can keep long-poll-style cadence).

1. **Create the VM:** Compute Engine → `e2-micro`, Always-Free region (us-west1/central1/east1),
   Ubuntu 24.04, allow HTTP+HTTPS, reserve + attach a static external IP. Install Docker:
   `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER && newgrp docker`.
2. **Hostname:** a free **duckdns.org** subdomain → the VM's static IP; put it in
   `deploy/gcp/Caddyfile` with a real email.
3. **DB + GitHub App:** as in §1–§2, but the callback/webhook URLs use `https://<your-host>`.
4. **Deploy:**
   ```bash
   git clone <this-repo> ~/agentpr && cd ~/agentpr
   cp deploy/gcp/control-plane.env.example .env   # fill PUBLIC_URL, DATABASE_URL, GITHUB_*, etc.
   docker compose -f deploy/gcp/docker-compose.gcp.yml up -d --build   # auto-migrates Neon on boot
   curl -s https://<your-host>/health             # {"ok":true} (TLS issued by Caddy)
   ```
   > ⚠️ The 1 GB e2-micro **OOMs during `--build`** (the build needs ~1 GB; no swap by default).
   > Either add a **≥2 GB swapfile** before building, or build the image elsewhere and `docker
   > compose pull`. The Cloud Run path above sidesteps this entirely (Cloud Build does the build).
5. **Runner + smoke test:** as in §9–§10, with `CONTROL_PLANE_URL=https://<your-host>`.
