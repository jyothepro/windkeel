

import type { Pool, PoolClient } from "pg";
import { csvField } from "../factory/audit-log.js";
import { debitedCompute, rowToCostLine, type CostLineRow, type CreditRole } from "./credit-ledger.js";
import { microToCredits, priceCostLine, priceCostLines } from "../factory/config/credits.js";
import type { BillingPeriod } from "./usage.js";
import { selectOrganizationCostLinesWithDebits, selectRepositoryNames, selectRunCostLinesWithDebits } from "./stores/credit-ledger-store.js";

type Queryable = Pool | PoolClient;

interface PricedCostLine extends CostLineRow {
  kindPriced: "compute" | "ai";
  amountMicro: number;
  sandboxSeconds: number | null;
  unpriced: boolean;

  debited: boolean;
}

async function pricedLines(db: Queryable, rows: Array<Record<string, unknown>>): Promise<PricedCostLine[]> {
  const lines = rows.map((r) => ({ line: rowToCostLine(r), debited: r["debit_micro"] !== null && r["debit_micro"] !== undefined, row: r }));
  const pending = lines.filter((l) => !l.debited).map((l) => l.line);
  const pendingPriced = priceCostLines(pending, await debitedCompute(db, pending));
  let next = 0;
  return lines.map(({ line, debited, row }) => {
    const priced = debited ? priceCostLine(line) : pendingPriced[next++]!;
    return {
      ...line,
      kindPriced: priced.kind,
      amountMicro: debited ? Number(row["debit_micro"]) : priced.amountMicro,
      sandboxSeconds: debited && row["debit_seconds"] !== null ? Number(row["debit_seconds"]) : priced.sandboxSeconds,
      unpriced: priced.unpriced,
      debited,
    };
  });
}

const round6 = (n: number): number => Number(n.toFixed(6));

export interface RunReceipt {
  runId: string;
  unit: "credit";

  creditUsd: number;
  compute: Array<{ role: CreditRole; sandboxSeconds: number; sandboxMinutes: number; creditsPerMinute: number; credits: number }>;
  ai: Array<{
    role: CreditRole;
    model: string | null;

    keySource: string;
    tokensIn: number;
    tokensOut: number;
    calls: number;

    unpricedCalls: number;
    credits: number;
  }>;
  totals: { computeCredits: number; aiCredits: number; credits: number; totalMicro: number; debitedMicro: number };

  settled: boolean;
}

export async function runReceipt(db: Queryable, runId: string): Promise<RunReceipt> {
  const lines = await pricedLines(db, (await selectRunCostLinesWithDebits(db, runId)).rows);
  const compute = new Map<CreditRole, { seconds: number; micro: number }>();
  const ai = new Map<string, RunReceipt["ai"][number] & { micro: number }>();
  let computeMicro = 0;
  let aiMicro = 0;
  let debitedMicro = 0;
  for (const line of lines) {
    if (line.debited) debitedMicro += line.amountMicro;
    if (line.kindPriced === "compute") {
      const entry = compute.get(line.role) ?? { seconds: 0, micro: 0 };
      entry.seconds += line.sandboxSeconds ?? 0;
      entry.micro += line.amountMicro;
      compute.set(line.role, entry);
      computeMicro += line.amountMicro;
      continue;
    }
    const keySource = line.keySource ?? "orqon";
    const key = `${line.role}\u0000${line.model ?? ""}\u0000${keySource}`;
    const entry = ai.get(key) ?? {
      role: line.role,
      model: line.model,
      keySource,
      tokensIn: 0,
      tokensOut: 0,
      calls: 0,
      unpricedCalls: 0,
      credits: 0,
      micro: 0,
    };
    entry.tokensIn += line.tokensIn ?? 0;
    entry.tokensOut += line.tokensOut ?? 0;
    entry.calls += 1;
    if (line.unpriced) entry.unpricedCalls += 1;
    entry.micro += line.amountMicro;
    ai.set(key, entry);
    aiMicro += line.amountMicro;
  }
  const roleOrder: Record<CreditRole, number> = { maker: 0, verifier: 1, criteria: 2 };
  return {
    runId,
    unit: "credit",
    creditUsd: 0.01,
    compute: [...compute.entries()]
      .sort(([a], [b]) => roleOrder[a] - roleOrder[b])
      .map(([role, e]) => ({
        role,
        sandboxSeconds: e.seconds,
        sandboxMinutes: round6(e.seconds / 60),
        creditsPerMinute: 2,
        credits: microToCredits(e.micro),
      })),
    ai: [...ai.values()]
      .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || String(a.model).localeCompare(String(b.model)))
      .map(({ micro, ...e }) => ({ ...e, credits: microToCredits(micro) })),
    totals: {
      computeCredits: microToCredits(computeMicro),
      aiCredits: microToCredits(aiMicro),
      credits: microToCredits(computeMicro + aiMicro),
      totalMicro: computeMicro + aiMicro,
      debitedMicro,
    },
    settled: lines.length > 0 && lines.every((l) => l.debited),
  };
}

export interface StatementRow {
  runId: string;
  repositoryId: string;
  repository: string | null;
  role: CreditRole;
  kind: "compute" | "ai";
  model: string | null;
  sandboxSeconds: number;
  tokensIn: number;
  tokensOut: number;
  credits: number;
  micro: number;
}

export interface Statement {
  organizationId: string;
  period: { start: string; end: string; label: string };
  rows: StatementRow[];
  byRun: Array<{ runId: string; repository: string | null; credits: number }>;
  byRepository: Array<{ repositoryId: string; repository: string | null; credits: number }>;
  byRole: Array<{ role: CreditRole; credits: number }>;
  totals: { credits: number; totalMicro: number };
}

export async function organizationStatement(
  db: Queryable,
  organizationId: string,
  period: BillingPeriod,
  label: string,
): Promise<Statement> {
  const lines = await pricedLines(db, (await selectOrganizationCostLinesWithDebits(db, organizationId, period.start, period.end)).rows);
  const repoIds = [...new Set(lines.map((l) => l.repositoryId))];
  const names = new Map<string, string>();
  if (repoIds.length) {
    const { rows } = await selectRepositoryNames(db, repoIds);
    for (const r of rows) names.set(r["id"] as string, `${r["owner"]}/${r["name"]}`);
  }
  const grouped = new Map<string, StatementRow>();
  for (const line of lines) {
    const key = [line.engineeringRunId, line.role, line.kindPriced, line.model ?? ""].join("\u0000");
    const row = grouped.get(key) ?? {
      runId: line.engineeringRunId,
      repositoryId: line.repositoryId,
      repository: names.get(line.repositoryId) ?? null,
      role: line.role,
      kind: line.kindPriced,
      model: line.kindPriced === "ai" ? line.model : null,
      sandboxSeconds: 0,
      tokensIn: 0,
      tokensOut: 0,
      credits: 0,
      micro: 0,
    };
    row.sandboxSeconds += line.sandboxSeconds ?? 0;
    row.tokensIn += line.tokensIn ?? 0;
    row.tokensOut += line.tokensOut ?? 0;
    row.micro += line.amountMicro;
    row.credits = microToCredits(row.micro);
    grouped.set(key, row);
  }
  const rows = [...grouped.values()];
  const sum = <K extends string>(keyOf: (r: StatementRow) => K) => {
    const out = new Map<K, number>();
    for (const r of rows) out.set(keyOf(r), (out.get(keyOf(r)) ?? 0) + r.micro);
    return out;
  };
  const total = rows.reduce((s, r) => s + r.micro, 0);
  return {
    organizationId,
    period: { start: period.start.toISOString(), end: period.end.toISOString(), label },
    rows,
    byRun: [...sum((r) => r.runId).entries()].map(([runId, micro]) => ({
      runId,
      repository: rows.find((r) => r.runId === runId)?.repository ?? null,
      credits: microToCredits(micro),
    })),
    byRepository: [...sum((r) => r.repositoryId).entries()].map(([repositoryId, micro]) => ({
      repositoryId,
      repository: names.get(repositoryId) ?? null,
      credits: microToCredits(micro),
    })),
    byRole: [...sum((r) => r.role).entries()].map(([role, micro]) => ({ role, credits: microToCredits(micro) })),
    totals: { credits: microToCredits(total), totalMicro: total },
  };
}

const STATEMENT_CSV_COLUMNS = [
  "period",
  "run_id",
  "repository",
  "role",
  "kind",
  "model",
  "sandbox_seconds",
  "tokens_in",
  "tokens_out",
  "credits",
] as const;

export function statementCsv(statement: Statement): string {
  const lines = [STATEMENT_CSV_COLUMNS.join(",")];
  for (const r of statement.rows) {
    lines.push(
      [
        statement.period.label,
        r.runId,
        r.repository ?? r.repositoryId,
        r.role,
        r.kind,
        r.model,
        r.sandboxSeconds,
        r.tokensIn,
        r.tokensOut,
        (r.micro / 1_000_000).toFixed(6),
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
