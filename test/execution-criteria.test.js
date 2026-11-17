import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  EXECUTION_CRITERION_REASON,
  demandsExecution,
  executedCommands,
  explainUnsettledExecution,
} from "../packages/verification/dist/stages/execution-criteria.js";
import {
  CRITERIA_SYSTEM_PROMPT,
  MAPPING_SYSTEM_PROMPT,
  mappingUserPrompt,
} from "../packages/verification/dist/providers/prompt.js";
import { fixtureRepo, readJson, runCli, tempDir } from "./helpers.js";

/**
 * #254: *"the documented command works from a clean checkout"* can never be demonstrated — no
 * stage runs an arbitrary command on the verifier's behalf, so the mapper returns `unknown`, the
 * verdict warns, and the change goes to a human for something a shell could have answered.
 *
 * The approach taken is **declared checks become citable, and the `unknown` explains itself**.
 * Nothing new executes: the verifier still runs only what the *repository* declares, because a
 * criterion is author prose on an issue and running it would let anyone who can file an issue
 * run a command inside a sandbox holding a `contents: read` token (ADR-0014 §2).
 */

// --- the class is recognised -------------------------------------------------------------------

test("the criteria that caused this are recognised as needing execution", () => {
  // content-machine#91 AC3, the worked example in #254.
  assert.ok(demandsExecution("the command works as written, from a clean checkout"));
  assert.ok(demandsExecution("`npm run build` exits 0"));
  assert.ok(demandsExecution("the migration script exits with a non-zero code on conflict"));
  assert.ok(demandsExecution("the README snippet runs successfully when you run it"));
});

test("an ordinary criterion is not swept up", () => {
  assert.equal(demandsExecution("the manifest schema validates all fixture packages"), false);
  assert.equal(demandsExecution("no file outside src/ is modified"), false);
  assert.equal(demandsExecution("the new helper is covered by a test"), false);
});

// --- the commands a criterion may cite ----------------------------------------------------------

test("the commands the repository declared and the runner actually ran are the citable ones", () => {
  const executed = executedCommands([
    {
      id: "ev-01",
      stage: "checks",
      type: "tests_result",
      status: "passed",
      producer: { command: "npm test", exit_code: 0, duration_ms: 10 },
    },
    // A check that never executed (#227) settles nothing, but it is still a command that ran
    // far enough to record one — the exit code is what says which.
    {
      id: "ev-02",
      stage: "checks",
      type: "docs_example_result",
      status: "failed",
      producer: { command: "bash docs/example.sh", exit_code: 127, duration_ms: 3 },
    },
    // Not a command at all.
    { id: "ev-03", stage: "review", type: "review_finding_set", status: "passed" },
  ]);

  assert.deepEqual(
    executed.map((c) => `${c.id}:${c.name}:${c.command}:${c.exitCode}`),
    ["ev-01:tests:npm test:0", "ev-02:docs_example:bash docs/example.sh:127"],
  );
});

test("the mapper is shown the commands that ran, with their exit codes", () => {
  const prompt = mappingUserPrompt({
    criteria: [{ id: "AC3", text: "the command works as written, from a clean checkout" }],
    evidence: [{ id: "ev-01", stage: "checks", status: "passed", summary: "npm test exited 0" }],
    executed: [
      { id: "ev-01", name: "tests", command: "npm test", exitCode: 0, status: "passed" },
    ],
    diff: "",
  });

  assert.match(prompt, /COMMANDS THIS VERIFICATION EXECUTED/);
  assert.match(prompt, /ev-01: `npm test` — declared as "tests", exited 0/);
});

test("a repository that declares no checks says so rather than showing an empty list", () => {
  const prompt = mappingUserPrompt({
    criteria: [{ id: "AC1", text: "x" }],
    evidence: [],
    executed: [],
    diff: "",
  });

  assert.match(prompt, /none: this repository declares no checks, so nothing was executed/);
});

test("the mapper is told that only those commands settle an execution criterion", () => {
  assert.match(MAPPING_SYSTEM_PROMPT, /can only be settled by running something/);
  assert.match(MAPPING_SYSTEM_PROMPT, /COMMANDS THIS\s+VERIFICATION EXECUTED/);
  assert.match(MAPPING_SYSTEM_PROMPT, /the criterion is "unknown": nothing ran it/);
});

test("the criteria generator is steered away from writing one at all", () => {
  assert.match(CRITERIA_SYSTEM_PROMPT, /settleable by what the verifier can see/);
  assert.match(CRITERIA_SYSTEM_PROMPT, /does \*\*not\*\* run a command written in a criterion/);
});

// --- the reason an author reads -----------------------------------------------------------------

test("an unsettled execution criterion is told what to do differently", () => {
  const explained = explainUnsettledExecution(
    { status: "unknown", reason: "I have no way to check this." },
    "the command works as written, from a clean checkout",
    [{ id: "ev-01", name: "tests", command: "npm test", exitCode: 0, status: "passed" }],
  );

  assert.equal(explained.status, "unknown", "the status is never touched");
  assert.match(explained.reason, new RegExp(EXECUTION_CRITERION_REASON));
  assert.match(explained.reason, /only the commands the repository declares/);
  assert.match(explained.reason, /`npm test` \(tests, ev-01, exit 0\)/);
  assert.match(explained.reason, /declare the command as a check in windkeel\.config\.json/);
  assert.match(explained.reason, /The mapper's own account: I have no way to check this\./);
});

test("the explanation says so plainly when nothing was executed at all", () => {
  const explained = explainUnsettledExecution(
    { status: "unknown", reason: "" },
    "`./build.sh` exits 0",
    [],
  );

  assert.match(explained.reason, /ran no commands at all/);
});

/**
 * The regression that matters. #245 made `unknown` and `unsatisfied` different verdicts — the
 * first is a claim about the evidence, the second a claim about the change — and collapsing them
 * is what let run `f28748b2` reject a correct change four times for $4.24. Explaining an
 * `unknown` must not start deciding one.
 */
test("nothing here changes a status, in either direction", () => {
  const text = "the command works as written, from a clean checkout";
  for (const status of ["satisfied", "unsatisfied"]) {
    const untouched = explainUnsettledExecution({ status, reason: "r" }, text, []);
    assert.deepEqual(untouched, { status, reason: "r" }, `${status} must pass through unchanged`);
  }
  const unknown = explainUnsettledExecution({ status: "unknown", reason: "r" }, text, []);
  assert.equal(unknown.status, "unknown");
});

test("a criterion that needs no execution keeps the mapper's own reason", () => {
  const untouched = explainUnsettledExecution(
    { status: "unknown", reason: "no review item speaks for the diff" },
    "no file outside src/ is modified",
    [],
  );

  assert.deepEqual(untouched.reason, "no review item speaks for the diff");
});

test("explaining twice does not stack the explanation", () => {
  const text = "`./build.sh` exits 0";
  const once = explainUnsettledExecution({ status: "unknown", reason: "r" }, text, []);
  const twice = explainUnsettledExecution(once, text, []);

  assert.deepEqual(twice, once);
});

// --- end to end -----------------------------------------------------------------------------

const SCRIPTS = { test: "node -e \"console.log('2 passing')\"" };

function verifyWith(mappings, criteriaMarkdown) {
  const repo = fixtureRepo(SCRIPTS);
  writeFileSync(join(repo, "src.js"), "export const add = (a, b) => a + b;\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "feat: add()"], { cwd: repo });

  const out = join(tempDir("out"), "evidence");
  const intent = join(tempDir("intent"), "intent.md");
  writeFileSync(intent, criteriaMarkdown);
  const scripted = (name, value) => {
    const path = join(tempDir(name), `${name}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const result = runCli(["verify", "--repo", repo, "--out", out, "--intent", intent], {
    env: {
      WINDKEEL_FAKE_REVIEWER: scripted("reviewer", { summary: "no defects found", findings: [] }),
      WINDKEEL_FAKE_MAPPER: scripted("mapper", { mappings }),
    },
  });
  return { out, result };
}

test("a criterion needing execution reaches the package as unknown, explained", () => {
  const { out, result } = verifyWith(
    [
      {
        criterion: "AC1",
        status: "unknown",
        evidence: [],
        reason: "nothing here ran that command",
      },
    ],
    "- [ ] the documented command works as written, from a clean checkout\n",
  );

  assert.equal(result.code, 0, result.stdout + result.stderr);
  const mapping = readJson(out, "mapping.json");
  assert.equal(mapping.mappings[0].status, "unknown");
  assert.match(mapping.mappings[0].reason, new RegExp(EXECUTION_CRITERION_REASON));
  assert.match(mapping.mappings[0].reason, /declare the command as a check/);

  const verdict = readJson(out, "verdict.json");
  assert.equal(verdict.verdict, "warn", "unknown warns; it does not fail (#241)");
  assert.deepEqual(verdict.unknown_criteria, ["AC1"]);
});

test("a criterion that names a declared check is satisfied by citing it", () => {
  const { out, result } = verifyWith(
    [
      {
        criterion: "AC1",
        status: "satisfied",
        evidence: ["ev-01"],
        reason: "the declared `test` check ran and exited 0",
      },
    ],
    "- [ ] the repository's declared `test` check passes\n",
  );

  assert.equal(result.code, 0, result.stdout + result.stderr);
  const mapping = readJson(out, "mapping.json");
  assert.equal(mapping.mappings[0].status, "satisfied");
  assert.deepEqual(mapping.mappings[0].evidence, ["ev-01"]);
  assert.equal(readJson(out, "verdict.json").verdict, "pass");
});

/**
 * #256's gate is what turns the explanation into something CI acts on: the class stays
 * undemonstrable by design, so a caller that cannot send it to a human stops instead.
 */
test("a CI gate can refuse the change and repeat the explanation to the author", () => {
  const { out } = verifyWith(
    [{ criterion: "AC1", status: "unknown", evidence: [], reason: "nothing ran it" }],
    "- [ ] the documented command works as written, from a clean checkout\n",
  );

  const gated = runCli(["verify-package", out, "--gate=criteria"]);

  assert.equal(gated.code, 1, gated.stdout);
  assert.match(gated.stdout, /AC1: requires_execution/);
  assert.match(gated.stdout, /declare the command as a check in windkeel\.config\.json/);
});
