import {
  type VendorIncident,
  type VendorStatus,
  type VendorStatusResponse,
  VendorStatusResponseSchema,
} from "@agentpr/shared";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";

// External vendors / AI services we depend on. All four expose an Atlassian
// Statuspage JSON API at `<host>/api/v2/summary.json` (uniform shape), so one
// adapter (`normalizeStatuspage`) handles every one. Adding a vendor = appending
// an entry here. (Neon and Google Cloud do NOT serve this shape — they'd each
// need a separate adapter; see the plan notes.)
const VENDORS = [
  {
    key: "claude",
    name: "Claude",
    summaryUrl: "https://status.claude.com/api/v2/summary.json",
    statusPageUrl: "https://status.claude.com/",
  },
  {
    key: "github",
    name: "GitHub",
    summaryUrl: "https://www.githubstatus.com/api/v2/summary.json",
    statusPageUrl: "https://www.githubstatus.com/",
  },
  {
    key: "cloudflare",
    name: "Cloudflare",
    summaryUrl: "https://www.cloudflarestatus.com/api/v2/summary.json",
    statusPageUrl: "https://www.cloudflarestatus.com/",
  },
  {
    key: "openai",
    name: "OpenAI",
    summaryUrl: "https://status.openai.com/api/v2/summary.json",
    statusPageUrl: "https://status.openai.com/",
  },
] as const;

type Vendor = (typeof VENDORS)[number];

// Status is identical for every user, so cache it process-wide for a short TTL.
// This stops dashboard polling (and multiple operators) from hammering the
// upstream Statuspage APIs. Per-warm-instance on Cloud Run, which is fine.
const CACHE_TTL_MS = Number(process.env.VENDOR_STATUS_TTL_MS) || 60_000;
const FETCH_TIMEOUT_MS = 5_000;

let cache: { at: number; data: VendorStatusResponse } | null = null;

/** Test-only: drop the cached response so each test starts cold. */
export function resetVendorStatusCache(): void {
  cache = null;
}

/** Map a raw Statuspage `status.indicator` to our normalized level bucket. */
export function mapIndicatorToLevel(indicator: string | null | undefined): VendorStatus["level"] {
  switch (indicator) {
    case "none":
      return "operational";
    case "minor":
      return "degraded";
    case "major":
      return "partial_outage";
    case "critical":
      return "major_outage";
    case "maintenance":
      return "maintenance";
    default:
      return "unknown";
  }
}

/** Statuspage summary.json (the bits we read). */
interface StatuspageSummary {
  page?: { updated_at?: string | null };
  status?: { indicator?: string | null; description?: string | null };
  incidents?: Array<{
    name?: string;
    impact?: string;
    status?: string;
    shortlink?: string;
    updated_at?: string | null;
  }>;
}

/** Shape one vendor's Statuspage summary into our normalized VendorStatus. */
export function normalizeStatuspage(vendor: Vendor, json: StatuspageSummary): VendorStatus {
  const indicator = json.status?.indicator ?? null;
  // The summary endpoint already returns only currently-relevant incidents; drop
  // any that are resolved/closed so the panel shows only what's actively ongoing.
  const incidents: VendorIncident[] = (json.incidents ?? [])
    .filter((i) => i.status !== "resolved" && i.status !== "postmortem")
    .map((i) => ({
      name: i.name ?? "Incident",
      impact: i.impact ?? "unknown",
      status: i.status ?? "unknown",
      shortlink: i.shortlink,
      updatedAt: i.updated_at ?? null,
    }));
  return {
    key: vendor.key,
    name: vendor.name,
    statusPageUrl: vendor.statusPageUrl,
    level: mapIndicatorToLevel(indicator),
    description: json.status?.description ?? "Unknown",
    indicator,
    updatedAt: json.page?.updated_at ?? null,
    incidents,
    ok: true,
  };
}

/** A vendor whose status fetch failed — surfaced as "unknown" rather than dropped. */
function unavailable(vendor: Vendor): VendorStatus {
  return {
    key: vendor.key,
    name: vendor.name,
    statusPageUrl: vendor.statusPageUrl,
    level: "unknown",
    description: "Status unavailable",
    indicator: null,
    updatedAt: null,
    incidents: [],
    ok: false,
  };
}

// Each vendor resolves independently: a fetch error / timeout / non-2xx becomes
// that vendor's "unknown" entry rather than rejecting, so one outage can't tank
// the rest of the panel.
async function fetchVendor(vendor: Vendor): Promise<VendorStatus> {
  try {
    const res = await fetch(vendor.summaryUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`${vendor.key} status ${res.status}`);
    return normalizeStatuspage(vendor, (await res.json()) as StatuspageSummary);
  } catch {
    return unavailable(vendor);
  }
}

export function registerVendorStatusRoutes(app: FastifyInstance): void {
  app.get("/api/vendor-status", { preHandler: requireUser }, async () => {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

    const vendors = await Promise.all(VENDORS.map(fetchVendor));

    const data = VendorStatusResponseSchema.parse({
      fetchedAt: new Date().toISOString(),
      vendors,
    });
    cache = { at: Date.now(), data };
    return data;
  });
}
