import { test } from "node:test";
import assert from "node:assert/strict";
import { criteriaCheck, newestVerification } from "./criteria-check.ts";
import type { Criterion, ReportedVerification, StageResult } from "./types.ts";

const CRITERIA: Criterion[] = [
  { id: "c1", text: "A late merge completes the run." },
  { id: "c2", text: "The evidence is kept." },
];

const intent = (status: StageResult["status"], items: StageResult["items"] = [{ id: "mapping", stage: "intent", type: "criteria_mapping", status, summary: "1 of 2 criteria met, 1 not met" }]): StageResult => ({
  stage: "intent",
  status,
  items,
});

const verification = (cycle: number, over: Partial<ReportedVerification> = {}): ReportedVerification => ({
  id: `v${cycle}`,
  cycle,
  candidateSha: "abc",
  verdict: "pass",
  startedAt: null,
  completedAt: "2026-10-17T00:00:00Z",
  evidence: { state: "stored", ref: null, manifestDigest: null },
  verdictOfRecord: false,
  superseded: false,
  stages: [intent("passed", [{ id: "mapping", stage: "intent", type: "criteria_mapping", status: "passed", summary: "2 of 2 criteria met" }])],
  ...over,
});

test("before verification, nothing is ticked and the tab says when it will be", () => {
  const check = criteriaCheck(CRITERIA, [], "WAITING_FOR_APPROVAL");
  assert.equal(check.headline, "Not checked yet");
  assert.ok(check.items.every((i) => i.mark === "not_checked"));
  assert.match(check.detail!, /approve/);
});

test("ticks come from the newest verification, not the first", () => {
  const older = verification(1, { stages: [intent("failed")], verdict: "fail" });
  const newer = verification(2);
  assert.equal(newestVerification([newer, older])?.id, "v2");
  const check = criteriaCheck(CRITERIA, [older, newer], "WAITING_FOR_HUMAN");
  assert.equal(check.verificationId, "v2");
  assert.ok(check.items.every((i) => i.mark === "met"));
  assert.equal(check.headline, "2 of 2 criteria met");
});

test("a count that isn't every criterion ticks none of them rather than guessing which", () => {
  const check = criteriaCheck(CRITERIA, [verification(1, { stages: [intent("failed")], verdict: "fail" })], "REPAIRING");
  assert.ok(check.items.every((i) => i.mark === "not_itemised"));
  assert.equal(check.headline, "1 of 2 criteria met, 1 not met");
  assert.equal(check.dot, "fail");
});

test("one item per criterion ticks each from its own", () => {
  const items: StageResult["items"] = [
    { id: "c1", stage: "intent", type: "criterion", status: "passed", summary: null },
    { id: "c2", stage: "intent", type: "criterion", status: "warning", summary: null },
  ];
  const check = criteriaCheck(CRITERIA, [verification(1, { stages: [intent("warning", items)] })], "WAITING_FOR_HUMAN");
  assert.deepEqual(
    check.items.map((i) => i.mark),
    ["met", "unsettled"],
  );
  assert.equal(check.headline, "1 of 2 criteria met");
});

test("a verification still running, or sealed without stage results, is never drawn as met", () => {
  const running = criteriaCheck(CRITERIA, [verification(1, { stages: null, verdict: null, completedAt: null })], "VERIFYING");
  assert.equal(running.headline, "Being checked now");
  const old = criteriaCheck(CRITERIA, [verification(1, { stages: null })], "COMPLETED");
  assert.equal(old.headline, "Not reported");
  for (const check of [running, old]) assert.ok(check.items.every((i) => i.mark === "not_checked"));
});

test("a skipped criteria stage says why, and ticks nothing", () => {
  const skipped = intent("skipped", [{ id: "mapping", stage: "intent", type: "criteria_mapping", status: "skipped", summary: "No criteria to map" }]);
  const check = criteriaCheck(CRITERIA, [verification(1, { stages: [skipped] })], "COMPLETED");
  assert.equal(check.detail, "No criteria to map");
  assert.ok(check.items.every((i) => i.mark === "not_checked"));
});
