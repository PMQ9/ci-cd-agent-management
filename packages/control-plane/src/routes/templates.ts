import { and, asc, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import { templates } from "../db/schema.js";

const UpdateTemplateSchema = z.object({
  content: z.string().min(1).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});

export function registerTemplateRoutes(app: FastifyInstance): void {
  app.get("/api/templates", { preHandler: requireUser }, async () => {
    const rows = await db
      .select()
      .from(templates)
      .orderBy(asc(templates.kind), asc(templates.name));
    return rows.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      kind: t.kind,
      description: t.description,
      content: t.content,
      isActive: t.isActive,
      updatedAt: t.updatedAt,
    }));
  });

  app.patch<{ Params: { id: string } }>(
    "/api/templates/:id",
    { preHandler: requireUser },
    async (request, reply) => {
      const parsed = UpdateTemplateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "bad_request", message: "Invalid update" } });
      }
      const [row] = await db
        .select()
        .from(templates)
        .where(eq(templates.id, request.params.id))
        .limit(1);
      if (!row)
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "Template not found" } });

      await db.transaction(async (tx) => {
        // Activating a pr_review template demotes the other pr_review rows first — the
        // partial unique index allows exactly one active pr_review (the enforced rubric).
        if (parsed.data.isActive === true && row.kind === "pr_review") {
          await tx
            .update(templates)
            .set({ isActive: false, updatedAt: new Date() })
            .where(and(eq(templates.kind, "pr_review"), ne(templates.id, row.id)));
        }
        const set: Record<string, unknown> = { updatedAt: new Date() };
        if (parsed.data.content !== undefined) set.content = parsed.data.content;
        if (parsed.data.description !== undefined) set.description = parsed.data.description;
        if (parsed.data.isActive !== undefined) set.isActive = parsed.data.isActive;
        await tx.update(templates).set(set).where(eq(templates.id, row.id));
      });
      return { ok: true };
    },
  );
}
