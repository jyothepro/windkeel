import { foldFeed, turnDuration, type StepRow, type Turn } from "./agent-steps.ts";
import type { RunEvent } from "./types.ts";

export interface TerminalCommand {
  key: string;
  tool: "run" | "test";
  command: string;
  state: StepRow["state"];
  status: string | null;
  output: string | null;
  duration: { label: string; title: string } | null;
}

export interface TerminalTurn {
  key: string;
  agentRunId: string;
  role: string;
  running: boolean;
  duration: string | null;
  commands: TerminalCommand[];
}

const READ_INTERVAL_S = 60;

export function commandDuration(startedAt: string | null | undefined, endedAt: string | null | undefined): TerminalCommand["duration"] {
  if (!startedAt || !endedAt) return null;
  const seconds = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return null;
  if (seconds < READ_INTERVAL_S / 2) {
    return { label: seconds === 0 ? "under a minute" : `${seconds}s`, title: "Started and finished between two of Windkeel's reads of the agent's log, which are about a minute apart" };
  }
  const minutes = Math.round(seconds / 60);
  const label = seconds < 90 ? `~${seconds}s` : minutes < 60 ? `~${minutes}m` : `~${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return { label, title: "The time between the reads of the agent's log that saw it start and finish, within about a minute" };
}

export function terminalOf(events: readonly RunEvent[], live: boolean): TerminalTurn[] {
  const turns = foldFeed(events, live).filter((i): i is Turn => i.kind === "turn");
  return turns
    .map((turn) => ({
      key: turn.key,
      agentRunId: turn.agentRunId,
      role: turn.role,
      running: !turn.ended,
      duration: turnDuration(turn),
      commands: turn.rows
        .filter((r): r is StepRow => r.kind === "step" && (r.tool === "run" || r.tool === "test"))
        .map((r) => ({
          key: r.key,
          tool: r.tool as "run" | "test",
          command: r.target,
          state: r.state,
          status: r.state === "running" ? null : r.meta,
          output: r.output ? r.output : null,
          duration: r.state === "running" ? null : commandDuration(r.startedAt, r.endedAt),
        })),
    }))
    .filter((t) => t.commands.length > 0);
}

export function filesTouched(events: readonly RunEvent[], agentRunId: string): string[] {
  const seen = new Set<string>();
  for (const e of events) {
    if (e.kind !== "agent" || e.agentRunId !== agentRunId || e.event?.type !== "file_changed" || !e.event.path) continue;
    seen.add(e.event.path);
  }
  return [...seen];
}
