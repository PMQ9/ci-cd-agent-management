import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// config.ts parses env at IMPORT time, so each test resets the module registry,
// stubs a fresh env, then dynamically imports a clean copy.

const BASE_ENV: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  DATABASE_SSL: "disable",
  PUBLIC_URL: "http://localhost:8080",
  SESSION_SECRET: "test-session-secret",
};

// The optional vars set by vitest.config's controlPlaneEnv (project-level) that
// could leak into a test that means to drop them. We clear ALL of these to
// `undefined` first, then layer BASE_ENV + the test override on top.
const CLEARABLE = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "ALLOWED_GITHUB_LOGIN",
  "INTERNAL_API_TOKEN",
  "SESSION_SECRET",
  "RUNNER_ENROLLMENT_SECRET",
  "LEASE_TTL_SECONDS",
  "DATABASE_SSL",
  "NODE_ENV",
];

function setEnv(over: Record<string, string | undefined> = {}) {
  // Start from a clean slate so vitest.config's controlPlaneEnv doesn't leak
  // GitHub creds / defaults into tests that mean to drop them. Passing
  // `undefined` to stubEnv DELETES the key (an empty string would still count
  // as "present" and defeat Zod `.default()`).
  vi.unstubAllEnvs();
  for (const k of CLEARABLE) vi.stubEnv(k, undefined);

  const merged: Record<string, string | undefined> = { ...BASE_ENV, ...over };
  for (const [k, v] of Object.entries(merged)) {
    vi.stubEnv(k, v); // undefined deletes; string sets
  }
}

// A complete set of GitHub creds (private key inline) for the "configured" case.
const GH = {
  GITHUB_APP_ID: "999",
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_CLIENT_SECRET: "secret",
  GITHUB_WEBHOOK_SECRET: "whsecret",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN KEY-----\\nabc\\n-----END KEY-----",
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function importConfig() {
  vi.resetModules();
  return import("../src/config.js");
}

describe("githubConfigured", () => {
  it("is true when every GitHub credential (incl. a private key) is present", async () => {
    setEnv(GH);
    const { githubConfigured } = await importConfig();
    expect(githubConfigured).toBe(true);
  });

  for (const drop of [
    "GITHUB_APP_ID",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
  ] as const) {
    it(`is false when ${drop} is missing`, async () => {
      const env: Record<string, string | undefined> = { ...GH, [drop]: undefined };
      setEnv(env);
      const { githubConfigured } = await importConfig();
      expect(githubConfigured).toBe(false);
    });
  }

  it("is false when no private key (inline or path) is available", async () => {
    const { GITHUB_APP_PRIVATE_KEY: _omit, ...rest } = GH;
    setEnv({ ...rest, GITHUB_APP_PRIVATE_KEY_PATH: "/no/such/key.pem" });
    const { githubConfigured } = await importConfig();
    expect(githubConfigured).toBe(false);
  });
});

describe("loadPrivateKey", () => {
  it("turns literal \\n sequences in the inline key into real newlines", async () => {
    setEnv({ GITHUB_APP_PRIVATE_KEY: "line1\\nline2\\nline3" });
    const { loadPrivateKey } = await importConfig();
    expect(loadPrivateKey()).toBe("line1\nline2\nline3");
  });

  it("prefers the inline env var over the path", async () => {
    // Point the path at a real file that should be IGNORED in favor of the inline key.
    setEnv({
      GITHUB_APP_PRIVATE_KEY: "inline-wins",
      GITHUB_APP_PRIVATE_KEY_PATH: "/etc/hosts",
    });
    const { loadPrivateKey } = await importConfig();
    expect(loadPrivateKey()).toBe("inline-wins");
  });

  it("returns undefined when neither the inline key nor a readable path is set", async () => {
    setEnv({}); // no GITHUB_APP_PRIVATE_KEY, no path
    const { loadPrivateKey } = await importConfig();
    expect(loadPrivateKey()).toBeUndefined();
  });

  it("reads the key from a file when only the path is set", async () => {
    // /etc/hosts exists on darwin/linux; we just assert non-empty file contents come back.
    setEnv({ GITHUB_APP_PRIVATE_KEY_PATH: "/etc/hosts" });
    const { loadPrivateKey } = await importConfig();
    const key = loadPrivateKey();
    expect(typeof key).toBe("string");
    expect((key ?? "").length).toBeGreaterThan(0);
  });
});

describe("EnvSchema parsing", () => {
  it("rejects (import throws) when DATABASE_URL is missing", async () => {
    setEnv({ DATABASE_URL: undefined });
    await expect(importConfig()).rejects.toThrow();
  });

  it("defaults LEASE_TTL_SECONDS to 900 when unset", async () => {
    setEnv({}); // no LEASE_TTL_SECONDS
    const { env } = await importConfig();
    expect(env.LEASE_TTL_SECONDS).toBe(900);
  });

  it("provides a default SESSION_SECRET when unset", async () => {
    // BASE_ENV sets SESSION_SECRET; drop it to exercise the schema default.
    const { SESSION_SECRET: _omit, ...rest } = BASE_ENV;
    setEnv({ ...rest, SESSION_SECRET: undefined });
    const { env } = await importConfig();
    expect(env.SESSION_SECRET).toBe("dev-insecure-session-secret-change-me");
  });

  it("throws when DATABASE_SSL is an invalid enum value", async () => {
    setEnv({ DATABASE_SSL: "totally-bogus" });
    await expect(importConfig()).rejects.toThrow();
  });

  it("coerces LEASE_TTL_SECONDS from a string env value", async () => {
    setEnv({ LEASE_TTL_SECONDS: "120" });
    const { env } = await importConfig();
    expect(env.LEASE_TTL_SECONDS).toBe(120);
  });
});

describe("isProd", () => {
  it("is true when NODE_ENV === 'production'", async () => {
    setEnv({ NODE_ENV: "production" });
    const { isProd } = await importConfig();
    expect(isProd).toBe(true);
  });

  it("is false for any non-production NODE_ENV", async () => {
    setEnv({ NODE_ENV: "development" });
    const { isProd } = await importConfig();
    expect(isProd).toBe(false);
  });
});
