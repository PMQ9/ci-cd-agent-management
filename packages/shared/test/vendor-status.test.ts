import { describe, expect, it } from "vitest";
import {
  VENDOR_STATUS_LEVELS,
  VendorStatusResponseSchema,
  VendorStatusSchema,
} from "../src/contracts";

const validVendor = {
  key: "claude",
  name: "Claude",
  statusPageUrl: "https://status.claude.com/",
  level: "operational" as const,
  description: "All Systems Operational",
  indicator: "none",
  updatedAt: "2026-06-23T18:32:57.399Z",
  incidents: [],
  ok: true,
};

describe("VendorStatusSchema", () => {
  it("round-trips a valid vendor status", () => {
    const parsed = VendorStatusSchema.parse(validVendor);
    expect(parsed).toEqual(validVendor);
  });

  it("accepts an incident with optional shortlink omitted and a nullable updatedAt", () => {
    const parsed = VendorStatusSchema.parse({
      ...validVendor,
      level: "major_outage",
      indicator: "critical",
      ok: true,
      incidents: [
        { name: "Elevated errors", impact: "major", status: "investigating", updatedAt: null },
      ],
    });
    expect(parsed.incidents[0].shortlink).toBeUndefined();
    expect(parsed.incidents[0].updatedAt).toBeNull();
  });

  it("rejects an invalid level enum", () => {
    const bad = VendorStatusSchema.safeParse({ ...validVendor, level: "totally_down" });
    expect(bad.success).toBe(false);
  });

  it("exposes every level in VENDOR_STATUS_LEVELS as a valid enum value", () => {
    for (const level of VENDOR_STATUS_LEVELS) {
      expect(VendorStatusSchema.safeParse({ ...validVendor, level }).success).toBe(true);
    }
  });
});

describe("VendorStatusResponseSchema", () => {
  it("round-trips a response with multiple vendors", () => {
    const res = {
      fetchedAt: "2026-06-23T18:40:00.000Z",
      vendors: [validVendor, { ...validVendor, key: "github", name: "GitHub" }],
    };
    expect(VendorStatusResponseSchema.parse(res)).toEqual(res);
  });

  it("rejects a missing fetchedAt", () => {
    expect(VendorStatusResponseSchema.safeParse({ vendors: [validVendor] }).success).toBe(false);
  });
});
