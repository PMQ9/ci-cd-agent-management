import type { JobError, JobResult } from "@agentpr/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../src/client.js";

const fetchMock = vi.fn();

// Build a fake Response for fetch.
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; text?: string } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => init.text ?? "",
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE = "http://cp.local";

describe("ControlPlaneClient.post behavior (via public methods)", () => {
  it("always sets content-type application/json and POST method", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ job: null }));
    const client = new ControlPlaneClient(BASE, "tok");
    await client.lease();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(BASE + "/api/runners/lease");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({}));
  });

  it("adds Authorization: Bearer <token> on authed requests when a token is set", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ job: null }));
    const client = new ControlPlaneClient(BASE, "my-token");
    await client.lease();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.authorization).toBe("Bearer my-token");
  });

  it("omits Authorization on authed requests when NO token is set", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ job: null }));
    const client = new ControlPlaneClient(BASE); // no token
    await client.lease();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.authorization).toBeUndefined();
  });

  it("omits Authorization on UN-authed requests (enroll) even when a token is set", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ runnerId: "11111111-1111-1111-1111-111111111111", runnerToken: "t" }),
    );
    const client = new ControlPlaneClient(BASE, "preset-token");
    await client.enroll({
      enrollmentSecret: "secret",
      name: "box",
      capabilities: { providers: ["claude_code"], version: "0.2.0" },
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.authorization).toBeUndefined();
  });

  it("setToken makes subsequent authed requests include the new bearer", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ job: null }));
    const client = new ControlPlaneClient(BASE);
    client.setToken("late-token");
    await client.lease();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.authorization).toBe("Bearer late-token");
  });

  it("throws on a non-2xx response, including status and body text", async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, { ok: false, status: 500, text: "kaboom" }));
    const client = new ControlPlaneClient(BASE, "tok");
    await expect(client.lease()).rejects.toThrow(/500 kaboom/);
  });
});

describe("ControlPlaneClient.enroll", () => {
  it("POSTs to /api/runners/enroll and parses EnrollResponse", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    fetchMock.mockResolvedValue(jsonResponse({ runnerId: id, runnerToken: "durable-tok" }));
    const client = new ControlPlaneClient(BASE);
    const res = await client.enroll({
      enrollmentSecret: "s",
      name: "n",
      capabilities: { providers: ["claude_code"], version: "0.2.0" },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(BASE + "/api/runners/enroll");
    expect(init.method).toBe("POST");
    expect(res).toEqual({ runnerId: id, runnerToken: "durable-tok" });
  });

  it("rejects when the enroll response fails the shared schema (bad uuid)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ runnerId: "not-a-uuid", runnerToken: "t" }));
    const client = new ControlPlaneClient(BASE);
    await expect(
      client.enroll({
        enrollmentSecret: "s",
        name: "n",
        capabilities: { providers: ["claude_code"] },
      }),
    ).rejects.toThrow();
  });
});

describe("ControlPlaneClient.lease", () => {
  it("POSTs to /api/runners/lease and parses { job: null }", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ job: null }));
    const client = new ControlPlaneClient(BASE, "tok");
    const res = await client.lease();
    expect(fetchMock.mock.calls[0]![0]).toBe(BASE + "/api/runners/lease");
    expect(res.job).toBeNull();
  });

  it("parses a full LeaseJob job payload through the shared schema", async () => {
    const job = {
      jobId: "33333333-3333-3333-3333-333333333333",
      leaseId: "44444444-4444-4444-4444-444444444444",
      repoFullName: "octocat/hello",
      cloneUrl: "https://github.com/octocat/hello.git",
      prNumber: 9,
      headSha: "head",
      baseSha: "base",
      provider: "claude_code",
      model: null,
      round: 1,
      githubToken: "ghs_token",
      resumeSessionId: null,
      priorFindings: [],
    };
    fetchMock.mockResolvedValue(jsonResponse({ job }));
    const client = new ControlPlaneClient(BASE, "tok");
    const res = await client.lease();
    expect(res.job?.jobId).toBe(job.jobId);
    expect(res.job?.provider).toBe("claude_code");
  });

  it("passes an AbortSignal to fetch (per-request abort timer)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ job: null }));
    const client = new ControlPlaneClient(BASE, "tok");
    await client.lease();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects when the lease response fails the schema (missing job key)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const client = new ControlPlaneClient(BASE, "tok");
    await expect(client.lease()).rejects.toThrow();
  });
});

describe("ControlPlaneClient.reportResult / reportError", () => {
  it("reportResult POSTs the JobResult to /api/runners/result with auth", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { ok: true }));
    const client = new ControlPlaneClient(BASE, "tok");
    const result: JobResult = {
      leaseId: "55555555-5555-5555-5555-555555555555",
      sessionId: "sess",
      verdict: "approve",
      summary: "ok",
      findings: [],
      concerns: [],
      suggestedFixes: [],
      modelUsed: "claude-opus-4",
      totalCostUsd: 0.02,
      inputTokens: 10,
      outputTokens: 5,
      wallMs: 1234,
    };
    await client.reportResult(result);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(BASE + "/api/runners/result");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toMatchObject({ leaseId: result.leaseId, verdict: "approve" });
  });

  it("reportError POSTs the JobError to /api/runners/error with auth", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { ok: true }));
    const client = new ControlPlaneClient(BASE, "tok");
    const err: JobError = {
      leaseId: "66666666-6666-6666-6666-666666666666",
      message: "boom",
      totalCostUsd: null,
      wallMs: null,
    };
    await client.reportError(err);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(BASE + "/api/runners/error");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toMatchObject({ leaseId: err.leaseId, message: "boom" });
  });

  it("reportResult throws on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, { ok: false, status: 409, text: "conflict" }));
    const client = new ControlPlaneClient(BASE, "tok");
    await expect(
      client.reportResult({
        leaseId: "77777777-7777-7777-7777-777777777777",
        sessionId: null,
        verdict: "comment",
        summary: "x",
        findings: [],
        concerns: [],
        suggestedFixes: [],
        totalCostUsd: 0,
        inputTokens: null,
        outputTokens: null,
        wallMs: 1,
      }),
    ).rejects.toThrow(/409 conflict/);
  });
});
