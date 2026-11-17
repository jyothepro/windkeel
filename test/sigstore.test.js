import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { canSignKeyless, verifySignature } from "@windkeel/verification/attest/sigstore.js";
import { fixtureRepo, runCli, tempDir } from "./helpers.js";

const cosignInstalled = () =>
  spawnSync("cosign", ["version"], { encoding: "utf8" }).status === 0;

const SCRIPTS = { test: "node -e \"console.log('ok')\"" };

function packagedRun() {
  const out = join(tempDir("out"), "evidence");
  runCli(["verify", "--repo", fixtureRepo(SCRIPTS), "--out", out]);
  return out;
}

test("a local run without an OIDC identity is honestly unsigned", () => {
  const out = join(tempDir("out"), "evidence");
  const result = runCli(["verify", "--repo", fixtureRepo(SCRIPTS), "--out", out]);

  assert.match(result.stdout, /signature: unsigned — no ambient OIDC identity/);
  assert.match(runCli(["verify-package", out]).stdout, /signature: unsigned \(no Sigstore bundle\)/);
});

test("keyless signing is attempted exactly when an ambient OIDC token exists", () => {
  assert.equal(canSignKeyless({}), false);
  assert.equal(canSignKeyless({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" }), true);
  assert.equal(canSignKeyless({ SIGSTORE_ID_TOKEN: "t" }), true);
});

test("an unverifiable Sigstore bundle is an integrity failure, not a pass", () => {
  const out = packagedRun();
  writeFileSync(join(out, "attestation/bundle.sigstore.json"), '{"not":"a bundle"}');

  const result = runCli([
    "verify-package",
    out,
    "--certificate-identity",
    "https://github.com/jyothepro/windkeel/.*",
    "--certificate-oidc-issuer",
    "https://token.actions.githubusercontent.com",
  ]);

  // Either outcome is correct, but neither may read as verified: where cosign exists the
  // garbage bundle must fail the package, and where it does not the report must say the
  // signature went unchecked.
  if (cosignInstalled()) {
    assert.equal(result.code, 3);
    assert.match(result.stdout, /Sigstore verification failed/);
  } else {
    assert.equal(result.code, 0);
    assert.match(result.stdout, /signature: signed, but cosign is not installed/);
  }
});

test("a signed package with no expected signer says the signature was not checked", () => {
  const out = packagedRun();
  writeFileSync(join(out, "attestation/bundle.sigstore.json"), "{}");

  const report = verifySignature(out, undefined, undefined);

  assert.equal(report.inconclusive, true);
  assert.match(report.detail, /no expected signer given/);
});
