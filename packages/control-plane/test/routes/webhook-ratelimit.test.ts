import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// server.js transitively imports db/client + github/app; stub them so building
// the server needs no real Postgres pool or Octokit. The rate-limit requests
// below are rejected at the signature check (401) long before any DB/GitHub use.
const holder = vi.hoisted(() => ({}) as { db?: unknown; pool?: unknown });
vi.mock("../../src/db/client.js", () => ({
  get db() {
    return holder.db;
  },
  get pool() {
    return holder.pool;
  },
}));
vi.mock("../../src/github/app.js", () => ({
  getApp: vi.fn(),
  mintRepoToken: vi.fn(),
  postReview: vi.fn(),
  getPrRefs: vi.fn(),
  listOpenPrs: vi.fn(),
}));

const { buildServer } = await import("../../src/server.js");
const { WEBHOOK_RATE_LIMIT } = await import("../../src/webhook.js");

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("webhook rate limiting", () => {
  const post = () =>
    app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-github-event": "ping" },
      payload: {},
    });

  it("rate-limits the webhook route once the per-IP budget is exceeded", async () => {
    // The limiter's hook runs before the handler, so even these unsigned (401)
    // requests count against the budget. Exhaust it, then expect a 429.
    const statuses: number[] = [];
    for (let i = 0; i < WEBHOOK_RATE_LIMIT.max; i++) {
      statuses.push((await post()).statusCode);
    }
    expect(statuses).toHaveLength(WEBHOOK_RATE_LIMIT.max);
    expect(statuses.some((s) => s === 429)).toBe(false);

    const limited = await post();
    expect(limited.statusCode).toBe(429);
  });
});
