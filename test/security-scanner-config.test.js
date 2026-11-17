/**
 * ORQ-16: **the change under review does not get to configure the scanners that judge it.**
 *
 * gitleaks, osv-scanner and semgrep each read configuration or ignore files from the tree they
 * scan by default — `.gitleaks.toml` and `.gitleaksignore`, `osv-scanner.toml`'s
 * `[[IgnoredVulns]]`, `.semgrepignore` — and in the Gate that tree is the candidate's head. A
 * change that adds a credential, a vulnerable dependency or an ERROR-rule match beside the file
 * that suppresses it used to scan clean.
 *
 * The real-tool tests plant exactly that and are gated per scanner, as
 * `security-planted-secret.test.js` is: CI's image carries none of the three, and a test that
 * passed without the tool would prove nothing. The argv test below always runs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LocalExecutionEnvironment } from "@windkeel/verification/exec/local.js";
import { scannerAssets } from "@windkeel/verification/stages/scanner-assets.js";
import { runSecurity } from "@windkeel/verification/stages/security.js";
import { tempDir } from "./helpers.js";

const has = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" }).status === 0;
const skipUnless = (tool, args) => (has(tool, args) ? false : `${tool} is not installed on this runner`);

/** A committed fixture repository: `files` is `{ path: content }`, every one of them committed. */
function committedRepo(name, files) {
  const dir = tempDir(name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture Author");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  return dir;
}

const scannerFor = (evidence, tool) => evidence.scanners.find((s) => s.tool === tool);

test(
  "gitleaks: a .gitleaks.toml and .gitleaksignore in the candidate do not hide its secret",
  { skip: skipUnless("gitleaks", ["version"]) },
  async () => {
    // A ruleset with no rules, and the leak's own fingerprint on the ignore list — each alone was
    // enough to turn the scan clean.
    const repo = committedRepo("gl-suppressed", {
      "config.js": 'export const aws = { accessKeyId: "AKIAIMNOJVGFDXXXE4OA" };\n',
      ".gitleaks.toml": 'title = "nothing to see"\n',
    });
    const fingerprint = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    const ignore = `${fingerprint}:config.js:aws-access-token:1\n`;
    writeFileSync(join(repo, ".gitleaksignore"), ignore);
    spawnSync("git", ["add", "-A"], { cwd: repo });
    spawnSync("git", ["commit", "-qm", "ignore it"], { cwd: repo });
    // And where a repository check running candidate code could write it before this stage runs.
    writeFileSync(join(repo, ".git", ".gitleaksignore"), ignore);

    const { evidence } = await runSecurity(new LocalExecutionEnvironment(), "ev-03", repo);

    assert.equal(scannerFor(evidence, "gitleaks").ran, true);
    assert.match(scannerFor(evidence, "gitleaks").note, /1 secret\(s\) detected/);
    assert.ok(evidence.findings.some((f) => f.category === "secret" && /config\.js/.test(f.location)));
  },
);

test(
  "osv-scanner: an osv-scanner.toml in the candidate cannot ignore its own advisories",
  { skip: skipUnless("osv-scanner", ["--version"]) },
  async () => {
    // lodash 4.17.15 carries GHSA-35jh-r3h4-6jhm (HIGH), among others.
    const lock = {
      name: "f",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "f", version: "1.0.0", dependencies: { lodash: "4.17.15" } },
        "node_modules/lodash": { version: "4.17.15" },
      },
    };
    const repo = committedRepo("osv-suppressed", {
      "package-lock.json": JSON.stringify(lock),
      "osv-scanner.toml": '[[IgnoredVulns]]\nid = "GHSA-35jh-r3h4-6jhm"\nreason = "trust me"\n',
    });

    const { evidence } = await runSecurity(new LocalExecutionEnvironment(), "ev-03", repo);

    assert.equal(scannerFor(evidence, "osv-scanner").ran, true, scannerFor(evidence, "osv-scanner").note);
    assert.ok(
      evidence.findings.some((f) => f.id === "SEC-DEP-GHSA-35jh-r3h4-6jhm"),
      "the ignored advisory is still reported",
    );
  },
);

test(
  "semgrep: a .semgrepignore in the candidate does not hide its match, and the default ignores still apply",
  { skip: skipUnless("semgrep", ["--version"]) },
  async () => {
    const repo = committedRepo("sg-suppressed", {
      "src/a.js": "eval(userInput);\n",
      // Ignored by semgrep's built-in default list, as it was before: the fix must not widen the scan.
      "tests/t.js": "eval(fixture);\n",
      ".semgrepignore": "src/a.js\n",
    });
    // Local rules in place of the pre-fetched `p/ci`, so the scan needs no network.
    const assetDir = tempDir("sg-assets");
    const assets = scannerAssets(assetDir);
    writeFileSync(
      assets.semgrepRules,
      "rules:\n- id: no-eval\n  pattern: eval(...)\n  message: eval of untrusted input\n  languages: [javascript]\n  severity: ERROR\n",
    );

    const { evidence } = await runSecurity(new LocalExecutionEnvironment(), "ev-03", repo, undefined, assets);

    assert.equal(scannerFor(evidence, "semgrep").ran, true, scannerFor(evidence, "semgrep").note);
    const locations = evidence.findings.filter((f) => f.category === "dangerous-pattern").map((f) => f.location);
    assert.deepEqual(locations, ["src/a.js:1"]);
  },
);

test("every scanner is pointed at Gate-owned configuration, never at a file in the scanned tree", async () => {
  const calls = [];
  const written = {};
  const env = {
    async exec(command, options = {}) {
      calls.push({ command, args: options.args ?? [], env: options.env ?? {} });
      if (command === "git") return { status: 0, signal: null, stdout: "/repo/.git\n", stderr: "" };
      const probe = options.args?.[0] === "--version" || options.args?.[0] === "version";
      if (probe) return { status: 0, signal: null, stdout: "1.0.0", stderr: "" };
      if (command === "gitleaks") written[options.args.at(-1)] = "[]";
      return { status: 0, signal: null, stdout: JSON.stringify({ results: [] }), stderr: "" };
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
      return `/tmp/${prefix}gate`;
    },
  };
  const scan = (command) => calls.filter((c) => c.command === command && !["--version", "version"].includes(c.args[0]));
  const flag = (args, name) => args[args.indexOf(name) + 1];

  await runSecurity(env, "ev-03", "/repo");
  await runSecurity(env, "ev-04", "/repo");

  const [gitleaks] = scan("gitleaks");
  // A fresh Gate-owned directory, not the checkout or its `.git/`, which the repository's checks
  // (candidate code) have had a chance to write into; `GIT_DIR` names the history to read.
  assert.equal(flag(gitleaks.args, "--source"), "/tmp/windkeel-gitleaks-gate");
  assert.equal(gitleaks.env.GIT_DIR, "/repo/.git");
  assert.match(written[flag(gitleaks.args, "--config")], /useDefault = true/);
  assert.equal(written[flag(gitleaks.args, "--gitleaks-ignore-path")], "");
  assert.ok(!flag(gitleaks.args, "--config").startsWith("/repo"));

  const [osv] = scan("osv-scanner");
  assert.equal(written[flag(osv.args, "--config")], "");
  assert.ok(!flag(osv.args, "--config").startsWith("/repo"));

  const [first, second] = scan("semgrep").map((c) => flag(c.args, "--x-semgrepignore-filename"));
  assert.match(first, /^\.windkeel-semgrepignore-[0-9a-f]{24}$/);
  assert.notEqual(first, second, "a fresh name per scan, so no tree can carry one in advance");
});
