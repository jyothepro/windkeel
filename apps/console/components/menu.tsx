"use client";

import { useEffect, useRef } from "react";

export function Menu({
  summary,
  label,
  align = "start",
  className,
  children,
}: {
  summary: React.ReactNode;
  label: string;
  align?: "start" | "end";
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        el.open = false;
        el.querySelector("summary")?.focus();
      } else if (!el.contains(e.target as Node)) {
        el.open = false;
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  return (
    <details ref={ref} className={["console-menu", className].filter(Boolean).join(" ")}>
      <summary aria-label={label}>{summary}</summary>
      <div
        className="console-menu__panel"
        data-align={align}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a, button[type='submit']") && ref.current) ref.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}
