import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureRepo, readJson, runCli, tempDir } from "./helpers.js";

const SCRIPTS = { test: "node -e \"console.log('ok')\"" };

/** A "flow" is any command; the fixtures fake Playwright by writing the artifacts it would. */
function verifyWithFlows(flows, seedArtifacts = () => {}) {
  const repo = fixtureRepo(SCRIPTS);
  writeFileSync(join(repo, "windkeel.config.json"), JSON.stringify({ flows }, null, 2));
  seedArtifacts(repo);
  const out = join(tempDir("out"), "evidence");
  const result = runCli(["verify", "--repo", repo, "--out", out, "--gate"]);
  return { out, result, evidence: readJson(out, "evidence/ev-04.json") };
}

const writeArtifacts = (repo) => {
  mkdirSync(join(repo, "test-results"), { recursive: true });
  writeFileSync(join(repo, "test-results", "checkout.png"), Buffer.alloc(2048, 7));
  writeFileSync(join(repo, "test-results", "console.log"), "navigated to /checkout\n");
};

test("a repo declaring no flows skips browser QA with the reason", () => {
  const { evidence } = verifyWithFlows([]);

  assert.equal(evidence.stage, "browser");
  assert.equal(evidence.status, "skipped");
  assert.match(evidence.reason, /^no_flows_declared/);
});

test("a passing flow packages its artifacts with digests", () => {
  const { out, result, evidence } = verifyWithFlows(
    [{ name: "checkout", command: "node -e \"console.log('flow ok')\"" }],
    writeArtifacts,
  );

  assert.equal(result.code, 0, result.stdout);
  assert.equal(evidence.status, "passed");
  const png = evidence.artifacts.find((a) => a.path.endsWith("checkout.png"));
  assert.equal(png.bytes, 2048);
  assert.match(png.sha256, /^[0-9a-f]{64}$/);
  assert.equal(png.included, true);
  assert.ok(existsSync(join(out, png.path)));
  // Packaged artifacts are hashed like every other file, so tampering with a screenshot
  // is caught by verify-package.
  assert.ok(readJson(out, "hashes.json").files[png.path]);
});

test("a failing flow is a blocking finding and fails the gate", () => {
  const { result, evidence } = verifyWithFlows(
    [{ name: "checkout", command: "node -e \"process.exit(1)\"" }],
    writeArtifacts,
  );

  assert.equal(result.code, 1);
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.findings[0].severity, "blocking");
  assert.match(evidence.findings[0].claim, /"checkout" does not complete/);
});

test("console errors in a passing flow warn rather than block", () => {
  const { out, result, evidence } = verifyWithFlows([
    { name: "checkout", command: "node -e \"console.log('Uncaught TypeError: x is not a function')\"" },
  ]);

  assert.equal(result.code, 0);
  assert.equal(evidence.status, "completed_with_findings");
  assert.equal(evidence.findings[0].severity, "non_blocking");
  assert.equal(readJson(out, "verdict.json").verdict, "warn");
});

/**
 * The behaviour corpus cases 11 and 12 rest on. A screenshot the evidence vouches for by
 * digest is only evidence while that digest still matches — and re-`seal`ing the package
 * must not launder a doctored one, since sealing is not a signature.
 */
test("a doctored artifact fails verification, before and after a reseal", () => {
  const { out } = verifyWithFlows(
    [{ name: "checkout", command: "node -e \"console.log('flow ok')\"" }],
    writeArtifacts,
  );
  const png = readJson(out, "evidence/ev-04.json").artifacts.find((a) =>
    a.path.endsWith("checkout.png"),
  );
  writeFileSync(join(out, png.path), Buffer.alloc(2048, 9));

  const beforeSeal = runCli(["verify-package", out]);
  runCli(["seal", out]);
  const afterSeal = runCli(["verify-package", out]);

  assert.equal(beforeSeal.code, 3);
  assert.match(beforeSeal.stdout, /hash mismatch: evidence\/browser\/checkout\/checkout\.png/);
  assert.equal(afterSeal.code, 3);
  assert.match(
    afterSeal.stdout,
    /artifact digest mismatch: ev-04 does not match evidence\/browser\/checkout\/checkout\.png/,
  );
});

test("an artifact the package claims to carry but does not is an integrity failure", () => {
  const { out } = verifyWithFlows(
    [{ name: "checkout", command: "node -e \"console.log('flow ok')\"" }],
    writeArtifacts,
  );
  rmSync(join(out, "evidence/browser/checkout/checkout.png"));
  runCli(["seal", out]);

  const result = runCli(["verify-package", out]);

  assert.equal(result.code, 3);
  assert.match(result.stdout, /missing artifact evidence\/browser\/checkout\/checkout\.png/);
});

test("an artifact too large to carry is referenced by digest instead", () => {
  const { out, evidence } = verifyWithFlows(
    [{ name: "checkout", command: "node -e \"console.log('ok')\"" }],
    (repo) => {
      mkdirSync(join(repo, "test-results"), { recursive: true });
      writeFileSync(join(repo, "test-results", "trace.zip"), Buffer.alloc(6 * 1024 * 1024, 3));
    },
  );

  const trace = evidence.artifacts[0];
  assert.equal(trace.included, false);
  assert.equal(trace.bytes, 6 * 1024 * 1024);
  assert.match(trace.sha256, /^[0-9a-f]{64}$/);
  assert.equal(existsSync(join(out, trace.path)), false);
  assert.match(evidence.summary, /referenced by digest only/);
});

test("isSafeArtifactPath is exported, and is the rule the stage applies", async () => {
  const { isSafeArtifactPath } = await import("../packages/verification/dist/evidence/paths.js");
  for (const bad of ["../x", "/abs", "a\\b", "a//b", ".", "a/./b", "a/..", "", "a\u0000b"]) {
    assert.equal(isSafeArtifactPath(bad), false, JSON.stringify(bad));
  }
  for (const good of ["shots/a.png", "a.png", ".hidden/x.png"]) assert.equal(isSafeArtifactPath(good), true, good);
});
