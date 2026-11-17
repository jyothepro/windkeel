import type { RepositorySummary, RunSummary, TaskRow } from "./types.ts";
import { TERMINAL_STATES, stateLabel, type RunState } from "./run-states.ts";

export type CommandKind = "action" | "page" | "run" | "task" | "repository";

export type RunCommand = "approve" | "run_again" | "cancel";

export interface CommandItem {
  kind: CommandKind;
  key: string;
  label: string;
  detail?: string;
  href: string;
  keywords?: string[];
  command?: RunCommand;
}

export const ACTIONS: CommandItem[] = [
  { kind: "action", key: "action:new-task", label: "New task", href: "/tasks/new", keywords: ["file", "submit", "create", "start", "prompt"] },
];

export const PAGES: CommandItem[] = [
  { kind: "page", key: "page:home", label: "Home", href: "/", keywords: ["composer", "start"] },
  { kind: "page", key: "page:inbox", label: "Inbox", href: "/runs", keywords: ["runs", "decisions", "failed"] },
  { kind: "page", key: "page:tasks", label: "Tasks", href: "/tasks" },
  { kind: "page", key: "page:repositories", label: "Repositories", href: "/repositories", keywords: ["repos"] },
  { kind: "page", key: "page:metrics", label: "Metrics", href: "/metrics", keywords: ["cost", "rates"] },
  { kind: "page", key: "page:settings", label: "Settings", href: "/settings", keywords: ["tokens", "members", "theme"] },
  { kind: "page", key: "page:tokens", label: "Your tokens", href: "/settings/tokens", keywords: ["settings", "api", "cli", "mcp"] },
];

export const RUN_COMMAND_LABEL: Record<RunCommand, string> = {
  approve: "Approve criteria",
  run_again: "Run again",
  cancel: "Cancel run",
};

export function runCommands(state: RunState): RunCommand[] {
  const out: RunCommand[] = [];
  if (state === "WAITING_FOR_APPROVAL") out.push("approve");
  if (TERMINAL_STATES.has(state)) out.push("run_again");
  else out.push("cancel");
  return out;
}

export function actionItems(run: { runId: string; title: string; commands: readonly RunCommand[] } | null): CommandItem[] {
  const own = (run?.commands ?? []).map(
    (command): CommandItem => ({
      kind: "action",
      key: `action:${command}`,
      label: RUN_COMMAND_LABEL[command],
      detail: run!.title,
      href: `/runs/${encodeURIComponent(run!.runId)}`,
      keywords: command === "cancel" ? ["stop"] : command === "run_again" ? ["retry", "restart"] : ["criteria", "accept"],
      command,
    }),
  );
  return [...own, ...ACTIONS];
}

export interface SearchSources {
  runs: RunSummary[];
  tasks: TaskRow[];
  repositories: RepositorySummary[];
}

export function buildIndex(sources: SearchSources): CommandItem[] {
  const repoName = new Map(sources.repositories.map((r) => [r.id, r.fullName]));
  return [
    ...ACTIONS,
    ...PAGES,
    ...sources.runs.map(
      (run): CommandItem => ({
        kind: "run",
        key: `run:${run.id}`,
        label: run.taskTitle,
        detail: `${run.id.slice(0, 8)} · ${stateLabel(run.status)}`,
        href: `/runs/${encodeURIComponent(run.id)}`,
        keywords: [run.id, run.status, repoName.get(run.repositoryId) ?? "", run.prNumber ? `#${run.prNumber}` : ""],
      }),
    ),
    ...sources.tasks.map(
      (task): CommandItem => ({
        kind: "task",
        key: `task:${task.id}`,
        label: task.title,
        detail: repoName.get(task.repositoryId) ?? task.sourceReference,
        href: `/tasks/${encodeURIComponent(task.id)}`,
        keywords: [task.id, task.sourceReference],
      }),
    ),
    ...sources.repositories.map(
      (repo): CommandItem => ({
        kind: "repository",
        key: `repository:${repo.id}`,
        label: repo.fullName,
        detail: repo.openRuns === 1 ? "1 open run" : `${repo.openRuns} open runs`,
        href: `/repositories/${encodeURIComponent(repo.id)}`,
        keywords: [repo.id],
      }),
    ),
  ];
}

export function matchScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (q === "") return 1;
  if (t.startsWith(q)) return 100;
  if (t.split(/[^a-z0-9#]+/).some((word) => word.startsWith(q))) return 80;
  if (t.includes(q)) return 60;
  let at = 0;
  for (const ch of q) {
    at = t.indexOf(ch, at);
    if (at === -1) return 0;
    at += 1;
  }
  return 20;
}

const KIND_WEIGHT: Record<CommandKind, number> = { action: 4, page: 3, run: 2, task: 1, repository: 0 };

export function searchCommands(items: CommandItem[], query: string, limit = 12): CommandItem[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items.slice(0, limit);

  const scored: Array<{ item: CommandItem; score: number; index: number }> = [];
  items.forEach((item, index) => {
    let total = 0;
    for (const word of words) {
      const best = Math.max(
        matchScore(item.label, word) * 1.5,
        item.detail ? matchScore(item.detail, word) : 0,
        ...(item.keywords ?? []).map((k) => matchScore(k, word)),
      );
      if (best === 0) return;
      total += best;
    }
    scored.push({ item, score: total + KIND_WEIGHT[item.kind], index });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((s) => s.item);
}
