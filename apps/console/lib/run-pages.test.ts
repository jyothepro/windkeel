import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPages, mergeRuns } from "./run-pages.ts";
import type { Page, RunSummary } from "./types.ts";

const pages: Array<Page<number>> = [
  { items: [1, 2], endCursor: "a", hasNextPage: true },
  { items: [3, 4], endCursor: "b", hasNextPage: true },
  { items: [5], endCursor: null, hasNextPage: false },
];
const fetcher = (seen: Array<string | undefined>) => async (cursor: string | undefined) => {
  seen.push(cursor);
  return pages[cursor === undefined ? 0 : cursor === "a" ? 1 : 2]!;
};

test("collectPages follows the cursor to the end", async () => {
  const seen: Array<string | undefined> = [];
  assert.deepEqual(await collectPages(fetcher(seen), 10), { items: [1, 2, 3, 4, 5], truncated: false });
  assert.deepEqual(seen, [undefined, "a", "b"]);
});

test("collectPages stops at the bound and says so", async () => {
  const seen: Array<string | undefined> = [];
  assert.deepEqual(await collectPages(fetcher(seen), 2), { items: [1, 2, 3, 4], truncated: true });
  assert.deepEqual(seen, [undefined, "a"]);
});

test("collectPages reads one page when there is only one", async () => {
  const one = async () => ({ items: [9], endCursor: null, hasNextPage: false });
  assert.deepEqual(await collectPages(one, 1), { items: [9], truncated: false });
});

test("mergeRuns: a failed run past the newest page still reaches the inbox, once, newest first", () => {
  const run = (id: string, createdAt: string, status = "FAILED") => ({ id, createdAt, status }) as unknown as RunSummary;
  const newest = [run("n1", "2026-10-03T00:00:00Z", "IMPLEMENTING"), run("f1", "2026-10-02T00:00:00Z")];
  const failed = [run("f1", "2026-10-02T00:00:00Z"), run("f0", "2026-09-01T00:00:00Z", "MAX_REPAIR_ATTEMPTS_REACHED")];
  assert.deepEqual(
    mergeRuns([newest, failed]).map((r) => r.id),
    ["n1", "f1", "f0"],
  );
});
