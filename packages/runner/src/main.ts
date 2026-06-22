import { hostname } from "node:os";
import type { LeaseJob } from "@agentpr/shared";
import { prepareCheckout, type Checkout } from "./checkout.js";
import { ControlPlaneClient } from "./client.js";
import { env } from "./config.js";
import { loadCreds, saveCreds } from "./creds.js";
import { runClaudeReview } from "./exec-claude.js";

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), "[runner]", ...args);
}

async function ensureEnrolled(client: ControlPlaneClient): Promise<void> {
  const existing = await loadCreds(env.RUNNER_CRED_FILE);
  if (existing) {
    client.setToken(existing.runnerToken);
    log(`using stored runner token (id ${existing.runnerId})`);
    return;
  }
  if (!env.RUNNER_ENROLLMENT_SECRET_CLIENT) {
    throw new Error(
      "No stored runner token and RUNNER_ENROLLMENT_SECRET_CLIENT is not set — cannot enroll.",
    );
  }
  const res = await client.enroll({
    enrollmentSecret: env.RUNNER_ENROLLMENT_SECRET_CLIENT,
    name: env.RUNNER_NAME || hostname(),
    capabilities: { providers: ["claude_code"], version: "0.1.0" },
  });
  await saveCreds(env.RUNNER_CRED_FILE, res);
  client.setToken(res.runnerToken);
  log(`enrolled as ${res.runnerId}`);
}

async function handleJob(client: ControlPlaneClient, job: LeaseJob): Promise<void> {
  const started = Date.now();
  log(`leased ${job.jobId} — ${job.repoFullName}#${job.prNumber} (round ${job.round})`);
  let checkout: Checkout | undefined;
  try {
    if (job.provider !== "claude_code") {
      throw new Error(`provider "${job.provider}" not supported yet (Claude Code only in v1)`);
    }
    checkout = await prepareCheckout({
      workdir: env.RUNNER_WORKDIR,
      jobId: job.jobId,
      cloneUrl: job.cloneUrl,
      githubToken: job.githubToken,
      baseSha: job.baseSha,
      headSha: job.headSha,
    });
    const result = await runClaudeReview({
      claudeBin: env.CLAUDE_BIN,
      cwd: checkout.dir,
      diff: checkout.diff,
      repoFullName: job.repoFullName,
      prNumber: job.prNumber,
      baseSha: job.baseSha,
      headSha: job.headSha,
      round: job.round,
      priorFindings: job.priorFindings,
      resumeSessionId: job.resumeSessionId,
      model: job.model,
      timeoutMs: env.CLAUDE_TIMEOUT_MS,
    });
    await client.reportResult({
      leaseId: job.leaseId,
      sessionId: result.sessionId,
      verdict: result.review.verdict,
      summary: result.review.summary,
      findings: result.review.findings,
      totalCostUsd: result.totalCostUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      wallMs: Date.now() - started,
    });
    log(
      `done ${job.jobId}: ${result.review.verdict}, ${result.review.findings.length} finding(s), $${result.totalCostUsd.toFixed(4)}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`FAILED ${job.jobId}: ${message}`);
    try {
      await client.reportError({ leaseId: job.leaseId, message, totalCostUsd: null, wallMs: Date.now() - started });
    } catch (reportErr) {
      log(`could not report error for ${job.jobId}:`, reportErr);
    }
  } finally {
    if (checkout) await checkout.cleanup().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) {
    log(
      "WARNING: ANTHROPIC_API_KEY is set. Reviews will be REFUSED to protect your subscription billing — unset it in this environment.",
    );
  }
  const client = new ControlPlaneClient(env.CONTROL_PLANE_URL);
  await ensureEnrolled(client);
  log(`polling ${env.CONTROL_PLANE_URL} as "${env.RUNNER_NAME}"`);

  let running = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      running = false;
      log("shutting down");
      process.exit(0);
    });
  }

  let backoff = 1000;
  while (running) {
    try {
      const { job } = await client.lease();
      backoff = 1000;
      if (job) await handleJob(client, job);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/abort/i.test(message)) continue; // long-poll window elapsed; just re-poll
      log(`poll error: ${message}; retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

main().catch((err) => {
  console.error("[runner] fatal:", err);
  process.exit(1);
});
