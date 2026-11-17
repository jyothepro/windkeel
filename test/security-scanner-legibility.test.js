/**
 * #219's second question, which is the one that matters more: **does an evidence package that
 * reports no secrets now mean that something looked?**
 *
 * Two ways it did not. The scanners were never installed, so all three skipped on every run. And
 * a scanner that *was* present but could not reach its data parsed as zero findings — an
 * `osv-scanner` that could not reach `api.osv.dev` produced exactly the section a clean scan
 * produces. These tests pin both: what the stage runs once the install phase has left it what it
 * needs, and what it says when a scanner starts and cannot finish.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  scannerAssets,
} from "@windkeel/verification/stages/scanner-assets.js";
import { runSecurity } from "@windkeel/verification/stages/security.js";
import { runToolInstalls } from "@windkeel/verification/stages/environment.js";

/** An execution environment whose scanners are scripted, with `present` naming what is installed. */
function scannerEnv({ present = [], results = {}, files = {} } = {}) {
  const calls = [];
  const written = { ...files };
  return {
    calls,
    async exec(command, options = {}) {
      calls.push({ command, args: options.args ?? [] });
      if (!present.includes(command)) {
        return { status: 127, signal: null, stdout: "", stderr: "", error: `${command}: not found` };
      }
      const probe = options.args?.[0] === "--version" || options.args?.[0] === "version";
      if (probe) return { status: 0, signal: null, stdout: "1.0.0", stderr: "" };
      const scripted = results[command] ?? {};
      if (scripted.report) written[options.args.at(-1)] = scripted.report;
      return { status: 0, signal: null, stdout: "", stderr: "", ...scripted };
    },
    async exists(path) {
      return path in written;
    },
    async readFile(path) {
      return Buffer.from(written[path] ?? "");
    },
    async writeFile(path, data) {
      written[path] = String(data);
    },
    async listFiles() {
      return [];
    },
    async mkdtemp(prefix) {
      return `/tmp/${prefix}scan`;
    },
  };
}

const argsFor = (env, command) =>
  env.calls.filter((c) => c.command === command && !["--version", "version"].includes(c.args[0])).at(0)?.args;

/** A per-sandbox asset directory, exactly as `installScanners` would have produced it. */
const ASSETS = scannerAssets("/tmp/windkeel-scanners-abc123");

test("with nothing installed, every scanner still skips — the old behaviour, unchanged", async () => {
  const { evidence } = await runSecurity(scannerEnv(), "ev-03", "/repo");

  assert.equal(evidence.status, "skipped");
  assert.match(evidence.reason, /no_scanner_available/);
  assert.deepEqual(evidence.scanners.map((s) => s.ran), [false, false, false]);
});

test("once the scanners are installed the stage reports instead of skipping", async () => {
  const env = scannerEnv({
    present: ["gitleaks", "osv-scanner", "semgrep"],
    results: {
      gitleaks: { status: 1, report: JSON.stringify([{ RuleID: "aws-access-key", File: "src/config.ts", StartLine: 12 }]) },
      "osv-scanner": { stdout: JSON.stringify({ results: [] }) },
      semgrep: { stdout: JSON.stringify({ results: [] }) },
    },
  });

  const { evidence } = await runSecurity(env, "ev-03", "/repo");

  assert.equal(evidence.status, "completed_with_findings");
  assert.deepEqual(evidence.scanners.map((s) => [s.tool, s.ran]), [
    ["gitleaks", true],
    ["osv-scanner", true],
    ["semgrep", true],
  ]);
  // A committed credential is blocking whatever else the change does.
  assert.equal(evidence.findings[0].severity, "blocking");
  assert.match(evidence.findings[0].claim, /aws-access-key/);
});

test("a scanner that starts and cannot finish is reported as not run, with its own last words", async () => {
  const env = scannerEnv({
    present: ["gitleaks", "osv-scanner", "semgrep"],
    results: {
      gitleaks: { status: 0, report: "[]" },
      // The exact shape of a scanner that is installed and cannot reach its database.
      "osv-scanner": { status: 127, stderr: 'max retries exceeded: Post "https://api.osv.dev/v1/querybatch": Forbidden' },
      semgrep: { stdout: JSON.stringify({ results: [] }) },
    },
  });

  const { evidence } = await runSecurity(env, "ev-03", "/repo");

  const osv = evidence.scanners.find((s) => s.tool === "osv-scanner");
  assert.equal(osv.ran, false, "a scanner that could not complete must not count as a clean scan");
  assert.match(osv.note, /could not complete/);
  assert.match(osv.note, /api\.osv\.dev/);
  // The package says which check did not happen, instead of a quiet pass.
  assert.equal(evidence.status, "warning");
  assert.match(evidence.summary, /not run: osv-scanner/);
});

test("the install phase's offline assets are what the scan actually uses", async () => {
  const env = scannerEnv({
    present: ["gitleaks", "osv-scanner", "semgrep"],
    results: {
      gitleaks: { status: 0, report: "[]" },
      "osv-scanner": { stdout: JSON.stringify({ results: [] }) },
      semgrep: { stdout: JSON.stringify({ results: [] }) },
    },
    files: { [ASSETS.osvMarker]: "ready", [ASSETS.semgrepRules]: "rules: []" },
  });

  const { evidence } = await runSecurity(env, "ev-03", "/repo", undefined, ASSETS);

  // `--offline-vulnerabilities` is the difference between a local lookup and a request that
  // cannot leave the sandbox once egress has narrowed.
  // `--config` / `--x-semgrepignore-filename` are ORQ-16's: the Gate's configuration, not the tree's.
  assert.deepEqual(argsFor(env, "osv-scanner"), [
    "--offline-vulnerabilities",
    "--config",
    "/tmp/windkeel-osv-scan/osv-scanner.toml",
    "--format",
    "json",
    "-r",
    ".",
  ]);
  const semgrepArgs = argsFor(env, "semgrep");
  assert.match(semgrepArgs[semgrepArgs.length - 2], /^\.windkeel-semgrepignore-[0-9a-f]{24}$/);
  assert.deepEqual(semgrepArgs, [
    "--config",
    ASSETS.semgrepRules,
    "--json",
    "--quiet",
    "--metrics",
    "off",
    "--x-semgrepignore-filename",
    semgrepArgs[semgrepArgs.length - 2],
    ".",
  ]);
  assert.match(evidence.scanners.find((s) => s.tool === "osv-scanner").note, /local database/);
});

test("without those assets the scan falls back to the network forms, and says nothing false", async () => {
  const env = scannerEnv({
    present: ["osv-scanner", "semgrep"],
    results: {
      "osv-scanner": { stdout: JSON.stringify({ results: [] }) },
      semgrep: { stdout: JSON.stringify({ results: [] }) },
    },
  });

  await runSecurity(env, "ev-03", "/repo");

  assert.deepEqual(argsFor(env, "osv-scanner"), [
    "--config",
    "/tmp/windkeel-osv-scan/osv-scanner.toml",
    "--format",
    "json",
    "-r",
    ".",
  ]);
  assert.equal(argsFor(env, "semgrep")[1], "p/ci");
});

test("a tool the repo declared and the sandbox could not install is a blocking finding", () => {
  const { evidence } = runToolInstalls("ev-02", [
    { tool: "restic", source: "repository", status: "failed", detail: "dnf: No match for argument", durationMs: 1200 },
    { tool: "gitleaks", source: "engine", status: "installed", detail: "gitleaks 8.24.3", durationMs: 800 },
  ]);

  assert.equal(evidence.status, "failed");
  assert.equal(evidence.findings.length, 1);
  assert.equal(evidence.findings[0].id, "F-tool-restic");
  assert.equal(evidence.findings[0].severity, "blocking");
  // Never a silently skipped check: the verdict can say the check did not run, and why.
  assert.match(evidence.findings[0].claim, /No match for argument/);
  assert.match(evidence.summary, /repo-declared missing: restic/);
});

test("a scanner the verifier could not install is visible, and is the gate's problem not the candidate's", () => {
  const { evidence } = runToolInstalls("ev-02", [
    { tool: "semgrep", source: "engine", status: "failed", detail: "pip3 could not install semgrep", durationMs: 400 },
  ]);

  assert.equal(evidence.status, "warning");
  assert.equal(evidence.findings[0].severity, "non_blocking");
  assert.match(evidence.findings[0].failure_scenario, /rather than "nothing looked"/);
});

test("everything installed is evidence too, with the per-run cost it took", () => {
  const { evidence, transcript } = runToolInstalls("ev-02", [
    { tool: "restic", source: "repository", status: "installed", detail: "dnf installed restic", durationMs: 9000 },
    { tool: "gitleaks", source: "engine", status: "installed", detail: "gitleaks 8.24.3", durationMs: 1000 },
  ]);

  assert.equal(evidence.status, "passed");
  assert.equal(evidence.findings, undefined);
  assert.deepEqual(evidence.tools.map((t) => [t.tool, t.source, t.status]), [
    ["restic", "repository", "installed"],
    ["gitleaks", "engine", "installed"],
  ]);
  assert.match(evidence.summary, /10s spent installing/);
  assert.match(transcript, /repository: restic — installed \(9000ms\)/);
});
