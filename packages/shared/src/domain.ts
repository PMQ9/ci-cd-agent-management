import { z } from "zod";
import {
  FINDING_STATUSES,
  JOB_STATES,
  PROVIDERS,
  RUNNER_STATUSES,
  SEVERITIES,
  TRIGGER_SOURCES,
  VERDICTS,
} from "./enums";

// Canonical entity shapes. The DB row, the API response, and the dashboard all
// speak these. Parse at every trust boundary; trust the type inside it.

export const RepoSchema = z.object({
  id: z.string().uuid(),
  installationId: z.number().int(),
  fullName: z.string(), // "owner/name"
  isPrivate: z.boolean(),
  defaultBranch: z.string(),
  autoReviewEnabled: z.boolean(),
  provider: z.enum(PROVIDERS),
  model: z.string().nullable(),
  dailyCostCapUsd: z.number().nonnegative().nullable(),
  createdAt: z.string().datetime(),
});
export type Repo = z.infer<typeof RepoSchema>;

export const RunnerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.enum(RUNNER_STATUSES),
  lastSeenAt: z.string().datetime().nullable(),
  capabilities: z.object({
    providers: z.array(z.enum(PROVIDERS)),
    version: z.string().optional(),
  }),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Runner = z.infer<typeof RunnerSchema>;

export const JobSchema = z.object({
  id: z.string().uuid(),
  repoId: z.string().uuid(),
  prNumber: z.number().int(),
  headSha: z.string(),
  baseSha: z.string(),
  trigger: z.enum(TRIGGER_SOURCES),
  state: z.enum(JOB_STATES),
  round: z.number().int(),
  leasedByRunner: z.string().uuid().nullable(),
  preferredRunnerId: z.string().uuid().nullable(),
  claudeSessionId: z.string().nullable(),
  attempts: z.number().int(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Job = z.infer<typeof JobSchema>;

export const FindingSchema = z.object({
  id: z.string().uuid(),
  reviewId: z.string().uuid(),
  path: z.string(),
  line: z.number().int().nullable(),
  severity: z.enum(SEVERITIES),
  title: z.string(),
  body: z.string(),
  status: z.enum(FINDING_STATUSES),
  prevFindingId: z.string().uuid().nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReviewSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  round: z.number().int(),
  githubReviewId: z.number().int().nullable(),
  verdict: z.enum(VERDICTS),
  summary: z.string(),
  createdAt: z.string().datetime(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const UsageEventSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid().nullable(),
  runnerId: z.string().uuid().nullable(),
  model: z.string().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  costUsd: z.number().nonnegative(),
  wallMs: z.number().int().nullable(),
  createdAt: z.string().datetime(),
});
export type UsageEvent = z.infer<typeof UsageEventSchema>;
