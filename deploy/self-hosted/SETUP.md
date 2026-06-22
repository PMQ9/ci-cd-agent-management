# Deploying on your self-hosted host

Any always-on Linux host with Docker and Node 20+ hosts the **control plane + Postgres +
dashboard** in Docker Compose, and runs the **runner** as a systemd user service on the
host (where Claude is logged in). Public ingress is via **Tailscale Funnel** — no inbound
ports. Replace the example hostnames/paths below with your own.

## 1. Public URL (Tailscale Funnel)

```bash
# Install + log in (once)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Expose the control plane's port 8080 publicly over HTTPS
sudo tailscale funnel --bg 8080
tailscale funnel status     # note the https://your-host.tailXXXX.ts.net URL
```

Use that URL as `PUBLIC_URL` and for the GitHub App webhook + callback below.

## 2. Create the GitHub App

GitHub → Settings → Developer settings → **GitHub Apps → New GitHub App**:

- **Homepage / Callback URL:** `https://<your-funnel>.ts.net` and
  `https://<your-funnel>.ts.net/auth/callback`
- **Webhook URL:** `https://<your-funnel>.ts.net/webhook` · **Secret:** `openssl rand -hex 32`
- **Request user authorization (OAuth) during installation:** ✅ (enables dashboard login)
- **Repository permissions:** Pull requests **R/W**, Contents **R**, Checks **R/W**,
  Metadata **R**, Issues **R/W** (for the `/review` comment + labels)
- **Subscribe to events:** Pull request, Issue comment, Installation, Installation
  repositories
- Generate a **private key** (.pem). Note the **App ID**, **Client ID**, generate a
  **Client secret**, and the app **slug** (from the app URL).

Then **Install** the app on the repos you want (this is the connect/disconnect UX).

## 3. Configure + start the control plane

```bash
git clone <this-repo> ~/agentpr && cd ~/agentpr
cp deploy/self-hosted/control-plane.env.example .env
# Fill in PUBLIC_URL, all GITHUB_*, ALLOWED_GITHUB_LOGIN, SESSION_SECRET, RUNNER_ENROLLMENT_SECRET

docker compose --profile prod up -d --build      # postgres + control-plane (auto-migrates)
docker compose logs -f control-plane             # watch it boot
curl -s http://localhost:8080/health             # {"ok":true}
```

Open the Funnel URL → **Sign in with GitHub** → you should see your installed repos
(click "Sync" if not). Reviews are **manual by default**; flip the per-repo toggle to
enable auto-review.

## 4. Configure + start the runner (on the host)

Node 20+ must be installed on the host. Confirm Claude is logged in via subscription
(`~/.claude/.credentials.json` exists) and **`ANTHROPIC_API_KEY` is unset**.

```bash
cd ~/agentpr
pnpm install && pnpm --filter @agentpr/runner build

mkdir -p ~/.agentpr
cp deploy/self-hosted/runner.env.example ~/.agentpr/runner.env
# Set CLAUDE_BIN (abs path), RUNNER_ENROLLMENT_SECRET_CLIENT (= server's RUNNER_ENROLLMENT_SECRET)

cp deploy/self-hosted/agentpr-runner.service ~/.config/systemd/user/
# Edit ExecStart: set the absolute node path and the repo path
loginctl enable-linger $USER
systemctl --user daemon-reload
systemctl --user enable --now agentpr-runner
journalctl --user -u agentpr-runner -f         # "enrolled as …" then "polling …"
```

The runner should now show **online** on the dashboard's Runners tab.

## 5. Smoke test

Open a non-draft PR on a connected repo, then either click **Review** in the dashboard
or comment `/review` on the PR. Within a minute or two a Claude review comment should
appear, and the Activity tab should show the job `succeeded` with a `total_cost_usd`.
Confirm in the Claude Console that the spend hit your **subscription**, not the API.

## Backups (single box = single point of failure)

Keep out-of-band copies of: the GitHub App **private key**, the **webhook secret**, and
`SESSION_SECRET`/`RUNNER_ENROLLMENT_SECRET`. Postgres data lives in the `pgdata` Docker
volume — see `docs/runbooks/` for the dump/restore procedure.
