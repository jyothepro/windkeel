import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "./helpers.js";

const CORPUS = join(repoRoot, "bench", "corpus");

export function corpusCases() {
  return readdirSync(CORPUS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(readFileSync(join(CORPUS, entry.name, "case.json"), "utf8")))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * A corpus case is deleted by deleting a directory, which no test would otherwise notice —
 * the scores would simply be computed over whatever is left and still read as 100%.
 */
test("every stage the gate can catch a defect in has at least one corpus case", () => {
  const cases = corpusCases();

  for (const stage of ["checks", "intent", "security", "review", "browser"]) {
    assert.ok(
      cases.some((c) => c.stage === stage),
      `no corpus case exercises the ${stage} stage`,
    );
  }
});

test("the corpus keeps clean controls, not only seeded defects", () => {
  const cases = corpusCases();

  const clean = cases.filter((c) => c.kind === "clean");
  assert.ok(clean.length >= 2, `only ${clean.length} clean control(s)`);
  for (const control of clean) assert.equal(control.expect, "pass", control.id);
});

test("each case declares the id of its own directory, the kind and the expectation", () => {
  const dirs = readdirSync(CORPUS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(
    corpusCases().map((c) => c.id),
    dirs,
  );
  for (const c of corpusCases()) {
    assert.ok(["seeded", "clean", "replay"].includes(c.kind), `${c.id}: kind ${c.kind}`);
    assert.ok(["pass", "fail"].includes(c.expect), `${c.id}: expect ${c.expect}`);
    assert.ok(c.defect, `${c.id}: no defect description`);
  }
});
