import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// config.ts parses process.env at import time into the `env` export. To probe
// defaults/coercion we reset the module registry, stub env, and re-import.
// Note: the vitest runner project sets CONTROL_PLANE_URL + RUNNER_NAME, so to
// observe a DEFAULT we must clear the var (vi.stubEnv(key, undefined) deletes it).

async function importFreshEnv() {
  vi.resetModules();
  const mod = await import("../src/config.js");
  return mod.env;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("config EnvSchema — defaults", () => {
  it("CONTROL_PLANE_URL defaults to http://localhost:8080 when unset", async () => {
    vi.stubEnv("CONTROL_PLANE_URL", undefined);
    const env = await importFreshEnv();
    expect(env.CONTROL_PLANE_URL).toBe("http://localhost:8080");
  });

  it("RUNNER_NAME defaults to 'runner' when unset", async () => {
    vi.stubEnv("RUNNER_NAME", undefined);
    const env = await importFreshEnv();
    expect(env.RUNNER_NAME).toBe("runner");
  });

  it("CLAUDE_BIN defaults to 'claude'", async () => {
    vi.stubEnv("CLAUDE_BIN", undefined);
    const env = await importFreshEnv();
    expect(env.CLAUDE_BIN).toBe("claude");
  });

  it("OPENCODE_BIN defaults to 'opencode'", async () => {
    vi.stubEnv("OPENCODE_BIN", undefined);
    const env = await importFreshEnv();
    expect(env.OPENCODE_BIN).toBe("opencode");
  });

  it("RUNNER_WORKDIR defaults under the home dir (.agentpr/work)", async () => {
    vi.stubEnv("RUNNER_WORKDIR", undefined);
    const env = await importFreshEnv();
    expect(env.RUNNER_WORKDIR).toBe(resolve(homedir(), ".agentpr/work"));
  });

  it("RUNNER_CRED_FILE defaults under the home dir (.agentpr/runner.json)", async () => {
    vi.stubEnv("RUNNER_CRED_FILE", undefined);
    const env = await importFreshEnv();
    expect(env.RUNNER_CRED_FILE).toBe(resolve(homedir(), ".agentpr/runner.json"));
  });

  it("RUNNER_ENROLLMENT_SECRET_CLIENT is optional → undefined when unset", async () => {
    vi.stubEnv("RUNNER_ENROLLMENT_SECRET_CLIENT", undefined);
    const env = await importFreshEnv();
    expect(env.RUNNER_ENROLLMENT_SECRET_CLIENT).toBeUndefined();
  });

  it("numeric timers fall back to their defaults when unset", async () => {
    vi.stubEnv("POLL_INTERVAL_MS", undefined);
    vi.stubEnv("POLL_TIMEOUT_MS", undefined);
    vi.stubEnv("CLAUDE_TIMEOUT_MS", undefined);
    const env = await importFreshEnv();
    expect(env.POLL_INTERVAL_MS).toBe(25_000);
    expect(env.POLL_TIMEOUT_MS).toBe(20_000);
    expect(env.CLAUDE_TIMEOUT_MS).toBe(20 * 60_000);
  });
});

describe("config EnvSchema — coercion & overrides", () => {
  it("coerces numeric string env vars to numbers", async () => {
    vi.stubEnv("POLL_INTERVAL_MS", "1234");
    vi.stubEnv("POLL_TIMEOUT_MS", "5678");
    vi.stubEnv("CLAUDE_TIMEOUT_MS", "9999");
    const env = await importFreshEnv();
    expect(env.POLL_INTERVAL_MS).toBe(1234);
    expect(env.POLL_TIMEOUT_MS).toBe(5678);
    expect(env.CLAUDE_TIMEOUT_MS).toBe(9999);
    expect(typeof env.POLL_INTERVAL_MS).toBe("number");
  });

  it("honors a provided CONTROL_PLANE_URL (valid url passes)", async () => {
    vi.stubEnv("CONTROL_PLANE_URL", "https://cp.example.com");
    const env = await importFreshEnv();
    expect(env.CONTROL_PLANE_URL).toBe("https://cp.example.com");
  });

  it("honors provided string overrides for binaries & name", async () => {
    vi.stubEnv("CLAUDE_BIN", "/abs/path/claude");
    vi.stubEnv("RUNNER_NAME", "my-box");
    const env = await importFreshEnv();
    expect(env.CLAUDE_BIN).toBe("/abs/path/claude");
    expect(env.RUNNER_NAME).toBe("my-box");
  });
});
