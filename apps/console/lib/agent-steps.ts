import type { AgentStep, RunEvent } from "./types.ts";

export type StepTool = "run" | "test" | "edit" | "think" | "retry" | "fail" | "browser";

export interface StepRow {
  kind: "step";
  key: string;
  tool: StepTool;
  verb: string;
  target: string;
  meta: string | null;
  state: "done" | "running" | "failed";
  detail: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  output?: string | null;
  exitCode?: number | null;
}

export interface MessageRow {
  kind: "message";
  key: string;
  text: string;
  at: string;
}

export interface ScreenshotRow {
  kind: "screenshot";
  key: string;
  screenshotId: string;
  name: string;
  url: string | null;
}

export type TurnRow = StepRow | MessageRow | ScreenshotRow;

export interface Turn {
  kind: "turn";
  key: string;
  agentRunId: string;
  role: string;
  startedAt: string;
  lastAt: string;
  ended: boolean;
  failed: boolean;
  rows: TurnRow[];
}

export type FeedItem = { kind: "event"; event: RunEvent } | Turn;

const firstLine = (text: string, max = 140) => {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const exitMeta = (code: number | null | undefined) => (code === null || code === undefined ? "killed" : `exit ${code}`);

export function foldFeed(events: readonly RunEvent[], live: boolean): FeedItem[] {
  const items: FeedItem[] = [];
  const turns = new Map<string, Turn>();
  const open = new Map<string, Map<string, number>>();

  for (const e of events) {
    if (e.kind !== "agent" || !e.event || !e.agentRunId) {
      items.push({ kind: "event", event: e });
      continue;
    }
    let turn = turns.get(e.agentRunId);
    if (!turn) {
      turn = { kind: "turn", key: `turn:${e.agentRunId}`, agentRunId: e.agentRunId, role: e.role ?? "implementer", startedAt: e.at, lastAt: e.at, ended: false, failed: false, rows: [] };
      turns.set(e.agentRunId, turn);
      open.set(e.agentRunId, new Map());
      items.push(turn);
    }
    turn.lastAt = e.at;
    apply(turn, open.get(e.agentRunId)!, e.event, e.cursor, e.at);
  }

  const newest = [...turns.values()].at(-1);
  for (const turn of turns.values()) {
    const running = live && !turn.ended && turn === newest;
    for (const row of turn.rows) {
      if (row.kind === "step" && row.state === "running" && !running) {
        row.state = "done";
        row.meta = row.meta ?? "no exit recorded";
      }
    }
    if (!running) turn.ended = true;
  }
  return items;
}

const RECONNECT = /^Reconnecting\.\.\.\s*(\d+\/\d+)\s*(?:\((.*)\))?\s*$/s;

function apply(turn: Turn, open: Map<string, number>, event: AgentStep, cursor: string, at: string): void {
  const key = `${turn.agentRunId}:${cursor}`;
  const reconnect = event.type === "failed" ? RECONNECT.exec(event.error ?? "") : null;
  const note = event.type === "screenshot" || event.type === "browser_unavailable";
  if (!note && event.type !== "completed" && (event.type !== "failed" || reconnect)) {
    turn.ended = false;
    turn.failed = false;
  }
  if (reconnect) {
    turn.rows.push({ kind: "step", key, tool: "retry", verb: "retry", target: reconnect[2] ?? "the model stream disconnected", meta: reconnect[1]!, state: "done", detail: null });
    return;
  }
  switch (event.type) {
    case "started":
      return;
    case "completed":
      turn.ended = true;
      turn.failed = false;
      return;
    case "failed":
      turn.ended = true;
      turn.failed = true;
      turn.rows.push({ kind: "step", key, tool: "fail", verb: "failed", target: firstLine(event.error ?? "the agent reported a failure"), meta: null, state: "failed", detail: event.error ?? null });
      return;
    case "command_started":
    case "test_started": {
      const tool: StepTool = event.type === "test_started" ? "test" : "run";
      const command = event.command ?? "";
      open.set(`${tool}:${command}`, turn.rows.length);
      turn.rows.push({ kind: "step", key, tool, verb: tool, target: command, meta: null, state: "running", detail: null, startedAt: at });
      return;
    }
    case "command_finished":
    case "test_finished": {
      const tool: StepTool = event.type === "test_finished" ? "test" : "run";
      const command = event.command ?? "";
      const failed = event.type === "test_finished" ? event.passed === false : typeof event.exitCode === "number" && event.exitCode !== 0;
      const meta = event.type === "test_finished" ? `${event.passed ? "passed" : "failed"} · ${exitMeta(event.exitCode)}` : exitMeta(event.exitCode);
      const row: StepRow = {
        kind: "step",
        key,
        tool,
        verb: tool,
        target: command,
        meta,
        state: failed ? "failed" : "done",
        detail: null,
        startedAt: null,
        endedAt: at,
        output: event.output ?? null,
        exitCode: event.exitCode ?? null,
      };
      const index = open.get(`${tool}:${command}`);
      if (index === undefined) turn.rows.push(row);
      else {
        const started = turn.rows[index] as StepRow;
        turn.rows[index] = { ...row, key: started.key, startedAt: started.startedAt ?? null };
        open.delete(`${tool}:${command}`);
      }
      return;
    }
    case "file_changed":
      turn.rows.push({ kind: "step", key, tool: "edit", verb: "edit", target: event.path ?? "", meta: event.kind === "add" ? "new file" : event.kind === "delete" ? "deleted" : null, state: "done", detail: null });
      return;
    case "thinking": {
      const text = event.text ?? "";
      turn.rows.push({ kind: "step", key, tool: "think", verb: "think", target: firstLine(text), meta: null, state: "done", detail: text.includes("\n") || text.length > 140 ? text : null });
      return;
    }
    case "message":
      turn.rows.push({ kind: "message", key, text: event.text ?? "", at });
      return;
    case "screenshot":
      if (typeof event.screenshotId !== "string") return;
      turn.rows.push({ kind: "screenshot", key, screenshotId: event.screenshotId, name: firstLine(event.name ?? "screenshot", 80), url: event.url ?? null });
      return;
    case "browser_unavailable":
      turn.rows.push({ kind: "step", key, tool: "browser", verb: "browser", target: "unavailable — the maker worked without one", meta: null, state: "done", detail: event.reason ?? null });
      return;
  }
}

export function turnDuration(turn: Turn, now: number = Date.now()): string | null {
  const end = turn.ended ? new Date(turn.lastAt).getTime() : now;
  const seconds = Math.max(0, Math.round((end - new Date(turn.startedAt).getTime()) / 1000));
  if (seconds < 1) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const stepCount = (turn: Turn) => turn.rows.filter((r) => r.kind === "step").length;
