/**
 * ADR-0039: a dependency advisory already on the base revision is reported, not blocking; one the
 * change introduces still blocks; and a baseline that cannot be taken leaves everything blocking.
 *
 * content-machine#98's README edit was failed for a HIGH advisory in a `zod` that `main` already
 * shipped. Real git (and `git archive` for the base) runs over a real two-commit repository; only
 * osv-scanner is a double, reporting an advisory for each known-vulnerable package that appears in
 * the lockfile of the tree it is pointed at — which is the part of osv-scanner this logic relies on.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LocalExecutionEnvironment } from "@windkeel/verification/exec/local.js";
import { runSecurity } from "@windkeel/verification/stages/security.js";
import { tempDir } from "./helpers.js";

const VULNERABLE = {
  zod: { id: "GHSA-mrhx-c7xc-m3w5", severity: "HIGH", summary: "Zod can exhaust memory" },
  lodash: { id: "GHSA-35jh-r3h4-6jhm", severity: "HIGH", summary: "Command injection in lodash" },
};

/** Real everything, except an osv-scanner that reads the scanned tree's package-lock.json. */
class FakeOsvEnvironment extends LocalExecutionEnvironment {
  constructor() {
    super();
    this.scannedDirs = [];
  }
  async exec(command, options = {}) {
    if (command !== "osv-scanner") return super.exec(command, options);
    if (options.args?.[0] === "--version") return { status: 0, stdout: "osv-scanner 2.0.2", stderr: "", signal: null };
    this.scannedDirs.push(options.cwd);
    const lock = join(options.cwd, "package-lock.json");
    if (!existsSync(lock)) return { status: 128, stdout: "", stderr: "No package sources found", signal: null };
    const deps = Object.keys(JSON.parse(readFileSync(lock, "utf8")).packages ?? {}).map((p) => p.replace(/^node_modules\//, ""));
    const packages = deps
      .filter((name) => VULNERABLE[name])
      .map((name) => ({
        package: { name, ecosystem: "npm" },
        vulnerabilities: [{ id: VULNERABLE[name].id, summary: VULNERABLE[name].summary, database_specific: { severity: VULNERABLE[name].severity } }],
      }));
    const report = { results: packages.length ? [{ source: { path: lock }, packages }] : [] };
    return { status: packages.length ? 1 : 0, stdout: JSON.stringify(report), stderr: "", signal: null };
  }
}

const lockfile = (...names) =>
  JSON.stringify({ packages: Object.fromEntries(names.map((n) => [`node_modules/${n}`, { version: "1.0.0" }])) });

/** Base commit with `baseDeps`, head commit with `headDeps` and a README edit. */
function repoWith(baseDeps, headDeps) {
  const dir = tempDir("osv-baseline");
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture Author");
  writeFileSync(join(dir, "README.md"), "# readme\n");
  writeFileSync(join(dir, "package-lock.json"), lockfile(...baseDeps));
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(dir, "README.md"), "# readme\n\nCopy .env.example to .env.\n");
  writeFileSync(join(dir, "package-lock.json"), lockfile(...headDeps));
  git("add", "-A");
  git("commit", "-qm", "head");
  return { dir, base };
}

const depFindings = (evidence) => (evidence.findings ?? []).filter((f) => f.category === "dependency");
const osvNote = (evidence) => evidence.scanners.find((s) => s.tool === "osv-scanner")?.note ?? "";

test("an advisory the base already has is reported but does not block (content-machine#98)", async () => {
  const { dir, base } = repoWith(["zod"], ["zod"]);
  const env = new FakeOsvEnvironment();
  const { evidence } = await runSecurity(env, "ev-04", dir, undefined, undefined, base);
  const [zod, ...rest] = depFindings(evidence);
  assert.equal(rest.length, 0);
  assert.equal(zod.id, "SEC-DEP-GHSA-mrhx-c7xc-m3w5");
  assert.equal(zod.severity, "non_blocking");
  assert.match(zod.claim, /already present on the base revision/);
  assert.match(osvNote(evidence), /1 already on the base revision \(reported, not blocking\)/);
  assert.equal(env.scannedDirs.length, 2, "head, then the exported base");
  assert.notEqual(env.scannedDirs[1], dir, "the base is scanned from an export, not the checkout");
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout, "", "the checkout is untouched");
});

test("an advisory the change introduces still blocks, next to a pre-existing one that does not", async () => {
  const { dir, base } = repoWith(["zod"], ["zod", "lodash"]);
  const { evidence } = await runSecurity(new FakeOsvEnvironment(), "ev-04", dir, undefined, undefined, base);
  const byPkg = Object.fromEntries(depFindings(evidence).map((f) => [f.claim.split(" ")[0], f]));
  assert.equal(byPkg.lodash.severity, "blocking");
  assert.match(byPkg.lodash.failure_scenario, /as shipped by this change/);
  assert.equal(byPkg.zod.severity, "non_blocking");
});

test("no base revision: the baseline fails closed and says so", async () => {
  const { dir } = repoWith(["zod"], ["zod"]);
  const { evidence } = await runSecurity(new FakeOsvEnvironment(), "ev-04", dir, undefined, undefined, undefined);
  assert.equal(depFindings(evidence)[0].severity, "blocking");
  assert.match(osvNote(evidence), /baseline unavailable \(no base revision was given\)/);
});

test("a base revision that cannot be exported fails closed too", async () => {
  const { dir } = repoWith(["zod"], ["zod"]);
  const { evidence } = await runSecurity(new FakeOsvEnvironment(), "ev-04", dir, undefined, undefined, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(depFindings(evidence)[0].severity, "blocking");
  assert.match(osvNote(evidence), /baseline unavailable \(could not export 0123456789ab/);
});

test("nothing blocking at the head: the base is never scanned", async () => {
  const { dir, base } = repoWith([], []);
  const env = new FakeOsvEnvironment();
  await runSecurity(env, "ev-04", dir, undefined, undefined, base);
  assert.equal(env.scannedDirs.length, 1);
});
