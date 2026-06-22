import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  FINDING_STATUSES,
  JOB_STATES,
  PROVIDERS,
  SEVERITIES,
  TRIGGER_SOURCES,
  VERDICTS,
} from "@agentpr/shared";

// Enum values come from @agentpr/shared so the DB and the Zod layer can never drift.
export const jobStateEnum = pgEnum("job_state", JOB_STATES);
export const triggerEnum = pgEnum("trigger_source", TRIGGER_SOURCES);
export const providerEnum = pgEnum("provider", PROVIDERS);
export const verdictEnum = pgEnum("verdict", VERDICTS);
export const findingStatusEnum = pgEnum("finding_status", FINDING_STATUSES);
export const severityEnum = pgEnum("severity", SEVERITIES);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubLogin: text("github_login").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const installations = pgTable("installations", {
  id: bigint("id", { mode: "number" }).primaryKey(), // GitHub installation id
  accountLogin: text("account_login").notNull(),
  repoSelection: text("repo_selection").notNull().default("selected"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const repos = pgTable("repos", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull().unique(),
  installationId: bigint("installation_id", { mode: "number" })
    .notNull()
    .references(() => installations.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull().unique(),
  isPrivate: boolean("is_private").notNull().default(true),
  defaultBranch: text("default_branch").notNull().default("main"),
  // The auto/manual toggle. Default false = manual (conserve quota).
  autoReviewEnabled: boolean("auto_review_enabled").notNull().default(false),
  provider: providerEnum("provider").notNull().default("claude_code"),
  model: text("model"),
  dailyCostCapUsd: numeric("daily_cost_cap_usd", { precision: 10, scale: 4 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runners = pgTable("runners", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // sha256 of the durable runner token; the plaintext lives only on the runner.
  tokenHash: text("token_hash").notNull(),
  capabilities: jsonb("capabilities")
    .$type<{ providers: string[]; version?: string }>()
    .notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull().default(""),
    trigger: triggerEnum("trigger").notNull(),
    state: jobStateEnum("state").notNull().default("queued"),
    round: integer("round").notNull().default(1),
    leaseId: uuid("lease_id"),
    leasedByRunner: uuid("leased_by_runner").references(() => runners.id, {
      onDelete: "set null",
    }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    preferredRunnerId: uuid("preferred_runner_id").references(() => runners.id, {
      onDelete: "set null",
    }),
    claudeSessionId: text("claude_session_id"),
    attempts: integer("attempts").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_state_repo_idx").on(t.state, t.repoId),
    index("jobs_active_state_idx")
      .on(t.state)
      .where(sql`${t.state} in ('queued','leased','running')`),
  ],
);

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  round: integer("round").notNull().default(1),
  githubReviewId: bigint("github_review_id", { mode: "number" }),
  verdict: verdictEnum("verdict").notNull(),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const findings = pgTable("findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  reviewId: uuid("review_id")
    .notNull()
    .references(() => reviews.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  line: integer("line"),
  severity: severityEnum("severity").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  status: findingStatusEnum("status").notNull().default("open"),
  prevFindingId: uuid("prev_finding_id").references((): AnyPgColumn => findings.id, {
    onDelete: "set null",
  }),
});

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    runnerId: uuid("runner_id").references(() => runners.id, { onDelete: "set null" }),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
    wallMs: integer("wall_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("usage_events_created_idx").on(t.createdAt)],
);

export type JobRow = typeof jobs.$inferSelect;
export type RepoRow = typeof repos.$inferSelect;
export type RunnerRow = typeof runners.$inferSelect;
