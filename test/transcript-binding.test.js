import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureCopy, readJson, runCli, tempDir, writeJson } from "./helpers.js";

/** One check that passes and one that exits 7, so a doctored status has a transcript to contradict. */
const SCRIPTS = {
  test: "node -e \"console.log('2 passing')\"",
  lint: "node -e \"console.error('1 error'); process.exit(7)\"",
};

function verifiedPackage() {
  const repo = tempDir("repo");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", scripts: SCRIPTS }, null, 2) + "\n",
  );
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture Author");
  git("add", ".");
  git("commit", "-qm", "fixture: initial commit");

  const out = join(tempDir("out"), "evidence");
  const result = runCli(["verify", "--repo", repo, "--out", out]);
  assert.equal(result.code, 0, result.stderr);
  // ev-01 is `lint` (exit 7), ev-02 is `tests` (exit 0) — discovery order is typecheck, lint, test.
  return out;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const transcript = (dir, rel) => readFileSync(join(dir, rel), "utf8");

/** Rewrite a transcript and re-bind its digest — the attacker who does their homework. */
function rewriteTranscript(dir, item, text) {
  const evidence = readJson(dir, `evidence/${item}.json`);
  writeFileSync(join(dir, evidence.transcript), text);
  evidence.transcript_sha256 = sha256(text);
  writeJson(dir, `evidence/${item}.json`, evidence);
}

test("every evidence item that cites a transcript binds its digest and a producer trailer", () => {
  const dir = verifiedPackage();

  const evidence = ["ev-01", "ev-02", "ev-03", "ev-04", "ev-05"].map((id) =>
    readJson(dir, `evidence/${id}.json`),
  );
  const cited = evidence.filter((e) => e.transcript);
  assert.ok(cited.length >= 3);
  for (const item of cited) {
    assert.match(item.transcript_sha256 ?? "", /^[0-9a-f]{64}$/, item.id);
    assert.equal(item.transcript_sha256, sha256(transcript(dir, item.transcript)), item.id);
  }
  for (const item of cited.filter((e) => ["checks", "security", "browser"].includes(e.stage))) {
    assert.match(transcript(dir, item.transcript).trimEnd(), /--- orqon exit:(\d+|none) ---$/);
  }
  assert.match(transcript(dir, readJson(dir, "evidence/ev-01.json").transcript), /exit:7 ---/);

  const result = runCli(["verify-package", dir]);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /integrity: ok/);
});

test("flipping an evidence status while leaving the transcript is caught", () => {
  const dir = verifiedPackage();
  const evidence = readJson(dir, "evidence/ev-01.json");
  evidence.status = "passed";
  writeJson(dir, "evidence/ev-01.json", evidence);
  runCli(["seal", dir]);

  const result = runCli(["verify-package", dir]);

  assert.equal(result.code, 3);
  assert.match(result.stdout, /ev-01: transcript records exit 7 but the status is "passed"/);
});

test("a fully consistent rewrite of the evidence and verdict is still caught by the transcript", () => {
  // Test-report scenario T3.10: before the binding, this rewrite re-sealed to `integrity: ok`
  // with a PASS verdict while the retained transcript plainly showed exit 7.
  const dir = verifiedPackage();
  const evidence = readJson(dir, "evidence/ev-01.json");
  evidence.status = "passed";
  evidence.producer.exit_code = 0;
  delete evidence.findings;
  writeJson(dir, "evidence/ev-01.json", evidence);
  const verdict = readJson(dir, "verdict.json");
  verdict.verdict = "pass";
  verdict.blocking_findings = [];
  verdict.evidence_counts = { passed: 2, skipped: 3 };
  writeJson(dir, "verdict.json", verdict);
  runCli(["seal", dir]);

  const result = runCli(["verify-package", dir]);

  assert.equal(result.code, 3);
  assert.match(result.stdout, /transcript evidence\/ev-01-lint\.log records exit 7 but ev-01 records exit 0/);
});

test("swapping two transcripts breaks both bindings even after a reseal", () => {
  const dir = verifiedPackage();
  const [a, b] = ["ev-01", "ev-02"].map((id) => readJson(dir, `evidence/${id}.json`).transcript);
  const [textA, textB] = [transcript(dir, a), transcript(dir, b)];
  writeFileSync(join(dir, a), textB);
  writeFileSync(join(dir, b), textA);
  runCli(["seal", dir]);

  const result = runCli(["verify-package", dir]);

  assert.equal(result.code, 3);
  assert.match(result.stdout, /transcript digest mismatch: ev-01 does not match/);
  assert.match(result.stdout, /transcript digest mismatch: ev-02 does not match/);
});

test("editing a trailer to claim a different exit code is caught even with the digest re-bound", () => {
  const dir = verifiedPackage();
  rewriteTranscript(dir, "ev-01", transcript(dir, "evidence/ev-01-lint.log").replace("exit:7", "exit:0"));
  runCli(["seal", dir]);

  const result = runCli(["verify-package", dir]);

  assert.equal(result.code, 3);
  assert.match(result.stdout, /records exit 0 but ev-01 records exit 7/);
  assert.match(result.stdout, /ev-01: transcript records exit 0 but the status is "failed"/);
});

test("a trailer whose exit code contradicts the status alone is incoherent", () => {
  const dir = verifiedPackage();
  // No producer to compare against — status coherence has to carry the check on its own.
  const evidence = readJson(dir, "evidence/ev-01.json");
  delete evidence.producer;
  writeJson(dir, "evidence/ev-01.json", evidence);
  rewriteTranscript(dir, "ev-01", "$ npm run --silent lint\n--- orqon exit:0 ---\n");
  runCli(["seal", dir]);

  const result = runCli(["verify-package", dir]);

  assert.equal(result.code, 3);
  assert.match(result.stdout, /ev-01: transcript records exit 0 but the status is "failed"/);
});

test("stripping the trailer, or the digest, is itself an integrity failure", () => {
  const stripped = verifiedPackage();
  rewriteTranscript(stripped, "ev-01", "$ npm run --silent lint\n1 error\n");
  runCli(["seal", stripped]);
  const withoutTrailer = runCli(["verify-package", stripped]);

  const unbound = verifiedPackage();
  const evidence = readJson(unbound, "evidence/ev-01.json");
  delete evidence.transcript_sha256;
  writeJson(unbound, "evidence/ev-01.json", evidence);
  runCli(["seal", unbound]);
  const withoutDigest = runCli(["verify-package", unbound]);

  assert.equal(withoutTrailer.code, 3);
  assert.match(withoutTrailer.stdout, /ends with no windkeel exit trailer/);
  assert.equal(withoutDigest.code, 3);
  assert.match(withoutDigest.stdout, /evidence ev-01 does not bind its transcript/);
});

test("a package produced before the bindings existed still verifies", () => {
  const dir = fixtureCopy("failing-package");
  assert.equal(readJson(dir, "manifest.json").tool.version, "0.1.0");

  const result = runCli(["verify-package", dir]);

  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /integrity: ok/);
});

test("an older package that does carry a digest is still checked against it", () => {
  const dir = fixtureCopy("failing-package");
  const evidence = readJson(dir, "evidence/ev-01.json");
  evidence.transcript_sha256 = sha256("a transcript this package does not contain");
  writeJson(dir, "evidence/ev-01.json", evidence);
  runCli(["seal", dir]);

  const result = runCli(["verify-package", dir]);

  assert.equal(result.code, 3);
  assert.match(result.stdout, /transcript digest mismatch: ev-01/);
});
