import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Checkout {
  dir: string;
  diff: string;
  cleanup: () => Promise<void>;
}

/**
 * Prepare a throwaway checkout of the PR and compute its diff. The installation
 * token is passed via an Authorization header (http.extraheader), so it never
 * lands in the remote URL or in git's error output.
 */
export async function prepareCheckout(opts: {
  workdir: string;
  jobId: string;
  cloneUrl: string;
  githubToken: string;
  baseSha: string;
  headSha: string;
}): Promise<Checkout> {
  const dir = join(opts.workdir, opts.jobId);
  const basic = Buffer.from(`x-access-token:${opts.githubToken}`).toString("base64");
  const authHeader = `http.extraheader=Authorization: Basic ${basic}`;
  const scrub = (s: string) => s.split(basic).join("***");

  const git = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync("git", args, { maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      throw new Error(scrub(err instanceof Error ? err.message : String(err)));
    }
  };

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  await git(["init", "-q", dir]);
  await git(["-C", dir, "remote", "add", "origin", opts.cloneUrl]);
  await git([
    "-C",
    dir,
    "-c",
    authHeader,
    "fetch",
    "--depth=50",
    "-q",
    "origin",
    opts.baseSha,
    opts.headSha,
  ]);
  await git(["-C", dir, "checkout", "-q", opts.headSha]);
  const diff = await git(["-C", dir, "diff", opts.baseSha, opts.headSha]);

  return {
    dir,
    diff,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
