import { describe, expect, it } from "vitest";
import { randomToken, safeEqualHex, sha256 } from "../src/util/crypto.js";

describe("safeEqualHex", () => {
  it("returns true for two identical strings", () => {
    expect(safeEqualHex("deadbeef", "deadbeef")).toBe(true);
  });

  it("returns false for strings of different length", () => {
    expect(safeEqualHex("abcd", "abcdef")).toBe(false);
  });

  it("returns false for equal-length but different strings", () => {
    expect(safeEqualHex("deadbeef", "deadbee0")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(safeEqualHex("", "")).toBe(true);
  });
});

describe("sha256", () => {
  it("matches the known empty-string vector", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the known 'abc' vector", () => {
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("produces a 64-char lowercase-hex digest", () => {
    const out = sha256("any input here");
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    expect(sha256("repeat-me")).toBe(sha256("repeat-me"));
  });
});

describe("randomToken", () => {
  it("returns 64 hex chars by default (32 bytes)", () => {
    expect(randomToken()).toHaveLength(64);
  });

  it("returns 2*N hex chars for an explicit byte count", () => {
    expect(randomToken(16)).toHaveLength(32);
    expect(randomToken(8)).toHaveLength(16);
  });

  it("produces only lowercase hex characters", () => {
    expect(randomToken()).toMatch(/^[0-9a-f]+$/);
  });

  it("returns different values on successive calls", () => {
    expect(randomToken()).not.toBe(randomToken());
  });
});
