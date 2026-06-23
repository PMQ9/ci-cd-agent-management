CREATE TYPE "public"."template_kind" AS ENUM('pr_review', 'pull_request', 'security_review');--> statement-breakpoint
CREATE TABLE "agent_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"editable" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_prompts_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "template_kind" NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "concerns" jsonb;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "suggested_fixes" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "templates_active_pr_review_idx" ON "templates" USING btree ("kind") WHERE "templates"."is_active" and "templates"."kind" = 'pr_review';