/**
 * Batch rails (#391, ADR-0036): the pure policy the dispatcher consults. No database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  batchFreeSlots,
  batchOutcome,
  batchRails,
  batchStopReason,
  childSpendCap,
  DEFAULT_BATCH_SPEND_CAP_USD,
  holdsBudget,
  isSettled,
  isSucceeded,
  occupiesSlot,
  positiveIntFromEnv,
  UncappedBatchError,
} from "../dist/batches/rails.js";
import { normaliseBatchInput } from "../dist/batches/batch-input.js";
import { summariseBatch } from "../dist/batches/store.js";
import { childDescription } from "../dist/batches/dispatch.js";
import { extractCriteria } from "../packages/verification/dist/stages/intent.js";

test("free slots are the smaller of the batch's room and the organization's, never negative", () => {
  assert.equal(batchFreeSlots({ maxConcurrency: 3, active: 1, orgMaxConcurrentRuns: 10, orgActive: 0 }), 2, "batch limit");
  assert.equal(batchFreeSlots({ maxConcurrency: 5, active: 0, orgMaxConcurrentRuns: 10, orgActive: 8 }), 2, "org limit");
  assert.equal(batchFreeSlots({ maxConcurrency: 2, active: 1, orgMaxConcurrentRuns: 3, orgActive: 2 }), 1, "both");
  assert.equal(batchFreeSlots({ maxConcurrency: 2, active: 4, orgMaxConcurrentRuns: 10, orgActive: 0 }), 0, "over the batch limit");
  assert.equal(batchFreeSlots({ maxConcurrency: 5, active: 0, orgMaxConcurrentRuns: 3, orgActive: 9 }), 0, "over the org limit");
});

test("the spend stop: at the cap stops, under it continues, a null cap never stops on spend", () => {
  const base = { settled: 0, failed: 0, ratio: null };
  assert.equal(batchStopReason({ ...base, spend: 10, cap: 10 }), "batch_spend_cap");
  assert.equal(batchStopReason({ ...base, spend: 11, cap: 10 }), "batch_spend_cap");
  assert.equal(batchStopReason({ ...base, spend: 9.99, cap: 10 }), null);
  assert.equal(batchStopReason({ ...base, spend: 1e6, cap: null }), null);
});

test("the failure-ratio breaker fires only after three settled children, at the threshold, and never on zero failures", () => {
  const base = { spend: 0, cap: null, ratio: 0.5 };
  assert.equal(batchStopReason({ ...base, settled: 2, failed: 2 }), null, "two settled is noise");
  assert.equal(batchStopReason({ ...base, settled: 3, failed: 2 }), "failure_ratio");
  assert.equal(batchStopReason({ ...base, settled: 4, failed: 2 }), "failure_ratio", "exactly at the threshold fires");
  assert.equal(batchStopReason({ ...base, settled: 4, failed: 1 }), null);
  assert.equal(batchStopReason({ spend: 0, cap: null, ratio: 1, settled: 5, failed: 0 }), null, "zero failures never fires");
  assert.equal(batchStopReason({ spend: 0, cap: null, ratio: null, settled: 5, failed: 5 }), null, "no ratio, no breaker");
});

test("a child's cap is the smaller of its own and what is left; nothing left means no dispatch", () => {
  assert.equal(childSpendCap(100, 25), 25);
  assert.equal(childSpendCap(7.5, 25), 7.5);
  assert.equal(childSpendCap(0, 25), null);
  assert.equal(childSpendCap(-3, 25), null);
  assert.equal(childSpendCap(null, 25), 25, "an uncapped batch still caps each child");
  assert.equal(childSpendCap(0.30000000000000004, 25), 0.3, "cents");
  assert.equal(childSpendCap(0.004, 25), null, "less than a cent is nothing");
});

test("a batch cap is required by default; null only when confirmed", () => {
  assert.deepEqual(batchRails(), { batch_spend_cap_usd: DEFAULT_BATCH_SPEND_CAP_USD });
  assert.deepEqual(batchRails({ spendCapUsd: 40 }), { batch_spend_cap_usd: 40 });
  assert.throws(() => batchRails({ spendCapUsd: null }), UncappedBatchError);
  assert.deepEqual(batchRails({ spendCapUsd: null, uncappedConfirmed: true }), { batch_spend_cap_usd: null });
});

test("slots, settled and succeeded: a verified PR waiting on a person holds no slot", () => {
  assert.equal(occupiesSlot("IMPLEMENTING"), true);
  assert.equal(occupiesSlot("CREATED"), true);
  assert.equal(occupiesSlot("WAITING_FOR_APPROVAL"), true);
  assert.equal(occupiesSlot("HUMAN_EDITING"), true);
  assert.equal(occupiesSlot("WAITING_FOR_HUMAN"), false);
  assert.equal(occupiesSlot("COMPLETED"), false);
  assert.equal(isSettled("WAITING_FOR_HUMAN"), true);
  assert.equal(isSettled("VERIFYING"), false);
  assert.equal(isSucceeded("WAITING_FOR_HUMAN", "pass"), true);
  assert.equal(isSucceeded("WAITING_FOR_HUMAN", "fail"), false);
  assert.equal(isSucceeded("MAX_REPAIR_ATTEMPTS_REACHED", "fail"), false);
  assert.equal(isSucceeded("COMPLETED", "pass"), true);
});

test("budget: every non-terminal child holds its reservation, a verified PR awaiting review included", () => {
  // *Make changes* takes a WAITING_FOR_HUMAN run back to work under the same cap (ADR-0029 §3).
  for (const s of ["CREATED", "IMPLEMENTING", "VERIFYING", "HUMAN_EDITING", "WAITING_FOR_APPROVAL", "WAITING_FOR_HUMAN"]) {
    assert.equal(holdsBudget(s), true, s);
  }
  for (const s of ["COMPLETED", "CANCELLED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED"]) assert.equal(holdsBudget(s), false, s);
});

test("outcome: all succeeded is COMPLETED, none is FAILED, otherwise PARTIAL", () => {
  assert.equal(batchOutcome({ items: 3, succeeded: 3 }), "COMPLETED");
  assert.equal(batchOutcome({ items: 3, succeeded: 2 }), "PARTIAL");
  assert.equal(batchOutcome({ items: 3, succeeded: 0 }), "FAILED");
});

test("environment numbers fall back on anything that is not a positive whole number", () => {
  assert.equal(positiveIntFromEnv(undefined, 10), 10);
  assert.equal(positiveIntFromEnv("", 10), 10);
  assert.equal(positiveIntFromEnv("4", 10), 4);
  assert.equal(positiveIntFromEnv("-1", 10), 10);
  assert.equal(positiveIntFromEnv("2.5", 10), 10);
});

test("input validation names the field", () => {
  const fanout = { kind: "fanout", title: "t", description: "d", repositoryId: "r", items: [{ title: "a", description: "b" }] };
  assert.equal(normaliseBatchInput(fanout).maxConcurrency, 3, "the issue's default");
  assert.equal(normaliseBatchInput(fanout).batchSpendCapUsd, DEFAULT_BATCH_SPEND_CAP_USD);
  const refused = (input, code) => assert.throws(() => normaliseBatchInput(input, 2), (e) => e.code === code, code);
  refused({ ...fanout, kind: "dag" }, "invalid_field");
  refused({ ...fanout, items: [] }, "no_items");
  refused({ ...fanout, items: [{ title: "a", description: "b" }, { title: "a", description: "b" }, { title: "a", description: "b" }] }, "too_many_items");
  refused({ ...fanout, maxConcurrency: 0 }, "invalid_concurrency");
  refused({ ...fanout, maxConcurrency: 51 }, "invalid_concurrency");
  refused({ ...fanout, batchSpendCapUsd: null }, "uncapped_batch");
  refused({ ...fanout, spendCapUsd: null }, "invalid_field");
  refused({ ...fanout, stopOnFailureRatio: 1.5 }, "invalid_field");
  refused({ kind: "multi_repo", title: "t", description: "d", repositories: ["a", "a"] }, "duplicate_repository");
  refused({ kind: "multi_repo", title: "t", description: "d", repositories: [] }, "no_items");
  assert.equal(normaliseBatchInput({ ...fanout, batchSpendCapUsd: null, uncappedConfirmed: true }).batchSpendCapUsd, null);
});

test("criteria become an Acceptance criteria checklist the extractor reads as explicit", () => {
  const description = childDescription(
    { description: "Bump the lockfile.", template: { riskLevel: "low", criteria: ["npm ci succeeds"] } },
    { spec: { criteria: ["npm test passes"] } },
  );
  const criteria = extractCriteria(description, { kind: "explicit", ref: "batch:x:0" });
  assert.deepEqual(criteria.map((c) => c.text), ["npm ci succeeds", "npm test passes"]);
  assert.equal(childDescription({ description: "plain", template: { criteria: [] } }, { spec: {} }), "plain");
});

test("the roll-up sums every child run, counts newest runs, and reserves what in-flight children may still spend", () => {
  const at = (s) => new Date(Date.UTC(2026, 9, 21, 0, 0, s));
  const items = [
    { id: "i0", ordinal: 0, taskId: "t0", state: "dispatched" },
    { id: "i1", ordinal: 1, taskId: "t1", state: "dispatched" },
    { id: "i2", ordinal: 2, taskId: "t2", state: "dispatched" },
    { id: "i3", ordinal: 3, taskId: null, state: "pending" },
    { id: "i4", ordinal: 4, taskId: null, state: "skipped" },
  ];
  const runs = [
    { id: "r0", taskId: "t0", status: "WAITING_FOR_HUMAN", finalVerdict: "pass", cost: 2, spendCapUsd: 25, createdAt: at(0) },
    // t1's first run failed and a rerun is in flight: the newest counts, both cost.
    { id: "r1", taskId: "t1", status: "FAILED", finalVerdict: "fail", cost: 3, spendCapUsd: 25, createdAt: at(1) },
    { id: "r1b", taskId: "t1", status: "IMPLEMENTING", finalVerdict: null, cost: 1, spendCapUsd: 5, createdAt: at(5) },
    { id: "r2", taskId: "t2", status: "MAX_REPAIR_ATTEMPTS_REACHED", finalVerdict: "fail", cost: 4, spendCapUsd: 25, createdAt: at(2) },
  ];
  const p = summariseBatch({ batchSpendCapUsd: 20 }, items, runs);
  assert.equal(p.items, 5);
  assert.equal(p.pending, 1);
  assert.equal(p.dispatched, 3);
  assert.equal(p.skipped, 1);
  assert.equal(p.totalCostUsd, 10);
  assert.equal(p.active, 1);
  // r1b's 4 left plus r0's 23: a child awaiting review keeps its unspent cap reserved.
  assert.equal(p.reservedUsd, 27);
  assert.equal(p.remainingBudgetUsd, 0);
  assert.equal(p.settled, 2);
  assert.equal(p.succeeded, 1);
  assert.equal(p.failed, 1);
  assert.deepEqual(p.byStatus, { WAITING_FOR_HUMAN: 1, IMPLEMENTING: 1, MAX_REPAIR_ATTEMPTS_REACHED: 1 });
  assert.deepEqual(p.verdicts, { pass: 1, warn: 0, fail: 1, none: 1 });
  assert.equal(summariseBatch({ batchSpendCapUsd: null }, items, runs).remainingBudgetUsd, null);
});
