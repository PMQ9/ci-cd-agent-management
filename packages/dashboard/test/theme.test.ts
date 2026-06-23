// Pins src/theme.ts: stored-theme validation, default fallback, private-mode
// resilience, and applyTheme's DOM attribute + persistence side-effects.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THEME,
  THEME_GROUPS,
  THEME_STORAGE_KEY,
  applyTheme,
  getStoredTheme,
} from "../src/theme.js";

const VALID_IDS = THEME_GROUPS.flatMap((g) => g.options.map((o) => o.id));

// This jsdom config exposes the Storage class but NO `localStorage` instance, so
// we install a real in-memory one before each test and assign it directly on
// globalThis (the source reads the bare `localStorage` global). For the
// private-mode cases a test swaps in a throwing object via setLocalStorage().
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
  document.documentElement.removeAttribute("data-webtui-theme");
});

describe("registry", () => {
  it("DEFAULT_THEME is itself a valid id", () => {
    expect(VALID_IDS).toContain(DEFAULT_THEME);
  });

  it("has the expected catppuccin/nord/gruvbox/vitesse/everforest families", () => {
    expect(VALID_IDS).toEqual(
      expect.arrayContaining([
        "catppuccin-mocha",
        "nord",
        "gruvbox-dark-medium",
        "vitesse-dark",
        "everforest-dark-medium",
      ]),
    );
  });
});

describe("getStoredTheme", () => {
  beforeEach(() => localStorage.clear());

  it("returns a stored VALID id verbatim", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "nord");
    expect(getStoredTheme()).toBe("nord");
  });

  it("returns every valid id when it is the stored value (drift guard)", () => {
    for (const id of VALID_IDS) {
      localStorage.setItem(THEME_STORAGE_KEY, id);
      expect(getStoredTheme()).toBe(id);
    }
  });

  it("returns DEFAULT_THEME when nothing is stored", () => {
    expect(getStoredTheme()).toBe(DEFAULT_THEME);
  });

  it("returns DEFAULT_THEME for an unknown/invalid stored value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "solarized-bogus");
    expect(getStoredTheme()).toBe(DEFAULT_THEME);
  });

  it("returns DEFAULT_THEME for an empty-string stored value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "");
    expect(getStoredTheme()).toBe(DEFAULT_THEME);
  });

  it("returns DEFAULT_THEME when localStorage.getItem throws (private mode)", () => {
    setLocalStorage({
      ...makeMemoryStorage(),
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    } as Storage);
    expect(getStoredTheme()).toBe(DEFAULT_THEME);
  });
});

describe("applyTheme", () => {
  it("sets data-webtui-theme on <html> to the given id", () => {
    applyTheme("gruvbox-light-medium");
    expect(
      document.documentElement.getAttribute("data-webtui-theme"),
    ).toBe("gruvbox-light-medium");
  });

  it("persists the id to localStorage under THEME_STORAGE_KEY", () => {
    applyTheme("vitesse-black");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("vitesse-black");
  });

  it("applyTheme then getStoredTheme round-trips a valid id", () => {
    applyTheme("everforest-light-medium");
    expect(getStoredTheme()).toBe("everforest-light-medium");
  });

  it("swallows a throwing localStorage.setItem but still sets the DOM attribute", () => {
    const setItem = vi.fn(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    setLocalStorage({ ...makeMemoryStorage(), setItem } as unknown as Storage);
    expect(() => applyTheme("nord")).not.toThrow();
    expect(setItem).toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-webtui-theme")).toBe("nord");
  });
});
