/**
 * #220's actual question, which is not "does discovery find the commands":
 * **can a Go repository reach a `pass` verdict that means something?**
 *
 * Before this, a Go repository discovered zero checks, which *warns* rather than fails, so a run
 * could reach `pass` having verified acceptance criteria and executed nothing at all — and from
 * the outside that is indistinguishable from a repository whose checks all passed. So these two
 * tests are built around the difference: the same fixture, once sound and once broken, asserting
 * in both cases that the checks genuinely ran (exit code, transcript, command) rather than that
 * discovery merely produced strings.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readJson, runCli, tempDir } from "./helpers.js";

const GO = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

/** A real, compilable Go module with no external dependencies, so `go test` runs offline. */
function goRepo({ sound }) {
  const dir = tempDir("gorepo");
  writeFileSync(join(dir, "go.mod"), "module example.com/adder\n\ngo 1.21\n");
  writeFileSync(
    join(dir, "adder.go"),
    `package adder\n\nfunc Add(a, b int) int { return a ${sound ? "+" : "-"} b }\n`,
  );
  writeFileSync(
    join(dir, "adder_test.go"),
    'package adder\n\nimport "testing"\n\n' +
      "func TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatalf(\"Add(2, 3) = %d, want 5\", Add(2, 3))\n\t}\n}\n",
  );
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture Author");
  git("add", "-A");
  git("commit", "-qm", "fixture: a Go module with its own tests");
  return dir;
}

function verifyGoRepo({ sound }, extraArgs = []) {
  const out = join(tempDir("out"), "evidence");
  const result = runCli(["verify", "--repo", goRepo({ sound }), "--out", out, ...extraArgs]);
  const ids = ["ev-01", "ev-02", "ev-03"];
  return {
    out,
    result,
    checks: ids.map((id) => readJson(out, `evidence/${id}.json`)),
  };
}

test("a Go repo with no windkeel.config.json runs its own checks and passes", { skip: !GO }, () => {
  const { out, result, checks } = verifyGoRepo({ sound: true });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    checks.map((c) => c.type),
    ["go-build_result", "go-vet_result", "go-tests_result"],
  );
  // The part that matters: each check *ran*. A discovered command with no producer block and no
  // transcript is the `pass`-with-nothing-executed this issue exists to prevent.
  for (const check of checks) {
    assert.equal(check.status, "passed");
    assert.equal(check.producer.exit_code, 0);
    assert.ok(check.producer.duration_ms >= 0);
    assert.ok(existsSync(join(out, check.transcript)), `${check.transcript} is missing`);
  }
  assert.deepEqual(
    checks.map((c) => c.producer.command),
    ["go build ./...", "go vet ./...", "go test ./..."],
  );
  const verdict = readJson(out, "verdict.json");
  assert.equal(verdict.verdict, "pass");
  assert.match(verdict.summary, /3 repo check\(s\) re-run/);
  // ...and the old symptom is gone: this is not a repo that "declared nothing verifiable".
  assert.doesNotMatch(verdict.summary, /no repo checks were discovered/);
});

test("a Go repo whose own test fails gates as fail, with the transcript to show it", { skip: !GO }, () => {
  const { out, result, checks } = verifyGoRepo({ sound: false }, ["--gate"]);

  assert.equal(result.code, 1);
  const tests = checks[2];
  assert.equal(tests.type, "go-tests_result");
  assert.equal(tests.status, "failed");
  assert.notEqual(tests.producer.exit_code, 0);
  assert.equal(tests.findings[0].severity, "blocking");
  assert.equal(tests.findings[0].id, "F-go-tests");
  // The failure is the repository's, quoted from its own test runner — not the gate's paraphrase.
  assert.match(readFileSync(join(out, tests.transcript), "utf8"), /Add\(2, 3\) = -1, want 5/);
  assert.equal(readJson(out, "verdict.json").verdict, "fail");
  assert.deepEqual(readJson(out, "verdict.json").blocking_findings, ["F-go-tests"]);
});
