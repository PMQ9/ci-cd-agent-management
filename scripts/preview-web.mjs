#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Local prod-preview launcher — "deploy the website locally" before pushing.
//
// Reproduces how Cloud Run serves the app: the dashboard is built as a PRODUCTION
// bundle (vite build) and the control plane serves it statically, SAME-ORIGIN, on
// :8080 — exactly like the deployed Dockerfile (build dashboard → control plane
// serves DASHBOARD_DIST with SPA fallback). This catches what `vite dev` can't:
// the single-origin static serve, the SPA 404 fallback, minification, and the
// pre-paint theme script in index.html.
//
// Differences from prod (intentional, so it's usable offline):
//   • NODE_ENV stays "development" so POST /auth/dev-login works (prod requires the
//     real GitHub OAuth login, which you can't complete against localhost).
//   • GitHub App creds are optional — without them GitHub-gated features show as
//     "not configured", but the whole UI still renders and is debuggable.
//
// Usage:
//   node scripts/preview-web.mjs            # db + dashboard(watch) + control plane (tsx)
//   node scripts/preview-web.mjs --build    # compile the control plane too (node dist) — max fidelity
//   node scripts/preview-web.mjs --no-watch # one-shot dashboard build (no rebuild-on-save)
//   node scripts/preview-web.mjs --no-db    # don't touch Docker (bring your own DATABASE_URL)
//   node scripts/preview-web.mjs --no-open  # don't open a browser
//
// Honors PORT, DATABASE_URL, NODE_ENV, and any other control-plane env from the
// process / a repo-root .env.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// GUI launchers (VS Code's debugger, Finder) start with a minimal PATH that often
// lacks Homebrew (`pnpm`) and Docker. Prepend the standard bin dirs that exist so
// the children we spawn below resolve regardless of how this script was launched.
{
  const sep = process.platform === "win32" ? ";" : ":";
  const current = (process.env.PATH || "").split(sep);
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(
    (d) => existsSync(d) && !current.includes(d),
  );
  if (extra.length) process.env.PATH = [...extra, ...current].join(sep);
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const BUILD_CP = has("--build");
const NO_WATCH = has("--no-watch");
const NO_DB = has("--no-db");
const NO_OPEN = has("--no-open");

const PORT = process.env.PORT || "8080";
const SITE_URL = `http://localhost:${PORT}`;
const DEFAULT_DSN = "postgres://agentpr:agentpr@localhost:5432/agentpr";
const DASHBOARD_DIST = resolve(ROOT, "packages/dashboard/dist");

const children = [];
let shuttingDown = false;

const C = { dim: "2", cyan: "36", magenta: "35", green: "32", red: "31", yellow: "33" };
const paint = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const log = (scope, msg, color = C.dim) =>
  process.stdout.write(`${paint(color, `[${scope}]`)} ${msg}\n`);

/** Pipe a child's stdout/stderr to ours, prefixed + line-buffered. */
function pipePrefixed(child, scope, color) {
  const tag = `${paint(color, `[${scope}]`)} `;
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(tag + line + "\n");
    });
    stream.on("end", () => {
      if (buf) process.stdout.write(tag + buf + "\n");
    });
  }
}

function spawnTracked(cmd, cmdArgs, { scope, color, env, cwd } = {}) {
  const child = spawn(cmd, cmdArgs, { cwd: cwd ?? ROOT, env: env ?? process.env });
  children.push(child);
  if (scope) pipePrefixed(child, scope, color);
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("preview", "shutting down…", C.yellow);
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  // Give children a moment to exit cleanly, then hard-exit.
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ── 1. Postgres ──────────────────────────────────────────────────────────────
function ensurePostgres() {
  if (NO_DB) {
    log("db", "skipped (--no-db); using DATABASE_URL from your env", C.yellow);
    return;
  }
  const dsn = process.env.DATABASE_URL;
  const isLocal = !dsn || dsn.includes("localhost") || dsn.includes("127.0.0.1");
  if (!isLocal) {
    log("db", "DATABASE_URL points off-box — leaving Postgres to you");
    return;
  }
  const hasDocker = spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;
  if (!hasDocker) {
    log("db", "Docker isn't available. Start Postgres yourself (`pnpm db:up`) or", C.red);
    log("db", "run with --no-db after setting DATABASE_URL to a reachable instance.", C.red);
    process.exit(1);
  }
  log("db", "starting Postgres (docker compose up -d --wait postgres)…");
  const ok = spawnSync("docker", ["compose", "up", "-d", "--wait", "postgres"], {
    cwd: ROOT,
    stdio: "inherit",
  }).status === 0;
  if (!ok) {
    log("db", "failed to bring up Postgres", C.red);
    process.exit(1);
  }
  log("db", "Postgres ready", C.green);
}

// ── 2. Dashboard (production build) ──────────────────────────────────────────
async function buildDashboard() {
  if (NO_WATCH) {
    log("dashboard", "building production bundle (one-shot)…", C.cyan);
    const child = spawnTracked(
      "pnpm",
      ["--filter", "@agentpr/dashboard", "exec", "vite", "build"],
      { scope: "dashboard", color: C.cyan },
    );
    const code = await new Promise((r) => child.on("exit", r));
    if (code !== 0) {
      log("dashboard", `build failed (exit ${code})`, C.red);
      process.exit(1);
    }
    log("dashboard", "build ready", C.green);
    return;
  }

  log("dashboard", "building production bundle (watch: rebuilds on save)…", C.cyan);
  const child = spawnTracked(
    "pnpm",
    ["--filter", "@agentpr/dashboard", "exec", "vite", "build", "--watch"],
    { scope: "dashboard", color: C.cyan },
  );
  child.on("exit", (code) => {
    if (!shuttingDown) {
      log("dashboard", `watcher exited (${code}) — stopping`, C.red);
      shutdown(1);
    }
  });
  // Block until the first build has emitted index.html (or the watcher died).
  const indexHtml = resolve(DASHBOARD_DIST, "index.html");
  const deadline = Date.now() + 120_000;
  while (!existsSync(indexHtml)) {
    if (child.exitCode !== null) process.exit(child.exitCode ?? 1);
    if (Date.now() > deadline) {
      log("dashboard", "timed out waiting for the first build", C.red);
      shutdown(1);
      return;
    }
    await sleep(200);
  }
  log("dashboard", "initial build ready", C.green);
}

// ── 3. Control plane (serves the built dashboard same-origin) ─────────────────
function startControlPlane() {
  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || "development",
    PORT,
    DASHBOARD_DIST,
    DATABASE_URL: process.env.DATABASE_URL || DEFAULT_DSN,
    PUBLIC_URL: process.env.PUBLIC_URL || SITE_URL,
  };

  if (BUILD_CP) {
    log("control-plane", "compiling (tsup)…", C.magenta);
    const built = spawnSync("pnpm", ["--filter", "@agentpr/control-plane", "build"], {
      cwd: ROOT,
      stdio: "inherit",
    }).status === 0;
    if (!built) {
      log("control-plane", "build failed", C.red);
      shutdown(1);
      return;
    }
    log("control-plane", "booting compiled bundle (node dist)…", C.magenta);
    const child = spawnTracked("node", ["dist/index.js"], {
      scope: "control-plane",
      color: C.magenta,
      env,
      cwd: resolve(ROOT, "packages/control-plane"),
    });
    child.on("exit", (code) => {
      if (!shuttingDown) {
        log("control-plane", `exited (${code})`, C.red);
        shutdown(code ?? 1);
      }
    });
    return child;
  }

  log("control-plane", "booting via tsx (hot-reload on save)…", C.magenta);
  const child = spawnTracked("pnpm", ["--filter", "@agentpr/control-plane", "dev"], {
    scope: "control-plane",
    color: C.magenta,
    env,
  });
  child.on("exit", (code) => {
    if (!shuttingDown) {
      log("control-plane", `exited (${code})`, C.red);
      shutdown(code ?? 1);
    }
  });
  return child;
}

// ── 4. Readiness + open browser ──────────────────────────────────────────────
function probeHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${SITE_URL}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForReady() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    if (await probeHealth()) return true;
    await sleep(400);
  }
  return false;
}

function openBrowser() {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [SITE_URL], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    }).unref();
  } catch {
    /* opening is best-effort */
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  log("preview", `local prod-preview → ${SITE_URL}`, C.green);
  ensurePostgres();
  await buildDashboard();
  startControlPlane();

  const ready = await waitForReady();
  if (ready) {
    log("preview", `site is up → ${SITE_URL}`, C.green);
    if (!NO_OPEN) openBrowser();
  } else if (!shuttingDown) {
    log("preview", `health check timed out; check the control-plane logs above`, C.yellow);
  }
  log("preview", "press Ctrl-C to stop everything", C.dim);
})().catch((err) => {
  console.error(err);
  shutdown(1);
});
