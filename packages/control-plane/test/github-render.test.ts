import { describe, expect, it } from "vitest";
import type { AgentFinding, Severity } from "@agentpr/shared";
import { renderTemplateBody } from "../src/github/app.js";

// Pure-unit tests for renderTemplateBody. postReview needs Octokit and is NOT
// exercised here.

const finding = (over: Partial<AgentFinding> = {}): AgentFinding => ({
  path: "src/foo.ts",
  line: 12,
  severity: "medium",
  title: "Title",
  body: "Body text",
  ...over,
});

const baseOpts = {
  verdict: "comment" as const,
  summary: "Looks mostly fine.",
  findings: [] as AgentFinding[],
  concerns: [] as string[],
  suggestedFixes: [] as string[],
  modelName: "claude-opus-4",
  round: 1,
};

// Extract the text block under a given "### " heading up to the next blank line
// boundary / next heading, so we can assert which bucket a finding landed in.
function bucketText(body: string, heading: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l === heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("### ") || l.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("renderTemplateBody — severity bucketing", () => {
  it("routes all 5 severities into the right 🔴/🟡/🟢 bucket and drops none", () => {
    const severities: Severity[] = ["critical", "high", "medium", "low", "info"];
    const findings = severities.map((s) => finding({ severity: s, title: `T-${s}`, path: `${s}.ts` }));
    const body = renderTemplateBody({ ...baseOpts, findings });

    const high = bucketText(body, "### 🔴 High");
    const medium = bucketText(body, "### 🟡 Medium");
    const low = bucketText(body, "### 🟢 Low");

    // critical + high → High bucket
    expect(high).toContain("T-critical");
    expect(high).toContain("T-high");
    // medium → Medium bucket
    expect(medium).toContain("T-medium");
    // low + info → Low bucket
    expect(low).toContain("T-low");
    expect(low).toContain("T-info");

    // none vanished
    for (const s of severities) expect(body).toContain(`T-${s}`);

    // none leaked into the wrong bucket
    expect(high).not.toContain("T-medium");
    expect(high).not.toContain("T-low");
    expect(medium).not.toContain("T-critical");
    expect(medium).not.toContain("T-low");
    expect(low).not.toContain("T-high");
    expect(low).not.toContain("T-medium");
  });

  it("renders 'None.' for every empty severity bucket", () => {
    const body = renderTemplateBody({ ...baseOpts, findings: [] });
    expect(bucketText(body, "### 🔴 High").trim()).toBe("None.");
    expect(bucketText(body, "### 🟡 Medium").trim()).toBe("None.");
    expect(bucketText(body, "### 🟢 Low").trim()).toBe("None.");
  });
});

describe("renderTemplateBody — finding location formatting", () => {
  it("renders path:line when a line number is present", () => {
    const body = renderTemplateBody({
      ...baseOpts,
      findings: [finding({ path: "src/a.ts", line: 99, severity: "low" })],
    });
    expect(body).toContain("`src/a.ts:99`");
  });

  it("renders just the path when line is null", () => {
    const body = renderTemplateBody({
      ...baseOpts,
      findings: [finding({ path: "src/a.ts", line: null, severity: "low" })],
    });
    expect(body).toContain("`src/a.ts`");
    expect(body).not.toContain("src/a.ts:");
  });

  it("indents a multi-line finding body so it stays inside the markdown bullet", () => {
    const body = renderTemplateBody({
      ...baseOpts,
      findings: [finding({ severity: "low", body: "line1\nline2" })],
    });
    // renderFindingLine replaces \n with "\n  " (two-space continuation).
    expect(body).toContain("line1\n  line2");
  });
});

describe("renderTemplateBody — concerns and suggested fixes", () => {
  it("renders concerns as '- <c>' bullet lines", () => {
    const body = renderTemplateBody({
      ...baseOpts,
      concerns: ["scope creep?", "missing tests"],
    });
    expect(bucketText(body, "## Concerns")).toContain("- scope creep?");
    expect(bucketText(body, "## Concerns")).toContain("- missing tests");
  });

  it("renders 'None.' when there are no concerns", () => {
    const body = renderTemplateBody({ ...baseOpts, concerns: [] });
    expect(bucketText(body, "## Concerns").trim()).toBe("None.");
  });

  it("renders suggested fixes as a 1./2. numbered list", () => {
    const body = renderTemplateBody({
      ...baseOpts,
      suggestedFixes: ["do X", "then Y"],
    });
    const fixes = bucketText(body, "## Suggested fixes");
    expect(fixes).toContain("1. do X");
    expect(fixes).toContain("2. then Y");
  });

  it("renders 'None.' when there are no suggested fixes", () => {
    const body = renderTemplateBody({ ...baseOpts, suggestedFixes: [] });
    // "## Suggested fixes" is the last section before the --- footer; assert the
    // section line is exactly "None." and no numbered item was emitted.
    const section = bucketText(body, "## Suggested fixes");
    expect(section).toContain("None.");
    expect(section).not.toMatch(/^\d+\. /m);
  });
});

describe("renderTemplateBody — verdict label mapping", () => {
  it("maps approve → 'Approve'", () => {
    const body = renderTemplateBody({ ...baseOpts, verdict: "approve" });
    expect(body).toContain("**Verdict:** Approve");
  });

  it("maps request_changes → 'Request changes'", () => {
    const body = renderTemplateBody({ ...baseOpts, verdict: "request_changes" });
    expect(body).toContain("**Verdict:** Request changes");
  });

  it("maps comment → 'Comment'", () => {
    const body = renderTemplateBody({ ...baseOpts, verdict: "comment" });
    expect(body).toContain("**Verdict:** Comment");
  });
});

describe("renderTemplateBody — footer", () => {
  it("stamps the reviewer model and round", () => {
    const body = renderTemplateBody({
      ...baseOpts,
      modelName: "claude-sonnet-4-5",
      round: 3,
    });
    expect(body).toContain("**Reviewed by:** claude-sonnet-4-5 · round 3");
  });

  it("includes the review summary and verdict header", () => {
    const body = renderTemplateBody({ ...baseOpts, summary: "All clear." });
    expect(body).toContain("## Review summary");
    expect(body).toContain("All clear.");
  });

  it("stamps the documented fallback name when the model is unknown", () => {
    // The control plane passes `repo.model ?? "unknown model"` when the runner
    // could not resolve a model name — the footer must render it verbatim.
    const body = renderTemplateBody({ ...baseOpts, modelName: "unknown model", round: 1 });
    expect(body).toContain("**Reviewed by:** unknown model · round 1");
  });
});
