"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { OPEN_COMMAND_SEARCH } from "./command-palette.tsx";
import { IconMenu, IconSearch } from "./icons.tsx";

export function DrawerBar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    const root = document.documentElement;
    if (open) root.dataset.drawer = "open";
    else delete root.dataset.drawer;
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => {
      const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (link && link.closest("#console-sidebar")) setOpen(false);
    };
    const onBack = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onBack);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onBack);
      document.removeEventListener("click", onClick);
    };
  }, [open]);

  return (
    <>
      <div className="console-topbar">
        <button
          type="button"
          className="oq-button oq-button--ghost oq-button--sm oq-button--icon"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls="console-sidebar"
          onClick={() => setOpen((o) => !o)}
        >
          <IconMenu />
        </button>
        <span className="console-topbar__brand">
          <span className="console-mark" aria-hidden="true" />
          Windkeel
        </span>
        <button
          type="button"
          className="oq-button oq-button--ghost oq-button--sm oq-button--icon"
          aria-label="Search"
          onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_SEARCH))}
        >
          <IconSearch />
        </button>
      </div>
      {open ? <div className="console-drawer-scrim" aria-hidden="true" onClick={() => setOpen(false)} /> : null}
    </>
  );
}
