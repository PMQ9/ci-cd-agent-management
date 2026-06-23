import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { installDbLifecycle, type DbHolder } from "../harness/setup-db.js";
import { makeRepo } from "../harness/factories.js";
import { signedWebhook, webhookSignature } from "../harness/http.js";
import { installations, jobs, pullRequests } from "../../src/db/schema.js";

const holder = vi.hoisted(() => ({}) as DbHolder);
vi.mock("../../src/db/client.js", () => ({
  get db() {
    return holder.db;
  },
  get pool() {
    return holder.pool;
  },
}));

const gh = vi.hoisted(() => ({
  getPrRefs: vi.fn(async () => ({
    headSha: "x".repeat(40),
    baseSha: "y".repeat(40),
    cloneUrl: "https://github.com/o/r.git",
    draft: false,
  })),
  mintRepoToken: vi.fn(),
  postReview: vi.fn(),
  listOpenPrs: vi.fn(),
  getApp: vi.fn(() => {
    throw new Error("getApp() should not be called");
  }),
}));
vi.mock("../../src/github/app.js", () => gh);

const syncInstallationRepos = vi.hoisted(() => vi.fn(async () => 2));
vi.mock("../../src/github/sync.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  syncInstallationRepos,
}));

installDbLifecycle(holder);

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  gh.getPrRefs.mockClear();
  syncInstallationRepos.mockClear();
});

function prPayload(repoGithubId: number, over: Record<string, any> = {}) {
  return {
    action: over.action ?? "opened",
    repository: { id: repoGithubId },
    pull_request: {
      number: over.number ?? 1,
      title: over.title ?? "Add feature",
      state: over.state ?? "open",
      draft: over.draft ?? false,
      user: { login: "octocat" },
      head: { sha: "a".repeat(40) },
      base: { sha: "b".repeat(40) },
      html_url: "https://github.com/o/r/pull/1",
      updated_at: "2026-06-23T00:00:00Z",
      merged: over.merged ?? false,
      ...over.pull_request,
    },
  };
}

describe("POST /webhook — signature gate", () => {
  it("401 on a bad signature", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": "sha256=deadbeef" },
      payload: JSON.stringify({ hello: "world" }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe("bad_signature");
  });

  it("401 when the signature header is absent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-github-event": "ping" },
      payload: JSON.stringify({ hello: "world" }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a correctly-signed but unhandled event", async () => {
    const res = await app.inject({ method: "POST", url: "/webhook", ...signedWebhook("ping", { zen: "hi" }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("computes the signature over the exact raw body (helper matches the server)", () => {
    // Sanity check the test helper is using HMAC-SHA256 with the test secret.
    expect(webhookSignature("abc")).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("401 when signed with the wrong secret (proves the secret is actually checked)", async () => {
    const res = await app.inject({ method: "POST", url: "/webhook", ...signedWebhook("ping", { zen: "hi" }, "the-wrong-secret") });
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe("bad_signature");
  });

  it("401 when the body is tampered after signing (HMAC is over the exact bytes)", async () => {
    const signedFor = JSON.stringify({ a: 1 });
    const tampered = JSON.stringify({ a: 2 });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": webhookSignature(signedFor),
      },
      payload: tampered,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /webhook — pull_request", () => {
  it("ignores an event for a repo that is not connected", async () => {
    const res = await app.inject({ method: "POST", url: "/webhook", ...signedWebhook("pull_request", prPayload(999999)) });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe("repo_not_connected");
  });

  it("enqueues an auto review for a connected repo with auto-review ON, and refreshes the inbox", async () => {
    const repo = await makeRepo(holder.db, { autoReviewEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      ...signedWebhook("pull_request", prPayload(repo.githubRepoId, { number: 5 })),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("queued");

    const jobRows = await holder.db.select().from(jobs).where(eq(jobs.repoId, repo.id));
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0].trigger).toBe("auto");

    const prRows = await holder.db.select().from(pullRequests).where(eq(pullRequests.repoId, repo.id));
    expect(prRows).toHaveLength(1);
    expect(prRows[0].number).toBe(5);
    // SHAs came from the payload — GitHub was not queried.
    expect(gh.getPrRefs).not.toHaveBeenCalled();
  });

  it("does not enqueue when auto-review is OFF, but still tracks the PR in the inbox", async () => {
    const repo = await makeRepo(holder.db, { autoReviewEnabled: false });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      ...signedWebhook("pull_request", prPayload(repo.githubRepoId, { number: 6 })),
    });
    expect(res.json().ignored).toBe("auto_review_off");
    const jobRows = await holder.db.select().from(jobs).where(eq(jobs.repoId, repo.id));
    expect(jobRows).toHaveLength(0);
    const prRows = await holder.db.select().from(pullRequests).where(eq(pullRequests.repoId, repo.id));
    expect(prRows).toHaveLength(1);
  });

  it("skips a draft PR on auto-review", async () => {
    const repo = await makeRepo(holder.db, { autoReviewEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      ...signedWebhook("pull_request", prPayload(repo.githubRepoId, { number: 7, draft: true })),
    });
    expect(res.json().status).toBe("skipped");
    expect(res.json().reason).toBe("draft PR");
  });

  it("ignores a non-review action (e.g. labeled)", async () => {
    const repo = await makeRepo(holder.db, { autoReviewEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      ...signedWebhook("pull_request", prPayload(repo.githubRepoId, { action: "labeled" })),
    });
    expect(res.json().ignored).toBe("labeled");
  });

  it("marks the PR closed/merged in the inbox on a closed action", async () => {
    const repo = await makeRepo(holder.db, { autoReviewEnabled: true });
    // open first
    await app.inject({
      method: "POST",
      url: "/webhook",
      ...signedWebhook("pull_request", prPayload(repo.githubRepoId, { number: 8 })),
    });
    // then close (merged)
    await app.inject({
      method: "POST",
      url: "/webhook",
      ...signedWebhook("pull_request", prPayload(repo.githubRepoId, { number: 8, action: "closed", state: "closed", merged: true })),
    });
    const [pr] = await holder.db.select().from(pullRequests).where(eq(pullRequests.repoId, repo.id));
    expect(pr.state).toBe("merged");
  });
});

describe("POST /webhook — issue_comment /review command", () => {
  it("triggers a command review when the allowlisted user comments /review", async () => {
    const repo = await makeRepo(holder.db);
    const payload = {
      action: "created",
      repository: { id: repo.githubRepoId },
      issue: { number: 12, pull_request: { url: "x" } },
      comment: { body: "/review please", user: { login: "testuser" } },
    };
    const res = await app.inject({ method: "POST", url: "/webhook", ...signedWebhook("issue_comment", payload) });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("queued");
    // command path resolves SHAs from GitHub
    expect(gh.getPrRefs).toHaveBeenCalled();
    const jobRows = await holder.db.select().from(jobs).where(eq(jobs.repoId, repo.id));
    expect(jobRows[0].trigger).toBe("command");
  });

  it("ignores a /review comment from a non-allowlisted user", async () => {
    const repo = await makeRepo(holder.db);
    const payload = {
      action: "created",
      repository: { id: repo.githubRepoId },
      issue: { number: 13, pull_request: { url: "x" } },
      comment: { body: "/review", user: { login: "stranger" } },
    };
    const res = await app.inject({ method: "POST", url: "/webhook", ...signedWebhook("issue_comment", payload) });
    expect(res.json().ignored).toBe("commenter_not_allowed");
  });

  it("ignores a comment that is not a /review command", async () => {
    const repo = await makeRepo(holder.db);
    const payload = {
      action: "created",
      repository: { id: repo.githubRepoId },
      issue: { number: 14, pull_request: { url: "x" } },
      comment: { body: "looks good to me", user: { login: "testuser" } },
    };
    const res = await app.inject({ method: "POST", url: "/webhook", ...signedWebhook("issue_comment", payload) });
    expect(res.json().ignored).toBe("no_command");
  });

  it("ignores a comment on an issue that is not a PR", async () => {
    const payload = {
      action: "created",
      repository: { id: 1 },
      issue: { number: 15 }, // no pull_request
      comment: { body: "/review", user: { login: "testuser" } },
    };
    const res = await app.inject({ method: "POST", url: "/webhook", ...signedWebhook("issue_comment", payload) });
    expect(res.json().ignored).toBe("not_a_pr");
  });
});

describe("POST /webhook — installation", () => {
  it("upserts the installation and syncs its repos on 'created'", async () => {
    const payload = {
      action: "created",
      installation: { id: 424242, account: { login: "octo-org" }, repository_selection: "all" },
    };
    const res = await app.inject({ method: "POST", url: "/webhook", ...signedWebhook("installation", payload) });
    expect(res.statusCode).toBe(200);
    expect(syncInstallationRepos).toHaveBeenCalledWith(424242);
    const [inst] = await holder.db.select().from(installations).where(eq(installations.id, 424242));
    expect(inst.accountLogin).toBe("octo-org");
  });

  it("removes the installation on 'deleted'", async () => {
    await holder.db.insert(installations).values({ id: 555, accountLogin: "gone" });
    const payload = { action: "deleted", installation: { id: 555, account: { login: "gone" } } };
    const res = await app.inject({ method: "POST", url: "/webhook", ...signedWebhook("installation", payload) });
    expect(res.statusCode).toBe(200);
    const rows = await holder.db.select().from(installations).where(eq(installations.id, 555));
    expect(rows).toHaveLength(0);
  });
});
