import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IllegalTransitionError,
  TERMINAL_STATES,
  initialRunState,
  isLegalTransition,
  transition,
} from "../dist/factory/run-state-machine.js";

const ALL_STATES = [
  "CREATED",
  "CLASSIFYING",
  "PLANNING",
  "WAITING_FOR_APPROVAL",
  "PROVISIONING",
  "IMPLEMENTING",
  "VERIFYING",
  "REPAIRING",
  "PR_CREATING",
  "PR_READY",
  "WAITING_FOR_HUMAN",
  "HUMAN_EDITING",
  "COMPLETED",
  "CANCELLED",
  "BLOCKED",
  "FAILED",
  "MAX_REPAIR_ATTEMPTS_REACHED",
];

test("the happy path is legal end to end", () => {
  let run = initialRunState();
  const path = [
    "CLASSIFYING",
    "PLANNING",
    "PROVISIONING",
    "IMPLEMENTING",
    "VERIFYING",
    "PR_CREATING",
    "PR_READY",
    "WAITING_FOR_HUMAN",
    "COMPLETED",
  ];
  for (const to of path) {
    const { next } = transition(run, to);
    run = next;
  }
  assert.equal(run.state, "COMPLETED");
});

test("the approval-gate branch is legal", () => {
  let run = { state: "PLANNING", blockedFrom: null };
  run = transition(run, "WAITING_FOR_APPROVAL").next;
  run = transition(run, "PROVISIONING").next;
  assert.equal(run.state, "PROVISIONING");
});

test("VERIFYING <-> REPAIRING is a cycle, and it is legal", () => {
  let run = { state: "VERIFYING", blockedFrom: null };
  run = transition(run, "REPAIRING").next;
  run = transition(run, "VERIFYING").next;
  run = transition(run, "REPAIRING").next;
  run = transition(run, "VERIFYING").next;
  assert.equal(run.state, "VERIFYING");
});

test("VERIFYING -> MAX_REPAIR_ATTEMPTS_REACHED covers both cap-reached and stuck-detection (ADR-0011)", () => {
  const run = { state: "VERIFYING", blockedFrom: null };
  const { next } = transition(run, "MAX_REPAIR_ATTEMPTS_REACHED", "repair_cap");
  assert.equal(next.state, "MAX_REPAIR_ATTEMPTS_REACHED");
  const stuck = transition(run, "MAX_REPAIR_ATTEMPTS_REACHED", "stuck");
  assert.equal(stuck.next.state, "MAX_REPAIR_ATTEMPTS_REACHED");
});

test("WAITING_FOR_HUMAN resolves to COMPLETED or CANCELLED", () => {
  assert.equal(isLegalTransition("WAITING_FOR_HUMAN", "COMPLETED"), true);
  assert.equal(isLegalTransition("WAITING_FOR_HUMAN", "CANCELLED"), true);
});

test("every non-terminal state except BLOCKED can be BLOCKED or CANCELLED", () => {
  for (const state of ALL_STATES) {
    if (TERMINAL_STATES.has(state) || state === "BLOCKED") continue;
    assert.equal(isLegalTransition(state, "BLOCKED"), true, `${state} -> BLOCKED`);
    assert.equal(isLegalTransition(state, "CANCELLED"), true, `${state} -> CANCELLED`);
  }
});

test("BLOCKED returns only to the state it left, or to CANCELLED", () => {
  let run = { state: "IMPLEMENTING", blockedFrom: null };
  run = transition(run, "BLOCKED", "external dependency").next;
  assert.deepEqual(run, { state: "BLOCKED", blockedFrom: "IMPLEMENTING" });

  assert.equal(isLegalTransition("BLOCKED", "IMPLEMENTING", run.blockedFrom), true);
  assert.equal(isLegalTransition("BLOCKED", "CANCELLED", run.blockedFrom), true);
  assert.equal(isLegalTransition("BLOCKED", "VERIFYING", run.blockedFrom), false);

  const resumed = transition(run, "IMPLEMENTING").next;
  assert.deepEqual(resumed, { state: "IMPLEMENTING", blockedFrom: null });
});

test("a different run's BLOCKED does not resume to another run's left-from state", () => {
  const blockedFromPlanning = transition({ state: "PLANNING", blockedFrom: null }, "BLOCKED").next;
  assert.equal(isLegalTransition("BLOCKED", "IMPLEMENTING", blockedFromPlanning.blockedFrom), false);
  assert.equal(isLegalTransition("BLOCKED", "PLANNING", blockedFromPlanning.blockedFrom), true);
});

test("CLASSIFYING through PR_CREATING can fail; states outside that range cannot", () => {
  const canFail = [
    "CLASSIFYING",
    "PLANNING",
    "WAITING_FOR_APPROVAL",
    "PROVISIONING",
    "IMPLEMENTING",
    "VERIFYING",
    "REPAIRING",
    "PR_CREATING",
  ];
  for (const state of canFail) {
    assert.equal(isLegalTransition(state, "FAILED"), true, `${state} -> FAILED`);
  }
  for (const state of ["CREATED", "PR_READY", "WAITING_FOR_HUMAN", "HUMAN_EDITING", "BLOCKED"]) {
    assert.equal(isLegalTransition(state, "FAILED"), false, `${state} -> FAILED`);
  }
});

test("terminal states accept no outgoing transition", () => {
  for (const terminal of TERMINAL_STATES) {
    for (const to of ALL_STATES) {
      assert.equal(isLegalTransition(terminal, to), false, `${terminal} -> ${to}`);
    }
  }
});

test("a rejected transition throws IllegalTransitionError and leaves no record", () => {
  const run = { state: "CREATED", blockedFrom: null };
  assert.throws(() => transition(run, "COMPLETED"), IllegalTransitionError);
  assert.throws(() => transition(run, "VERIFYING"), /illegal transition: CREATED -> VERIFYING/);
});

test("transition() returns a record shaped for the ADR-0013 run_state_transition row", () => {
  const { record } = transition({ state: "PLANNING", blockedFrom: null }, "PROVISIONING", "plan ready");
  assert.deepEqual(record, { from: "PLANNING", to: "PROVISIONING", reason: "plan ready" });
});

test("recovery from a terminal state is a new run, not a transition", () => {
  for (const terminal of TERMINAL_STATES) {
    assert.equal(isLegalTransition(terminal, "CREATED"), false);
  }
});

// ADR-0029 §3: HUMAN_EDITING, exactly as its table says.

test("HUMAN_EDITING is non-terminal, entered by take over (at a boundary), Pair mode, or Make changes", () => {
  assert.equal(TERMINAL_STATES.has("HUMAN_EDITING"), false);
  assert.equal(isLegalTransition("IMPLEMENTING", "HUMAN_EDITING"), true);
  assert.equal(isLegalTransition("REPAIRING", "HUMAN_EDITING"), true);
  assert.equal(isLegalTransition("WAITING_FOR_HUMAN", "HUMAN_EDITING"), true);
});

test("HUMAN_EDITING leaves only to VERIFYING (submit), IMPLEMENTING (hand back), BLOCKED or CANCELLED", () => {
  const allowed = new Set(["VERIFYING", "IMPLEMENTING", "BLOCKED", "CANCELLED"]);
  for (const to of ALL_STATES) {
    assert.equal(isLegalTransition("HUMAN_EDITING", to), allowed.has(to), `HUMAN_EDITING -> ${to}`);
  }
});

test("nothing else enters HUMAN_EDITING — not VERIFYING, not PR_READY, not a terminal state", () => {
  const entries = new Set(["IMPLEMENTING", "REPAIRING", "WAITING_FOR_HUMAN"]);
  for (const from of ALL_STATES) {
    if (from === "BLOCKED") continue;
    assert.equal(isLegalTransition(from, "HUMAN_EDITING"), entries.has(from), `${from} -> HUMAN_EDITING`);
  }
});

test("BLOCKED from HUMAN_EDITING returns only to HUMAN_EDITING", () => {
  const blocked = transition({ state: "HUMAN_EDITING", blockedFrom: null }, "BLOCKED").next;
  assert.deepEqual(blocked, { state: "BLOCKED", blockedFrom: "HUMAN_EDITING" });
  assert.equal(isLegalTransition("BLOCKED", "HUMAN_EDITING", blocked.blockedFrom), true);
  assert.equal(isLegalTransition("BLOCKED", "VERIFYING", blocked.blockedFrom), false);
});

test("the second cycle: WAITING_FOR_HUMAN -> HUMAN_EDITING -> VERIFYING -> PR_CREATING -> PR_READY", () => {
  let run = { state: "WAITING_FOR_HUMAN", blockedFrom: null };
  for (const to of ["HUMAN_EDITING", "VERIFYING", "PR_CREATING", "PR_READY", "WAITING_FOR_HUMAN", "COMPLETED"]) {
    run = transition(run, to).next;
  }
  assert.equal(run.state, "COMPLETED");
});

test("take over, hand back, repair, take over again, submit", () => {
  let run = { state: "IMPLEMENTING", blockedFrom: null };
  for (const to of ["HUMAN_EDITING", "IMPLEMENTING", "VERIFYING", "REPAIRING", "HUMAN_EDITING", "VERIFYING"]) {
    run = transition(run, to).next;
  }
  assert.equal(run.state, "VERIFYING");
  assert.throws(() => transition({ state: "VERIFYING", blockedFrom: null }, "HUMAN_EDITING"), IllegalTransitionError);
  assert.throws(() => transition({ state: "HUMAN_EDITING", blockedFrom: null }, "FAILED"), IllegalTransitionError);
  assert.throws(() => transition({ state: "HUMAN_EDITING", blockedFrom: null }, "PR_CREATING"), IllegalTransitionError);
});
