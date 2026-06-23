// HTTP helpers for route tests driven by Fastify's app.inject (no real port).
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";

// A signed session cookie for the allowlisted user, obtained the real way: via the
// non-prod /auth/dev-login route (NODE_ENV=test ⇒ available). Returns a Cookie
// header value ready to attach to subsequent injected requests.
export async function getSessionCookie(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/dev-login", payload: {} });
  if (res.statusCode !== 200) throw new Error(`dev-login failed: ${res.statusCode} ${res.body}`);
  const session = res.cookies.find((c) => c.name === "session");
  if (!session) throw new Error("no session cookie returned by dev-login");
  return `session=${session.value}`;
}

// Compute the GitHub webhook signature header over the exact raw body bytes, using
// the test env's GITHUB_WEBHOOK_SECRET.
export function webhookSignature(rawBody: string, secret = "test-webhook-secret"): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

// Build the headers + payload for a signed webhook POST. `body` is stringified once
// and that exact string is both signed and sent (so the HMAC matches rawBody).
export function signedWebhook(event: string, body: unknown, secret?: string) {
  const raw = JSON.stringify(body);
  return {
    payload: raw,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": webhookSignature(raw, secret),
    },
  };
}
