import { useState } from "react";
import { applyTheme, getStoredTheme, THEME_GROUPS } from "./theme.js";

export function ThemeSwitcher() {
  // Initialised from localStorage, which the pre-paint script already applied to
  // <html>, so React state and the DOM agree on first render.
  const [theme, setTheme] = useState<string>(getStoredTheme);

  return (
    <label className="theme-switch">
      <span>Theme</span>
      <select
        value={theme}
        onChange={(e) => {
          applyTheme(e.target.value);
          setTheme(e.target.value);
        }}
      >
        {THEME_GROUPS.map((g) => (
          <optgroup key={g.family} label={g.family}>
            {g.options.map((o) => (
              <option key={o.id} value={o.id}>
                {g.family} · {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
