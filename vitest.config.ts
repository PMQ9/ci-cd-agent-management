import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// A complete, valid env for the control-plane so `config.ts`'s import-time
// `EnvSchema.parse(process.env)` succeeds and `githubConfigured` is true (the
// webhook/auth suites need it). The pg.Pool in db/client.ts is lazy, so pure
// tests never actually connect; integration tests mock db/client entirely.
const controlPlaneEnv: Record<string, string> = {
  NODE_ENV: "test",
  PORT: "8080",
  PUBLIC_URL: "http://localhost:8080",
  DATABASE_URL: "postgres://agentpr:agentpr@localhost:5432/agentpr_test",
  DATABASE_SSL: "disable",
  SESSION_SECRET: "test-session-secret-0123456789abcdef",
  RUNNER_ENROLLMENT_SECRET: "test-enroll-secret",
  ALLOWED_GITHUB_LOGIN: "testuser",
  INTERNAL_API_TOKEN: "test-internal-token",
  LEASE_TTL_SECONDS: "900",
  RUNNER_OFFLINE_SECONDS: "60",
  // Full GitHub App creds so `githubConfigured === true`. The private key is a
  // dummy string — `loadPrivateKey()` only checks truthiness; suites that reach
  // Octokit mock github/app.js so the key is never actually parsed.
  GITHUB_APP_ID: "123456",
  GITHUB_APP_SLUG: "test-app",
  GITHUB_APP_CLIENT_ID: "Iv1.testclientid0",
  GITHUB_APP_CLIENT_SECRET: "test-client-secret",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
};

const runnerEnv: Record<string, string> = {
  NODE_ENV: "test",
  CONTROL_PLANE_URL: "http://localhost:8080",
  RUNNER_NAME: "test-runner",
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          root: "./packages/shared",
          environment: "node",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "control-plane",
          root: "./packages/control-plane",
          environment: "node",
          include: ["test/**/*.test.ts"],
          env: controlPlaneEnv,
          testTimeout: 20_000,
          hookTimeout: 40_000,
        },
      },
      {
        test: {
          name: "runner",
          root: "./packages/runner",
          environment: "node",
          include: ["test/**/*.test.ts"],
          env: runnerEnv,
          testTimeout: 15_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: "dashboard",
          root: "./packages/dashboard",
          environment: "jsdom",
          include: ["test/**/*.test.{ts,tsx}"],
          setupFiles: ["./test/setup.ts"],
        },
      },
    ],
  },
});
