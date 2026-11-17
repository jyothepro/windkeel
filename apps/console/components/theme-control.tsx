"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";

export function ThemeControl() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("windkeel-theme");
      if (saved === "light" || saved === "dark") setTheme(saved);
    } catch {}
  }, []);

  const choose = (t: Theme) => {
    setTheme(t);
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("windkeel-theme", t);
    } catch {}
  };

  return (
    <div className="oq-segmented" role="group" aria-label="Theme">
      {(["system", "light", "dark"] as const).map((t) => (
        <button key={t} type="button" className="oq-segmented__item" aria-pressed={theme === t} onClick={() => choose(t)}>
          {t.charAt(0).toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  );
}
