/**
 * ORQ-03: `ci.yml` runs the pull request's own code — `npm ci` lifecycle scripts, the typecheck,
 * the test suite — and the factory's maker opens same-repo pull requests whose package.json and
 * tests it wrote. Whatever secrets sit in that job's environment are the maker's to read. So no job
 * a `pull_request` runs may name a secret; the sandbox-backed tests that need the Vercel token run
 * in their own job, only on a push to main, with the secrets on the one step that needs them.
 *
 * Read as text, not parsed: the workflow is small, its layout is ours, and a YAML dependency for
 * one test is more surface than the check is worth.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "./helpers.js";

const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

/** Each job under `jobs:`, by name, as its text (two-space-indented keys start a job). */
function jobs(text) {
  const body = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length);
  const found = new Map();
  let name = null;
  for (const line of body.split("\n")) {
    const start = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (start) {
      name = start[1];
      found.set(name, "");
    } else if (name && /^\S/.test(line)) {
      name = null;
    } else if (name) {
      found.set(name, `${found.get(name)}${line}\n`);
    }
  }
  return found;
}

const PUSH_TO_MAIN = /^    if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\s*$/m;

test("ci.yml's workflow token is read-only", () => {
  assert.match(workflow, /^permissions:\n  contents: read\s*$/m);
});

test("no job a pull request runs names a repository secret (ORQ-03)", () => {
  const all = jobs(workflow);
  assert.ok(all.has("checks"), "the checks job is still there");
  assert.doesNotMatch(all.get("checks"), /secrets\./, "the PR-run job holds no secrets");
  for (const [name, text] of all) {
    if (!/secrets\./.test(text)) continue;
    assert.match(text, PUSH_TO_MAIN, `${name} names a secret, so it runs only on a push to main`);
    // Job-level env reaches every step, checkout and npm ci included; a secret goes on its step.
    const jobEnv = /^    env:\n((?: {6}.*\n)+)/m.exec(text);
    assert.doesNotMatch(jobEnv?.[1] ?? "", /secrets\./, `${name} keeps secrets off its job-level env`);
  }
});

test("checkouts in ci.yml do not persist credentials", () => {
  const steps = workflow.split(/^ {6}- /m).slice(1);
  const checkouts = steps.filter((step) => /^(?: {8})?uses: actions\/checkout@[^\s#]+/m.test(step));
  assert.ok(checkouts.length > 0);
  for (const step of checkouts) {
    const inputs = /^ {8}with:[ \t]*\n((?: {10,}[^\n]*\n?)*)/m.exec(step)?.[1] ?? "";
    assert.match(inputs, /^ {10}persist-credentials:[ \t]*false[ \t]*(?:#.*)?$/m);
  }
});
