import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareCheckout } from "../src/checkout.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAVE_GIT = gitAvailable();

describe.skipIf(!HAVE_GIT)("prepareCheckout (integration, real git)", () => {
  let root: string;
  let originRepo: string;
  let workdir: string;
  let baseSha: string;
  let headSha: string;

  const git = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "agentpr-checkout-"));
    originRepo = join(root, "origin");
    workdir = join(root, "work");

    execFileSync("git", ["init", "-q", originRepo]);
    // Deterministic identity so commits succeed in CI sandboxes.
    git(["config", "user.email", "test@example.com"], originRepo);
    git(["config", "user.name", "Test"], originRepo);
    git(["config", "commit.gpgsign", "false"], originRepo);

    writeFileSync(join(originRepo, "file.txt"), "line one\n");
    git(["add", "."], originRepo);
    git(["commit", "-q", "-m", "base commit"], originRepo);
    baseSha = git(["rev-parse", "HEAD"], originRepo);

    writeFileSync(join(originRepo, "file.txt"), "line one\nUNIQUE_CHANGED_CONTENT\n");
    git(["add", "."], originRepo);
    git(["commit", "-q", "-m", "head commit"], originRepo);
    headSha = git(["rev-parse", "HEAD"], originRepo);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("checks out the PR and returns a diff containing the changed content", async () => {
    const checkout = await prepareCheckout({
      workdir,
      jobId: "job-happy",
      cloneUrl: originRepo, // a local path is a valid git remote
      githubToken: "should-not-appear-anywhere",
      baseSha,
      headSha,
    });
    expect(checkout.dir).toBe(join(workdir, "job-happy"));
    expect(existsSync(checkout.dir)).toBe(true);
    expect(checkout.diff).toContain("UNIQUE_CHANGED_CONTENT");
    expect(checkout.diff).toContain("file.txt");

    // cleanup() removes the dir.
    await checkout.cleanup();
    expect(existsSync(checkout.dir)).toBe(false);
  });

  it("re-uses the dir name and wipes any stale prior checkout (rm before init)", async () => {
    // First checkout to create the dir + leave a stray file.
    const first = await prepareCheckout({
      workdir,
      jobId: "job-reuse",
      cloneUrl: originRepo,
      githubToken: "tok",
      baseSha,
      headSha,
    });
    writeFileSync(join(first.dir, "STALE.txt"), "stale");
    expect(existsSync(join(first.dir, "STALE.txt"))).toBe(true);

    // Second checkout with the same jobId wipes the dir first.
    const second = await prepareCheckout({
      workdir,
      jobId: "job-reuse",
      cloneUrl: originRepo,
      githubToken: "tok",
      baseSha,
      headSha,
    });
    expect(existsSync(join(second.dir, "STALE.txt"))).toBe(false);
    expect(second.diff).toContain("UNIQUE_CHANGED_CONTENT");
    await second.cleanup();
  });

  it("scrubs the base64 token (and raw token) from error output on a git failure", async () => {
    const token = "super-secret-raw-token-value";
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");

    let caught: Error | undefined;
    try {
      await prepareCheckout({
        workdir,
        jobId: "job-fail",
        cloneUrl: originRepo,
        githubToken: token,
        // Bogus SHAs → the fetch step fails.
        baseSha: "deadbeef".repeat(5),
        headSha: "deadbeef".repeat(5),
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = caught!.message;
    // `***` only appears if the base64 auth header WAS in git's raw error and got
    // scrubbed — so this proves the redaction ran, and that the base64 (and the raw
    // token) do not leak.
    expect(msg).toContain("***");
    expect(msg).not.toContain(basic);
    expect(msg).not.toContain(token);
  });
});
