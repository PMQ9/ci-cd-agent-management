import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { REVIEW_OUTPUT_CONTRACT_PROMPT } from "@agentpr/shared";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import { agentPrompts } from "../db/schema.js";
import { assembleReviewInstruction, loadReviewPromptParts } from "../review-prompt.js";

const UpdatePromptSchema = z.object({ content: z.string().min(1) });

export function registerPromptRoutes(app: FastifyInstance): void {
  app.get("/api/prompts", { preHandler: requireUser }, async () => {
    const rows = await db.select().from(agentPrompts).orderBy(asc(agentPrompts.key));
    const editable = rows.map((p) => ({
      key: p.key,
      label: p.label,
      description: p.description,
      content: p.content,
      editable: p.editable,
      updatedAt: p.updatedAt,
    }));
    // Surface the code-fixed JSON output contract as a read-only entry so the tab shows
    // the COMPLETE prompt the agent sees, while it stays un-editable (breaking it would
    // break result parsing). It is sourced from @agentpr/shared, not the DB.
    return [
      ...editable,
      {
        key: "reviewer.output_contract",
        label: "Output contract (fixed)",
        description:
          "The exact JSON shape the agent must emit. Code-fixed and always appended so the parser can't be broken from the UI.",
        content: REVIEW_OUTPUT_CONTRACT_PROMPT,
        editable: false,
        updatedAt: null,
      },
    ];
  });

  app.patch<{ Params: { key: string } }>(
    "/api/prompts/:key",
    { preHandler: requireUser },
    async (request, reply) => {
      const parsed = UpdatePromptSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "bad_request", message: "Invalid update" } });
      }
      const [row] = await db.select().from(agentPrompts).where(eq(agentPrompts.key, request.params.key)).limit(1);
      if (!row) return reply.code(404).send({ error: { code: "not_found", message: "Prompt not found" } });
      if (!row.editable) {
        return reply.code(400).send({ error: { code: "read_only", message: "This prompt is not editable" } });
      }
      await db
        .update(agentPrompts)
        .set({ content: parsed.data.content, updatedAt: new Date() })
        .where(eq(agentPrompts.key, row.key));
      return { ok: true };
    },
  );

  // The fully-assembled instruction the runner receives — identical code path to the
  // lease handler, so what you preview is what runs.
  app.get("/api/prompts/preview", { preHandler: requireUser }, async () => {
    const parts = await loadReviewPromptParts();
    const instruction = assembleReviewInstruction(parts, {
      repoFullName: "owner/example-repo",
      prNumber: 42,
      baseSha: "0000000000000000000000000000000000000000",
      headSha: "1111111111111111111111111111111111111111",
      round: 1,
      priorFindings: [],
    });
    return { instruction, templateName: parts.templateName };
  });
}
