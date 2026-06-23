import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaseJob } from "@agentpr/shared";

// main.ts now exports handleJob/ensureEnrolled/main and only starts the poll loop
// when run as the process entrypoint, so importing it here has no side effects.
const prepareCheckout = vi.hoisted(() => vi.fn());
const runClaudeReview = vi.hoisted(() => vi.fn());
const loadCreds = vi.hoisted(() => vi.fn());
const saveCreds = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/checkout.js", () => ({ prepareCheckout }));
vi.mock("../src/exec-claude.js", () => ({ runClaudeReview }));
vi.mock("../src/creds.js", () => ({ loadCreds, saveCreds }));

const { handleJob, ensureEnrolled } = await import("../src/main.js");

function makeClient() {
  return {
    setToken: vi.fn(),
    enroll: vi.fn(async () => ({ runnerId: "rid", runnerToken: "tok" })),
    lease: vi.fn(),
    reportResult: vi.fn(async () => undefined),
    reportError: vi.fn(async () => undefined),
  };
}

function leaseJob(over: Partial<LeaseJob> = {}): LeaseJob {
  return {
    jobId: "job-1",
    leaseId: "lease-1",
    repoFullName: "octocat/hello",
    cloneUrl: "https://github.com/octocat/hello.git",
    prNumber: 3,
    headSha: "h".repeat(40),
    baseSha: "b".repeat(40),
    provider: "claude_code",
    model: "claude-opus-4-8",
    round: 1,
    githubToken: "ghs_x",
    reviewInstruction: "do the review",
    resumeSessionId: null,
    priorFindings: [],
    ...over,
  };
}

beforeEach(() => {
  prepareCheckout.mockReset();
  runClaudeReview.mockReset();
  loadCreds.mockReset();
  saveCreds.mockClear();
});

describe("handleJob", () => {
  it("checks out, runs the review, and reports the mapped result; cleans up", async () => {
    const cleanup = vi.fn(async () => undefined);
    prepareCheckout.mockResolvedValue({ dir: "/tmp/work/job-1", diff: "some diff", cleanup });
    runClaudeReview.mockResolvedValue({
      review: {
        verdict: "request_changes",
        summary: "needs work",
        findings: [{ path: "a.ts", line: 1, severity: "high", title: "t", body: "b" }],
        concerns: ["c1"],
        suggestedFixes: ["f1"],
      },
      sessionId: "sess-9",
      modelUsed: "claude-opus-4-8",
      totalCostUsd: 0.2,
      inputTokens: 10,
      outputTokens: 5,
    });
    const client = makeClient();

    await handleJob(client as any, leaseJob());

    expect(prepareCheckout).toHaveBeenCalledOnce();
    expect(runClaudeReview).toHaveBeenCalledOnce();
    // the assembled instruction from the control plane is forwarded to the agent
    expect(runClaudeReview.mock.calls[0][0]).toMatchObject({ reviewInstruction: "do the review", diff: "some diff" });

    expect(client.reportResult).toHaveBeenCalledOnce();
    const reported = client.reportResult.mock.calls[0][0];
    expect(reported).toMatchObject({
      leaseId: "lease-1",
      sessionId: "sess-9",
      verdict: "request_changes",
      summary: "needs work",
      modelUsed: "claude-opus-4-8",
      totalCostUsd: 0.2,
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(reported.findings).toHaveLength(1);
    expect(typeof reported.wallMs).toBe("number");
    expect(client.reportError).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("refuses a non-claude_code provider and reports an error (no checkout)", async () => {
    const client = makeClient();
    await handleJob(client as any, leaseJob({ provider: "opencode" as any }));
    expect(prepareCheckout).not.toHaveBeenCalled();
    expect(client.reportResult).not.toHaveBeenCalled();
    expect(client.reportError).toHaveBeenCalledOnce();
    expect(client.reportError.mock.calls[0][0]).toMatchObject({ leaseId: "lease-1" });
    expect(client.reportError.mock.calls[0][0].message).toContain("not supported");
  });

  it("reports an error (with the leaseId) when the agent throws, and still cleans up", async () => {
    const cleanup = vi.fn(async () => undefined);
    prepareCheckout.mockResolvedValue({ dir: "/tmp/work/job-1", diff: "d", cleanup });
    runClaudeReview.mockRejectedValue(new Error("agent timed out"));
    const client = makeClient();

    await handleJob(client as any, leaseJob());

    expect(client.reportResult).not.toHaveBeenCalled();
    expect(client.reportError).toHaveBeenCalledOnce();
    expect(client.reportError.mock.calls[0][0]).toMatchObject({ leaseId: "lease-1", message: "agent timed out" });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does not throw if reporting the error also fails", async () => {
    prepareCheckout.mockRejectedValue(new Error("git boom"));
    const client = makeClient();
    client.reportError.mockRejectedValue(new Error("network down"));
    await expect(handleJob(client as any, leaseJob())).resolves.toBeUndefined();
  });
});

describe("ensureEnrolled", () => {
  it("uses a stored token when present (no enrollment)", async () => {
    loadCreds.mockResolvedValue({ runnerId: "rid", runnerToken: "stored-tok" });
    const client = makeClient();
    await ensureEnrolled(client as any);
    expect(client.setToken).toHaveBeenCalledWith("stored-tok");
    expect(client.enroll).not.toHaveBeenCalled();
  });

  it("throws when there is no stored token and no enrollment secret", async () => {
    // The test env does not set RUNNER_ENROLLMENT_SECRET_CLIENT, so enrollment
    // is impossible and ensureEnrolled must refuse rather than silently no-op.
    loadCreds.mockResolvedValue(null);
    await expect(ensureEnrolled(makeClient() as any)).rejects.toThrow(/cannot enroll/i);
  });
});
