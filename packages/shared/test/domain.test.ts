import {
  FindingSchema,
  JobSchema,
  PullRequestSchema,
  RepoSchema,
  ReviewSchema,
  RunnerSchema,
  UsageEventSchema,
} from "@agentpr/shared";
import { describe, expect, it } from "vitest";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const UUID2 = "00000000-0000-4000-8000-000000000000";
const ISO = "2026-06-23T12:00:00.000Z";

// Each domain entity: round-trip a valid instance, then assert a representative
// invalid one is rejected (bad uuid / negative cost / bad enum / non-ISO date).

describe("RepoSchema", () => {
  const valid = {
    id: UUID,
    installationId: 42,
    fullName: "owner/name",
    isPrivate: true,
    defaultBranch: "main",
    autoReviewEnabled: false,
    provider: "claude_code" as const,
    model: null as string | null,
    dailyCostCapUsd: 5 as number | null,
    createdAt: ISO,
  };

  it("round-trips a valid repo (model & cap nullable)", () => {
    expect(RepoSchema.safeParse(valid).success).toBe(true);
    expect(
      RepoSchema.safeParse({ ...valid, model: "claude-opus", dailyCostCapUsd: null }).success,
    ).toBe(true);
  });

  it("REJECTS a non-uuid id", () => {
    expect(RepoSchema.safeParse({ ...valid, id: "nope" }).success).toBe(false);
  });

  it("REJECTS a negative dailyCostCapUsd (.nonnegative())", () => {
    expect(RepoSchema.safeParse({ ...valid, dailyCostCapUsd: -1 }).success).toBe(false);
  });

  it("REJECTS an invalid provider enum", () => {
    expect(RepoSchema.safeParse({ ...valid, provider: "bedrock" }).success).toBe(false);
  });

  it("REJECTS a non-ISO createdAt", () => {
    expect(RepoSchema.safeParse({ ...valid, createdAt: "yesterday" }).success).toBe(false);
  });

  it("REJECTS a non-integer installationId", () => {
    expect(RepoSchema.safeParse({ ...valid, installationId: 1.5 }).success).toBe(false);
  });
});

describe("PullRequestSchema", () => {
  const valid = {
    id: UUID,
    repoId: UUID2,
    number: 7,
    title: "feat: thing",
    author: "octocat" as string | null,
    headSha: "abc",
    baseSha: "def",
    isDraft: false,
    state: "open" as const,
    htmlUrl: "https://github.com/o/r/pull/7",
    prUpdatedAt: ISO as string | null,
    createdAt: ISO,
    updatedAt: ISO,
  };

  it("round-trips a valid PR (author & prUpdatedAt nullable)", () => {
    expect(PullRequestSchema.safeParse(valid).success).toBe(true);
    expect(PullRequestSchema.safeParse({ ...valid, author: null, prUpdatedAt: null }).success).toBe(
      true,
    );
  });

  it("REJECTS an invalid state enum", () => {
    expect(PullRequestSchema.safeParse({ ...valid, state: "reopened" }).success).toBe(false);
  });

  it("REJECTS a non-uuid repoId", () => {
    expect(PullRequestSchema.safeParse({ ...valid, repoId: "x" }).success).toBe(false);
  });

  it("REJECTS a non-ISO prUpdatedAt string", () => {
    expect(PullRequestSchema.safeParse({ ...valid, prUpdatedAt: "soon" }).success).toBe(false);
  });
});

describe("RunnerSchema", () => {
  const valid = {
    id: UUID,
    name: "macbook",
    status: "online" as const,
    lastSeenAt: ISO as string | null,
    capabilities: { providers: ["claude_code"], version: "0.2.0" },
    revokedAt: null as string | null,
    createdAt: ISO,
  };

  it("round-trips a valid runner", () => {
    expect(RunnerSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts capabilities without version and lastSeenAt=null", () => {
    expect(
      RunnerSchema.safeParse({
        ...valid,
        lastSeenAt: null,
        capabilities: { providers: ["claude_code"] },
      }).success,
    ).toBe(true);
  });

  it("REJECTS an invalid status enum", () => {
    expect(RunnerSchema.safeParse({ ...valid, status: "idle" }).success).toBe(false);
  });

  it("REJECTS an invalid provider in capabilities", () => {
    expect(RunnerSchema.safeParse({ ...valid, capabilities: { providers: ["gpt"] } }).success).toBe(
      false,
    );
  });
});

describe("JobSchema", () => {
  const valid = {
    id: UUID,
    repoId: UUID2,
    prNumber: 3,
    headSha: "abc",
    baseSha: "def",
    trigger: "auto" as const,
    state: "queued" as const,
    round: 1,
    leasedByRunner: null as string | null,
    preferredRunnerId: null as string | null,
    claudeSessionId: null as string | null,
    attempts: 0,
    errorMessage: null as string | null,
    createdAt: ISO,
    updatedAt: ISO,
  };

  it("round-trips a valid job", () => {
    expect(JobSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts uuid leasedByRunner / preferredRunnerId", () => {
    expect(
      JobSchema.safeParse({ ...valid, leasedByRunner: UUID, preferredRunnerId: UUID2 }).success,
    ).toBe(true);
  });

  it("REJECTS an invalid trigger enum", () => {
    expect(JobSchema.safeParse({ ...valid, trigger: "cron" }).success).toBe(false);
  });

  it("REJECTS an invalid state enum", () => {
    expect(JobSchema.safeParse({ ...valid, state: "pending" }).success).toBe(false);
  });

  it("REJECTS a non-uuid leasedByRunner when present", () => {
    expect(JobSchema.safeParse({ ...valid, leasedByRunner: "x" }).success).toBe(false);
  });
});

describe("FindingSchema", () => {
  const valid = {
    id: UUID,
    reviewId: UUID2,
    path: "src/a.ts",
    line: 12 as number | null,
    severity: "high" as const,
    title: "t",
    body: "b",
    status: "open" as const,
    prevFindingId: null as string | null,
  };

  it("round-trips a valid finding; line nullable; allows line=0 (.int().nullable())", () => {
    expect(FindingSchema.safeParse(valid).success).toBe(true);
    expect(FindingSchema.safeParse({ ...valid, line: null }).success).toBe(true);
    expect(FindingSchema.safeParse({ ...valid, line: 0 }).success).toBe(true);
  });

  it("REJECTS an invalid status enum", () => {
    expect(FindingSchema.safeParse({ ...valid, status: "done" }).success).toBe(false);
  });

  it("REJECTS an invalid severity enum", () => {
    expect(FindingSchema.safeParse({ ...valid, severity: "blocker" }).success).toBe(false);
  });

  it("REJECTS a non-uuid reviewId", () => {
    expect(FindingSchema.safeParse({ ...valid, reviewId: "x" }).success).toBe(false);
  });

  it("accepts a uuid prevFindingId (cross-round link)", () => {
    expect(FindingSchema.safeParse({ ...valid, prevFindingId: UUID }).success).toBe(true);
  });
});

describe("ReviewSchema", () => {
  const valid = {
    id: UUID,
    jobId: UUID2,
    round: 1,
    githubReviewId: 999 as number | null,
    verdict: "approve" as const,
    summary: "ok",
    createdAt: ISO,
  };

  it("round-trips a valid review; githubReviewId nullable", () => {
    expect(ReviewSchema.safeParse(valid).success).toBe(true);
    expect(ReviewSchema.safeParse({ ...valid, githubReviewId: null }).success).toBe(true);
  });

  it("REJECTS an invalid verdict enum", () => {
    expect(ReviewSchema.safeParse({ ...valid, verdict: "merge" }).success).toBe(false);
  });

  it("REJECTS a non-integer githubReviewId", () => {
    expect(ReviewSchema.safeParse({ ...valid, githubReviewId: 1.5 }).success).toBe(false);
  });
});

describe("UsageEventSchema", () => {
  const valid = {
    id: UUID,
    jobId: UUID2 as string | null,
    runnerId: null as string | null,
    model: "claude-opus" as string | null,
    inputTokens: 100 as number | null,
    outputTokens: 200 as number | null,
    costUsd: 0.05,
    wallMs: 1200 as number | null,
    createdAt: ISO,
  };

  it("round-trips a valid usage event (jobId/runnerId/model/tokens/wallMs nullable)", () => {
    expect(UsageEventSchema.safeParse(valid).success).toBe(true);
    expect(
      UsageEventSchema.safeParse({
        ...valid,
        jobId: null,
        runnerId: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
        wallMs: null,
      }).success,
    ).toBe(true);
  });

  it("REJECTS a negative costUsd (.nonnegative())", () => {
    expect(UsageEventSchema.safeParse({ ...valid, costUsd: -0.01 }).success).toBe(false);
  });

  it("accepts costUsd=0 (nonnegative boundary)", () => {
    expect(UsageEventSchema.safeParse({ ...valid, costUsd: 0 }).success).toBe(true);
  });

  it("REJECTS a float inputTokens (.int())", () => {
    expect(UsageEventSchema.safeParse({ ...valid, inputTokens: 1.5 }).success).toBe(false);
  });

  it("REJECTS a non-uuid id", () => {
    expect(UsageEventSchema.safeParse({ ...valid, id: "x" }).success).toBe(false);
  });
});
