import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RUN_STATES,
  TERMINAL_STATES,
  dotForRun,
  dotForStage,
  guidanceClosedReason,
  railFor,
} from "./run-states.ts";

const factorySource = readFileSync(new URL("../../../src/factory/run-state-machine.ts", import.meta.url), "utf8");

test("the console's states are exactly the factory's", () => {
  const union = factorySource.match(/export type RunState =([\s\S]*?);/);
  assert.ok(union, "RunState union not found in run-state-machine.ts");
  const factoryStates = [...(union[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...RUN_STATES].sort(), factoryStates.sort());
});

test("the console's terminal states are exactly the factory's", () => {
  const set = factorySource.match(/export const TERMINAL_STATES[\s\S]*?new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(set, "TERMINAL_STATES not found in run-state-machine.ts");
  const factoryTerminal = [...(set[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...TERMINAL_STATES].sort(), factoryTerminal.sort());
});

test("a finished run with no verdict is drawn skipped, never fail", () => {
  assert.equal(dotForRun("CANCELLED", null), "skipped");
  assert.equal(dotForRun("COMPLETED", "warn"), "warn");
  assert.equal(dotForRun("FAILED", "fail"), "fail");
  assert.equal(dotForRun("VERIFYING", null), "running");
  assert.equal(dotForRun("CREATED", null), "queued", "a queued run is not the agent's");
  assert.equal(dotForRun("WAITING_FOR_APPROVAL", null), "waiting", "waiting on a person is not a verdict");
});

test("findings that do not block draw as warn, not pass", () => {
  assert.equal(dotForStage("completed_with_findings"), "warn");
  assert.equal(dotForStage("skipped"), "skipped");
  assert.equal(dotForStage(null), "running");
});

test("guidance is open only where a session listens", () => {
  for (const state of RUN_STATES) {
    assert.equal(guidanceClosedReason(state) === null, ["IMPLEMENTING", "REPAIRING", "VERIFYING"].includes(state), state);
  }
});

test("a run that skipped approval shows it as not taken, not pending", () => {
  const rail = railFor("IMPLEMENTING", ["CREATED", "CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING"]);
  const status = Object.fromEntries(rail.map((r) => [r.step, r.status]));
  assert.equal(status["Approval"], "not_taken");
  assert.equal(status["Implement"], "current");
  assert.equal(status["Verify"], "upcoming");
});

test("a finished run leaves nothing upcoming", () => {
  const rail = railFor("FAILED", ["CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "VERIFYING"]);
  assert.ok(rail.every((r) => r.status !== "upcoming" && r.status !== "current"));
});
