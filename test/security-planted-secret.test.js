/**
 * The difference #219 is actually about: a package that reports no secrets because something
 * looked, versus one that reports no secrets because nothing did. From the outside they were
 * identical — and every evidence package produced so far is the second kind.
 *
 * So this drives the *real* scanner over a fixture repository with a planted credential, and over
 * one without. It proves the scanner ran, not merely that it was found on `PATH`.
 *
 * Gated on `gitleaks` being installed, because CI's image does not carry it — that is the whole
 * premise of the issue. Where it is absent the suite skips rather than passing vacuously, which is
 * the same distinction the stage itself now draws.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LocalExecutionEnvironment } from "@windkeel/verification/exec/local.js";
import { runSecurity } from "@windkeel/verification/stages/security.js";
import { tempDir } from "./helpers.js";

const GITLEAKS = spawnSync("gitleaks", ["version"], { encoding: "utf8" }).status === 0;
const skip = GITLEAKS ? false : "gitleaks is not installed on this runner";

/**
 * A committed AWS key, in the shape gitleaks' own `aws-access-token` rule matches. Planted in a
 * committed file, because gitleaks scans history: an uncommitted file proves nothing about what a
 * repository is carrying.
 */
function repoWithSecret({ planted }) {
  const dir = tempDir("planted");
  writeFileSync(
    join(dir, "config.js"),
    planted
      ? 'export const aws = { accessKeyId: "AKIAIMNOJVGFDXXXE4OA", region: "us-east-1" };\n'
      : 'export const aws = { accessKeyId: process.env.AWS_ACCESS_KEY_ID, region: "us-east-1" };\n',
  );
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture Author");
  git("add", "-A");
  git("commit", "-qm", "fixture: application config");
  return dir;
}

test("a planted secret is found, which is what proves the scanner ran", { skip }, async () => {
  const repo = repoWithSecret({ planted: true });

  const { evidence, transcript } = await runSecurity(new LocalExecutionEnvironment(), "ev-03", repo);

  const gitleaks = evidence.scanners.find((s) => s.tool === "gitleaks");
  assert.equal(gitleaks.ran, true);
  assert.match(gitleaks.note, /1 secret\(s\) detected/);
  const finding = evidence.findings.find((f) => f.category === "secret");
  assert.equal(finding.severity, "blocking");
  assert.match(finding.location, /config\.js/);
  // Redacted in the transcript: the evidence package must not become the second place the
  // credential is readable.
  assert.doesNotMatch(transcript, /AKIAIMNOJVGFDXXXE4OA/);
});

test("the same repo without the secret reports clean — and says who looked", { skip }, async () => {
  const repo = repoWithSecret({ planted: false });

  const { evidence } = await runSecurity(new LocalExecutionEnvironment(), "ev-03", repo);

  const gitleaks = evidence.scanners.find((s) => s.tool === "gitleaks");
  assert.equal(gitleaks.ran, true);
  assert.match(gitleaks.note, /0 secret\(s\) detected/);
  assert.equal((evidence.findings ?? []).filter((f) => f.category === "secret").length, 0);
  // The claim the package is now entitled to make: this section is empty because gitleaks ran.
  assert.match(evidence.summary, /gitleaks: 0 secret\(s\) detected/);
});
