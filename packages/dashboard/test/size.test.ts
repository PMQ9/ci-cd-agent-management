// Pins src/size.ts (mirrors theme.ts): stored-size validation, default fallback,
// private-mode resilience, and applySize's inline --font-size + persistence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySize,
  DEFAULT_SIZE,
  getStoredSize,
  SIZE_OPTIONS,
  SIZE_STORAGE_KEY,
} from "../src/size.js";

const VALID_IDS = SIZE_OPTIONS.map((o) => o.id);

// See theme.test.ts: this jsdom config has the Storage class but no
// `localStorage` instance, so we install a real in-memory one each test and
// swap in throwing impls for the private-mode cases.
function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

function setLocalStorage(impl: Storage) {
  (globalThis as { localStorage: Storage }).localStorage = impl;
}

beforeEach(() => {
  setLocalStorage(makeMemoryStorage());
});

afterEach(() => {
  document.documentElement.style.removeProperty("--font-size");
});

describe("registry", () => {
  it("DEFAULT_SIZE is itself a valid id", () => {
    expect(VALID_IDS).toContain(DEFAULT_SIZE);
  });

  it("covers the inclusive 11..24 px range as string ids", () => {
    expect(VALID_IDS).toEqual([
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "20",
      "21",
      "22",
      "23",
      "24",
    ]);
    expect(SIZE_OPTIONS[0]).toEqual({ id: "11", label: "11px" });
    expect(SIZE_OPTIONS.at(-1)).toEqual({ id: "24", label: "24px" });
  });
});

describe("getStoredSize", () => {
  beforeEach(() => localStorage.clear());

  it("returns a stored VALID id verbatim", () => {
    localStorage.setItem(SIZE_STORAGE_KEY, "20");
    expect(getStoredSize()).toBe("20");
  });

  it("returns every valid id when it is the stored value (drift guard)", () => {
    for (const id of VALID_IDS) {
      localStorage.setItem(SIZE_STORAGE_KEY, id);
      expect(getStoredSize()).toBe(id);
    }
  });

  it("returns DEFAULT_SIZE when nothing is stored", () => {
    expect(getStoredSize()).toBe(DEFAULT_SIZE);
  });

  it("returns DEFAULT_SIZE for an out-of-range value (10, below MIN)", () => {
    localStorage.setItem(SIZE_STORAGE_KEY, "10");
    expect(getStoredSize()).toBe(DEFAULT_SIZE);
  });

  it("returns DEFAULT_SIZE for an out-of-range value (25, above MAX)", () => {
    localStorage.setItem(SIZE_STORAGE_KEY, "25");
    expect(getStoredSize()).toBe(DEFAULT_SIZE);
  });

  it("returns DEFAULT_SIZE for a non-numeric / garbage value", () => {
    localStorage.setItem(SIZE_STORAGE_KEY, "huge");
    expect(getStoredSize()).toBe(DEFAULT_SIZE);
  });

  it("returns DEFAULT_SIZE for a px-suffixed value (ids are bare numbers)", () => {
    localStorage.setItem(SIZE_STORAGE_KEY, "16px");
    expect(getStoredSize()).toBe(DEFAULT_SIZE);
  });

  it("returns DEFAULT_SIZE when localStorage.getItem throws (private mode)", () => {
    setLocalStorage({
      ...makeMemoryStorage(),
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    } as Storage);
    expect(getStoredSize()).toBe(DEFAULT_SIZE);
  });
});

describe("applySize", () => {
  it("sets the inline --font-size custom property on <html> with a px suffix", () => {
    applySize("20");
    expect(document.documentElement.style.getPropertyValue("--font-size")).toBe("20px");
  });

  it("persists the bare id to localStorage under SIZE_STORAGE_KEY", () => {
    applySize("18");
    expect(localStorage.getItem(SIZE_STORAGE_KEY)).toBe("18");
  });

  it("applySize then getStoredSize round-trips a valid id", () => {
    applySize("13");
    expect(getStoredSize()).toBe("13");
  });

  it("swallows a throwing localStorage.setItem but still sets the inline style", () => {
    const setItem = vi.fn(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    setLocalStorage({ ...makeMemoryStorage(), setItem } as unknown as Storage);
    expect(() => applySize("22")).not.toThrow();
    expect(setItem).toHaveBeenCalled();
    expect(document.documentElement.style.getPropertyValue("--font-size")).toBe("22px");
  });
});
