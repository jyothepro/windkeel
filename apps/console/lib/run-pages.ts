import type { Page, RunSummary } from "./types.ts";

export async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  maxPages: number,
): Promise<{ items: T[]; truncated: boolean }> {
  let page = await fetchPage(undefined);
  const items = [...page.items];
  for (let n = 1; page.hasNextPage && page.endCursor; n++) {
    if (n >= maxPages) return { items, truncated: true };
    page = await fetchPage(page.endCursor);
    items.push(...page.items);
  }
  return { items, truncated: false };
}

export function mergeRuns(lists: ReadonlyArray<readonly RunSummary[]>): RunSummary[] {
  const byId = new Map<string, RunSummary>();
  for (const list of lists) for (const run of list) byId.set(run.id, run);
  return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
