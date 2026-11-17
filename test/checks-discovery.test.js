import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readJson, runCli, tempDir } from "./helpers.js";

/** A git repo with nothing the gate could re-run: no windkeel config, no package.json. */
function repoWithoutChecks(config) {
  const dir = tempDir("nochecks");
  writeFileSync(join(dir, "README.md"), "# a repo that declares nothing verifiable\n");
  if (config) writeFileSync(join(dir, "windkeel.config.json"), JSON.stringify(config, null, 2) + "\n");
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture Author");
  git("add", ".");
  git("commit", "-qm", "fixture: initial commit");
  return dir;
}

function verifyRepo(config, extraArgs = []) {
  const out = join(tempDir("out"), "evidence");
  const result = runCli(["verify", "--repo", repoWithoutChecks(config), "--out", out, ...extraArgs]);
  return { out, result, checks: readJson(out, "evidence/ev-01.json") };
}

test("a repo with no discoverable checks warns instead of gating green", () => {
  const { out, result, checks } = verifyRepo(null);

  assert.equal(result.code, 0, result.stderr);
  const verdict = readJson(out, "verdict.json");
  assert.equal(verdict.verdict, "warn");
  assert.equal(checks.stage, "checks");
  assert.equal(checks.type, "no_checks_discovered");
  assert.equal(checks.status, "warning");
  // Evidence with a reason, not a skip: "this repo declared nothing verifiable" is
  // applicable information, where a skip would claim the stage did not apply.
  assert.notEqual(checks.status, "skipped");
  assert.match(checks.reason, /^no_checks_discovered — discovery looked at /);
  assert.match(checks.reason, /windkeel\.config\.json/);
  assert.match(checks.reason, /package\.json scripts/);
  assert.match(verdict.summary, /no repo checks were discovered/);
  assert.doesNotMatch(verdict.summary, /All 0 repo checks passed/);
});

test("the no-checks evidence carries a transcript of what discovery looked for", () => {
  const { out, checks } = verifyRepo(null);

  const transcript = readJson(out, "hashes.json").files[checks.transcript];
  assert.ok(transcript, `${checks.transcript} should be hashed into the package`);
  assert.equal(runCli(["verify-package", out]).code, 0);
});

test("checks.required escalates the same condition to a blocking finding", () => {
  const { out, result, checks } = verifyRepo({ checks: { required: true } }, ["--gate"]);

  assert.equal(result.code, 1);
  const verdict = readJson(out, "verdict.json");
  assert.equal(verdict.verdict, "fail");
  assert.equal(checks.status, "failed");
  assert.equal(checks.findings.length, 1);
  assert.equal(checks.findings[0].severity, "blocking");
  assert.deepEqual(verdict.blocking_findings, ["F-checks-required"]);
  assert.match(verdict.summary, /no repo checks were discovered/);
});

test("a package produced either way recomputes to the verdict it stored", () => {
  for (const [config, expected] of [
    [null, "warn"],
    [{ checks: { required: true } }, "fail"],
  ]) {
    const { out } = verifyRepo(config);

    const result = runCli(["verify-package", out]);

    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /integrity: ok/);
    assert.match(result.stdout, new RegExp(`verdict: ${expected.toUpperCase()}`));
  }
});

test("hiding the warning from the evidence is caught as tampering", () => {
  const { out } = verifyRepo(null);
  const checks = readJson(out, "evidence/ev-01.json");
  checks.status = "passed";
  writeFileSync(join(out, "evidence/ev-01.json"), JSON.stringify(checks, null, 2) + "\n");

  const result = runCli(["verify-package", out]);

  assert.equal(result.code, 3);
  assert.match(result.stdout, /hash mismatch: evidence\/ev-01\.json/);
});

test("a config that says nothing about strictness keeps the warn default", () => {
  // Configs written before `checks.required` existed must not start failing repos.
  for (const config of [
    { flows: [] },
    { checks: [] },
    { checks: { commands: [] } },
    { checks: { required: false } },
  ]) {
    const { out, result } = verifyRepo(config);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(readJson(out, "verdict.json").verdict, "warn", JSON.stringify(config));
  }
});

test("declaring checks in the object form runs them and drops the discovery warning", () => {
  const { out, result, checks } = verifyRepo({
    checks: { required: true, commands: [{ name: "tests", command: "node -e \"console.log('ok')\"" }] },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(checks.type, "tests_result");
  assert.equal(checks.status, "passed");
  assert.match(readJson(out, "verdict.json").summary, /1 repo check\(s\) re-run/);
});
