import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import { db } from "../db/client.js";
import { usageEvents } from "../db/schema.js";

// There is NO API for remaining Claude subscription quota, so we report what we
// MEASURE (cost/tokens we spent) and link out to the authoritative console.
const CLAUDE_CONSOLE_URL = "https://claude.ai/settings/usage";

export function registerUsageRoutes(app: FastifyInstance): void {
  app.get("/api/usage/summary", { preHandler: requireUser }, async () => {
    const [row] = await db
      .select({
        today: sql<string>`coalesce(sum(${usageEvents.costUsd}) filter (where ${usageEvents.createdAt} >= date_trunc('day', now())), 0)`,
        last7d: sql<string>`coalesce(sum(${usageEvents.costUsd}) filter (where ${usageEvents.createdAt} >= now() - interval '7 days'), 0)`,
        last30d: sql<string>`coalesce(sum(${usageEvents.costUsd}) filter (where ${usageEvents.createdAt} >= now() - interval '30 days'), 0)`,
        totalRuns: sql<number>`count(*)`,
        totalCost: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)`,
      })
      .from(usageEvents);
    return {
      today: Number(row?.today ?? 0),
      last7d: Number(row?.last7d ?? 0),
      last30d: Number(row?.last30d ?? 0),
      totalRuns: Number(row?.totalRuns ?? 0),
      totalCost: Number(row?.totalCost ?? 0),
      note: "Measured spend only. Anthropic exposes no remaining-quota API.",
      claudeConsoleUrl: CLAUDE_CONSOLE_URL,
    };
  });

  app.get<{ Querystring: { days?: string } }>(
    "/api/usage/daily",
    { preHandler: requireUser },
    async (request) => {
      const days = Math.min(Number(request.query.days ?? 30) || 30, 180);
      const rows = await db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${usageEvents.createdAt}), 'YYYY-MM-DD')`,
          cost: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)`,
          runs: sql<number>`count(*)`,
        })
        .from(usageEvents)
        .where(sql`${usageEvents.createdAt} >= now() - make_interval(days => ${days})`)
        .groupBy(sql`date_trunc('day', ${usageEvents.createdAt})`)
        .orderBy(sql`date_trunc('day', ${usageEvents.createdAt})`);
      return rows.map((r) => ({ day: r.day, cost: Number(r.cost), runs: Number(r.runs) }));
    },
  );
}
