import { useState } from "react";
import { SIZE_OPTIONS, applySize, getStoredSize } from "./size.js";

export function SizeSwitcher() {
  // Initialised from localStorage, which the pre-paint script already applied to
  // <html>, so React state and the DOM agree on first render.
  const [size, setSize] = useState<string>(getStoredSize);

  return (
    <label className="theme-switch">
      <span>Size</span>
      <select
        value={size}
        onChange={(e) => {
          applySize(e.target.value);
          setSize(e.target.value);
        }}
      >
        {SIZE_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
