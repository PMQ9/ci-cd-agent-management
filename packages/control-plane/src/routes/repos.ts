import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PROVIDERS } from "@agentpr/shared";
import { requireUser } from "../auth.js";
import { env, githubConfigured } from "../config.js";
import { db } from "../db/client.js";
import { installations, repos } from "../db/schema.js";
import { syncInstallationRepos } from "../github/sync.js";
import { triggerReviewForPr } from "../review-service.js";

const UpdateRepoSchema = z.object({
  autoReviewEnabled: z.boolean().optional(),
  provider: z.enum(PROVIDERS).optional(),
  model: z.string().nullable().optional(),
  dailyCostCapUsd: z.number().nonnegative().nullable().optional(),
});

export function registerRepoRoutes(app: FastifyInstance): void {
  app.get("/api/repos", { preHandler: requireUser }, async () => {
    const rows = await db.select().from(repos).orderBy(desc(repos.createdAt));
    return rows.map((r) => ({
      id: r.id,
      fullName: r.fullName,
      isPrivate: r.isPrivate,
      defaultBranch: r.defaultBranch,
      autoReviewEnabled: r.autoReviewEnabled,
      provider: r.provider,
      model: r.model,
      dailyCostCapUsd: r.dailyCostCapUsd == null ? null : Number(r.dailyCostCapUsd),
    }));
  });

  app.patch<{ Params: { id: string } }>(
    "/api/repos/:id",
    { preHandler: requireUser },
    async (request, reply) => {
      const parsed = UpdateRepoSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "bad_request", message: "Invalid update" } });
      }
      const set: Record<string, unknown> = {};
      if (parsed.data.autoReviewEnabled !== undefined) set.autoReviewEnabled = parsed.data.autoReviewEnabled;
      if (parsed.data.provider !== undefined) set.provider = parsed.data.provider;
      if (parsed.data.model !== undefined) set.model = parsed.data.model;
      if (parsed.data.dailyCostCapUsd !== undefined) {
        set.dailyCostCapUsd = parsed.data.dailyCostCapUsd == null ? null : parsed.data.dailyCostCapUsd.toFixed(4);
      }
      const [updated] = await db.update(repos).set(set).where(eq(repos.id, request.params.id)).returning();
      if (!updated) return reply.code(404).send({ error: { code: "not_found", message: "Repo not found" } });
      return { ok: true };
    },
  );

  // Manual trigger — the dashboard "Review" button.
  app.post<{ Params: { id: string }; Body: { prNumber?: number } }>(
    "/api/repos/:id/review",
    { preHandler: requireUser },
    async (request, reply) => {
      const prNumber = Number(request.body?.prNumber);
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        return reply.code(400).send({ error: { code: "bad_request", message: "prNumber required" } });
      }
      const [repo] = await db.select().from(repos).where(eq(repos.id, request.params.id)).limit(1);
      if (!repo) return reply.code(404).send({ error: { code: "not_found", message: "Repo not found" } });
      if (!githubConfigured) {
        return reply.code(503).send({ error: { code: "github_not_configured", message: "Configure GitHub first" } });
      }
      const outcome = await triggerReviewForPr({ repo, prNumber, trigger: "manual" });
      return reply.send(outcome);
    },
  );

  app.get("/api/installations", { preHandler: requireUser }, async () => {
    const rows = await db.select().from(installations).orderBy(desc(installations.createdAt));
    const installUrl = env.GITHUB_APP_SLUG
      ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`
      : null;
    return { installations: rows, installUrl, githubConfigured };
  });

  app.post<{ Params: { id: string } }>(
    "/api/installations/:id/sync",
    { preHandler: requireUser },
    async (request, reply) => {
      if (!githubConfigured) {
        return reply.code(503).send({ error: { code: "github_not_configured", message: "Configure GitHub first" } });
      }
      const n = await syncInstallationRepos(Number(request.params.id));
      return reply.send({ ok: true, synced: n });
    },
  );
}
