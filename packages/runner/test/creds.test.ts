import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCreds, type RunnerCreds, saveCreds } from "../src/creds.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "agentpr-creds-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const creds: RunnerCreds = { runnerId: "runner-abc", runnerToken: "tok-secret-123" };

describe("saveCreds / loadCreds round-trip", () => {
  it("saves then loads back the same creds", async () => {
    const file = join(workDir, "runner.json");
    await saveCreds(file, creds);
    const loaded = await loadCreds(file);
    expect(loaded).toEqual(creds);
  });

  it("creates the parent directory if it does not exist", async () => {
    const file = join(workDir, "nested", "deep", "runner.json");
    await saveCreds(file, creds);
    const loaded = await loadCreds(file);
    expect(loaded).toEqual(creds);
  });

  it("writes the file with mode 0o600 (owner read/write only)", async () => {
    const file = join(workDir, "runner.json");
    await saveCreds(file, creds);
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("loadCreds — failure / missing cases", () => {
  it("returns null when the file does not exist", async () => {
    const loaded = await loadCreds(join(workDir, "does-not-exist.json"));
    expect(loaded).toBeNull();
  });

  it("returns null when the file is not valid JSON", async () => {
    const file = join(workDir, "garbage.json");
    writeFileSync(file, "this is not json {{{");
    expect(await loadCreds(file)).toBeNull();
  });

  it("returns null when JSON lacks runnerId", async () => {
    const file = join(workDir, "partial.json");
    writeFileSync(file, JSON.stringify({ runnerToken: "tok" }));
    expect(await loadCreds(file)).toBeNull();
  });

  it("returns null when JSON lacks runnerToken", async () => {
    const file = join(workDir, "partial2.json");
    writeFileSync(file, JSON.stringify({ runnerId: "id" }));
    expect(await loadCreds(file)).toBeNull();
  });
});
