# Running a runner (on your own machine)

The runner executes the actual review with `claude -p`, so it runs on a machine where
**Claude is logged in via your subscription** (OAuth). It connects **outbound** to the
control plane (the GCP deployment) — no inbound ports, works behind NAT. You can run a
runner on several machines; jobs route to whichever is free, and re-reviews prefer the
machine that did the original.

## Prerequisites
- Node 20+ installed.
- Claude Code logged in via your subscription: `~/.claude/.credentials.json` exists.
- **`ANTHROPIC_API_KEY` is unset** in this machine's environment (if set, `claude` bills
  the pay-per-token API — the runner detects this and refuses to run).

## Install
```bash
git clone <this-repo> ~/agentpr && cd ~/agentpr
pnpm install
pnpm --filter @agentpr/runner build

mkdir -p ~/.agentpr
cp deploy/runner/runner.env.example ~/.agentpr/runner.env
# Edit ~/.agentpr/runner.env:
#   CONTROL_PLANE_URL=https://<your-gcp-host>
#   RUNNER_ENROLLMENT_SECRET_CLIENT=<the control plane's RUNNER_ENROLLMENT_SECRET>
#   CLAUDE_BIN=<absolute path>   (zsh -lic 'command -v claude')
```

## Run as a systemd user service (Linux)
```bash
cp deploy/runner/agentpr-runner.service ~/.config/systemd/user/
# Edit ExecStart: set the absolute node path (zsh -lic 'command -v node') and the repo path
loginctl enable-linger $USER          # keep running without an active login
systemctl --user daemon-reload
systemctl --user enable --now agentpr-runner
journalctl --user -u agentpr-runner -f   # "enrolled as …" then "polling …"
```

Or run it directly to test first:
```bash
node packages/runner/dist/main.js        # reads ~/.agentpr/runner.env via the env file? no —
# the systemd unit loads the env file; for a manual run, export the vars or use a tool like
# `env $(grep -v '^#' ~/.agentpr/runner.env | xargs) node packages/runner/dist/main.js`
```

The runner should appear **online** on the dashboard's Runners tab. The durable token is
saved to `~/.agentpr/runner.json`; after first enrollment you can clear
`RUNNER_ENROLLMENT_SECRET_CLIENT`.

## macOS
There's no systemd; run it under `launchd`, `pm2`, or just in a terminal/`tmux` for now.
The daemon logic is identical.
