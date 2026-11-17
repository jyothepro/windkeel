"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { IconSearch } from "./icons.tsx";
import { PAGES, actionItems, searchCommands, type CommandItem, type CommandKind, type RunCommand } from "../lib/command-search.ts";

export const OPEN_COMMAND_SEARCH = "windkeel:command-search";

const KIND_LABEL: Record<CommandKind, string> = { action: "Do", page: "Go to", run: "Run", task: "Task", repository: "Repository" };

export interface RunCommands {
  runId: string;
  title: string;
  commands: readonly RunCommand[];
  perform: (command: RunCommand) => void;
}

let registered: RunCommands | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const emit = () => listeners.forEach((l) => l());

export function useRunCommands(runId: string, title: string, commands: readonly RunCommand[], perform: (command: RunCommand) => void) {
  const performRef = useRef(perform);
  performRef.current = perform;
  const key = commands.join(",");
  useEffect(() => {
    const entry: RunCommands = { runId, title, commands: key ? (key.split(",") as RunCommand[]) : [], perform: (c) => performRef.current(c) };
    registered = entry;
    emit();
    return () => {
      if (registered === entry) {
        registered = null;
        emit();
      }
    };
  }, [runId, title, key]);
}

type Loaded = { state: "idle" | "loading" } | { state: "ready"; items: CommandItem[] } | { state: "failed"; message: string };

export function CommandPalette() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ state: "idle" });
  const listId = useId();
  const run = useSyncExternalStore(subscribe, () => registered, () => null);

  const open = useCallback(() => {
    const el = dialog.current;
    if (!el || el.open) return;
    setQuery("");
    setActive(0);
    el.showModal();
    input.current?.focus();
    setLoaded({ state: "loading" });
    fetch("/api/search", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { items?: CommandItem[]; error?: string };
        if (!res.ok || !body.items) throw new Error(body.error ?? `search answered ${res.status}`);
        setLoaded({ state: "ready", items: body.items });
      })
      .catch((err: unknown) => setLoaded({ state: "failed", message: err instanceof Error ? err.message : String(err) }));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (dialog.current?.open) dialog.current.close();
        else open();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COMMAND_SEARCH, open);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_COMMAND_SEARCH, open);
    };
  }, [open]);

  const items = useMemo(
    () => [...actionItems(run), ...(loaded.state === "ready" ? loaded.items.filter((i) => i.kind !== "action") : PAGES)],
    [run, loaded],
  );
  const results = useMemo(() => searchCommands(items, query), [items, query]);
  const selected = results[Math.min(active, results.length - 1)];

  const go = (item: CommandItem | undefined) => {
    if (!item) return;
    dialog.current?.close();
    if (item.command && run) run.perform(item.command);
    else router.push(item.href);
  };

  const onInputKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (Math.min(i, results.length - 1) + step + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(selected);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="oq-dialog console-command"
      aria-label="Search the console"
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <div className="console-command__field">
        <input
          ref={input}
          className="oq-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={selected ? `${listId}-${selected.key}` : undefined}
          aria-autocomplete="list"
          placeholder="Search or do something — runs, tasks, pages, actions"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onInputKey}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <ul id={listId} role="listbox" className="console-command__results" aria-label="Results">
        {results.map((item, index) => (
          <li
            key={item.key}
            id={`${listId}-${item.key}`}
            role="option"
            aria-selected={item === selected}
            className="console-command__item"
            onMouseMove={() => setActive(index)}
            onClick={() => go(item)}
          >
            <span className="console-command__kind">{KIND_LABEL[item.kind]}</span>
            <span className="console-command__label">{item.label}</span>
            {item.detail ? <span className="console-command__detail">{item.detail}</span> : null}
          </li>
        ))}
        {results.length === 0 ? <li className="console-command__empty">Nothing matches “{query.trim()}”.</li> : null}
      </ul>
      <p className="console-command__status" role="status">
        {loaded.state === "loading"
          ? "Loading runs, tasks and repositories…"
          : loaded.state === "failed"
            ? `Only pages are searchable right now: ${loaded.message}`
            : "Recent runs and everything waiting on you · ↑↓ to move · Enter to open or do · Esc to close"}
      </p>
    </dialog>
  );
}

export function CommandSearchButton() {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  return (
    <button
      type="button"
      className="oq-nav-item console-command__open"
      onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_SEARCH))}
    >
      <IconSearch />
      <span className="oq-nav-item__label">Search</span>
      <span className="oq-kbd" aria-label={mac ? "Command K" : "Control K"}>
        {mac ? "⌘K" : "Ctrl K"}
      </span>
    </button>
  );
}
