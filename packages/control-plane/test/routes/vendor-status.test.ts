import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mapIndicatorToLevel,
  normalizeStatuspage,
  resetVendorStatusCache,
} from "../../src/routes/vendor-status.js";
import { getSessionCookie } from "../harness/http.js";
import { type DbHolder, installDbLifecycle } from "../harness/setup-db.js";

// The vendor-status route touches neither the DB nor GitHub, but buildServer
// registers every route and /auth/dev-login (used to mint the session cookie)
// reads the DB — so we stand up the same mocked-DB + mocked-GitHub harness the
// other route tests use.
const holder = vi.hoisted(() => ({}) as DbHolder);
vi.mock("../../src/db/client.js", () => ({
  get db() {
    return holder.db;
  },
  get pool() {
    return holder.pool;
  },
}));
vi.mock("../../src/github/app.js", () => ({}));

installDbLifecycle(holder);

const { buildServer } = await import("../../src/server.js");

// Canned Atlassian Statuspage `summary.json` payloads (only the fields we read).
const opSummary = (name: string) => ({
  page: { name, updated_at: "2026-06-23T18:32:57.399Z" },
  status: { indicator: "none", description: "All Systems Operational" },
  incidents: [],
});
const cloudflareSummary = {
  page: { name: "Cloudflare", updated_at: "2026-06-23T18:38:56.082Z" },
  status: { indicator: "minor", description: "Minor Service Outage" },
  incidents: [
    {
      name: "Elevated 5xx in WEUR",
      impact: "minor",
      status: "investigating",
      shortlink: "https://stspg.io/abc",
      updated_at: "2026-06-23T18:38:00.000Z",
    },
    // A resolved incident must be filtered out of the normalized output.
    {
      name: "Old resolved thing",
      impact: "minor",
      status: "resolved",
      updated_at: "2026-06-22T00:00:00.000Z",
    },
  ],
};

const SUMMARY_BY_HOST: Record<string, unknown> = {
  "status.claude.com": opSummary("Claude"),
  "www.githubstatus.com": opSummary("GitHub"),
  "www.cloudflarestatus.com": cloudflareSummary,
  "status.openai.com": opSummary("OpenAI"),
};

/** Build a fetch mock; `rejectHosts` forces a network failure for those hosts. */
function makeFetch(rejectHosts: string[] = []) {
  return vi.fn(async (url: string | URL) => {
    const host = new URL(String(url)).host;
    if (rejectHosts.includes(host)) throw new Error(`network down: ${host}`);
    return {
      ok: true,
      status: 200,
      json: async () => SUMMARY_BY_HOST[host],
    } as unknown as Response;
  });
}

let app: FastifyInstance;
let cookie: string;
let fetchMock: ReturnType<typeof makeFetch>;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  cookie = await getSessionCookie(app);
  resetVendorStatusCache();
  fetchMock = makeFetch();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const auth = () => ({ cookie });

describe("GET /api/vendor-status", () => {
  it("requires a session (401 without the cookie)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/vendor-status" });
    expect(res.statusCode).toBe(401);
  });

  it("returns all four vendors with indicators mapped to levels + active incidents", async () => {
    const res = await app.inject({ method: "GET", url: "/api/vendor-status", headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const byKey = Object.fromEntries(body.vendors.map((v: any) => [v.key, v]));
    expect(Object.keys(byKey).sort()).toEqual(["claude", "cloudflare", "github", "openai"]);

    expect(byKey.claude.level).toBe("operational");
    expect(byKey.claude.ok).toBe(true);
    expect(byKey.github.level).toBe("operational");

    // minor indicator → degraded, and only the unresolved incident survives.
    expect(byKey.cloudflare.level).toBe("degraded");
    expect(byKey.cloudflare.incidents).toHaveLength(1);
    expect(byKey.cloudflare.incidents[0].name).toBe("Elevated 5xx in WEUR");
    expect(byKey.cloudflare.incidents[0].impact).toBe("minor");

    expect(typeof body.fetchedAt).toBe("string");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("isolates a single vendor's failure — others still return, the failed one is 'unknown'", async () => {
    vi.stubGlobal("fetch", makeFetch(["status.openai.com"]));
    const res = await app.inject({ method: "GET", url: "/api/vendor-status", headers: auth() });
    expect(res.statusCode).toBe(200);
    const byKey = Object.fromEntries(res.json().vendors.map((v: any) => [v.key, v]));

    expect(byKey.openai.level).toBe("unknown");
    expect(byKey.openai.ok).toBe(false);
    expect(byKey.openai.description).toBe("Status unavailable");
    // The healthy vendors are unaffected.
    expect(byKey.claude.level).toBe("operational");
    expect(byKey.claude.ok).toBe(true);
  });

  it("treats a non-2xx response as that vendor being 'unknown'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response,
      ),
    );
    const res = await app.inject({ method: "GET", url: "/api/vendor-status", headers: auth() });
    expect(res.statusCode).toBe(200);
    for (const v of res.json().vendors) {
      expect(v.level).toBe("unknown");
      expect(v.ok).toBe(false);
    }
  });

  it("serves a cached response within the TTL (no re-fetch on the second call)", async () => {
    await app.inject({ method: "GET", url: "/api/vendor-status", headers: auth() });
    await app.inject({ method: "GET", url: "/api/vendor-status", headers: auth() });
    // 4 vendor fetches for the first call, zero for the cached second call.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("mapIndicatorToLevel", () => {
  it.each([
    ["none", "operational"],
    ["minor", "degraded"],
    ["major", "partial_outage"],
    ["critical", "major_outage"],
    ["maintenance", "maintenance"],
    ["something-new", "unknown"],
    [null, "unknown"],
  ])("maps indicator %s → %s", (indicator, level) => {
    expect(mapIndicatorToLevel(indicator as string | null)).toBe(level);
  });
});

describe("normalizeStatuspage", () => {
  const vendor = {
    key: "cloudflare",
    name: "Cloudflare",
    summaryUrl: "https://www.cloudflarestatus.com/api/v2/summary.json",
    statusPageUrl: "https://www.cloudflarestatus.com/",
  } as const;

  it("shapes a summary into the normalized VendorStatus and drops resolved incidents", () => {
    const out = normalizeStatuspage(vendor, cloudflareSummary);
    expect(out.key).toBe("cloudflare");
    expect(out.level).toBe("degraded");
    expect(out.indicator).toBe("minor");
    expect(out.description).toBe("Minor Service Outage");
    expect(out.updatedAt).toBe("2026-06-23T18:38:56.082Z");
    expect(out.ok).toBe(true);
    expect(out.incidents.map((i) => i.name)).toEqual(["Elevated 5xx in WEUR"]);
  });

  it("falls back gracefully when fields are missing", () => {
    const out = normalizeStatuspage(vendor, {});
    expect(out.level).toBe("unknown");
    expect(out.description).toBe("Unknown");
    expect(out.indicator).toBeNull();
    expect(out.updatedAt).toBeNull();
    expect(out.incidents).toEqual([]);
  });
});
