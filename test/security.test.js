import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureRepo, readJson, runCli, tempDir } from "./helpers.js";

const SCRIPTS = { test: "node -e \"console.log('ok')\"" };

function scan(scanners, flags = []) {
  const script = join(tempDir("scan"), "scanners.json");
  writeFileSync(script, JSON.stringify(scanners));
  const out = join(tempDir("out"), "evidence");
  const result = runCli(["verify", "--repo", fixtureRepo(SCRIPTS), "--out", out, ...flags], {
    env: { WINDKEEL_FAKE_SECURITY: script },
  });
  return { out, result, evidence: readJson(out, "evidence/ev-03.json") };
}

const CLEAN = [
  { tool: "gitleaks", ran: true, note: "0 secret(s) detected" },
  { tool: "osv-scanner", ran: true, note: "0 advisory match(es)" },
  { tool: "semgrep", ran: true, note: "0 rule match(es)" },
];

test("clean scanners produce passing security evidence and a pass verdict", () => {
  const { out, result, evidence } = scan(CLEAN);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(evidence.stage, "security");
  assert.equal(evidence.status, "passed");
  assert.deepEqual(
    evidence.scanners.map((s) => s.tool),
    ["gitleaks", "osv-scanner", "semgrep"],
  );
  assert.equal(readJson(out, "verdict.json").verdict, "pass");
});

test("a committed secret is blocking and fails the gate", () => {
  const { result, evidence } = scan(
    [
      {
        tool: "gitleaks",
        ran: true,
        note: "1 secret(s) detected",
        findings: [
          {
            id: "SEC-SECRET-1",
            severity: "blocking",
            category: "secret",
            claim: "aws-access-key committed to the repository",
            location: "src/config.ts:12",
            failure_scenario: "the credential must be rotated, not just removed",
          },
        ],
      },
      ...CLEAN.slice(1),
    ],
    ["--gate"],
  );

  assert.equal(result.code, 1);
  assert.equal(evidence.status, "completed_with_findings");
  assert.equal(evidence.findings[0].severity, "blocking");
});

test("a low-severity advisory warns instead of blocking", () => {
  const { out, result, evidence } = scan([
    ...CLEAN.slice(0, 1),
    {
      tool: "osv-scanner",
      ran: true,
      note: "1 advisory match(es)",
      findings: [
        {
          id: "SEC-DEP-GHSA-x",
          severity: "non_blocking",
          category: "dependency",
          claim: "left-pad is affected by GHSA-x (LOW)",
          failure_scenario: "an attacker exploits GHSA-x",
        },
      ],
    },
    ...CLEAN.slice(2),
  ]);

  assert.equal(result.code, 0);
  assert.equal(evidence.findings.length, 1);
  assert.equal(readJson(out, "verdict.json").verdict, "warn");
});

test("a scanner that is not installed is named, not silently dropped", () => {
  const { out, evidence } = scan([
    ...CLEAN.slice(0, 2),
    { tool: "semgrep", ran: false, note: "semgrep is not installed on this runner" },
  ]);

  assert.equal(evidence.status, "warning");
  assert.match(evidence.summary, /not run: semgrep \(semgrep is not installed/);
  // A missing scanner is a warning, never a pass — the check did not happen.
  assert.equal(readJson(out, "verdict.json").verdict, "warn");
});

/**
 * The boundary corpus cases 06 and 07 stand on: the same advisory, on a runtime dependency
 * and on a dev-only one, has to reach opposite verdicts — otherwise the dev-only control is
 * either a false positive or the runtime case is not really blocking.
 */
test("the same advisory blocks as a runtime dependency and only warns as a dev-only one", () => {
  const advisory = (severity, note) => [
    ...CLEAN.slice(0, 1),
    {
      tool: "osv-scanner",
      ran: true,
      note: "1 advisory match(es)",
      findings: [
        {
          id: "SEC-DEP-GHSA-test",
          severity,
          category: "dependency",
          claim: `left-pad is affected by GHSA-test (HIGH): ${note}`,
          location: "package-lock.json",
          failure_scenario: "an attacker exploits GHSA-test",
        },
      ],
    },
    ...CLEAN.slice(2),
  ];

  const runtime = scan(advisory("blocking", "shipped at runtime"), ["--gate"]);
  const devOnly = scan(advisory("non_blocking", "development dependency only"), ["--gate"]);

  assert.equal(runtime.result.code, 1);
  assert.equal(readJson(runtime.out, "verdict.json").verdict, "fail");
  assert.equal(runtime.evidence.findings[0].severity, "blocking");

  assert.equal(devOnly.result.code, 0, devOnly.result.stderr);
  assert.equal(readJson(devOnly.out, "verdict.json").verdict, "warn");
  assert.equal(devOnly.evidence.findings[0].severity, "non_blocking");
});

test("with no scanner available the stage is skipped with the reason", () => {
  const { evidence } = scan([
    { tool: "gitleaks", ran: false, note: "not installed" },
    { tool: "osv-scanner", ran: false, note: "not installed" },
    { tool: "semgrep", ran: false, note: "not installed" },
  ]);

  assert.equal(evidence.status, "skipped");
  assert.match(evidence.reason, /^no_scanner_available — gitleaks, osv-scanner, semgrep/);
});
