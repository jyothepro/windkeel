import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evidenceItemsFromPackage, evidenceItemsOf, stageResults } from "../dist/factory/stage-results.js";

function packageWith(items, mapping) {
  const dir = mkdtempSync(join(tmpdir(), "windkeel-stages-"));
  mkdirSync(join(dir, "evidence"));
  items.forEach((item, i) => writeFileSync(join(dir, "evidence", `ev-0${i + 1}.json`), JSON.stringify(item)));
  if (mapping) writeFileSync(join(dir, "mapping.json"), JSON.stringify(mapping));
  return dir;
}

test("stage results are read from the package's evidence items, most serious status winning (G3)", () => {
  const dir = packageWith([
    { id: "ev-01", stage: "checks", type: "command", status: "passed", summary: "npm run lint" },
    { id: "ev-02", stage: "checks", type: "command", status: "failed", summary: "npm test exited 1" },
    { id: "ev-03", stage: "review", type: "model_review", status: "completed_with_findings" },
    { id: "ev-04", stage: "browser", type: "browser_qa", status: "skipped", reason: "no flows configured" },
  ]);
  const stages = stageResults(evidenceItemsFromPackage(dir));
  assert.deepEqual(
    stages.map((s) => [s.stage, s.status, s.items.length]),
    [
      ["checks", "failed", 2],
      ["review", "completed_with_findings", 1],
      ["browser", "skipped", 1],
    ],
    "pipeline order; a stage with no item is absent rather than invented",
  );
  assert.equal(stages[2].items[0].summary, "no flows configured", "a skip's reason stands in for its summary");
});

test("an item that isn't a stage or a status the package defines is left out", () => {
  const dir = packageWith([
    { id: "ev-01", stage: "deploy", type: "x", status: "passed" },
    { id: "ev-02", stage: "checks", type: "x", status: "mostly_passed" },
  ]);
  assert.deepEqual(evidenceItemsFromPackage(dir), []);
});

test("a row written before stage results existed reads as none, not as an empty pass", () => {
  assert.equal(evidenceItemsOf({ blocking: [], signed: true }), null);
  assert.equal(evidenceItemsOf(null), null);
  assert.deepEqual(evidenceItemsOf({ evidence: [] }), []);
});

test("a package with no evidence directory has no items", () => {
  assert.deepEqual(evidenceItemsFromPackage(mkdtempSync(join(tmpdir(), "windkeel-stages-"))), []);
});

test("the criteria stage comes from mapping.json, which is where it records its result", () => {
  const stageOf = (mapping) => stageResults(evidenceItemsFromPackage(packageWith([], mapping))).find((s) => s.stage === "intent");
  const met = stageOf({ status: "completed", mappings: [{ status: "satisfied" }, { status: "satisfied" }] });
  assert.equal(met.status, "passed");
  assert.equal(met.items[0].summary, "2 of 2 criteria met");
  assert.equal(stageOf({ status: "completed", mappings: [{ status: "satisfied" }, { status: "unknown" }] }).status, "warning", "unknown warns");
  assert.equal(stageOf({ status: "completed", mappings: [{ status: "unsatisfied" }, { status: "unknown" }] }).status, "failed");
  assert.equal(stageOf({ status: "skipped", reason: "no criteria", mappings: [] }).status, "skipped");
  assert.equal(stageOf(undefined), undefined, "no mapping file, no criteria stage");
});
