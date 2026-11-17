import assert from "node:assert/strict";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureCopy, readJson, runCli, tempDir, writeJson } from "./helpers.js";

/** One-line `windkeel: ...` with no stack trace — a CI operator reads this, not a debugger. */
function assertCleanError(stderr) {
  const lines = stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1, stderr);
  assert.match(lines[0], /^windkeel: /);
  assert.doesNotMatch(stderr, /\n\s+at /);
}

test("a fail verdict is reported but only gates when --gate is passed", () => {
  const dir = fixtureCopy("failing-package");

  const ungated = runCli(["verify-package", dir]);
  const gated = runCli(["verify-package", dir, "--gate"]);

  assert.equal(ungated.code, 0, ungated.stdout);
  assert.equal(gated.code, 1, gated.stdout);
  assert.match(gated.stdout, /verdict: FAIL/);
  assert.match(gated.stdout, /blocking findings: F1/);
  assert.match(gated.stdout, /unsatisfied criteria: AC1/);
});

test("skipped stages survive verification as first-class evidence", () => {
  const dir = fixtureCopy("failing-package");

  const result = runCli(["verify-package", dir]);

  assert.match(result.stdout, /browser_flow\s+skipped\s+not_applicable/);
});

test("a tampered evidence file fails integrity with exit 3", () => {
  const dir = fixtureCopy("failing-package");
  const evidence = readJson(dir, "evidence/ev-02.json");
  evidence.findings = [];
  writeJson(dir, "evidence/ev-02.json", evidence);

  const result = runCli(["verify-package", dir]);

  assert.equal(result.code, 3);
  assert.match(result.stdout, /integrity: FAILED/);
  assert.match(result.stdout, /hash mismatch: evidence\/ev-02\.json/);
});

test("a hand-set verdict that disagrees with recomputation fails integrity", () => {
  const dir = fixtureCopy("failing-package");
  const verdict = readJson(dir, "verdict.json");
  verdict.verdict = "pass";
  writeJson(dir, "verdict.json", verdict);
  runCli(["seal", dir]);

  const result = runCli(["verify-package", dir]);

  assert.equal(result.code, 3);
  assert.match(result.stdout, /stored verdict "pass" != recomputed "fail"/);
});

test("an unhashed file smuggled into a sealed package fails integrity", () => {
  const dir = fixtureCopy("failing-package");
  writeFileSync(join(dir, "evidence/ev-99.json"), "{}\n");

  const result = runCli(["verify-package", dir]);

  assert.equal(result.code, 3);
  assert.match(result.stdout, /unhashed file present: evidence\/ev-99\.json/);
});

test("a transcript deleted from the package fails integrity", () => {
  const dir = fixtureCopy("failing-package");
  rmSync(join(dir, "evidence/ev-01.log"));

  const result = runCli(["verify-package", dir]);

  assert.equal(result.code, 3);
  assert.match(result.stdout, /missing transcript evidence\/ev-01\.log/);
});

test("a directory that is not an evidence package is a usage error, not an integrity failure", () => {
  const missing = runCli(["verify-package", "/tmp/windkeel-does-not-exist"]);
  const empty = runCli(["verify-package", tempDir("empty")]);

  assert.equal(missing.code, 2);
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /not an evidence package/);
});

test("a path that is a regular file, not a directory, is a usage error", () => {
  const file = join(tempDir("file"), "verdict.json");
  writeFileSync(file, "{}\n");

  const result = runCli(["verify-package", file]);

  assert.equal(result.code, 2);
  assertCleanError(result.stderr);
});

test("usage errors name the path and print no stack trace", () => {
  for (const path of ["/tmp/windkeel-does-not-exist", tempDir("empty")]) {
    const result = runCli(["verify-package", path]);

    assert.equal(result.code, 2);
    assertCleanError(result.stderr);
    assert.ok(result.stderr.includes(path), result.stderr);
  }
});

test("one spine file makes the path a package: what is missing is then an integrity failure", () => {
  const complete = fixtureCopy("failing-package");
  for (const spine of ["manifest.json", "intent.json", "mapping.json", "verdict.json"]) {
    const dir = tempDir("spine");
    cpSync(join(complete, spine), join(dir, spine));

    const result = runCli(["verify-package", dir]);

    assert.equal(result.code, 3, `${spine} alone should read as a broken package`);
    assertCleanError(result.stderr);
    assert.match(result.stderr, /evidence package is incomplete: missing /);
  }
});

test("a package whose spine files are all present but malformed is an integrity failure", () => {
  const dir = fixtureCopy("failing-package");
  writeFileSync(join(dir, "manifest.json"), "{not json\n");

  const result = runCli(["verify-package", dir]);

  assert.equal(result.code, 3);
  assertCleanError(result.stderr);
});
