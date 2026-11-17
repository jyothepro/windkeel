import type { BatchDetail, BatchInput, BatchItemView, BatchView, WindkeelApi } from "../client/api.js";
import type { RemoteIo } from "./remote.js";

export const BATCH_USAGE =
  "usage: windkeel batch list [--json]\n" +
  "       windkeel batch create --repos <id,id,...> --title <title> --description <text|@file>\n" +
  "                          [--criteria-file <file>] [--risk low|medium|high]\n" +
  "                          [--max-concurrency <n>] [--cap <usd>|none [--uncapped-confirmed]]\n" +
  "                          [--child-cap <usd>] [--wall-clock <seconds>] [--stop-on-failure-ratio <0-1>] [--json]\n" +
  "       windkeel batch create --items <items.json> --repo <repository-id> --title <title>\n" +
  "                          --description <text|@file> [same options]\n" +
  "         (items.json: [{ \"title\": ..., \"description\": ..., \"criteria\": [...] }])\n" +
  "       windkeel batch status <batch-id> [--watch] [--json]\n" +
  "       windkeel batch pause|resume|cancel <batch-id>\n";

const SETTLED = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);

export type BatchAction =
  | { kind: "list"; json?: boolean }
  | { kind: "create"; input: BatchInput; json?: boolean }
  | { kind: "status"; batchId: string; watch?: boolean; json?: boolean; intervalMs?: number; sleep?: (ms: number) => Promise<void> }
  | { kind: "pause" | "resume" | "cancel"; batchId: string; json?: boolean };

export function parseCriteria(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((c) => typeof c !== "string")) {
      throw new Error("a JSON criteria file must be an array of strings");
    }
    return parsed as string[];
  }
  return trimmed
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*(\[[ xX]?\]\s*)?/, "").trim())
    .filter((line) => line !== "");
}

export function batchCapFlag(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  return raw.trim().toLowerCase() === "none" ? null : Number(raw);
}

export async function batchCommand(api: WindkeelApi, io: RemoteIo, action: BatchAction): Promise<number> {
  switch (action.kind) {
    case "list": {
      const page = await api.listBatches();
      if (action.json) {
        io.out(JSON.stringify(page.items, null, 2));
        return 0;
      }
      if (page.items.length === 0) {
        io.out("no batches; create one with `windkeel batch create`");
        return 0;
      }
      for (const b of page.items) io.out(formatBatchLine(b));
      return 0;
    }
    case "create": {
      const created = await api.createBatch(action.input);
      if (action.json) io.out(JSON.stringify(created, null, 2));
      else {
        io.out(`created batch ${created.batchId}: started ${created.started} of ${created.batch.progress.items}`);
        io.out(formatDetail(created));
      }
      return 0;
    }
    case "status": {
      const sleep = action.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      for (;;) {
        const detail = await api.getBatch(action.batchId);
        io.out(action.json ? JSON.stringify(detail, null, 2) : formatDetail(detail));
        if (!action.watch || SETTLED.has(detail.batch.status)) {
          return detail.batch.status === "FAILED" ? 1 : 0;
        }
        await sleep(action.intervalMs ?? 10_000);
      }
    }
    case "pause":
    case "resume":
    case "cancel": {
      const answer = await api.batchCommand(action.batchId, action.kind);
      if (action.json) io.out(JSON.stringify(answer, null, 2));
      else {
        const done = { pause: "paused", resume: "resumed", cancel: "cancelled" }[action.kind];
        io.out(`${done} batch ${answer.batchId}: ${answer.batch.status}`);
        if (answer.cancelled?.length) io.out(`  cancelled ${answer.cancelled.length} child run(s)`);
        if (action.kind === "resume" && answer.started) io.out(`  started ${answer.started}`);
      }
      return 0;
    }
  }
}

function usd(n: number | null): string {
  return n === null ? "uncapped" : `$${n.toFixed(2)}`;
}

export function formatBatchLine(b: BatchView): string {
  const p = b.progress;
  return (
    `${b.id}  ${b.status}${b.stopReason ? ` (${b.stopReason})` : ""}  ${b.kind}  ${b.title}\n` +
    `  ${p.items} items: ${p.active} active, ${p.pending} pending, ${p.succeeded} succeeded, ${p.failed} failed, ${p.skipped} skipped` +
    ` · spent ${usd(p.totalCostUsd)} of ${usd(b.batchSpendCapUsd)}`
  );
}

function formatItem(i: BatchItemView): string {
  const state = i.state === "dispatched" ? (i.runStatus ?? "dispatched") : i.state === "skipped" ? `skipped (${i.skipReason ?? "?"})` : "pending";
  const verdict = i.finalVerdict ? `  verdict ${i.finalVerdict}` : "";
  const pr = i.pullRequestUrl ? `  ${i.pullRequestUrl}` : "";
  const run = i.runId ? `  run ${i.runId}` : "";
  return `  #${i.ordinal}  ${i.repositoryFullName}${i.title ? `  ${i.title}` : ""}  ${state}${verdict}  ${usd(i.costUsd)}${run}${pr}`;
}

export function formatDetail(d: BatchDetail): string {
  const v = d.batch.progress.verdicts;
  return [
    formatBatchLine(d.batch),
    `  verdicts: pass ${v.pass}, warn ${v.warn}, fail ${v.fail}, none yet ${v.none} · max ${d.batch.maxConcurrency} at once` +
      (d.batch.progress.remainingBudgetUsd !== null ? ` · ${usd(d.batch.progress.remainingBudgetUsd)} unreserved` : ""),
    ...d.items.map(formatItem),
  ].join("\n");
}
