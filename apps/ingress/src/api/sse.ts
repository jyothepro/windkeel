

import type { RunEvent } from "@windkeel/factory/runs";
import type { RunChange } from "@windkeel/factory/runs";

export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/event-stream; charset=utf-8",

  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",

  "x-accel-buffering": "no",
});

export function frame(event: string, data: unknown, id?: string): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);

  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join("\n")}\n\n`;
}

export function eventFrame(event: RunEvent): string {
  return frame(event.kind, event, event.cursor);
}

export function cursorFrame(cursor: string, reason: CloseReason): string {
  return frame("cursor", { cursor, reason, reconnect: reason !== "run_terminal" }, cursor);
}

export type CloseReason = "budget_exhausted" | "run_terminal" | "client_gone";

export function changeFrame(change: RunChange, resumeCursor: string): string {
  return frame(change.kind, change, resumeCursor);
}

export function resyncFrame(cursor: string): string {
  return frame("resync", { cursor }, cursor);
}

export function keepAlive(): string {
  return `: keep-alive\n\n`;
}
