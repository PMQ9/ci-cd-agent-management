// Single source of truth for enum value sets. Both the Zod schemas (runtime
// validation) and the Drizzle pgEnum definitions (DB) import these tuples, so a
// value can never drift between the database and the application.

export const TRIGGER_SOURCES = ["auto", "manual", "command"] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export const JOB_STATES = [
  "queued",
  "leased",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** States that still occupy a runner / queue slot. */
export const ACTIVE_JOB_STATES = ["queued", "leased", "running"] as const;
/** Terminal states. */
export const TERMINAL_JOB_STATES = [
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
] as const;

export const PROVIDERS = ["claude_code", "opencode"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const VERDICTS = ["approve", "request_changes", "comment"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const FINDING_STATUSES = ["open", "resolved", "regressed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const RUNNER_STATUSES = ["online", "offline"] as const;
export type RunnerStatus = (typeof RUNNER_STATUSES)[number];
