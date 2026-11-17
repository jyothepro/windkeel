import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
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

const RUNS = { numRuns: 500 };

function legalTargets(run) {
  return ALL_STATES.filter((to) => isLegalTransition(run.state, to, run.blockedFrom));
}

const attempt = fc.record({
  pickLegal: fc.boolean(),
  index: fc.nat(),
  target: fc.constantFrom(...ALL_STATES),
});

function walk(attempts) {
  let run = initialRunState();
  const trace = [run];
  const rejected = [];
  for (const a of attempts) {
    const legal = legalTargets(run);
    const to = a.pickLegal && legal.length ? legal[a.index % legal.length] : a.target;
    try {
      run = transition(run, to).next;
      trace.push(run);
    } catch (err) {
      assert.ok(err instanceof IllegalTransitionError);
      rejected.push({ from: run, to });
    }
  }
  return { trace, rejected };
}

const walks = fc.array(attempt, { maxLength: 60 });

test("transition accepts exactly the legal moves and rejects the rest", () => {
  fc.assert(
    fc.property(walks, (attempts) => {
      const { trace, rejected } = walk(attempts);
      for (let i = 1; i < trace.length; i++) {
        assert.ok(isLegalTransition(trace[i - 1].state, trace[i].state, trace[i - 1].blockedFrom));
      }
      for (const r of rejected) {
        assert.equal(isLegalTransition(r.from.state, r.to, r.from.blockedFrom), false);
      }
    }),
    RUNS,
  );
});

test("a terminal state is never left", () => {
  fc.assert(
    fc.property(walks, (attempts) => {
      const { trace } = walk(attempts);
      const first = trace.findIndex((r) => TERMINAL_STATES.has(r.state));
      if (first === -1) return;
      assert.equal(trace.length, first + 1);
    }),
    RUNS,
  );
});

test("blockedFrom is set exactly while BLOCKED, and unblocking returns to it", () => {
  fc.assert(
    fc.property(walks, (attempts) => {
      const { trace } = walk(attempts);
      for (let i = 0; i < trace.length; i++) {
        const r = trace[i];
        assert.equal(r.state === "BLOCKED", r.blockedFrom !== null);
        if (r.state === "BLOCKED") assert.equal(r.blockedFrom, trace[i - 1].state);
        if (i > 0 && trace[i - 1].state === "BLOCKED") {
          assert.ok(r.state === "CANCELLED" || r.state === trace[i - 1].blockedFrom);
        }
      }
    }),
    RUNS,
  );
});

function unblocked(trace) {
  return trace.map((r) => r.state).filter((s) => s !== "BLOCKED");
}

test("no pull request without the verifier: PR_CREATING is entered only from VERIFYING", () => {
  fc.assert(
    fc.property(walks, (attempts) => {
      const states = unblocked(walk(attempts).trace);
      for (let i = 1; i < states.length; i++) {
        if (states[i] === "PR_CREATING" && states[i - 1] !== "PR_CREATING") {
          assert.equal(states[i - 1], "VERIFYING");
        }
      }
    }),
    RUNS,
  );
});

test("COMPLETED is reached only through PR_CREATING, PR_READY and WAITING_FOR_HUMAN", () => {
  fc.assert(
    fc.property(walks, (attempts) => {
      const states = unblocked(walk(attempts).trace);
      const done = states.indexOf("COMPLETED");
      if (done === -1) return;
      const before = states.slice(0, done);
      const pr = before.lastIndexOf("PR_CREATING");
      assert.ok(pr >= 0);
      assert.equal(before[pr - 1], "VERIFYING");
      assert.ok(before.slice(pr).includes("PR_READY"));
      assert.equal(before.at(-1), "WAITING_FOR_HUMAN");
    }),
    RUNS,
  );
});

test("code that changes after a pass is verified again before a pull request", () => {
  fc.assert(
    fc.property(walks, (attempts) => {
      const states = unblocked(walk(attempts).trace);
      let verifiedSinceChange = false;
      for (const s of states) {
        if (s === "IMPLEMENTING" || s === "REPAIRING" || s === "HUMAN_EDITING") {
          verifiedSinceChange = false;
        }
        if (s === "VERIFYING") verifiedSinceChange = true;
        if (s === "PR_CREATING") assert.ok(verifiedSinceChange);
      }
    }),
    RUNS,
  );
});

test("every reachable state can still reach a terminal state", () => {
  const reachable = new Set();
  const frontier = [initialRunState()];
  const key = (r) => `${r.state}|${r.blockedFrom}`;
  const nodes = new Map();
  while (frontier.length) {
    const run = frontier.pop();
    if (reachable.has(key(run))) continue;
    reachable.add(key(run));
    const next = legalTargets(run).map((to) => transition(run, to).next);
    nodes.set(key(run), { run, next: next.map(key) });
    frontier.push(...next);
  }
  assert.deepEqual(
    new Set([...reachable].map((k) => k.split("|")[0])),
    new Set(ALL_STATES),
    "every state is reachable from CREATED",
  );
  const canFinish = new Set(
    [...nodes.values()].filter((n) => TERMINAL_STATES.has(n.run.state)).map((n) => key(n.run)),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const [k, n] of nodes) {
      if (!canFinish.has(k) && n.next.some((m) => canFinish.has(m))) {
        canFinish.add(k);
        grew = true;
      }
    }
  }
  assert.deepEqual([...reachable].filter((k) => !canFinish.has(k)), []);
});

test("transition is pure: the input is never mutated and reasons are recorded verbatim", () => {
  fc.assert(
    fc.property(walks, fc.string(), (attempts, reason) => {
      const { trace } = walk(attempts);
      const last = trace.at(-1);
      const frozen = structuredClone(last);
      for (const to of legalTargets(last)) {
        const { record } = transition(last, to, reason);
        assert.deepEqual(record, { from: last.state, to, reason });
        assert.deepEqual(last, frozen);
      }
    }),
    RUNS,
  );
});
