import type { CreditBalanceReport, CreditStatement, WindkeelApi, RunReceipt } from "../client/api.js";
import type { RemoteIo } from "./remote.js";

export const credits = (value: number): string =>
  value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const day = (iso: string): string => iso.slice(0, 10);

const ALERT_TEXT: Record<string, string> = {
  plan_50: "50% of plan credits used",
  plan_80: "80% of plan credits used",
  plan_100: "plan credits used up",
  overage_cap: "overage cap reached",
};

export function formatBalance(b: CreditBalanceReport): string {
  if (!b.onCredits) return "This organization is not on a credit plan (billed by usage; see `windkeel usage`).";
  const lines: string[] = [];
  const plan = b.plan ? b.plan[0]!.toUpperCase() + b.plan.slice(1) : "no plan";
  lines.push(`Plan              ${plan}${b.pendingPlan ? `  (changes to ${b.pendingPlan} at period end)` : ""}`);
  if (b.period) lines.push(`Period            ${day(b.period.start)} → ${day(b.period.end)}  (resets in ${b.period.daysToReset} day${b.period.daysToReset === 1 ? "" : "s"})`);
  if (b.planCredits) lines.push(`Plan credits      ${credits(b.planCredits.left)} left of ${credits(b.planCredits.included)}  (${credits(b.planCredits.used)} used)`);
  for (const t of b.topups ?? []) {
    lines.push(`${t.source === "trial" ? "Trial" : "Top-up"}${" ".repeat(t.source === "trial" ? 13 : 12)}${credits(t.left)} left of ${credits(t.credits)}  (expires ${day(t.expiresAt)})`);
  }
  if (b.overage) {
    lines.push(
      b.overage.enabled
        ? `Overage           on, ${credits(b.overage.billedCredits)} of ${credits(b.overage.capCredits ?? 0)} cap this period`
        : `Overage           off (out of credits stops new runs)`,
    );
    if (b.overage.unbilledCredits > 0) lines.push(`                  ${credits(b.overage.unbilledCredits)} past the last credit, not billed (steps already under way)`);
  }
  lines.push(`Available         ${credits(b.availableCredits ?? 0)} credits${b.admits === false ? "  — new runs are refused" : ""}`);
  for (const a of b.alerts ?? []) lines.push(`Alert             ${ALERT_TEXT[a.kind] ?? a.kind}  (${day(a.raisedAt)})`);
  return lines.join("\n");
}

export function formatStatement(s: CreditStatement): string {
  const lines = [`Statement for ${s.period.label}: ${credits(s.totals.credits)} credits`];
  if (s.rows.length === 0) return `${lines[0]}\n  (no usage)`;
  lines.push("By role");
  for (const r of s.byRole) lines.push(`  ${r.role.padEnd(10)} ${credits(r.credits).padStart(12)}`);
  lines.push("By repository");
  for (const r of s.byRepository) lines.push(`  ${(r.repository ?? r.repositoryId).padEnd(30)} ${credits(r.credits).padStart(12)}`);
  lines.push("By run");
  for (const r of s.byRun) lines.push(`  ${r.runId}  ${(r.repository ?? "").padEnd(24)} ${credits(r.credits).padStart(12)}`);
  return lines.join("\n");
}

export function formatReceipt(r: RunReceipt): string {
  const lines = ["Receipt (credits; 1 credit = $0.01)"];
  for (const c of r.compute) {
    lines.push(`  compute  ${c.role.padEnd(9)} ${c.sandboxMinutes.toFixed(2)} min × ${c.creditsPerMinute}`.padEnd(52) + credits(c.credits).padStart(12));
  }
  for (const a of r.ai) {
    const note = a.keySource === "customer" ? "  your key" : a.unpricedCalls > 0 ? `  ${a.unpricedCalls} unpriced` : "";
    lines.push(
      `  ai       ${a.role.padEnd(9)} ${a.model ?? "(model not recorded)"} ${a.tokensIn}/${a.tokensOut} tok${note}`.padEnd(52) + credits(a.credits).padStart(12),
    );
  }
  lines.push(`  total`.padEnd(52) + credits(r.totals.credits).padStart(12));
  return lines.join("\n");
}

export async function billingCommand(
  api: WindkeelApi,
  io: RemoteIo,
  options: { subcommand?: string | undefined; period?: string | undefined; csv?: boolean; json?: boolean },
): Promise<number> {
  if (options.subcommand === "statement") {
    if (options.csv) {
      io.out((await api.billingStatementCsv(options.period)).trimEnd());
      return 0;
    }
    const statement = await api.billingStatement(options.period);
    io.out(options.json ? JSON.stringify(statement, null, 2) : formatStatement(statement));
    return 0;
  }
  if (options.subcommand !== undefined && options.subcommand !== "balance") {
    io.err(`windkeel billing: unknown subcommand ${options.subcommand} (balance, statement)`);
    return 2;
  }
  const balance = await api.billingBalance();
  io.out(options.json ? JSON.stringify(balance, null, 2) : formatBalance(balance));
  return 0;
}
