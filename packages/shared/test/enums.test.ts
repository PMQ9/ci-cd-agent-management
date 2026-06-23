import {
  ACTIVE_JOB_STATES,
  FINDING_STATUSES,
  JOB_STATES,
  PR_STATES,
  PROVIDERS,
  REVIEW_OUTPUT_CONTRACT_PROMPT,
  RUNNER_STATUSES,
  SEVERITIES,
  TEMPLATE_KINDS,
  TERMINAL_JOB_STATES,
  TRIGGER_SOURCES,
  VERDICTS,
} from "@agentpr/shared";
import { describe, expect, it } from "vitest";

// These tests pin the canonical enum tuples. enums.ts is the single source of
// truth shared by Zod and Drizzle pgEnums, so any drift here breaks the DB↔app
// contract. We assert EXACT membership (set equality) so adding/removing/renaming
// a value is caught.

const expectExactMembers = (actual: readonly string[], expected: string[]) => {
  // order-insensitive set equality + no duplicates
  expect([...actual].sort()).toEqual([...expected].sort());
  expect(new Set(actual).size).toBe(actual.length);
};

describe("enum tuple membership (drift guards)", () => {
  it("TRIGGER_SOURCES is exactly auto/manual/command", () => {
    expectExactMembers(TRIGGER_SOURCES, ["auto", "manual", "command"]);
  });

  it("JOB_STATES is exactly the 7 lifecycle states", () => {
    expectExactMembers(JOB_STATES, [
      "queued",
      "leased",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "superseded",
    ]);
  });

  it("ACTIVE_JOB_STATES is exactly queued/leased/running", () => {
    expectExactMembers(ACTIVE_JOB_STATES, ["queued", "leased", "running"]);
  });

  it("TERMINAL_JOB_STATES is exactly succeeded/failed/cancelled/superseded", () => {
    expectExactMembers(TERMINAL_JOB_STATES, ["succeeded", "failed", "cancelled", "superseded"]);
  });

  it("PROVIDERS is exactly claude_code/opencode", () => {
    expectExactMembers(PROVIDERS, ["claude_code", "opencode"]);
  });

  it("VERDICTS is exactly approve/request_changes/comment", () => {
    expectExactMembers(VERDICTS, ["approve", "request_changes", "comment"]);
  });

  it("FINDING_STATUSES is exactly open/resolved/regressed", () => {
    expectExactMembers(FINDING_STATUSES, ["open", "resolved", "regressed"]);
  });

  it("SEVERITIES is exactly critical/high/medium/low/info", () => {
    expectExactMembers(SEVERITIES, ["critical", "high", "medium", "low", "info"]);
  });

  it("RUNNER_STATUSES is exactly online/offline", () => {
    expectExactMembers(RUNNER_STATUSES, ["online", "offline"]);
  });

  it("PR_STATES is exactly open/closed/merged", () => {
    expectExactMembers(PR_STATES, ["open", "closed", "merged"]);
  });

  it("TEMPLATE_KINDS is exactly pr_review/pull_request/security_review", () => {
    expectExactMembers(TEMPLATE_KINDS, ["pr_review", "pull_request", "security_review"]);
  });
});

describe("ACTIVE_JOB_STATES + TERMINAL_JOB_STATES partition JOB_STATES", () => {
  it("have no overlap", () => {
    const active = new Set<string>(ACTIVE_JOB_STATES);
    const overlap = TERMINAL_JOB_STATES.filter((s) => active.has(s));
    expect(overlap).toEqual([]);
  });

  it("together cover every JOB_STATES value (full partition)", () => {
    const union = new Set<string>([...ACTIVE_JOB_STATES, ...TERMINAL_JOB_STATES]);
    expectExactMembers([...union], [...JOB_STATES]);
    // exact count: active + terminal == job states, with no overlap counted above
    expect(ACTIVE_JOB_STATES.length + TERMINAL_JOB_STATES.length).toBe(JOB_STATES.length);
  });

  it("every active state is a member of JOB_STATES", () => {
    for (const s of ACTIVE_JOB_STATES) {
      expect(JOB_STATES).toContain(s);
    }
  });

  it("every terminal state is a member of JOB_STATES", () => {
    for (const s of TERMINAL_JOB_STATES) {
      expect(JOB_STATES).toContain(s);
    }
  });
});

describe("REVIEW_OUTPUT_CONTRACT_PROMPT stays in sync with the enums", () => {
  it("mentions every severity name from SEVERITIES", () => {
    for (const sev of SEVERITIES) {
      expect(
        REVIEW_OUTPUT_CONTRACT_PROMPT,
        `contract prompt must mention severity "${sev}"`,
      ).toContain(sev);
    }
  });

  it("mentions every verdict name from VERDICTS", () => {
    for (const verdict of VERDICTS) {
      expect(
        REVIEW_OUTPUT_CONTRACT_PROMPT,
        `contract prompt must mention verdict "${verdict}"`,
      ).toContain(verdict);
    }
  });

  it("is a non-empty multi-line string", () => {
    expect(typeof REVIEW_OUTPUT_CONTRACT_PROMPT).toBe("string");
    expect(REVIEW_OUTPUT_CONTRACT_PROMPT.length).toBeGreaterThan(0);
    expect(REVIEW_OUTPUT_CONTRACT_PROMPT).toContain("\n");
  });
});
