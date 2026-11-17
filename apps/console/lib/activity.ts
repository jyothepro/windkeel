import { foldFeed, type Turn } from "./agent-steps.ts";
import type { RunState } from "./run-states.ts";
import type { RunEvent } from "./types.ts";

export interface CostFold {
  usd: number;
  unpriced: number;
  byKind: Record<string, number>;
}

export interface StageHeader {
  kind: "stage";
  key: string;
  to: RunState;
  from: RunState | null;
  at: string;
  reason: string | null;
  title: string;
  cost: CostFold | null;
}

export type ActivityTurn = Turn & { cost: CostFold | null };

export interface LeadingCost {
  kind: "cost";
  key: string;
  at: string;
  cost: CostFold;
}

export type ActivityItem = StageHeader | ActivityTurn | LeadingCost;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function withoutIds(text: string): { text: string; ids: string[] } {
  const ids = text.match(UUID) ?? [];
  if (ids.length === 0) return { text, ids };
  const cleaned = text
    .replace(UUID, "")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s+([,.;:)\]])/g, "$1")
    .replace(/([(\[])\s+/g, "$1")
    .replace(/(?:\s*[·:,-]\s*)+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text: cleaned, ids };
}

function addCost(into: { cost: CostFold | null }, event: RunEvent): void {
  const cost = (into.cost ??= { usd: 0, unpriced: 0, byKind: {} });
  const kind = event.costKind ?? "other";
  if (event.usd === null || event.usd === undefined) cost.unpriced += 1;
  else {
    cost.usd += event.usd;
    cost.byKind[kind] = (cost.byKind[kind] ?? 0) + event.usd;
  }
}

export function activityOf(events: readonly RunEvent[], live: boolean): ActivityItem[] {
  const out: ActivityItem[] = [];
  let stage: StageHeader | null = null;
  let turn: ActivityTurn | null = null;
  let leading: LeadingCost | null = null;

  for (const item of foldFeed(events, live)) {
    if (item.kind === "turn") {
      turn = { ...item, cost: null };
      out.push(turn);
      continue;
    }
    const e = item.event;
    if (e.kind === "transition" && e.to) {
      const reason = e.reason ? withoutIds(e.reason).text || null : null;
      stage = {
        kind: "stage",
        key: `transition:${e.cursor}`,
        to: e.to,
        from: e.from ?? null,
        at: e.at,
        reason,
        title: [e.from ? `${e.from} → ${e.to}` : e.to, e.reason].filter(Boolean).join(" · "),
        cost: null,
      };
      turn = null;
      out.push(stage);
    } else if (e.kind === "cost") {
      const into = turn ?? stage;
      if (into) addCost(into, e);
      else {
        if (!leading) {
          leading = { kind: "cost", key: `cost:${e.cursor}`, at: e.at, cost: { usd: 0, unpriced: 0, byKind: {} } };
          out.push(leading);
        }
        addCost(leading, e);
      }
    }
  }
  return out;
}

export function costText(cost: CostFold, usd: (n: number) => string): { short: string; detail: string } {
  const amount = usd(cost.usd);
  return {
    short: cost.unpriced ? `at least ${amount}` : amount,
    detail: [
      ...Object.entries(cost.byKind).map(([kind, n]) => `${kind} ${usd(n)}`),
      cost.unpriced ? `${cost.unpriced} unpriced ${cost.unpriced === 1 ? "call" : "calls"}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

export function splitEarlier(items: readonly ActivityItem[], keep = 2): { earlier: ActivityItem[]; recent: ActivityItem[] } {
  const headers = items.flatMap((item, i) => (item.kind === "stage" ? [i] : []));
  if (headers.length <= keep) return { earlier: [], recent: [...items] };
  const running = items.findIndex((item) => item.kind === "turn" && !item.ended);
  const cut = Math.min(headers[headers.length - keep]!, running === -1 ? Infinity : running);
  return { earlier: items.slice(0, cut), recent: items.slice(cut) };
}
