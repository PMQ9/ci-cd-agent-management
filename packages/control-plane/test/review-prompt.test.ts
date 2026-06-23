import { type PriorFinding, REVIEW_OUTPUT_CONTRACT_PROMPT } from "@agentpr/shared";
import { describe, expect, it } from "vitest";
import {
  assembleReviewInstruction,
  type ReviewContext,
  type ReviewPromptParts,
} from "../src/review-prompt.js";

// Pure-unit tests for the prompt assembler. We build `parts` inline (NOT via
// loadReviewPromptParts, which needs the DB) so nothing here touches Postgres.

const makeParts = (over: Partial<ReviewPromptParts> = {}): ReviewPromptParts => ({
  persona: "You are a meticulous senior reviewer.",
  rules: "Follow the template exactly. Cite file:line.",
  rereview: "Verify whether prior findings are resolved or regressed.",
  templateName: "PR Review",
  templateContent: "## Summary\n## Findings\n## Verdict",
  ...over,
});

const makeCtx = (over: Partial<ReviewContext> = {}): ReviewContext => ({
  repoFullName: "octo/widgets",
  prNumber: 42,
  baseSha: "abcdef0123456789abcdef",
  headSha: "fedcba9876543210fedcba",
  round: 1,
  priorFindings: [],
  ...over,
});

const priorFinding = (over: Partial<PriorFinding> = {}): PriorFinding => ({
  path: "src/index.ts",
  line: 10,
  severity: "high",
  title: "Null deref",
  body: "x may be undefined",
  ...over,
});

describe("assembleReviewInstruction — round 1 (initial review)", () => {
  it("starts with the PR header containing the 12-char base/head slices and the stdin note", () => {
    const out = assembleReviewInstruction(makeParts(), makeCtx());
    expect(
      out.startsWith(
        "Reviewing PR #42 of octo/widgets (base abcdef012345 .. head fedcba987654). The diff is on stdin.",
      ),
    ).toBe(true);
  });

  it("includes the trimmed persona and rules", () => {
    const out = assembleReviewInstruction(
      makeParts({ persona: "  PERSONA-X  ", rules: "  RULES-Y  " }),
      makeCtx(),
    );
    expect(out).toContain("PERSONA-X");
    expect(out).toContain("RULES-Y");
    // trimmed: surrounding whitespace not present as part of the inserted block
    expect(out).not.toContain("  PERSONA-X  ");
    expect(out).not.toContain("  RULES-Y  ");
  });

  it("wraps the active template in the labeled template block with trimmed content", () => {
    const out = assembleReviewInstruction(
      makeParts({ templateName: "Rubric", templateContent: "  ## A\n## B  " }),
      makeCtx(),
    );
    expect(out).toContain('--- REVIEW TEMPLATE: "Rubric" (fill every section) ---');
    expect(out).toContain("--- END REVIEW TEMPLATE ---");
    expect(out).toContain("## A\n## B");
    // the END marker comes after the START marker
    expect(out.indexOf("--- END REVIEW TEMPLATE ---")).toBeGreaterThan(
      out.indexOf('--- REVIEW TEMPLATE: "Rubric"'),
    );
  });

  it("ends with the fixed JSON output contract from @agentpr/shared", () => {
    const out = assembleReviewInstruction(makeParts(), makeCtx());
    expect(out.endsWith(REVIEW_OUTPUT_CONTRACT_PROMPT)).toBe(true);
  });

  it("emits NO re-review block on round 1", () => {
    const out = assembleReviewInstruction(makeParts(), makeCtx({ round: 1 }));
    expect(out).not.toContain("RE-REVIEW round");
    expect(out).not.toContain("Previous round's findings:");
  });

  it("omits the re-review block on round 1 even when findings are present", () => {
    const out = assembleReviewInstruction(
      makeParts(),
      makeCtx({ round: 1, priorFindings: [priorFinding()] }),
    );
    expect(out).not.toContain("RE-REVIEW round");
    expect(out).not.toContain("Previous round's findings:");
  });
});

describe("assembleReviewInstruction — re-review (round > 1)", () => {
  it("includes the re-review header, trimmed rereview text, the findings label, and pretty-printed JSON", () => {
    const findings = [priorFinding(), priorFinding({ path: "b.ts", line: null, severity: "low" })];
    const out = assembleReviewInstruction(
      makeParts({ rereview: "  RE-REVIEW-TEXT  " }),
      makeCtx({ round: 3, priorFindings: findings }),
    );
    expect(out).toContain("RE-REVIEW round 3.");
    expect(out).toContain("RE-REVIEW-TEXT");
    expect(out).not.toContain("  RE-REVIEW-TEXT  ");
    expect(out).toContain("Previous round's findings:");
    expect(out).toContain(JSON.stringify(findings, null, 2));
  });

  it("still ends with the JSON contract after the re-review block", () => {
    const out = assembleReviewInstruction(
      makeParts(),
      makeCtx({ round: 2, priorFindings: [priorFinding()] }),
    );
    expect(out.endsWith(REVIEW_OUTPUT_CONTRACT_PROMPT)).toBe(true);
    // re-review block sits before the contract
    expect(out.indexOf("RE-REVIEW round 2.")).toBeLessThan(
      out.indexOf(REVIEW_OUTPUT_CONTRACT_PROMPT),
    );
  });

  it("OMITS the re-review block when round > 1 but priorFindings is empty (boundary)", () => {
    const out = assembleReviewInstruction(makeParts(), makeCtx({ round: 5, priorFindings: [] }));
    expect(out).not.toContain("RE-REVIEW round");
    expect(out).not.toContain("Previous round's findings:");
  });
});

describe("assembleReviewInstruction — SHA slicing", () => {
  it("slices to 12 chars without padding when SHAs are longer", () => {
    const out = assembleReviewInstruction(
      makeParts(),
      makeCtx({ baseSha: "0123456789abcdefXXXX", headSha: "abcdefABCDEF0000zzzz" }),
    );
    expect(out).toContain("(base 0123456789ab .. head abcdefABCDEF). The diff is on stdin.");
  });

  it("does not pad when SHAs are SHORTER than 12 chars (exact substring)", () => {
    const out = assembleReviewInstruction(makeParts(), makeCtx({ baseSha: "abc", headSha: "de" }));
    expect(out).toContain("(base abc .. head de). The diff is on stdin.");
    // no padding characters / no spillover spaces between slice and the dots
    expect(out).not.toContain("base abc  ");
  });

  it("handles empty SHAs as empty substrings", () => {
    const out = assembleReviewInstruction(makeParts(), makeCtx({ baseSha: "", headSha: "" }));
    expect(out).toContain("(base  .. head ). The diff is on stdin.");
  });
});
