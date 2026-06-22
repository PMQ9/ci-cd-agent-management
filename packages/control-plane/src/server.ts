import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { env, isProd } from "./config.js";
import { registerAuth } from "./auth.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { registerRunnerRoutes } from "./routes/runners.js";
import { registerUsageRoutes } from "./routes/usage.js";
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

  app.get("/health", async () => ({ ok: true }));
  app.get("/readyz", async () => ({ ok: true }));

  registerAuth(app);
  registerWebhook(app);
  registerRunnerRoutes(app);
  registerRepoRoutes(app);
  registerJobRoutes(app);
  registerUsageRoutes(app);

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
