/**
 * The difference #227 is about: a check that **ran and disagreed** with the repository, versus
 * one that **never executed**. Before this they were the same evidence item, and the second was
 * handed to the repair agent as a code defect to fix.
 *
 * Run `f2455ce2-d56c-4e33-9de0-e0f10c1aab56` recorded
 * `{"check":"tests","command":"npm run --silent test","exit_code":127}` as a plain failure, so
 * the packet asked the maker to "make `tests` exit 0" for a command the sandbox did not have.
 * The turn produced `{"emptyChange": true, "filesChanged": []}` and the run stopped as `stuck`
 * after one attempt of three.
 *
 * The exit codes are produced by a real shell through `LocalExecutionEnvironment` rather than
 * scripted, because 127 and 126 are the shell's own conventions and a hand-written stub would be
 * asserting this file's belief about them instead of the behaviour.
 */

import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildRepairPacket } from "@windkeel/verification/engine/repair.js";
import { LocalExecutionEnvironment } from "@windkeel/verification/exec/local.js";
import {
  CHECK_COULD_NOT_RUN_REASON,
  checkCouldNotRun,
  runChecks,
} from "@windkeel/verification/stages/checks.js";
import { tempDir } from "./helpers.js";

const execEnv = new LocalExecutionEnvironment();

/** A name nothing on any `PATH` answers to, so the shell reports 127. */
const MISSING_COMMAND = "windkeel-no-such-command-227";

async function runOne(name, command, repo = tempDir("checks")) {
  const runs = await runChecks(execEnv, repo, [{ name, command }], "local");
  assert.equal(runs.length, 1);
  return runs[0];
}

const allMappingsSatisfied = { status: "completed", mappings: [] };

/** `buildRepairPacket` only produces a packet for a fail, which a blocking finding guarantees. */
function packetFor(evidence) {
  const computation = {
    verdict: "fail",
    blocking: (evidence.findings ?? []).map((f) => f.id),
    nonBlocking: [],
    unsatisfied: [],
    satisfied: [],
    counts: {},
  };
  return buildRepairPacket([evidence], allMappingsSatisfied, [], computation);
}

test("a check whose command does not exist is reported as one that could not run", async () => {
  const { evidence } = await runOne("tests", MISSING_COMMAND);

  assert.equal(evidence.producer?.exit_code, 127, "the shell's command-not-found code");
  assert.ok(checkCouldNotRun(evidence), "it should carry the could-not-run marker");
  assert.match(evidence.reason, new RegExp(`^${CHECK_COULD_NOT_RUN_REASON} — `));
  assert.match(evidence.summary, /could not be run/);
  assert.match(evidence.summary, /command not found/);
  // The command is named, so an operator does not have to open the transcript to learn which.
  assert.match(evidence.summary, new RegExp(MISSING_COMMAND));
});

test("the finding blames the verifier's environment, never the repository's source", async () => {
  const { evidence } = await runOne("tests", MISSING_COMMAND);
  const [finding] = evidence.findings;

  assert.equal(finding.severity, "blocking", "the gate still has no evidence either way");
  assert.equal(finding.category, "verifier-environment");
  assert.match(finding.claim, /never executed/);
  // The old claim was "The repo's own `tests` check fails on this head commit" — which was untrue.
  assert.doesNotMatch(finding.claim, /fails on this head commit/);
  assert.match(finding.failure_scenario, /Repairing the repository cannot help/);
});

test("a check found but not executable is could-not-run too", async () => {
  const repo = tempDir("checks-126");
  const script = join(repo, "not-executable.sh");
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  chmodSync(script, 0o644);

  const { evidence } = await runOne("tests", `./not-executable.sh`, repo);

  assert.equal(evidence.producer?.exit_code, 126);
  assert.ok(checkCouldNotRun(evidence));
  assert.match(evidence.summary, /found but not executable/);
});

/**
 * The regression that matters most. Over-broadening the new branch would stop the factory
 * repairing real test failures, which is the entire reason it exists — so this asserts the
 * ordinary failure is untouched, in the same terms the old path used.
 */
test("an ordinary non-zero exit is still an ordinary failing check", async () => {
  const { evidence } = await runOne("tests", "echo 'AssertionError: expected 1 to equal 2'; exit 1");

  assert.equal(evidence.status, "failed");
  assert.equal(evidence.producer?.exit_code, 1);
  assert.ok(!checkCouldNotRun(evidence), "exit 1 ran; it must stay a demand on the repairer");
  assert.equal(evidence.reason, undefined);
  assert.match(evidence.findings[0].claim, /fails on this head commit/);
  assert.equal(evidence.findings[0].category, "repo-checks");
});

test("a check that exits 0 still passes", async () => {
  const { evidence } = await runOne("tests", "true");

  assert.equal(evidence.status, "passed");
  assert.equal(evidence.producer?.exit_code, 0);
  assert.equal(evidence.findings, undefined);
  assert.ok(!checkCouldNotRun(evidence));
});

test("the repair packet does not ask the maker to fix a command that does not exist", async () => {
  const { evidence } = await runOne("tests", MISSING_COMMAND);
  const packet = packetFor(evidence);

  assert.deepEqual(packet.failed_checks, [], "a missing command is not a failing check");
  assert.ok(
    !packet.recommended_focus.some((f) => /make `tests` exit 0/.test(f)),
    `the packet still asks for the impossible: ${JSON.stringify(packet.recommended_focus)}`,
  );
  assert.deepEqual(packet.recommended_focus, []);
});

test("the packet still records the check that could not run, because the run stops on it", async () => {
  const { evidence } = await runOne("tests", MISSING_COMMAND);
  const packet = packetFor(evidence);

  assert.equal(packet.checks_could_not_run.length, 1);
  assert.equal(packet.checks_could_not_run[0].check, "tests");
  assert.equal(packet.checks_could_not_run[0].exit_code, 127);
  assert.match(packet.checks_could_not_run[0].detail, /command not found/);
  // Still linked, so `repair.json` points at the transcript an operator needs.
  assert.ok(packet.evidence_links.some((l) => l === evidence.transcript));
});

test("an ordinary failing check is still a demand, and is not filed as could-not-run", async () => {
  const { evidence } = await runOne("tests", "exit 1");
  const packet = packetFor(evidence);

  assert.deepEqual(packet.checks_could_not_run, []);
  assert.equal(packet.failed_checks.length, 1);
  assert.equal(packet.failed_checks[0].exit_code, 1);
  assert.ok(packet.recommended_focus.some((f) => /make `tests` exit 0/.test(f)));
});
