/**
 * scripts/skip-budget.mjs: a skipped test passes, so CI fails on any skip whose reason the budget
 * does not list. These hold the script to that, and the workflow to running it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "./helpers.js";

const script = join(repoRoot, "scripts", "skip-budget.mjs");
const dir = mkdtempSync(join(tmpdir(), "skip-budget-"));

function run(tap, budget) {
  const tapPath = join(dir, `${Math.random()}.tap`);
  writeFileSync(tapPath, tap);
  const args = [script, tapPath];
  if (budget) {
    const budgetPath = join(dir, `${Math.random()}.json`);
    writeFileSync(budgetPath, JSON.stringify(budget));
    args.push(budgetPath);
  }
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

const budget = [{ reason: "KEY not set", max: 1 }];

test("a skip the budget allows passes", () => {
  assert.equal(run("# tests 2\nok 1 - a\nok 2 - b # SKIP KEY not set\n", budget).status, 0);
});

test("a skip for an unlisted reason fails", () => {
  const r = run("# tests 1\n  ok 1 - a # SKIP TEST_DATABASE_URL not set\n", budget);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not allowed: "a"/);
});

test("a skipped test reported as not ok still counts", () => {
  const r = run("# tests 1\nnot ok 1 - skipped and threw # SKIP unexpected reason\n", budget);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not allowed: "skipped and threw"/);
});

test("more skips than the budget allows fails", () => {
  const r = run("# tests 2\nok 1 - a # SKIP KEY not set\nok 2 - b # SKIP KEY not set\n", budget);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /over budget/);
});

test("with no budget, any skip fails", () => {
  assert.equal(run("# tests 1\nok 1 - a # SKIP KEY not set\n").status, 1);
});

test("a run with no tests fails", () => {
  assert.equal(run("").status, 1);
});

test("ci.yml checks the skip budget in both test jobs", () => {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /run: npm run test:skip-budget/);
  assert.match(workflow, /run: node scripts\/skip-budget\.mjs sandbox-results\.tap\s*$/m);
});
