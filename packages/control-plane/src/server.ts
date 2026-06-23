import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "./auth.js";
import { env, isProd } from "./config.js";
import { sweepExpiredLeases } from "./queue.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerPromptRoutes } from "./routes/prompts.js";
import { registerPullRoutes } from "./routes/pulls.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { registerRunnerRoutes } from "./routes/runners.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { safeEqualHex } from "./util/crypto.js";
import { registerWebhook } from "./webhook.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isProd ? true : { transport: { target: "pino-pretty" } },
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true, // behind Tailscale Funnel / Caddy
  });

  // Keep the raw body so the webhook can verify the HMAC signature, while still
  // JSON-parsing for normal handlers.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    (req as unknown as { rawBody?: Buffer }).rawBody = body as Buffer;
    const buf = body as Buffer;
    if (!buf || buf.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(buf.toString("utf8")));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  await app.register(cookie, { secret: env.SESSION_SECRET });

  // Rate limiting is opt-in per route (global: false) so the runner's lease
  // short-poll and the dashboard API stay unthrottled. The public `/webhook`
  // endpoint opts in (see registerWebhook) to blunt floods of unauthenticated
  // (bad-HMAC) requests before they reach the signature check.
  await app.register(rateLimit, { global: false });

  app.get("/health", async () => ({ ok: true }));
  app.get("/readyz", async () => ({ ok: true }));

  // ── Internal: HTTP-triggered lease sweep ─────────────────────────────────────
  // Replaces the in-process timer under Cloud Run scale-to-zero (where the timer
  // can't fire): Cloud Scheduler POSTs here every minute. Guarded by a shared
  // bearer secret because the service is public (--allow-unauthenticated).
  app.post("/internal/sweep", async (request, reply) => {
    if (!env.INTERNAL_API_TOKEN) {
      return reply.code(404).send({ error: { code: "not_found", message: "Not found" } });
    }
    const auth = request.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token || !safeEqualHex(token, env.INTERNAL_API_TOKEN)) {
      return reply
        .code(401)
        .send({ error: { code: "unauthenticated", message: "Bad internal token" } });
    }
    const requeued = await sweepExpiredLeases();
    if (requeued) request.log.info({ requeued }, "swept expired leases (http)");
    return reply.send({ ok: true, requeued });
  });

  registerAuth(app);
  registerWebhook(app);
  registerRunnerRoutes(app);
  registerRepoRoutes(app);
  registerPullRoutes(app);
  registerJobRoutes(app);
  registerUsageRoutes(app);
  registerTemplateRoutes(app);
  registerPromptRoutes(app);

  // Optionally serve the prebuilt dashboard from the same origin.
  if (env.DASHBOARD_DIST) {
    const fastifyStatic = (await import("@fastify/static")).default;
    await app.register(fastifyStatic, { root: env.DASHBOARD_DIST, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      const isAppRoute =
        req.method === "GET" &&
        !req.url.startsWith("/api") &&
        !req.url.startsWith("/auth") &&
        !req.url.startsWith("/webhook");
      if (isAppRoute) return reply.sendFile("index.html");
      return reply.code(404).send({ error: { code: "not_found", message: "Not found" } });
    });
  }

  return app;
}
