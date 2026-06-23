import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock node:child_process so spawn is controllable AND observable. The module
// under test imports { spawn } from "node:child_process" at top level.
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

// Import AFTER the mock is registered.
const { runClaudeReview } = await import("../src/exec-claude.js");

// Build a fake ChildProcess that spawnCollect can consume: stdout/stderr are
// EventEmitters, stdin has write/end, and .on("close") drives completion.
function makeFakeChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  emitError?: Error;
}) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  // Drive the lifecycle asynchronously on the next tick so listeners are attached.
  setImmediate(() => {
    if (opts.emitError) {
      child.emit("error", opts.emitError);
      return;
    }
    if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
    child.emit("close", opts.exitCode ?? 0);
  });
  return child;
}

const minimalOpts = {
  claudeBin: "/usr/local/bin/claude",
  cwd: "/tmp/work",
  repoFullName: "octocat/hello",
  prNumber: 1,
  baseSha: "aaaaaaaaaaaa",
  headSha: "bbbbbbbbbbbb",
  round: 1,
  priorFindings: [],
  resumeSessionId: null,
  model: null,
  timeoutMs: 10_000,
};

const validReviewJson = JSON.stringify({
  verdict: "approve",
  summary: "Looks good.",
  findings: [],
  concerns: [],
  suggestedFixes: [],
});

function wrapperStdout(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    result: validReviewJson,
    session_id: "sess-1",
    total_cost_usd: 0.01,
    usage: { input_tokens: 5, output_tokens: 2 },
    model: "claude-opus-4",
    ...extra,
  });
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runClaudeReview — ANTHROPIC_API_KEY guard (the load-bearing negative test)", () => {
  it("REFUSES to run when ANTHROPIC_API_KEY is set, mentions billing/subscription, and NEVER spawns", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    await expect(runClaudeReview({ ...minimalOpts, diff: "some diff" })).rejects.toThrow(
      /bill|subscription/i,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses even when the diff is empty — the key guard must precede the empty-diff short-circuit", async () => {
    // Regression guard: if the empty-diff return were ordered before the API-key
    // check, an empty-diff job with a stray key would silently skip the refusal.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    await expect(runClaudeReview({ ...minimalOpts, diff: "" })).rejects.toThrow(
      /bill|subscription/i,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("runClaudeReview — empty diff short-circuit", () => {
  it("resolves to the no-diff comment fallback WITHOUT spawning", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const out = await runClaudeReview({ ...minimalOpts, diff: "" });
    expect(out.review.verdict).toBe("comment");
    expect(out.review.summary).toBe("No diff between base and head — nothing to review.");
    expect(out.totalCostUsd).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only diff as empty (diff.trim() falsy) without spawning", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const out = await runClaudeReview({ ...minimalOpts, diff: "   \n\t  " });
    expect(out.review.summary).toBe("No diff between base and head — nothing to review.");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("runClaudeReview — argv construction & happy path (spawn mocked)", () => {
  it("spawns [bin, base argv] and parses the wrapper from stdout", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    spawnMock.mockImplementation(() => makeFakeChild({ stdout: wrapperStdout(), exitCode: 0 }));

    const out = await runClaudeReview({
      ...minimalOpts,
      diff: "diff --git a b",
      reviewInstruction: "INSTRUCTION-FROM-CP",
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0]!;
    expect(bin).toBe("/usr/local/bin/claude");
    expect(args).toEqual([
      "-p",
      "INSTRUCTION-FROM-CP",
      "--output-format",
      "json",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Read,Grep,Glob",
    ]);
    // No --model / --resume since neither set.
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--resume");

    // Parsed wrapper.
    expect(out.review.verdict).toBe("approve");
    expect(out.sessionId).toBe("sess-1");
    expect(out.modelUsed).toBe("claude-opus-4");
    expect(out.totalCostUsd).toBe(0.01);
  });

  it("uses opts.reviewInstruction as the -p arg when provided", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    spawnMock.mockImplementation(() => makeFakeChild({ stdout: wrapperStdout(), exitCode: 0 }));
    await runClaudeReview({ ...minimalOpts, diff: "d", reviewInstruction: "CP-PROMPT" });
    const [, args] = spawnMock.mock.calls[0]!;
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("CP-PROMPT");
  });

  it("falls back to buildInstruction for the -p arg when reviewInstruction is absent", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    spawnMock.mockImplementation(() => makeFakeChild({ stdout: wrapperStdout(), exitCode: 0 }));
    await runClaudeReview({ ...minimalOpts, diff: "d", reviewInstruction: null });
    const [, args] = spawnMock.mock.calls[0]!;
    // The local builder includes the contract line + PR context.
    expect(args[1]).toContain("Respond with ONLY a JSON object");
    expect(args[1]).toContain("PR #1");
  });

  it("appends --model when opts.model is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    spawnMock.mockImplementation(() => makeFakeChild({ stdout: wrapperStdout(), exitCode: 0 }));
    await runClaudeReview({
      ...minimalOpts,
      diff: "d",
      model: "claude-3-5-sonnet",
      reviewInstruction: "x",
    });
    const [, args] = spawnMock.mock.calls[0]!;
    const i = args.indexOf("--model");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("claude-3-5-sonnet");
  });

  it("appends --resume when opts.resumeSessionId is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    spawnMock.mockImplementation(() => makeFakeChild({ stdout: wrapperStdout(), exitCode: 0 }));
    await runClaudeReview({
      ...minimalOpts,
      diff: "d",
      resumeSessionId: "resume-abc",
      reviewInstruction: "x",
    });
    const [, args] = spawnMock.mock.calls[0]!;
    const i = args.indexOf("--resume");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("resume-abc");
  });

  it("appends both --model and --resume (model before resume) when both set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    spawnMock.mockImplementation(() => makeFakeChild({ stdout: wrapperStdout(), exitCode: 0 }));
    await runClaudeReview({
      ...minimalOpts,
      diff: "d",
      model: "m1",
      resumeSessionId: "r1",
      reviewInstruction: "x",
    });
    const [, args] = spawnMock.mock.calls[0]!;
    expect(args.indexOf("--model")).toBeLessThan(args.indexOf("--resume"));
  });

  it("writes the diff to the child's stdin and ends it", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    let captured: any;
    spawnMock.mockImplementation(() => {
      captured = makeFakeChild({ stdout: wrapperStdout(), exitCode: 0 });
      return captured;
    });
    await runClaudeReview({ ...minimalOpts, diff: "the-diff-content", reviewInstruction: "x" });
    expect(captured.stdin.write).toHaveBeenCalledWith("the-diff-content");
    expect(captured.stdin.end).toHaveBeenCalled();
  });

  it("rejects with stderr context when the child exits non-zero", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    spawnMock.mockImplementation(() =>
      makeFakeChild({ stderr: "boom went the agent", exitCode: 2 }),
    );
    await expect(
      runClaudeReview({ ...minimalOpts, diff: "d", reviewInstruction: "x" }),
    ).rejects.toThrow(/agent exited 2: boom went the agent/);
  });

  it("rejects when the child emits an 'error' event", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    spawnMock.mockImplementation(() =>
      makeFakeChild({ emitError: new Error("ENOENT spawn claude") }),
    );
    await expect(
      runClaudeReview({ ...minimalOpts, diff: "d", reviewInstruction: "x" }),
    ).rejects.toThrow(/ENOENT spawn claude/);
  });
});
