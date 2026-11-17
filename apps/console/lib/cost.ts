import type { CostBreakdown, KeySource } from "./types.ts";

export interface SourceCost {
  keySource: KeySource | null;
  label: string;
  usd: number;
  events: number;
  unpricedEvents: number;
}

export function keySourceLabel(source: KeySource | null | undefined): string {
  return source === "orqon" ? "Windkeel's key" : source === "customer" ? "Your organization's key" : "Not recorded";
}

const ORDER = (source: KeySource | null): number => (source === "orqon" ? 0 : source === "customer" ? 1 : 2);

export function costBySource(cost: CostBreakdown): SourceCost[] {
  const rows =
    cost.bySource ??
    cost.byStage
      .filter((row) => row.kind === "model")
      .map((row) => ({ keySource: row.keySource ?? null, usd: row.usd, events: row.events, unpricedEvents: row.unpricedEvents ?? 0 }));
  const merged = new Map<KeySource | null, SourceCost>();
  for (const row of rows) {
    const key = row.keySource ?? null;
    const into = merged.get(key) ?? { keySource: key, label: keySourceLabel(key), usd: 0, events: 0, unpricedEvents: 0 };
    into.usd += row.usd;
    into.events += row.events;
    into.unpricedEvents += row.unpricedEvents ?? 0;
    merged.set(key, into);
  }
  return [...merged.values()].sort((a, b) => ORDER(a.keySource) - ORDER(b.keySource));
}

export function showsSourceSplit(sources: SourceCost[]): boolean {
  return sources.length > 1 || sources.some((source) => source.keySource === "customer");
}

export function costLabel(usdText: string, unpricedEvents: number | undefined): string {
  return unpricedEvents ? `at least ${usdText}` : usdText;
}
