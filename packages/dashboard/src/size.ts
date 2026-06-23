// UI size (root font-size) registry + persistence, mirroring theme.ts.
//
// WebTUI sizes everything in `ch`/`lh`/`em` units, all derived from the root
// `--font-size`. Setting it on <html> therefore scales the whole UI
// proportionally — no per-component overrides needed.
//
// NOTE: the localStorage key and default below are mirrored by the pre-paint
// inline script in index.html — keep them in sync (see index.html <head>).

export const SIZE_STORAGE_KEY = "agentpr.size";
export const DEFAULT_SIZE = "16"; // px — matches WebTUI base.css's --font-size

export interface SizeOption {
  id: string; // px value, as a string
  label: string;
}

// 1px steps for fine-grained control, labeled by the raw px value. Range bounds
// keep the layout usable at either end (sidebar width, table min-widths); 16 is
// the WebTUI default (DEFAULT_SIZE).
const MIN_SIZE = 11;
const MAX_SIZE = 24;

export const SIZE_OPTIONS: SizeOption[] = Array.from(
  { length: MAX_SIZE - MIN_SIZE + 1 },
  (_, i) => {
    const px = MIN_SIZE + i;
    return { id: String(px), label: `${px}px` };
  },
);

const VALID_IDS = new Set(SIZE_OPTIONS.map((o) => o.id));

export function getStoredSize(): string {
  try {
    const v = localStorage.getItem(SIZE_STORAGE_KEY);
    if (v && VALID_IDS.has(v)) return v;
  } catch {
    /* ignore (private mode / disabled storage) */
  }
  return DEFAULT_SIZE;
}

export function applySize(id: string): void {
  // Inline style on <html> overrides base.css's `:root { --font-size }` (inline
  // wins over any layered selector), and `html { font-size: var(--font-size) }`
  // then cascades the new scale to the whole tree.
  document.documentElement.style.setProperty("--font-size", `${id}px`);
  try {
    localStorage.setItem(SIZE_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}
