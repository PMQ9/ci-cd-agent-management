import { Octokit } from "@octokit/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env, githubConfigured, isProd } from "./config.js";
import { getApp } from "./github/app.js";
import { randomToken } from "./util/crypto.js";

const SESSION_COOKIE = "session";
const STATE_COOKIE = "oauth_state";

function setSession(reply: FastifyReply, login: string): void {
  reply.setCookie(SESSION_COOKIE, login, {
    signed: true,
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

/** preHandler: require a valid session cookie matching the allowlisted login. */
export function requireUser(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const raw = request.cookies?.[SESSION_COOKIE];
  if (!raw) {
    reply.code(401).send({ error: { code: "unauthenticated", message: "Sign in required" } });
    return;
  }
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) {
    reply.code(401).send({ error: { code: "unauthenticated", message: "Invalid session" } });
    return;
  }
  if (env.ALLOWED_GITHUB_LOGIN && unsigned.value !== env.ALLOWED_GITHUB_LOGIN) {
    reply.code(403).send({ error: { code: "forbidden", message: "Not allowed" } });
    return;
  }
  (request as FastifyRequest & { user?: string }).user = unsigned.value;
  done();
}

export function registerAuth(app: FastifyInstance): void {
  app.get("/auth/login", async (request, reply) => {
    if (!githubConfigured) {
      return reply
        .code(503)
        .send({ error: { code: "github_not_configured", message: "Configure the GitHub App first" } });
    }
    const state = randomToken(16);
    reply.setCookie(STATE_COOKIE, state, {
      signed: true,
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    const { url } = getApp().oauth.getWebFlowAuthorizationUrl({
      state,
      redirectUrl: `${env.PUBLIC_URL}/auth/callback`,
    });
    return reply.redirect(url);
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    "/auth/callback",
    async (request, reply) => {
      const { code, state } = request.query;
      const stateCookie = request.cookies?.[STATE_COOKIE];
      const unsigned = stateCookie ? request.unsignCookie(stateCookie) : { valid: false, value: null };
      if (!code || !state || !unsigned.valid || unsigned.value !== state) {
        return reply.code(400).send({ error: { code: "bad_oauth_state", message: "Invalid OAuth state" } });
      }
      reply.clearCookie(STATE_COOKIE, { path: "/" });

      const { authentication } = await getApp().oauth.createToken({ code });
      const octokit = new Octokit({ auth: authentication.token });
      const { data: user } = await octokit.request("GET /user");

      if (env.ALLOWED_GITHUB_LOGIN && user.login !== env.ALLOWED_GITHUB_LOGIN) {
        return reply
          .code(403)
          .send({ error: { code: "forbidden", message: `${user.login} is not allowed to sign in` } });
      }
      setSession(reply, user.login);
      return reply.redirect("/");
    },
  );

  app.post("/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: requireUser }, async (request) => {
    return { login: (request as FastifyRequest & { user?: string }).user };
  });

  // Local-only shortcut so the dashboard is usable before the GitHub App exists.
  if (!isProd) {
    app.post("/auth/dev-login", async (_request, reply) => {
      const login = env.ALLOWED_GITHUB_LOGIN || "dev";
      setSession(reply, login);
      return { ok: true, login };
    });
  }
}
