import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

// Load .env from the package dir and the repo root (dev convenience). In
// production (Docker), env comes from the container environment / env_file.
for (const p of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  if (existsSync(p)) {
    try {
      (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(p);
    } catch {
      /* older node without process.loadEnvFile — rely on real env */
    }
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8080),
  PUBLIC_URL: z.string().url().default("http://localhost:8080"),
  DATABASE_URL: z.string().min(1),
  // 'auto' enables SSL for non-local DBs (e.g. Neon). Override if your provider
  // needs it off ('disable') or uses a self-signed cert ('no-verify').
  DATABASE_SSL: z.enum(["auto", "require", "no-verify", "disable"]).default("auto"),

  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(), // for the install/manage link on the dashboard
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional(),

  ALLOWED_GITHUB_LOGIN: z.string().optional(),
  SESSION_SECRET: z.string().default("dev-insecure-session-secret-change-me"),
  RUNNER_ENROLLMENT_SECRET: z.string().default("dev-enroll-secret-change-me"),

  AUTO_MIGRATE: z.string().default("true"),
  LEASE_TTL_SECONDS: z.coerce.number().default(900),
  LONG_POLL_SECONDS: z.coerce.number().default(25),
  RUNNER_OFFLINE_SECONDS: z.coerce.number().default(60),
  GLOBAL_DAILY_COST_CAP_USD: z.coerce.number().optional(),

  // Shared bearer secret for /internal/* (e.g. Cloud Scheduler → POST /internal/sweep).
  // Required because the service is public (--allow-unauthenticated) for webhooks.
  INTERNAL_API_TOKEN: z.string().optional(),
  // In-process lease sweep timer. Keep "true" for local dev / the VM; set "false"
  // on Cloud Run scale-to-zero (the timer can't fire when the instance is frozen)
  // and rely on Cloud Scheduler → POST /internal/sweep instead.
  ENABLE_INPROCESS_SWEEP: z.string().default("true"),

  // Optional: absolute path to a prebuilt dashboard (served statically). If
  // unset, the control plane runs API-only and you use `pnpm dev:dash`.
  DASHBOARD_DIST: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;
export const env: Env = EnvSchema.parse(process.env);
export const isProd = env.NODE_ENV === "production";

export function loadPrivateKey(): string | undefined {
  if (env.GITHUB_APP_PRIVATE_KEY) return env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  if (env.GITHUB_APP_PRIVATE_KEY_PATH && existsSync(env.GITHUB_APP_PRIVATE_KEY_PATH)) {
    return readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
  }
  return undefined;
}

/** True only when every GitHub App credential is present. */
export const githubConfigured = Boolean(
  env.GITHUB_APP_ID &&
    env.GITHUB_APP_CLIENT_ID &&
    env.GITHUB_APP_CLIENT_SECRET &&
    env.GITHUB_WEBHOOK_SECRET &&
    loadPrivateKey(),
);
