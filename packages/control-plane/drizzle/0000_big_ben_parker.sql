CREATE TYPE "public"."finding_status" AS ENUM('open', 'resolved', 'regressed');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('claude_code', 'opencode');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('critical', 'high', 'medium', 'low', 'info');--> statement-breakpoint
CREATE TYPE "public"."trigger_source" AS ENUM('auto', 'manual', 'command');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('approve', 'request_changes', 'comment');--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"path" text NOT NULL,
	"line" integer,
	"severity" "severity" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"prev_finding_id" uuid
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" bigint PRIMARY KEY NOT NULL,
	"account_login" text NOT NULL,
	"repo_selection" text DEFAULT 'selected' NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text DEFAULT '' NOT NULL,
	"trigger" "trigger_source" NOT NULL,
	"state" "job_state" DEFAULT 'queued' NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"lease_id" uuid,
	"leased_by_runner" uuid,
	"lease_expires_at" timestamp with time zone,
	"preferred_runner_id" uuid,
	"claude_session_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"is_private" boolean DEFAULT true NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"auto_review_enabled" boolean DEFAULT false NOT NULL,
	"provider" "provider" DEFAULT 'claude_code' NOT NULL,
	"model" text,
	"daily_cost_cap_usd" numeric(10, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_github_repo_id_unique" UNIQUE("github_repo_id"),
	CONSTRAINT "repos_full_name_unique" UNIQUE("full_name")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"github_review_id" bigint,
	"verdict" "verdict" NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"runner_id" uuid,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"wall_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_login" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_login_unique" UNIQUE("github_login")
);
--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_prev_finding_id_findings_id_fk" FOREIGN KEY ("prev_finding_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_leased_by_runner_runners_id_fk" FOREIGN KEY ("leased_by_runner") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_preferred_runner_id_runners_id_fk" FOREIGN KEY ("preferred_runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_state_repo_idx" ON "jobs" USING btree ("state","repo_id");--> statement-breakpoint
CREATE INDEX "jobs_active_state_idx" ON "jobs" USING btree ("state") WHERE "jobs"."state" in ('queued','leased','running');--> statement-breakpoint
CREATE INDEX "usage_events_created_idx" ON "usage_events" USING btree ("created_at");