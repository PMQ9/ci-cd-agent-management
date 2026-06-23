import { describe, expect, it } from "vitest";
import {
  buildInstruction,
  emptyReview,
  extractJsonObject,
  extractModel,
  parseClaudeWrapper,
} from "../src/exec-claude.js";

// A minimal but schema-valid ReviewOutput as a JSON string the agent would emit.
const validReviewJson = JSON.stringify({
  verdict: "request_changes",
  summary: "One bug found.",
  findings: [
    {
      path: "src/a.ts",
      line: 12,
      severity: "high",
      title: "Off-by-one",
      body: "Loop runs one extra time; use < not <=.",
    },
  ],
  concerns: ["assumes UTF-8 input"],
  suggestedFixes: ["src/a.ts:12 change <= to <"],
});

describe("emptyReview", () => {
  it("returns a valid ReviewOutput with empty arrays and the given verdict/summary", () => {
    expect(emptyReview("comment", "hello")).toEqual({
      verdict: "comment",
      summary: "hello",
      findings: [],
      concerns: [],
      suggestedFixes: [],
    });
  });

  it("preserves the chosen verdict (approve)", () => {
    expect(emptyReview("approve", "lgtm").verdict).toBe("approve");
  });
});

describe("extractModel", () => {
  it("returns wrapper.model when it is a non-empty string", () => {
    expect(extractModel({ model: "claude-opus-4" })).toBe("claude-opus-4");
  });

  it("falls back to the first modelUsage key when model is an empty string", () => {
    expect(
      extractModel({ model: "", modelUsage: { "claude-sonnet-4": { input: 1 }, other: {} } }),
    ).toBe("claude-sonnet-4");
  });

  it("falls back to the first modelUsage key when model is absent", () => {
    expect(extractModel({ modelUsage: { "claude-haiku": {} } })).toBe("claude-haiku");
  });

  it("returns null when neither model nor a non-empty modelUsage is present", () => {
    expect(extractModel({})).toBeNull();
    expect(extractModel({ model: "" })).toBeNull();
    expect(extractModel({ modelUsage: {} })).toBeNull();
  });
});

describe("extractJsonObject", () => {
  it("strips a ```json fenced block and parses the inner object", () => {
    const text = '```json\n{"verdict":"approve","summary":"ok"}\n```';
    expect(extractJsonObject(text)).toEqual({ verdict: "approve", summary: "ok" });
  });

  it("strips a plain ``` fenced block (no json hint)", () => {
    const text = '```\n{"a":1}\n```';
    expect(extractJsonObject(text)).toEqual({ a: 1 });
  });

  it("extracts a prose-wrapped object from first { to last }", () => {
    const text = 'Here is my answer: {"verdict":"comment","summary":"hi"} thanks!';
    expect(extractJsonObject(text)).toEqual({ verdict: "comment", summary: "hi" });
  });

  it("takes the span from the FIRST { to the LAST } (nested objects survive)", () => {
    const text = 'noise {"a":{"b":2},"c":3} trailing';
    expect(extractJsonObject(text)).toEqual({ a: { b: 2 }, c: 3 });
  });

  it("throws 'no JSON object found' when there is no object", () => {
    expect(() => extractJsonObject("just prose, no braces here")).toThrow("no JSON object found");
  });
});

describe("parseClaudeWrapper", () => {
  it("parses a valid wrapper whose .result is a valid ReviewOutput JSON string", () => {
    const wrapper = JSON.stringify({
      result: validReviewJson,
      session_id: "sess-123",
      total_cost_usd: 0.0421,
      usage: { input_tokens: 1500, output_tokens: 320 },
      model: "claude-opus-4",
    });
    const out = parseClaudeWrapper(wrapper);
    expect(out.review.verdict).toBe("request_changes");
    expect(out.review.summary).toBe("One bug found.");
    expect(out.review.findings).toHaveLength(1);
    expect(out.review.concerns).toEqual(["assumes UTF-8 input"]);
    expect(out.review.suggestedFixes).toEqual(["src/a.ts:12 change <= to <"]);
    expect(out.sessionId).toBe("sess-123");
    expect(out.modelUsed).toBe("claude-opus-4");
    expect(out.totalCostUsd).toBe(0.0421);
    expect(out.inputTokens).toBe(1500);
    expect(out.outputTokens).toBe(320);
  });

  it("comment fallback when stdout is NOT JSON at all (metadata null/0)", () => {
    const out = parseClaudeWrapper("totally not json output");
    expect(out.review.verdict).toBe("comment");
    expect(out.review.summary).toBe("totally not json output");
    expect(out.review.findings).toEqual([]);
    expect(out.sessionId).toBeNull();
    expect(out.modelUsed).toBeNull();
    expect(out.totalCostUsd).toBe(0);
    expect(out.inputTokens).toBeNull();
    expect(out.outputTokens).toBeNull();
  });

  it("non-JSON empty stdout uses the '(empty agent output)' placeholder summary", () => {
    const out = parseClaudeWrapper("");
    expect(out.review.verdict).toBe("comment");
    expect(out.review.summary).toBe("(empty agent output)");
  });

  it("non-JSON stdout summary is truncated to 4000 chars", () => {
    const big = "x".repeat(5000);
    const out = parseClaudeWrapper(big);
    expect(out.review.summary).toHaveLength(4000);
  });

  it("valid wrapper but .result not parseable as ReviewOutput → comment fallback BUT metadata still extracted", () => {
    const wrapper = JSON.stringify({
      result: "I could not produce structured output, sorry.",
      session_id: "sess-xyz",
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet-4",
    });
    const out = parseClaudeWrapper(wrapper);
    expect(out.review.verdict).toBe("comment");
    // resultText has no braces → extractJsonObject throws → caught → fallback summary = resultText
    expect(out.review.summary).toBe("I could not produce structured output, sorry.");
    // Metadata STILL comes from the wrapper.
    expect(out.sessionId).toBe("sess-xyz");
    expect(out.modelUsed).toBe("claude-sonnet-4");
    expect(out.totalCostUsd).toBe(0.01);
    expect(out.inputTokens).toBe(10);
    expect(out.outputTokens).toBe(5);
  });

  it("valid wrapper with empty .result string → '(no structured output)' placeholder, metadata still extracted", () => {
    const wrapper = JSON.stringify({
      result: "",
      session_id: "sess-empty",
      total_cost_usd: 2,
    });
    const out = parseClaudeWrapper(wrapper);
    expect(out.review.verdict).toBe("comment");
    expect(out.review.summary).toBe("(no structured output)");
    expect(out.sessionId).toBe("sess-empty");
    expect(out.totalCostUsd).toBe(2);
  });

  it("parses .result wrapped in a ```json fenced block via extractJsonObject", () => {
    const fencedResult = "```json\n" + validReviewJson + "\n```";
    const wrapper = JSON.stringify({
      result: fencedResult,
      session_id: "sess-fence",
      total_cost_usd: 0.5,
      usage: { input_tokens: 100, output_tokens: 50 },
      model: "claude-opus-4",
    });
    const out = parseClaudeWrapper(wrapper);
    expect(out.review.verdict).toBe("request_changes");
    expect(out.review.findings).toHaveLength(1);
    expect(out.sessionId).toBe("sess-fence");
  });

  it("missing .usage → inputTokens/outputTokens null", () => {
    const wrapper = JSON.stringify({
      result: validReviewJson,
      session_id: "s",
      total_cost_usd: 1,
      model: "m",
    });
    const out = parseClaudeWrapper(wrapper);
    expect(out.inputTokens).toBeNull();
    expect(out.outputTokens).toBeNull();
  });

  it("non-number .total_cost_usd → coerced to 0", () => {
    const wrapper = JSON.stringify({
      result: validReviewJson,
      session_id: "s",
      total_cost_usd: "not-a-number",
      model: "m",
    });
    const out = parseClaudeWrapper(wrapper);
    expect(out.totalCostUsd).toBe(0);
  });

  it("non-string session_id → sessionId null", () => {
    const wrapper = JSON.stringify({
      result: validReviewJson,
      session_id: 12345,
      total_cost_usd: 1,
      model: "m",
    });
    const out = parseClaudeWrapper(wrapper);
    expect(out.sessionId).toBeNull();
  });
});

describe("buildInstruction", () => {
  const base = {
    repoFullName: "octocat/hello",
    prNumber: 7,
    baseSha: "1111111111111111",
    headSha: "2222222222222222",
  };

  it("round 1 has NO re-review block but always contains the JSON contract line", () => {
    const instr = buildInstruction({ ...base, round: 1, priorFindings: [] });
    expect(instr).not.toContain("RE-REVIEW round");
    expect(instr).toContain("Respond with ONLY a JSON object");
    // Identifying context is present.
    expect(instr).toContain("PR #7");
    expect(instr).toContain("octocat/hello");
  });

  it("round 1 with NO prior findings still omits the re-review block", () => {
    const instr = buildInstruction({ ...base, round: 1, priorFindings: [] });
    expect(instr).not.toContain("RE-REVIEW round");
  });

  it("round > 1 with priorFindings includes 'RE-REVIEW round N' and the serialized prior findings", () => {
    const priorFindings = [
      { path: "x.ts", line: 3, severity: "high" as const, title: "T", body: "B" },
    ];
    const instr = buildInstruction({ ...base, round: 2, priorFindings });
    expect(instr).toContain("RE-REVIEW round 2");
    expect(instr).toContain(JSON.stringify(priorFindings, null, 2));
    expect(instr).toContain("Respond with ONLY a JSON object");
  });

  it("round > 1 but EMPTY priorFindings omits the re-review block (guarded by length)", () => {
    const instr = buildInstruction({ ...base, round: 3, priorFindings: [] });
    expect(instr).not.toContain("RE-REVIEW round");
    expect(instr).toContain("Respond with ONLY a JSON object");
  });

  it("truncates the SHAs to 12 chars in the header line", () => {
    const instr = buildInstruction({
      repoFullName: "r/r",
      prNumber: 1,
      baseSha: "abcdefabcdef0000",
      headSha: "fedcbafedcba1111",
      round: 1,
      priorFindings: [],
    });
    expect(instr).toContain("abcdefabcdef");
    expect(instr).toContain("fedcbafedcba");
    expect(instr).not.toContain("abcdefabcdef0000");
  });
});
