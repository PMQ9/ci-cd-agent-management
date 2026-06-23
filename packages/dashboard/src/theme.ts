// Theme registry + persistence for the WebTUI theme switcher.
//
// NOTE: the localStorage key and default below are mirrored by the pre-paint
// inline script in index.html — keep them in sync (see index.html <head>).

export const THEME_STORAGE_KEY = "agentpr.theme";
export const DEFAULT_THEME = "catppuccin-mocha";

export interface ThemeOption {
  id: string;
  label: string;
}
export interface ThemeGroup {
  family: string;
  options: ThemeOption[];
}

// Curated selection spanning all 5 official WebTUI theme plugins. Every `id` is a
// real `data-webtui-theme` value verified against the installed packages.
export const THEME_GROUPS: ThemeGroup[] = [
  {
    family: "Catppuccin",
    options: [
      { id: "catppuccin-mocha", label: "Mocha" },
      { id: "catppuccin-macchiato", label: "Macchiato" },
      { id: "catppuccin-frappe", label: "Frappé" },
      { id: "catppuccin-latte", label: "Latte" },
    ],
  },
  {
    family: "Nord",
    options: [{ id: "nord", label: "Nord" }],
  },
  {
    family: "Gruvbox",
    options: [
      { id: "gruvbox-dark-medium", label: "Dark" },
      { id: "gruvbox-light-medium", label: "Light" },
    ],
  },
  {
    family: "Vitesse",
    options: [
      { id: "vitesse-dark", label: "Dark" },
      { id: "vitesse-black", label: "Black" },
      { id: "vitesse-light", label: "Light" },
    ],
  },
  {
    family: "Everforest",
    options: [
      { id: "everforest-dark-medium", label: "Dark" },
      { id: "everforest-light-medium", label: "Light" },
    ],
  },
];

const VALID_IDS = new Set(THEME_GROUPS.flatMap((g) => g.options.map((o) => o.id)));

export function getStoredTheme(): string {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v && VALID_IDS.has(v)) return v;
  } catch {
    /* ignore (private mode / disabled storage) */
  }
  return DEFAULT_THEME;
}

export function applyTheme(id: string): void {
  document.documentElement.setAttribute("data-webtui-theme", id);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}
