import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { computeVerdict } from "../packages/verification/dist/evidence/verdict.js";
import { GATE_LEVELS, gateDecision } from "../packages/verification/dist/evidence/gate.js";
import {
  UnapprovedCriteriaError,
  applyCommand,
  assertProvisionable,
} from "../dist/factory/criteria-gate.js";
import { TERMINAL_STATES, isLegalTransition } from "../dist/factory/run-state-machine.js";

const RUNS = { numRuns: 500 };

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

const finding = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  severity: fc.constantFrom("blocking", "non_blocking"),
  category: fc.constant("c"),
  claim: fc.constant("x"),
});

const evidenceItem = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  stage: fc.constantFrom("checks", "review", "intent", "security", "browser"),
  type: fc.constant("t"),
  status: fc.constantFrom("passed", "warning", "failed", "completed_with_findings", "skipped"),
  findings: fc.option(fc.array(finding, { maxLength: 4 }), { nil: undefined }),
});

const mapping = fc.record({
  criterion: fc.string({ minLength: 1, maxLength: 8 }),
  status: fc.constantFrom("satisfied", "unsatisfied", "unknown"),
  evidence: fc.constant([]),
  reason: fc.constant("r"),
});

const mappingFile = fc.record({
  status: fc.constant("completed"),
  mappings: fc.array(mapping, { maxLength: 6 }),
});

const evidence = fc.array(evidenceItem, { maxLength: 6 });

function specVerdict(items, file) {
  const findings = items.flatMap((e) => e.findings ?? []);
  if (findings.some((f) => f.severity === "blocking")) return "fail";
  if (file.mappings.some((m) => m.status === "unsatisfied")) return "fail";
  if (items.some((e) => e.status === "warning")) return "warn";
  if (findings.some((f) => f.severity === "non_blocking")) return "warn";
  if (file.mappings.some((m) => m.status === "unknown")) return "warn";
  return "pass";
}

const RANK = { pass: 0, warn: 1, fail: 2 };

test("computeVerdict is exactly VERDICT_RULE", () => {
  fc.assert(
    fc.property(evidence, mappingFile, (items, file) => {
      assert.equal(computeVerdict(items, file).verdict, specVerdict(items, file));
    }),
    RUNS,
  );
});

test("more evidence never improves a verdict", () => {
  fc.assert(
    fc.property(evidence, evidence, mappingFile, mappingFile, (a, b, m1, m2) => {
      const base = computeVerdict(a, m1).verdict;
      const more = computeVerdict([...a, ...b], { ...m1, mappings: [...m1.mappings, ...m2.mappings] }).verdict;
      assert.ok(RANK[more] >= RANK[base], `${base} became ${more}`);
    }),
    RUNS,
  );
});

test("one blocking finding or unsatisfied criterion always fails, whatever else is present", () => {
  fc.assert(
    fc.property(evidence, mappingFile, finding, fc.boolean(), (items, file, f, viaCriterion) => {
      const verdict = viaCriterion
        ? computeVerdict(items, {
            ...file,
            mappings: [...file.mappings, { criterion: "c", status: "unsatisfied", evidence: [], reason: "r" }],
          }).verdict
        : computeVerdict(
            [...items, { id: "b", stage: "review", type: "t", status: "passed", findings: [{ ...f, severity: "blocking" }] }],
            file,
          ).verdict;
      assert.equal(verdict, "fail");
    }),
    RUNS,
  );
});

test("the verdict does not depend on the order of evidence or criteria", () => {
  fc.assert(
    fc.property(evidence, mappingFile, (items, file) => {
      const reversed = computeVerdict([...items].reverse(), { ...file, mappings: [...file.mappings].reverse() });
      assert.equal(reversed.verdict, computeVerdict(items, file).verdict);
    }),
    RUNS,
  );
});

test("no gate level lets a failing verdict through, and stricter levels gate at least as much", () => {
  const strictness = ["fail", "criteria", "warn"];
  assert.deepEqual([...GATE_LEVELS].sort(), [...strictness].sort());
  fc.assert(
    fc.property(evidence, mappingFile, (items, file) => {
      const { verdict } = computeVerdict(items, file);
      const gated = strictness.map((level) => gateDecision(level, verdict, file).gated);
      if (verdict === "fail") assert.deepEqual(gated, [true, true, true]);
      for (let i = 1; i < gated.length; i++) assert.ok(!gated[i - 1] || gated[i]);
      if (verdict === "pass" && !file.mappings.some((m) => m.status === "unknown")) {
        assert.deepEqual(gated, [false, false, false]);
      }
      assert.equal(gateDecision(null, verdict, file).gated, false);
    }),
    RUNS,
  );
});

const criterion = fc.record({ id: fc.string({ minLength: 1 }), text: fc.string({ minLength: 1 }) });

const gatedRun = fc.record({
  status: fc.constantFrom(...ALL_STATES),
  acceptance_criteria: fc.array(criterion, { maxLength: 3 }),
  criteria_provenance: fc.constantFrom("extracted", "generated"),
  criteria_approved_at: fc.option(fc.date(), { nil: null }),
});

test("a /windkeel command only ever asks for a legal transition", () => {
  fc.assert(
    fc.property(gatedRun, fc.constantFrom("approve", "cancel"), (run, command) => {
      let to;
      try {
        to = applyCommand(run, command);
      } catch {
        assert.ok(
          TERMINAL_STATES.has(run.status) || (command === "approve" && run.status !== "WAITING_FOR_APPROVAL"),
        );
        return;
      }
      assert.ok(isLegalTransition(run.status, to, null) || (run.status === "BLOCKED" && to === "CANCELLED"));
    }),
    RUNS,
  );
});

test("nothing provisions without criteria, or with generated criteria nobody approved", () => {
  fc.assert(
    fc.property(gatedRun, (run) => {
      const allowed =
        run.acceptance_criteria.length > 0 &&
        !(run.criteria_provenance === "generated" && run.criteria_approved_at === null);
      if (allowed) assert.doesNotThrow(() => assertProvisionable(run));
      else assert.throws(() => assertProvisionable(run), UnapprovedCriteriaError);
    }),
    RUNS,
  );
});
