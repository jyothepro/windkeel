import assert from "node:assert/strict";
import { test } from "node:test";
import { computeVerdict, verdictFile } from "../packages/verification/dist/evidence/verdict.js";

/**
 * #241: a criterion the evidence cannot settle warns; a criterion the evidence refutes still
 * fails. The distinction is the whole fix, so both halves are asserted — and the second matters
 * more, because a fix that made everything warn would pass a naive version of the first.
 *
 * Run `f28748b2` is the case: a correct change rejected four times, $4.24, no pull request,
 * because "I could not verify this" was recorded as "this is not met" and handed to a repair
 * loop that could never satisfy it.
 */

const clean = [{ id: "ev-01", stage: "tests", type: "test_run", status: "passed", summary: "ok" }];
const mapping = (...mappings) => ({ status: "completed", mappings });
const m = (criterion, status) => ({ criterion, status, evidence: ["ev-01"], reason: "r" });

test("a criterion the evidence cannot settle warns rather than fails", () => {
  const c = computeVerdict(clean, mapping(m("AC1", "satisfied"), m("AC2", "unknown")));
  assert.equal(c.verdict, "warn");
  assert.deepEqual(c.unknown, ["AC2"]);
  assert.deepEqual(c.unsatisfied, [], "unknown must not be counted as unsatisfied");
});

/**
 * The regression that matters most. A fix that turned every hard verdict into a warn would
 * satisfy the test above and destroy the gate.
 */
test("a criterion the evidence refutes still fails", () => {
  const c = computeVerdict(clean, mapping(m("AC1", "satisfied"), m("AC2", "unsatisfied")));
  assert.equal(c.verdict, "fail");
  assert.deepEqual(c.unsatisfied, ["AC2"]);
});

test("a blocking finding still fails, whatever the criteria say", () => {
  const withFinding = [
    ...clean,
    {
      id: "ev-02",
      stage: "review",
      type: "review_finding_set",
      status: "completed_with_findings",
      summary: "s",
      findings: [{ id: "F1", severity: "blocking", claim: "c", failure_scenario: "f" }],
    },
  ];
  assert.equal(computeVerdict(withFinding, mapping(m("AC1", "unknown"))).verdict, "fail");
});

test("all satisfied and nothing unknown still passes", () => {
  const c = computeVerdict(clean, mapping(m("AC1", "satisfied"), m("AC2", "satisfied")));
  assert.equal(c.verdict, "pass");
  assert.deepEqual(c.unknown, []);
});

/**
 * A warn must say what caused it — the rule #228 established. An unknown criterion is now one of
 * the things that can cause one, so it has to be nameable from the package alone.
 */
test("the verdict file names the unsettled criteria, not just a count", () => {
  const c = computeVerdict(clean, mapping(m("AC1", "unknown"), m("AC2", "satisfied")));
  const file = verdictFile(c, "summary");
  assert.deepEqual(file.unknown_criteria, ["AC1"]);
  assert.equal(file.criteria.unknown, 1);
  assert.equal(file.criteria.total, 2, "unknown counts toward the total, or the maths lies");
  assert.match(file.rule, /could not settle/);
});
