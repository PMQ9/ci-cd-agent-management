import { z } from "zod";
import { PROVIDERS, SEVERITIES, VERDICTS } from "./enums";

// ── Agent output ────────────────────────────────────────────────────────────
// The exact JSON shape we ask `claude -p` to emit. The runner parses the agent's
// stdout against this; the control plane re-parses before persisting.

export const AgentFindingSchema = z.object({
  path: z.string().describe("repo-relative file path"),
  line: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("line in the new file, or null for file-level"),
  severity: z.enum(SEVERITIES),
  title: z.string().min(1),
  body: z.string().min(1).describe("explanation + suggested fix, markdown"),
});
export type AgentFinding = z.infer<typeof AgentFindingSchema>;

export const ReviewOutputSchema = z.object({
  verdict: z.enum(VERDICTS),
  summary: z.string().min(1).describe("1-3 sentence overall summary"),
  findings: z.array(AgentFindingSchema),
  // Template sections beyond findings. Optional + default [] so older runners /
  // agents that omit them never break parsing.
  concerns: z
    .array(z.string())
    .default([])
    .describe("open questions / risky assumptions / out-of-scope flags"),
  suggestedFixes: z
    .array(z.string())
    .default([])
    .describe("prioritized concrete actions, reference file:line where possible"),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

// The canonical "emit exactly this JSON" instruction. Lives next to ReviewOutputSchema
// so the prompt the agent sees and the schema the runner parses share ONE source and
// can't drift. The control plane always appends this (it is not user-editable), so a
// dashboard edit can never break the parser.
export const REVIEW_OUTPUT_CONTRACT_PROMPT = [
  `Respond with ONLY a JSON object (no markdown fences, no prose) of this exact shape:`,
  `{"verdict":"approve|request_changes|comment","summary":"1-3 sentences",`,
  `"findings":[{"path":"repo/relative/path","line":<integer or null>,"severity":"critical|high|medium|low|info","title":"short","body":"explanation + suggested fix"}],`,
  `"concerns":["open question or risky assumption", "..."],`,
  `"suggestedFixes":["prioritized action, reference file:line where possible", "..."]}`,
  `Map every finding into "findings" with its severity. Put open questions / out-of-scope flags in "concerns"`,
  `and the highest-leverage actions in "suggestedFixes". Use empty arrays where a section has nothing.`,
  `Use "approve" only if there are no findings. Use "request_changes" if any finding is high or critical.`,
].join("\n");

// A prior round's findings, passed back to the runner so the agent can verify
// resolved/regressed status on a re-review.
export const PriorFindingSchema = z.object({
  path: z.string(),
  line: z.number().int().nullable(),
  severity: z.enum(SEVERITIES),
  title: z.string(),
  body: z.string(),
});
export type PriorFinding = z.infer<typeof PriorFindingSchema>;

// ── Runner enrollment ─────────────────────────────────────────────────────────
export const EnrollRequestSchema = z.object({
  enrollmentSecret: z.string().min(1),
  name: z.string().min(1),
  capabilities: z.object({
    providers: z.array(z.enum(PROVIDERS)).min(1),
    version: z.string().optional(),
  }),
});
export type EnrollRequest = z.infer<typeof EnrollRequestSchema>;

export const EnrollResponseSchema = z.object({
  runnerId: z.string().uuid(),
  // Durable bearer token the runner stores and sends on every poll/report.
  runnerToken: z.string().min(1),
});
export type EnrollResponse = z.infer<typeof EnrollResponseSchema>;

// ── Lease (control plane → runner) ─────────────────────────────────────────────
// The runner long-polls /lease; if a job is available it gets a LeaseJob. The
// githubToken is a freshly-minted, 1-hour, single-repo-scoped installation token.
export const LeaseJobSchema = z.object({
  jobId: z.string().uuid(),
  leaseId: z.string().uuid(),
  repoFullName: z.string(),
  cloneUrl: z.string().url(),
  prNumber: z.number().int(),
  headSha: z.string(),
  baseSha: z.string(),
  provider: z.enum(PROVIDERS),
  model: z.string().nullable(),
  round: z.number().int(),
  githubToken: z.string().min(1),
  // The fully-assembled review instruction (persona + strict-template rules + the
  // active template + JSON contract). Optional for backward-compat: a runner that
  // predates this field falls back to its local builder. The control plane always
  // sends it so new runners enforce the template.
  reviewInstruction: z.string().optional(),
  // Re-review context:
  resumeSessionId: z.string().nullable(),
  priorFindings: z.array(PriorFindingSchema),
});
export type LeaseJob = z.infer<typeof LeaseJobSchema>;

export const LeaseResponseSchema = z.object({
  job: LeaseJobSchema.nullable(), // null = no work right now (long-poll timed out)
});
export type LeaseResponse = z.infer<typeof LeaseResponseSchema>;

// ── Result / error (runner → control plane) ────────────────────────────────────
// Idempotent on leaseId: re-POSTing the same leaseId is a no-op after the first.
export const JobResultSchema = z.object({
  leaseId: z.string().uuid(),
  sessionId: z.string().nullable(),
  verdict: z.enum(VERDICTS),
  summary: z.string(),
  findings: z.array(AgentFindingSchema),
  // Template sections + the model the runner actually used (for the mandatory
  // "Reviewed by: <model>" line). All optional so an un-upgraded runner's POST
  // still validates — a required field here would 400 and lose the result.
  concerns: z.array(z.string()).default([]),
  suggestedFixes: z.array(z.string()).default([]),
  modelUsed: z.string().nullable().optional(),
  totalCostUsd: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  wallMs: z.number().int().nonnegative(),
});
export type JobResult = z.infer<typeof JobResultSchema>;

export const JobErrorSchema = z.object({
  leaseId: z.string().uuid(),
  message: z.string(),
  // Optional partial cost so quota accounting is still recorded on failure.
  totalCostUsd: z.number().nonnegative().nullable(),
  wallMs: z.number().int().nonnegative().nullable(),
});
export type JobError = z.infer<typeof JobErrorSchema>;

// ── Generic API error envelope (consistent across every endpoint) ──────────────
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
