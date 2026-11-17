import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureRepo, readJson, runCli, tempDir } from "./helpers.js";

const SCRIPTS = { test: "node -e \"console.log('2 passing')\"" };

function repoWithDiff() {
  const repo = fixtureRepo(SCRIPTS);
  writeFileSync(join(repo, "src.js"), "export const add = (a, b) => a + b;\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "feat: add()"], { cwd: repo });
  return repo;
}

function scripted(name, value) {
  const path = join(tempDir(name), `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const CLEAN_REVIEW = { summary: "no defects found", findings: [] };

function verifyWithMapping(mappings, options = {}) {
  const repo = repoWithDiff();
  const out = join(tempDir("out"), "evidence");
  const intent = join(tempDir("intent"), "intent.md");
  writeFileSync(
    intent,
    options.intent ?? "- [ ] add() returns the sum of its arguments\n- [ ] the sum is covered by a test\n",
  );
  const result = runCli(["verify", "--repo", repo, "--out", out, "--intent", intent, "--gate"], {
    env: {
      WINDKEEL_FAKE_REVIEWER: scripted("reviewer", options.review ?? CLEAN_REVIEW),
      ...(mappings ? { WINDKEEL_FAKE_MAPPER: scripted("mapper", { mappings }) } : {}),
    },
  });
  return { out, result, intent };
}

test("every criterion satisfied by evidence passes the gate", () => {
  const { out, result } = verifyWithMapping([
    { criterion: "AC1", status: "satisfied", evidence: ["ev-01"], reason: "suite exercises add()" },
    { criterion: "AC2", status: "satisfied", evidence: ["ev-01"], reason: "2 passing tests" },
  ]);

  assert.equal(result.code, 0, result.stdout + result.stderr);
  const mapping = readJson(out, "mapping.json");
  assert.equal(mapping.status, "completed");
  assert.deepEqual(
    mapping.mappings.map((m) => m.status),
    ["satisfied", "satisfied"],
  );
  const verdict = readJson(out, "verdict.json");
  assert.equal(verdict.verdict, "pass");
  assert.deepEqual(verdict.criteria, { satisfied: 2, unsatisfied: 0, unknown: 0, total: 2 });
});

test("a criterion with no satisfying evidence fails the gate", () => {
  const { out, result } = verifyWithMapping([
    { criterion: "AC1", status: "satisfied", evidence: ["ev-01"], reason: "suite exercises add()" },
    { criterion: "AC2", status: "unsatisfied", evidence: [], reason: "no test covers the sum" },
  ]);

  assert.equal(result.code, 1);
  const verdict = readJson(out, "verdict.json");
  assert.equal(verdict.verdict, "fail");
  assert.deepEqual(verdict.unsatisfied_criteria, ["AC2"]);
  assert.match(verdict.summary, /without satisfying evidence: AC2/);
});

test("a criterion the mapper stays silent about is unsatisfied, not absent", () => {
  const { out, result } = verifyWithMapping([
    { criterion: "AC1", status: "satisfied", evidence: ["ev-01"], reason: "covered" },
  ]);

  assert.equal(result.code, 1);
  const mapping = readJson(out, "mapping.json");
  assert.equal(mapping.mappings.length, 2);
  const ac2 = mapping.mappings.find((m) => m.criterion === "AC2");
  assert.equal(ac2.status, "unsatisfied");
  assert.match(ac2.reason, /no verdict for this criterion/);
});

test("a criterion claimed satisfied by evidence that isn't in the package is unsatisfied", () => {
  const { out, result } = verifyWithMapping([
    { criterion: "AC1", status: "satisfied", evidence: ["ev-99"], reason: "covered by ev-99" },
    { criterion: "AC2", status: "satisfied", evidence: ["ev-01"], reason: "covered" },
  ]);

  assert.equal(result.code, 1);
  const ac1 = readJson(out, "mapping.json").mappings.find((m) => m.criterion === "AC1");
  assert.equal(ac1.status, "unsatisfied");
  assert.match(ac1.reason, /cites no evidence in this package/);
});

test("explicit intent supplies criteria when there is no PR to read", () => {
  const { out } = verifyWithMapping(null, {
    intent: '{"criteria": [{"id": "AC1", "text": "add() returns the sum"}]}\n',
  });

  const intent = readJson(out, "intent.json");
  assert.equal(intent.criteria.length, 1);
  assert.equal(intent.criteria[0].text, "add() returns the sum");
  assert.equal(intent.criteria[0].source.kind, "explicit");
});

/*
 * Behaviour change (gate isolation fix, E): this used to compute `pass` — "criteria are recorded
 * but do not gate" — so with no model key at all, stated criteria nobody judged passed the gate.
 * Every criterion is now `unknown`: the verdict warns, `--gate` (fail level) still exits 0, and
 * `--gate=criteria` stops it.
 */
test("without a mapper every criterion is unknown, so the verdict warns rather than passes", () => {
  const { out, result } = verifyWithMapping(null);

  assert.equal(result.code, 0, result.stdout);
  const mapping = readJson(out, "mapping.json");
  assert.equal(mapping.status, "skipped");
  assert.match(mapping.reason, /^no_mapper_configured/);
  assert.deepEqual(
    mapping.mappings.map((m) => [m.criterion, m.status]),
    [
      ["AC1", "unknown"],
      ["AC2", "unknown"],
    ],
  );
  assert.equal(readJson(out, "verdict.json").verdict, "warn");
  const gated = runCli(["verify-package", out, "--gate=criteria"]);
  assert.equal(gated.code, 1, gated.stdout);
});
