import { and, eq } from "drizzle-orm";
import { REVIEW_OUTPUT_CONTRACT_PROMPT, type PriorFinding } from "@agentpr/shared";
import { db } from "./db/client.js";
import { agentPrompts, templates } from "./db/schema.js";
import { SEED_PROMPTS, SEED_TEMPLATES } from "./seed-data.js";

// The editable pieces + the active rubric, pulled from the DB (with seed fallbacks so
// the reviewer never breaks if a row is missing). Shared by the lease handler and the
// /api/prompts/preview route so the preview shows EXACTLY what the runner receives.
export interface ReviewPromptParts {
  persona: string;
  rules: string;
  rereview: string;
  templateName: string;
  templateContent: string;
}

function seedPrompt(key: string): string {
  return SEED_PROMPTS.find((p) => p.key === key)?.content ?? "";
}

export async function loadReviewPromptParts(): Promise<ReviewPromptParts> {
  const prompts = await db.select().from(agentPrompts);
  const byKey = new Map(prompts.map((p) => [p.key, p.content]));

  const [active] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.kind, "pr_review"), eq(templates.isActive, true)))
    .limit(1);
  const fallback = SEED_TEMPLATES.find((t) => t.kind === "pr_review")!;

  return {
    persona: byKey.get("reviewer.persona") ?? seedPrompt("reviewer.persona"),
    rules: byKey.get("reviewer.rules") ?? seedPrompt("reviewer.rules"),
    rereview: byKey.get("reviewer.rereview") ?? seedPrompt("reviewer.rereview"),
    templateName: active?.name ?? fallback.name,
    templateContent: active?.content ?? fallback.content,
  };
}

export interface ReviewContext {
  repoFullName: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  round: number;
  priorFindings: PriorFinding[];
}

/**
 * Pure assembler: persona → strict-template rules → the active template → (re-review
 * addendum + prior findings) → the code-fixed JSON output contract. The contract comes
 * from @agentpr/shared so the prompt and the parser can never drift, and it is never
 * user-editable, so a dashboard edit can't break result parsing.
 */
export function assembleReviewInstruction(parts: ReviewPromptParts, ctx: ReviewContext): string {
  const lines = [
    `Reviewing PR #${ctx.prNumber} of ${ctx.repoFullName} ` +
      `(base ${ctx.baseSha.slice(0, 12)} .. head ${ctx.headSha.slice(0, 12)}). The diff is on stdin.`,
    "",
    parts.persona.trim(),
    "",
    parts.rules.trim(),
    "",
    `--- REVIEW TEMPLATE: "${parts.templateName}" (fill every section) ---`,
    parts.templateContent.trim(),
    `--- END REVIEW TEMPLATE ---`,
  ];
  if (ctx.round > 1 && ctx.priorFindings.length) {
    lines.push(
      "",
      `RE-REVIEW round ${ctx.round}.`,
      parts.rereview.trim(),
      "",
      `Previous round's findings:`,
      JSON.stringify(ctx.priorFindings, null, 2),
    );
  }
  lines.push("", REVIEW_OUTPUT_CONTRACT_PROMPT);
  return lines.join("\n");
}
