import { test } from "node:test";
import assert from "node:assert/strict";
import { batchControls, itemState, progressSegments } from "./batches.ts";

const progress = {
  items: 6,
  pending: 1,
  dispatched: 4,
  skipped: 1,
  active: 1,
  settled: 3,
  succeeded: 2,
  failed: 1,
  byStatus: {},
  verdicts: { pass: 2, warn: 0, fail: 1, none: 1 },
  totalCostUsd: 3,
  reservedUsd: 1,
  remainingBudgetUsd: 6,
};

test("the progress bar shows verified, failed, running, waiting and skipped, in that order", () => {
  assert.deepEqual(
    progressSegments(progress).map((s) => [s.key, s.count]),
    [["succeeded", 2], ["failed", 1], ["active", 1], ["waiting", 1], ["skipped", 1]],
  );
});

test("controls need batches.manage, follow the status, and never include a merge", () => {
  assert.deepEqual(batchControls("RUNNING", ["runs.read"]), []);
  assert.deepEqual(batchControls("RUNNING", ["batches.manage"]), ["pause", "cancel"]);
  assert.deepEqual(batchControls("PAUSED", ["batches.manage"]), ["resume", "cancel"]);
  assert.deepEqual(batchControls("STOPPING", ["batches.manage"]), ["cancel"]);
  assert.deepEqual(batchControls("PARTIAL", ["batches.manage"]), []);
});

test("an item reads as its run's state once it has one", () => {
  const base = { id: "i", ordinal: 0, repositoryId: "r", repositoryFullName: "a/b", title: null, runId: null, runStatus: null, finalVerdict: null, costUsd: 0, pullRequestNumber: null, pullRequestUrl: null, skipReason: null };
  assert.equal(itemState({ ...base, state: "pending" }), "Waiting for a slot");
  assert.equal(itemState({ ...base, state: "skipped", skipReason: "repository_not_granted" }), "Skipped: repository no longer granted");
  assert.notEqual(itemState({ ...base, state: "dispatched", runStatus: "VERIFYING" }), "VERIFYING", "in words, not the state's name");
  assert.equal(itemState({ ...base, state: "dispatched", runStatus: null }), "Started");
});
