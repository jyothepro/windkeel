import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { MetricsReport, WindkeelApi, ReapResult, UsageReport } from "../client/api.js";
import { ApiError } from "../client/api.js";
import type { RemoteIo } from "./remote.js";
import { printRefusal } from "./remote.js";

export async function metricsCommand(api: WindkeelApi, io: RemoteIo, json?: boolean): Promise<number> {
  const report = await api.metrics();
  io.out(json ? JSON.stringify(report, null, 2) : formatMetrics(report));
  return 0;
}

export function formatMetrics(report: MetricsReport): string {
  const lines: string[] = [];
  for (const [view, row] of Object.entries(report.summary)) {
    lines.push(view, ...formatRow(row), "");
  }
  for (const [view, rows] of Object.entries(report.perRun)) {
    lines.push(`${view} (${rows.length} row${rows.length === 1 ? "" : "s"})`);
    if (rows.length === 0) lines.push("  (none)");
    for (const row of rows) lines.push(...formatRow(row).map((l) => `  ${l}`));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function formatRow(row: Record<string, unknown>): string[] {
  return Object.entries(row).map(
    ([key, value]) => `  ${key}: ${value === null || value === undefined ? "—" : String(value)}`,
  );
}

export async function usageCommand(api: WindkeelApi, io: RemoteIo, options: { period?: string | undefined; json?: boolean }): Promise<number> {
  const report = await api.usage(options.period);
  io.out(options.json ? JSON.stringify(report, null, 2) : formatUsage(report));
  return 0;
}

const usd = (value: number): string => `$${value.toFixed(4)}`;

export function formatUsage(report: UsageReport): string {
  const lines = [
    `Usage for ${report.period.label}${report.plan ? ` (plan: ${report.plan})` : ""}`,
    `  AI, Windkeel's key       ${usd(report.raw.windkeelModelUsd)}`,
    `  AI, your own key      ${usd(report.raw.customerModelUsd)}   (shown, never billed)`,
    `  Compute (sandboxes)   ${usd(report.raw.sandboxUsd)}`,
    `  Verification          ${usd(report.verification.totalUsd)}   (${report.verification.runs} run${report.verification.runs === 1 ? "" : "s"}; included above)`,
    report.unpriced.calls > 0
      ? `  Unpriced calls        ${report.unpriced.calls}   (not billed; ~${usd(report.unpriced.estimatedWindkeelUsd + report.unpriced.estimatedCustomerUsd)} counted toward the budget)`
      : null,
    `Billable                ${usd(report.billable.totalUsd)}   (AI ${usd(report.billable.aiUsd)} + compute fee ${usd(report.billable.computeFeeUsd)} + verification fee ${usd(report.billable.verificationFeeUsd)})`,
    report.budget.monthlyLimitUsd === null
      ? "Budget                  none (unlimited)"
      : `Budget                  ${usd(report.budget.spentUsd)} of ${usd(report.budget.monthlyLimitUsd)}${report.budget.exhausted ? "  — spent: new runs are refused" : ""}`,
    report.billingStatus && report.billingStatus !== "active" ? `Billing status          ${report.billingStatus}` : null,
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

export async function reapCommand(
  api: WindkeelApi,
  io: RemoteIo,
  options: { dryRun?: boolean; json?: boolean },
): Promise<number> {
  if (options.dryRun) {
    const page = await api.reapable();
    if (options.json) {
      io.out(JSON.stringify(page.items, null, 2));
      return 0;
    }
    if (page.items.length === 0) {
      io.out("nothing to reap");
      return 0;
    }
    io.out(`${page.items.length} sandbox(es) would be destroyed:`);
    for (const c of page.items) {
      io.out(`  ${c.providerHandle}  (${c.sandboxProvider}/${c.role})  run ${c.engineeringRunId}  because ${c.because}`);
    }
    return 0;
  }

  let result: ReapResult;
  try {
    result = await api.reap();
  } catch (err) {
    if (err instanceof ApiError && err.code === "sweep_in_progress") {
      io.out(`skipped: ${err.message}`);
      return 0;
    }
    throw err;
  }
  if (options.json) {
    io.out(JSON.stringify(result, null, 2));
    return 0;
  }
  io.out(formatReap(result));
  return result.outcomes.some((o) => o.kind === "failed") ? 1 : 0;
}

export function formatReap(result: ReapResult): string {
  const counts = new Map<string, number>();
  for (const o of result.outcomes) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  const summary = [...counts.entries()].map(([kind, n]) => `${kind} ${n}`).join(", ");
  const failures = result.outcomes.filter(
    (o): o is Extract<ReapResult["outcomes"][number], { kind: "failed" }> => o.kind === "failed",
  );
  return [
    `considered ${result.considered}${summary ? `: ${summary}` : ""}`,
    ...failures.map((f) => `  failed ${f.workspaceId}: ${f.error} (attempt ${f.attempts})`),
  ].join("\n");
}

export async function captureCommand(
  api: WindkeelApi,
  io: RemoteIo,
  runId: string,
  options: { out: string },
): Promise<number> {
  const out = resolve(options.out);
  let fresh = true;
  try {
    const view = await api.capture(runId);
    io.out(`captured ${view.files.filter((f) => f.written).length} file(s) from ${view.scratchDir} (${view.providerHandle})`);
    for (const f of view.files) {
      io.out(`  ${f.written ? "stored " : f.escaped ? "refused" : "skipped"} ${f.path}  (${f.bytes} bytes)`);
    }
    const oversized = view.files.filter((f) => !f.written && !f.escaped).length;
    if (oversized) {
      io.out(`  ${oversized} file(s) exceeded the ${view.maxBytes}-byte cap and were left in place rather than truncated`);
    }
    const escaped = view.files.filter((f) => f.escaped).length;
    if (escaped) {
      io.out(
        `  ${escaped} file(s) named a path outside the capture and were refused — the listing comes ` +
          "from inside the sandbox and is not trusted to stay in bounds",
      );
    }
  } catch (err) {
    if (!(err instanceof ApiError && err.code === "capture_unavailable")) throw err;
    printRefusal(io, err);
    fresh = false;
  }

  const listing = await api.captured(runId);
  const stored = listing.items;
  if (stored.length === 0) {
    if (!fresh) {
      io.err(
        listing.state === "pruned"
          ? `The capture stored earlier was removed by retention policy on ${listing.prunedAt} (kept 30 days).`
          : "No earlier capture is stored for this run either.",
      );
    }
    return fresh ? 0 : 1;
  }
  if (!fresh) io.err(`Downloading the capture stored earlier (${stored.length} file(s)) instead.`);

  const written: string[] = [];
  const refused: string[] = [];
  for (const path of stored) {
    if (!containedIn(out, path)) {
      refused.push(path);
      continue;
    }
    const { url } = await api.captureFileUrl(runId, path);
    const target = join(out, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await api.download(url));
    written.push(path);
  }
  io.out(`wrote ${written.length} file(s) into ${out}`);
  for (const path of refused) io.err(`  refused ${path}: it would land outside ${out}`);
  return fresh && refused.length === 0 ? 0 : 1;
}

function containedIn(root: string, rel: string): boolean {
  const target = resolve(root, rel);
  return target.startsWith(root + sep);
}
