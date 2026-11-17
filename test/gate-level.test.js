import assert from "node:assert/strict";
import { test } from "node:test";
import { readEvidence } from "../packages/verification/dist/evidence/package.js";
import { computeVerdict, verdictFile } from "../packages/verification/dist/evidence/verdict.js";
import { fixtureCopy, readJson, runCli, writeJson } from "./helpers.js";

/**
 * #256: `windkeel verify --gate` exited 0 on a `warn`, and since #241 a criterion nobody could
 * judge is `unknown`, which warns. So a change whose acceptance criteria were never settled
 * passed a CI gate silently.
 *
 * The fix is in the *gate*, not the verdict. `computeVerdict` is untouched and
 * `test/unknown-criteria.test.js` still asserts its behaviour unchanged — moving the strictness
 * there would undo #241 and reinstate the $4.24 rejection of a correct change on run `f28748b2`.
 */

/**
 * Rewrites `failing-package` into the shape a case needs and re-seals it.
 *
 * `verdict.json` is recomputed with the real `computeVerdict` rather than hand-written, so a
 * fixture can never disagree with the recomputation `verify-package` does — that disagreement is
 * an integrity failure (exit 3) and would silently turn every assertion below into a test of the
 * wrong thing.
 */
function packageWhere(mappings, findings) {
  const dir = fixtureCopy("failing-package");

  const mapping = { status: "completed", mappings };
  writeJson(dir, "mapping.json", mapping);

  const review = readJson(dir, "evidence/ev-02.json");
  review.findings = findings;
  review.status = findings.length ? "completed_with_findings" : "passed";
  review.summary = `adversarial review: ${findings.length} finding(s)`;
  writeJson(dir, "evidence/ev-02.json", review);

  const evidence = readEvidence(dir, readJson(dir, "manifest.json"));
  writeJson(dir, "verdict.json", verdictFile(computeVerdict(evidence, mapping), "fixture"));

  const sealed = runCli(["seal", dir]);
  assert.equal(sealed.code, 0, sealed.stderr);
  return dir;
}

const satisfied = (id) => ({ criterion: id, status: "satisfied", evidence: ["ev-01"], reason: "green" });
const unknown = (id, reason) => ({ criterion: id, status: "unknown", evidence: [], reason });
const unsatisfied = (id) => ({
  criterion: id,
  status: "unsatisfied",
  evidence: ["ev-02"],
  reason: "the evidence refutes it",
});

const BLOCKING = [
  {
    id: "F1",
    severity: "blocking",
    category: "test-coverage",
    claim: "AC1 has no covering test",
    failure_scenario: "a blocking finding reaches main",
  },
];
const NON_BLOCKING = [
  {
    id: "F2",
    severity: "non_blocking",
    category: "maintainability",
    claim: "sha256 helper duplicates the hashes.ts one-liner",
  },
];

/** The regression. Every workflow file already in existence passes bare `--gate`. */
test("a fail verdict still exits 1 under bare --gate", () => {
  const dir = packageWhere([unsatisfied("AC1"), satisfied("AC2")], BLOCKING);

  const result = runCli(["verify-package", dir, "--gate"]);

  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /verdict: FAIL/);
});

test("--gate=fail means exactly what bare --gate means", () => {
  const dir = packageWhere([unsatisfied("AC1"), satisfied("AC2")], BLOCKING);

  assert.equal(runCli(["verify-package", dir, "--gate=fail"]).code, 1);
});

/** The hazard #256 exists to close: nobody judged AC1, and CI merged it anyway. */
test("an unsettled criterion passes bare --gate, which is the bug", () => {
  const dir = packageWhere([unknown("AC1", "no stage executes the documented command"), satisfied("AC2")], []);

  const result = runCli(["verify-package", dir, "--gate"]);

  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /verdict: WARN/);
});

test("--gate=criteria exits non-zero on an unsettled criterion and names it", () => {
  const dir = packageWhere(
    [unknown("AC1", "no stage executes the documented command"), satisfied("AC2")],
    [],
  );

  const result = runCli(["verify-package", dir, "--gate=criteria"]);

  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /gate: FAILED/);
  assert.match(
    result.stdout,
    /AC1: no stage executes the documented command/,
    "a red CI with no reason is the thing that teaches people to press re-run",
  );
  const gateLines = result.stdout.slice(result.stdout.indexOf("gate: FAILED"));
  assert.doesNotMatch(gateLines, /AC2/, "a criterion that was settled is not the gate's news");
});

test("--gate=criteria still exits 0 on a clean pass", () => {
  const dir = packageWhere([satisfied("AC1"), satisfied("AC2")], []);

  const result = runCli(["verify-package", dir, "--gate=criteria"]);

  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /verdict: PASS/);
});

/**
 * A non-blocking finding is a judgement somebody made; an unsettled criterion is a judgement
 * nobody made. `--gate=criteria` deliberately does not collapse them — that would be a second,
 * quieter decision than the one the flag is making.
 */
test("a warn from a non-blocking finding passes --gate=criteria and fails --gate=warn", () => {
  const dir = packageWhere([satisfied("AC1"), satisfied("AC2")], NON_BLOCKING);

  const lenient = runCli(["verify-package", dir, "--gate=criteria"]);
  const strict = runCli(["verify-package", dir, "--gate=warn"]);

  assert.equal(lenient.code, 0, lenient.stdout);
  assert.match(lenient.stdout, /verdict: WARN/);
  assert.equal(strict.code, 1, strict.stdout);
  assert.match(strict.stdout, /--gate=warn admits only a clean pass/);
});

test("--gate=warn on an unsettled criterion still names the criterion", () => {
  const dir = packageWhere([unknown("AC1", "nothing in the package speaks to it"), satisfied("AC2")], []);

  const result = runCli(["verify-package", dir, "--gate=warn"]);

  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /AC1: nothing in the package speaks to it/);
});

/**
 * Exit 3 says "this evidence is untrustworthy" and exit 1 says "this change does not clear the
 * bar". A pipeline branching on 3 must never be told the second thing, so integrity outranks
 * gating even when both apply.
 */
test("an integrity failure still exits 3, even under the strictest gate", () => {
  const dir = packageWhere([unknown("AC1", "unsettled"), satisfied("AC2")], []);
  const evidence = readJson(dir, "evidence/ev-01.json");
  evidence.summary = "tampered";
  writeJson(dir, "evidence/ev-01.json", evidence);

  const result = runCli(["verify-package", dir, "--gate=warn"]);

  assert.equal(result.code, 3, result.stdout);
  assert.match(result.stdout, /integrity: FAILED/);
});

test("a mistyped gate level is a usage error, not an integrity failure", () => {
  const dir = packageWhere([satisfied("AC1"), satisfied("AC2")], []);

  const result = runCli(["verify-package", dir, "--gate=strict"]);

  assert.equal(result.code, 2, result.stdout);
  assert.match(result.stderr, /unknown --gate level "strict"/);
  assert.match(result.stderr, /fail, criteria, warn/);
});

/**
 * `--gate` used to consume the next non-`--` token, so this parsed as `gate="<dir>"` with no
 * positional left. It stayed harmless only because the documented argument order puts the
 * directory first; now that `--gate` carries a level, it would have been a live bug.
 */
test("--gate does not swallow the package directory that follows it", () => {
  const dir = packageWhere([satisfied("AC1"), satisfied("AC2")], []);

  const result = runCli(["verify-package", "--gate", dir]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /verdict: PASS/);
});

test("the usage text documents the levels", () => {
  const result = runCli(["help"]);

  assert.match(result.stdout, /--gate=criteria/);
  assert.match(result.stdout, /--gate=warn/);
  assert.match(result.stdout, /Exit 3 is an integrity failure/);
});
