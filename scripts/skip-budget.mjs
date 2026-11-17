#!/usr/bin/env node
// Skip budget. A skipped test passes, so a job whose tests all skip is green while testing nothing.
// This reads a node:test TAP file and fails if any test skipped for a reason the budget does not
// allow, or more often than it allows. With no budget file, no skip is allowed.
//
// Run: node scripts/skip-budget.mjs <results.tap> [budget.json]
// Budget: [{ "reason": "<substring of the skip reason>", "max": <count>, "why": "<note>" }]
import { readFileSync } from "node:fs";

const [tapPath, budgetPath] = process.argv.slice(2);
if (!tapPath) {
  console.error("usage: skip-budget.mjs <results.tap> [budget.json]");
  process.exit(2);
}

const tap = readFileSync(tapPath, "utf8");
const budget = budgetPath ? JSON.parse(readFileSync(budgetPath, "utf8")) : [];

const tests = Number(/^# tests (\d+)$/m.exec(tap)?.[1] ?? 0);
if (tests === 0) {
  console.error(`skip-budget: ${tapPath} reports no tests run`);
  process.exit(1);
}

const skips = [];
for (const line of tap.split("\n")) {
  const m = /^\s*(?:not )?ok \d+ - (.*?) # SKIP(?: (.*))?$/.exec(line);
  if (m) skips.push({ name: m[1], reason: m[2] ?? "" });
}

const used = budget.map(() => 0);
const failures = [];
for (const skip of skips) {
  const i = budget.findIndex((b) => skip.reason.includes(b.reason));
  if (i === -1) failures.push(`not allowed: "${skip.name}" (reason: ${skip.reason || "none given"})`);
  else used[i] += 1;
}
budget.forEach((b, i) => {
  if (used[i] > b.max) failures.push(`over budget: ${used[i]} skips for "${b.reason}" (max ${b.max})`);
});

console.log(`skip-budget: ${tests} tests, ${skips.length} skips (suites and subtests included)`);
budget.forEach((b, i) => {
  if (used[i] < b.max) console.log(`  note: "${b.reason}" used ${used[i]} of ${b.max}; lower its max`);
});
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
