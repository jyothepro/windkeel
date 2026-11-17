/**
 * #228 at its source: what a `warn` is pointing at, and the one distinction that changes what a
 * reviewer does about it.
 *
 * `computeVerdict` warns on "any warning-status evidence **or** non-blocking finding". Only the
 * second half ever rendered, so run `2329bb84-d81c-4caf-967e-856a2c590c61` — the first successful
 * live run — posted a card reading 4/4 criteria, 0 blocking, 0 advisory, WARN. The cause was
 * semgrep exiting 143, killed when the sandbox's lifetime expired at 300 s during a 313 s
 * verification.
 *
 * `computeVerdict` is deliberately not exercised here and deliberately not changed: the verdict
 * was correct. This is about what the verdict can be explained by.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeExit, signalForExit } from "@windkeel/verification/exec/exit.js";
import { incompleteStages } from "@windkeel/verification/evidence/incomplete.js";
import { computeVerdict } from "@windkeel/verification/evidence/verdict.js";

const NO_MAPPINGS = { status: "completed", mappings: [] };

const securityEvidence = (scanners) => ({
  id: "ev-04",
  stage: "security",
  type: "security_scan",
  status: "warning",
  summary: "a security stage that did not finish",
  scanners,
});

test("a killed scanner is described as killed, not as having found something", () => {
  const [incomplete] = incompleteStages([
    securityEvidence([
      { tool: "gitleaks", ran: true, note: "no secrets found" },
      {
        tool: "semgrep",
        ran: false,
        note: "semgrep was killed before it finished: exit 143 (SIGTERM — killed, not a verdict on the code)",
        killed: true,
      },
    ]),
  ]);

  assert.equal(incomplete.tool, "semgrep", "the tool is named, not counted");
  assert.equal(incomplete.killed, true);
  assert.equal(incomplete.stage, "security");
  assert.equal(incomplete.evidenceId, "ev-04", "with the evidence item to open");
  assert.match(incomplete.detail, /SIGTERM/);
});

test("a scanner that ran is not reported as incomplete", () => {
  const found = incompleteStages([
    securityEvidence([{ tool: "gitleaks", ran: true, note: "no secrets found" }]),
  ]);

  assert.equal(found.length, 1, "the stage still warned, so it still explains itself");
  assert.equal(found[0].tool, "security", "falling back to the stage where no tool is unfinished");
});

test("a scanner that failed for an ordinary reason is errored, not signalled", () => {
  const [incomplete] = incompleteStages([
    securityEvidence([
      {
        tool: "osv-scanner",
        ran: false,
        note: "osv-scanner could not complete: exit 2 — could not reach the vulnerability database",
      },
    ]),
  ]);

  assert.equal(incomplete.killed, false);
  assert.doesNotMatch(incomplete.detail, /SIGTERM|SIGKILL|killed/);
});

test("evidence that passed or warned with no detail is handled without inventing one", () => {
  assert.deepEqual(incompleteStages([{ ...securityEvidence([]), status: "passed" }]), []);

  const [bare] = incompleteStages([
    { id: "ev-09", stage: "browser", type: "flows", status: "warning" },
  ]);
  assert.equal(bare.tool, "browser");
  assert.match(bare.detail, /did not complete/);
});

/**
 * The shape of the live run, end to end through the part that was broken: warning-status evidence,
 * zero findings, every criterion satisfied. The verdict is `warn` and is correct; what changed is
 * that there is now something to point at.
 */
test("a warn with no findings at all still has a named cause", () => {
  const evidence = [
    securityEvidence([
      { tool: "semgrep", ran: false, note: "semgrep was killed before it finished: exit 143", killed: true },
    ]),
  ];
  const computation = computeVerdict(evidence, {
    status: "completed",
    mappings: [{ criterion: "AC1", status: "satisfied", evidence: [], reason: "demonstrated" }],
  });

  assert.equal(computation.verdict, "warn");
  assert.deepEqual(computation.blocking, []);
  assert.deepEqual(computation.nonBlocking, []);
  assert.equal(
    incompleteStages(evidence).length,
    1,
    "before #228 this was the point at which the reason stopped being available",
  );
});

test("128+N is read as a signal, and an ordinary exit code is not", () => {
  assert.equal(signalForExit(143), "SIGTERM");
  assert.equal(signalForExit(137), "SIGKILL");
  assert.equal(signalForExit(1), null);
  assert.equal(signalForExit(127), null, "command-not-found is not a signal");
  assert.equal(signalForExit(128), null, "the boundary itself carries no signal number");
  assert.equal(signalForExit(null), null);
});

test("describeExit says which of the three happened", () => {
  assert.match(describeExit({ status: 143, signal: null }), /SIGTERM/);
  assert.match(describeExit({ status: 143, signal: null }), /not a verdict on the code/);
  assert.equal(describeExit({ status: 2, signal: null }), "exit 2");
  assert.match(describeExit({ status: 127, signal: null }), /command not found/);
  assert.match(describeExit({ status: null, signal: "SIGKILL" }), /terminated by SIGKILL/);
  assert.match(
    describeExit({ status: null, signal: null, error: "spawn ENOENT" }),
    /could not be started: spawn ENOENT/,
  );
});

test("computeVerdict is untouched by any of this", async () => {
  const source = await import("node:fs").then(({ readFileSync }) =>
    readFileSync(
      new URL("../packages/verification/src/evidence/verdict.ts", import.meta.url),
      "utf8",
    ),
  );
  assert.doesNotMatch(
    source,
    /incomplete/i,
    "the verdict was correct; widening it would be a behaviour change smuggled into a legibility fix",
  );
});
