import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureCopy, fixtureRepo, runCli, tempDir } from "./helpers.js";

const PASSING_SCRIPTS = { test: "node -e \"console.log('2 passing')\"" };

function verifyRepo(repo, extraArgs = []) {
  const out = join(tempDir("out"), "evidence");
  return { out, result: runCli(["verify", "--repo", repo, "--out", out, ...extraArgs]) };
}

// Zero-checks discovery lives in checks-discovery.test.js and transcript bindings live in
// transcript-binding.test.js. What is left here is the signing boundary: the bindings make a
// partial rewrite detectable, and only a signature says who produced the package at all.

test("--require-signature makes an unsigned package an integrity failure", () => {
  const repo = fixtureRepo(PASSING_SCRIPTS);
  const { out } = verifyRepo(repo);

  assert.equal(runCli(["verify-package", out]).code, 0);

  const result = runCli(["verify-package", out, "--require-signature"]);

  assert.equal(result.code, 3, result.stdout);
  assert.match(result.stdout, /--require-signature: unsigned/);
});

test("--require-signature rejects a signature that was never checked against a signer", () => {
  const dir = fixtureCopy("failing-package");
  writeFileSync(join(dir, "attestation", "bundle.sigstore.json"), "{}\n");
  assert.equal(runCli(["seal", dir, "--force"]).code, 0);

  const result = runCli(["verify-package", dir, "--require-signature"]);

  assert.equal(result.code, 3, result.stdout);
  assert.match(result.stdout, /--require-signature: signed, but/);
});

test("seal refuses to rewrite an attestation that an existing bundle signs", () => {
  const dir = fixtureCopy("failing-package");
  writeFileSync(join(dir, "attestation", "bundle.sigstore.json"), "{}\n");

  const result = runCli(["seal", dir]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /refusing to reseal/);
  assert.equal(runCli(["seal", dir, "--force"]).code, 0, "--force is the documented override");
});
