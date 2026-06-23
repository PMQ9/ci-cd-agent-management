import { describe, it, expect } from "vitest";
import {
  AgentFindingSchema,
  PriorFindingSchema,
  ReviewOutputSchema,
  EnrollRequestSchema,
  EnrollResponseSchema,
  LeaseJobSchema,
  LeaseResponseSchema,
  JobResultSchema,
  JobErrorSchema,
  ApiErrorSchema,
} from "@agentpr/shared";

// A real RFC-4122 v4 uuid for fields the schema validates with .uuid().
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const UUID2 = "00000000-0000-4000-8000-000000000000";

// ── AgentFindingSchema ─────────────────────────────────────────────────────────
// line is .int().positive().nullable(): line>0 or null only.
describe("AgentFindingSchema", () => {
  const base = {
    path: "src/index.ts",
    line: 42,
    severity: "high" as const,
    title: "Null deref",
    body: "Possible null dereference here; add a guard.",
  };

  it("accepts a positive integer line", () => {
    const r = AgentFindingSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.line).toBe(42);
  });

  it("accepts line=null (file-level finding)", () => {
    const r = AgentFindingSchema.safeParse({ ...base, line: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.line).toBeNull();
  });

  it("REJECTS line=0 (not positive)", () => {
    expect(AgentFindingSchema.safeParse({ ...base, line: 0 }).success).toBe(false);
  });

  it("REJECTS a negative line", () => {
    expect(AgentFindingSchema.safeParse({ ...base, line: -3 }).success).toBe(false);
  });

  it("REJECTS a non-integer / float line", () => {
    expect(AgentFindingSchema.safeParse({ ...base, line: 12.5 }).success).toBe(false);
  });

  it("REJECTS an empty title", () => {
    expect(AgentFindingSchema.safeParse({ ...base, title: "" }).success).toBe(false);
  });

  it("REJECTS an empty body", () => {
    expect(AgentFindingSchema.safeParse({ ...base, body: "" }).success).toBe(false);
  });

  it("REJECTS an invalid severity", () => {
    expect(
      AgentFindingSchema.safeParse({ ...base, severity: "blocker" }).success,
    ).toBe(false);
  });

  it("accepts every valid severity", () => {
    for (const sev of ["critical", "high", "medium", "low", "info"]) {
      expect(AgentFindingSchema.safeParse({ ...base, severity: sev }).success).toBe(
        true,
      );
    }
  });

  it("REJECTS missing required keys (path, severity, title, body)", () => {
    for (const key of ["path", "severity", "title", "body"]) {
      const partial: Record<string, unknown> = { ...base };
      delete partial[key];
      expect(
        AgentFindingSchema.safeParse(partial).success,
        `missing "${key}" should reject`,
      ).toBe(false);
    }
    // line is required too (it is nullable but not optional)
    const noLine: Record<string, unknown> = { ...base };
    delete noLine.line;
    expect(AgentFindingSchema.safeParse(noLine).success).toBe(false);
  });
});

// ── PriorFindingSchema ─────────────────────────────────────────────────────────
// Deliberate contrast: line is .int().nullable() (NOT .positive()), so 0 and
// negatives are ALLOWED here even though AgentFinding rejects them.
describe("PriorFindingSchema (line is .int().nullable(), NOT .positive())", () => {
  const base = {
    path: "src/a.ts",
    line: 10,
    severity: "low" as const,
    title: "t",
    body: "b",
  };

  it("accepts a positive line", () => {
    expect(PriorFindingSchema.safeParse(base).success).toBe(true);
  });

  it("ALLOWS line=0 (contrast with AgentFindingSchema which rejects 0)", () => {
    const prior = PriorFindingSchema.safeParse({ ...base, line: 0 });
    const agent = AgentFindingSchema.safeParse({ ...base, line: 0 });
    expect(prior.success).toBe(true);
    expect(agent.success).toBe(false);
  });

  it("ALLOWS a negative line (contrast with AgentFindingSchema)", () => {
    const prior = PriorFindingSchema.safeParse({ ...base, line: -5 });
    const agent = AgentFindingSchema.safeParse({ ...base, line: -5 });
    expect(prior.success).toBe(true);
    expect(agent.success).toBe(false);
  });

  it("accepts line=null", () => {
    expect(PriorFindingSchema.safeParse({ ...base, line: null }).success).toBe(true);
  });

  it("still REJECTS a float line (must be .int())", () => {
    expect(PriorFindingSchema.safeParse({ ...base, line: 1.5 }).success).toBe(false);
  });

  it("allows empty title/body (no .min(1) constraint, unlike AgentFinding)", () => {
    expect(
      PriorFindingSchema.safeParse({ ...base, title: "", body: "" }).success,
    ).toBe(true);
  });

  it("REJECTS an invalid severity", () => {
    expect(
      PriorFindingSchema.safeParse({ ...base, severity: "nope" }).success,
    ).toBe(false);
  });
});

// ── ReviewOutputSchema ─────────────────────────────────────────────────────────
describe("ReviewOutputSchema", () => {
  const finding = {
    path: "src/x.ts",
    line: 7,
    severity: "medium" as const,
    title: "X",
    body: "explain",
  };

  it("round-trips a fully-specified valid object", () => {
    const input = {
      verdict: "request_changes" as const,
      summary: "Needs work.",
      findings: [finding],
      concerns: ["is this thread-safe?"],
      suggestedFixes: ["add a mutex around foo()"],
    };
    const r = ReviewOutputSchema.safeParse(input);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.verdict).toBe("request_changes");
      expect(r.data.summary).toBe("Needs work.");
      expect(r.data.findings).toHaveLength(1);
      expect(r.data.concerns).toEqual(["is this thread-safe?"]);
      expect(r.data.suggestedFixes).toEqual(["add a mutex around foo()"]);
    }
  });

  it("defaults concerns and suggestedFixes to [] when omitted", () => {
    const r = ReviewOutputSchema.safeParse({
      verdict: "approve",
      summary: "LGTM",
      findings: [],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.concerns).toEqual([]);
      expect(r.data.suggestedFixes).toEqual([]);
    }
  });

  it("strips unknown keys (schema is NOT .strict())", () => {
    const r = ReviewOutputSchema.safeParse({
      verdict: "comment",
      summary: "fyi",
      findings: [],
      bogusExtraKey: "should be dropped",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).not.toHaveProperty("bogusExtraKey");
      expect(Object.keys(r.data).sort()).toEqual([
        "concerns",
        "findings",
        "suggestedFixes",
        "summary",
        "verdict",
      ]);
    }
  });

  it("REJECTS an empty summary", () => {
    expect(
      ReviewOutputSchema.safeParse({
        verdict: "approve",
        summary: "",
        findings: [],
      }).success,
    ).toBe(false);
  });

  it("REJECTS an invalid verdict", () => {
    expect(
      ReviewOutputSchema.safeParse({
        verdict: "reject",
        summary: "no",
        findings: [],
      }).success,
    ).toBe(false);
  });

  it("validates each finding element (a bad finding fails the whole object)", () => {
    const r = ReviewOutputSchema.safeParse({
      verdict: "comment",
      summary: "ok",
      findings: [finding, { ...finding, line: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it("REJECTS findings that is not an array", () => {
    expect(
      ReviewOutputSchema.safeParse({
        verdict: "approve",
        summary: "x",
        findings: "nope",
      }).success,
    ).toBe(false);
  });
});

// ── EnrollRequestSchema ────────────────────────────────────────────────────────
describe("EnrollRequestSchema", () => {
  const base = {
    enrollmentSecret: "s3cret",
    name: "macbook",
    capabilities: { providers: ["claude_code"], version: "0.2.0" },
  };

  it("accepts a valid enroll request", () => {
    expect(EnrollRequestSchema.safeParse(base).success).toBe(true);
  });

  it("accepts an omitted version (optional)", () => {
    const r = EnrollRequestSchema.safeParse({
      ...base,
      capabilities: { providers: ["claude_code"] },
    });
    expect(r.success).toBe(true);
  });

  it("REJECTS an empty providers array (.min(1))", () => {
    expect(
      EnrollRequestSchema.safeParse({
        ...base,
        capabilities: { providers: [] },
      }).success,
    ).toBe(false);
  });

  it("REJECTS an empty name", () => {
    expect(EnrollRequestSchema.safeParse({ ...base, name: "" }).success).toBe(false);
  });

  it("REJECTS an empty enrollmentSecret", () => {
    expect(
      EnrollRequestSchema.safeParse({ ...base, enrollmentSecret: "" }).success,
    ).toBe(false);
  });

  it("REJECTS an invalid provider", () => {
    expect(
      EnrollRequestSchema.safeParse({
        ...base,
        capabilities: { providers: ["gpt4"] },
      }).success,
    ).toBe(false);
  });
});

// ── EnrollResponseSchema ───────────────────────────────────────────────────────
describe("EnrollResponseSchema", () => {
  it("accepts a uuid runnerId + non-empty token", () => {
    expect(
      EnrollResponseSchema.safeParse({ runnerId: UUID, runnerToken: "tok" }).success,
    ).toBe(true);
  });

  it("REJECTS a non-uuid runnerId", () => {
    expect(
      EnrollResponseSchema.safeParse({ runnerId: "not-a-uuid", runnerToken: "tok" })
        .success,
    ).toBe(false);
  });

  it("REJECTS an empty runnerToken (.min(1))", () => {
    expect(
      EnrollResponseSchema.safeParse({ runnerId: UUID, runnerToken: "" }).success,
    ).toBe(false);
  });
});

// ── LeaseJobSchema ─────────────────────────────────────────────────────────────
describe("LeaseJobSchema", () => {
  const base = {
    jobId: UUID,
    leaseId: UUID2,
    repoFullName: "owner/repo",
    cloneUrl: "https://github.com/owner/repo.git",
    prNumber: 12,
    headSha: "abc",
    baseSha: "def",
    provider: "claude_code" as const,
    model: "claude-opus" as string | null,
    round: 1,
    githubToken: "ghs_token",
    resumeSessionId: null as string | null,
    priorFindings: [] as unknown[],
  };

  it("round-trips a valid lease (reviewInstruction omitted)", () => {
    const r = LeaseJobSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.reviewInstruction).toBeUndefined();
  });

  it("accepts reviewInstruction as a string", () => {
    const r = LeaseJobSchema.safeParse({ ...base, reviewInstruction: "review this" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.reviewInstruction).toBe("review this");
  });

  it("REJECTS reviewInstruction=null (.string().optional(), NOT nullable)", () => {
    expect(
      LeaseJobSchema.safeParse({ ...base, reviewInstruction: null }).success,
    ).toBe(false);
  });

  it("REJECTS a non-URL cloneUrl", () => {
    expect(
      LeaseJobSchema.safeParse({ ...base, cloneUrl: "not a url" }).success,
    ).toBe(false);
  });

  it("accepts resumeSessionId=null and a string", () => {
    expect(LeaseJobSchema.safeParse({ ...base, resumeSessionId: null }).success).toBe(
      true,
    );
    expect(
      LeaseJobSchema.safeParse({ ...base, resumeSessionId: "sess-1" }).success,
    ).toBe(true);
  });

  it("accepts model=null", () => {
    expect(LeaseJobSchema.safeParse({ ...base, model: null }).success).toBe(true);
  });

  it("REJECTS an invalid provider enum", () => {
    expect(LeaseJobSchema.safeParse({ ...base, provider: "bedrock" }).success).toBe(
      false,
    );
  });

  it("REJECTS a non-uuid jobId / leaseId", () => {
    expect(LeaseJobSchema.safeParse({ ...base, jobId: "x" }).success).toBe(false);
    expect(LeaseJobSchema.safeParse({ ...base, leaseId: "x" }).success).toBe(false);
  });

  it("validates each priorFindings element", () => {
    const goodPrior = {
      path: "a",
      line: 0, // allowed for PriorFinding
      severity: "info" as const,
      title: "t",
      body: "b",
    };
    expect(
      LeaseJobSchema.safeParse({ ...base, priorFindings: [goodPrior] }).success,
    ).toBe(true);
    expect(
      LeaseJobSchema.safeParse({
        ...base,
        priorFindings: [{ ...goodPrior, severity: "nope" }],
      }).success,
    ).toBe(false);
  });

  it("REJECTS a non-integer prNumber", () => {
    expect(LeaseJobSchema.safeParse({ ...base, prNumber: 1.5 }).success).toBe(false);
  });
});

describe("LeaseResponseSchema", () => {
  it("accepts job=null (no work right now)", () => {
    expect(LeaseResponseSchema.safeParse({ job: null }).success).toBe(true);
  });

  it("REJECTS a malformed nested job", () => {
    expect(LeaseResponseSchema.safeParse({ job: { jobId: "x" } }).success).toBe(false);
  });
});

// ── JobResultSchema ────────────────────────────────────────────────────────────
describe("JobResultSchema", () => {
  const base = {
    leaseId: UUID,
    sessionId: null as string | null,
    verdict: "approve" as const,
    summary: "ok",
    findings: [] as unknown[],
    totalCostUsd: 0.12,
    inputTokens: 100,
    outputTokens: 200,
    wallMs: 1500,
  };

  it("round-trips a valid result and defaults concerns/suggestedFixes to []", () => {
    const r = JobResultSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.concerns).toEqual([]);
      expect(r.data.suggestedFixes).toEqual([]);
    }
  });

  it("accepts modelUsed omitted, null, and a string (optional + nullable)", () => {
    expect(JobResultSchema.safeParse(base).success).toBe(true); // omitted
    const omitted = JobResultSchema.safeParse(base);
    if (omitted.success) expect(omitted.data.modelUsed).toBeUndefined();
    expect(JobResultSchema.safeParse({ ...base, modelUsed: null }).success).toBe(true);
    const withModel = JobResultSchema.safeParse({ ...base, modelUsed: "claude-opus" });
    expect(withModel.success).toBe(true);
    if (withModel.success) expect(withModel.data.modelUsed).toBe("claude-opus");
  });

  it("REJECTS a negative totalCostUsd (.nonnegative())", () => {
    expect(JobResultSchema.safeParse({ ...base, totalCostUsd: -0.01 }).success).toBe(
      false,
    );
  });

  it("accepts totalCostUsd=0 (nonnegative boundary)", () => {
    expect(JobResultSchema.safeParse({ ...base, totalCostUsd: 0 }).success).toBe(true);
  });

  it("accepts inputTokens/outputTokens = null (nullable)", () => {
    expect(
      JobResultSchema.safeParse({ ...base, inputTokens: null, outputTokens: null })
        .success,
    ).toBe(true);
  });

  it("REJECTS negative inputTokens / outputTokens", () => {
    expect(JobResultSchema.safeParse({ ...base, inputTokens: -1 }).success).toBe(false);
    expect(JobResultSchema.safeParse({ ...base, outputTokens: -1 }).success).toBe(
      false,
    );
  });

  it("REJECTS float inputTokens / outputTokens (must be .int())", () => {
    expect(JobResultSchema.safeParse({ ...base, inputTokens: 1.5 }).success).toBe(
      false,
    );
    expect(JobResultSchema.safeParse({ ...base, outputTokens: 1.5 }).success).toBe(
      false,
    );
  });

  it("accepts inputTokens/outputTokens = 0", () => {
    expect(
      JobResultSchema.safeParse({ ...base, inputTokens: 0, outputTokens: 0 }).success,
    ).toBe(true);
  });

  it("requires wallMs to be a nonnegative integer", () => {
    expect(JobResultSchema.safeParse({ ...base, wallMs: 0 }).success).toBe(true);
    expect(JobResultSchema.safeParse({ ...base, wallMs: -1 }).success).toBe(false);
    expect(JobResultSchema.safeParse({ ...base, wallMs: 1.5 }).success).toBe(false);
    // wallMs is NOT nullable on a result (it IS on JobError)
    expect(JobResultSchema.safeParse({ ...base, wallMs: null }).success).toBe(false);
  });

  it("REJECTS a bad uuid leaseId", () => {
    expect(JobResultSchema.safeParse({ ...base, leaseId: "nope" }).success).toBe(false);
  });

  it("accepts sessionId=null and a string", () => {
    expect(JobResultSchema.safeParse({ ...base, sessionId: null }).success).toBe(true);
    expect(JobResultSchema.safeParse({ ...base, sessionId: "abc" }).success).toBe(true);
  });

  it("validates each finding element", () => {
    expect(
      JobResultSchema.safeParse({
        ...base,
        findings: [{ path: "a", line: 0, severity: "high", title: "t", body: "b" }],
      }).success,
    ).toBe(false); // line=0 invalid for AgentFinding
  });
});

// ── JobErrorSchema ─────────────────────────────────────────────────────────────
describe("JobErrorSchema", () => {
  const base = {
    leaseId: UUID,
    message: "boom",
    totalCostUsd: null as number | null,
    wallMs: null as number | null,
  };

  it("round-trips with nullable totalCostUsd and wallMs both null", () => {
    expect(JobErrorSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a nonnegative numeric totalCostUsd and integer wallMs", () => {
    expect(
      JobErrorSchema.safeParse({ ...base, totalCostUsd: 0.5, wallMs: 100 }).success,
    ).toBe(true);
  });

  it("REJECTS a negative totalCostUsd (.nonnegative())", () => {
    expect(JobErrorSchema.safeParse({ ...base, totalCostUsd: -1 }).success).toBe(false);
  });

  it("REJECTS a float wallMs (.int())", () => {
    expect(JobErrorSchema.safeParse({ ...base, wallMs: 1.5 }).success).toBe(false);
  });

  it("REJECTS a bad uuid leaseId", () => {
    expect(JobErrorSchema.safeParse({ ...base, leaseId: "x" }).success).toBe(false);
  });

  it("requires a message field", () => {
    const noMsg: Record<string, unknown> = { ...base };
    delete noMsg.message;
    expect(JobErrorSchema.safeParse(noMsg).success).toBe(false);
  });
});

// ── ApiErrorSchema ─────────────────────────────────────────────────────────────
describe("ApiErrorSchema", () => {
  it("accepts { error: { code, message } } with fields omitted", () => {
    expect(
      ApiErrorSchema.safeParse({ error: { code: "BAD", message: "nope" } }).success,
    ).toBe(true);
  });

  it("accepts an optional fields record of string→string", () => {
    expect(
      ApiErrorSchema.safeParse({
        error: { code: "VALIDATION", message: "bad", fields: { name: "required" } },
      }).success,
    ).toBe(true);
  });

  it("REJECTS a fields record with non-string values", () => {
    expect(
      ApiErrorSchema.safeParse({
        error: { code: "X", message: "y", fields: { n: 123 } },
      }).success,
    ).toBe(false);
  });

  it("REJECTS a missing code or message", () => {
    expect(ApiErrorSchema.safeParse({ error: { message: "x" } }).success).toBe(false);
    expect(ApiErrorSchema.safeParse({ error: { code: "x" } }).success).toBe(false);
  });

  it("REJECTS a top-level shape without the error wrapper", () => {
    expect(ApiErrorSchema.safeParse({ code: "x", message: "y" }).success).toBe(false);
  });
});
