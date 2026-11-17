import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "./helpers.js";

const ADR_DIR = join(repoRoot, "docs", "adr");

// Superseded records move to docs/adr/archive/ and keep their number; README.md is the index.
function adrFiles() {
  const archive = join(ADR_DIR, "archive");
  const names = [...readdirSync(ADR_DIR), ...(existsSync(archive) ? readdirSync(archive) : [])];
  return names.filter((name) => name.endsWith(".md") && name !== "README.md").sort();
}

function adrPath(name) {
  const archived = join(ADR_DIR, "archive", name);
  return existsSync(archived) ? archived : join(ADR_DIR, name);
}

/**
 * A decision record is deleted by deleting a file, which nothing else would notice —
 * the code built on the decision keeps working while the reasoning behind it vanishes.
 */
test("the ADR directory exists and is not empty", () => {
  assert.ok(existsSync(ADR_DIR), "docs/adr/ is missing");
  assert.ok(adrFiles().length > 0, "docs/adr/ contains no ADRs");
});

test("ADR filenames are numbered kebab-case markdown", () => {
  for (const name of adrFiles()) {
    assert.match(name, /^\d{4}-[a-z0-9][a-z0-9-]*\.md$/, `bad ADR filename: ${name}`);
  }
});

test("ADR numbers are sequential from 0001 with no duplicates", () => {
  const numbers = adrFiles().map((name) => Number(name.slice(0, 4)));
  const expected = numbers.map((_, i) => i + 1);
  assert.deepEqual(numbers, expected, `ADR numbering has gaps or duplicates: ${numbers.join(", ")}`);
});

test("every ADR has a matching title, a valid status, and the required sections", () => {
  for (const name of adrFiles()) {
    const body = readFileSync(adrPath(name), "utf8");
    const number = name.slice(0, 4);

    assert.match(body, new RegExp(`^# ADR-${number}: .+`), `${name}: title must start "# ADR-${number}: "`);
    assert.match(
      body,
      /^- Status: (Proposed|Accepted|Superseded by ADR-\d{4})(; amended by ADR-\d{4}( \(proposed\))?(, ADR-\d{4}( \(proposed\))?)*)?$/m,
      `${name}: missing or invalid "- Status:" line`,
    );
    for (const section of ["## Context", "## Decision", "## Consequences"]) {
      assert.ok(body.includes(`\n${section}\n`), `${name}: missing "${section}" section`);
    }
  }
});

test("the v1 tenancy decision (issue #54) is recorded, and superseded only by a recorded decision", () => {
  const name = adrFiles().find((f) => f.startsWith("0001-"));
  assert.ok(name, "ADR-0001 is missing");
  const body = readFileSync(adrPath(name), "utf8");

  // #394: invite-only self-serve signup supersedes the single-tenant shape. The superseding ADR
  // must exist and say so; single-tenant stays the default deployment shape.
  const status = body.match(/^- Status: (Accepted|Superseded by ADR-(\d{4}))(;.*)?$/m);
  assert.ok(status, "ADR-0001 is neither Accepted nor Superseded by a named ADR");
  if (status[2]) {
    const successor = adrFiles().find((f) => f.startsWith(`${status[2]}-`));
    assert.ok(successor, `ADR-0001 names ADR-${status[2]} as its successor, which does not exist`);
    const successorBody = readFileSync(adrPath(successor), "utf8");
    assert.match(successorBody, /Supersedes: \[ADR-0001\]/, `ADR-${status[2]} does not say it supersedes ADR-0001`);
    assert.match(successorBody, /WINDKEEL_SELF_SERVE_SIGNUP/, "the successor names the flag that keeps single-tenant the default");
  }
  assert.ok(body.includes("issues/54"), "ADR-0001 does not reference issue #54");
  assert.ok(body.includes("single-tenant"), "ADR-0001 does not record the single-tenant decision");
});

/**
 * ADR-0023 §1 fixed ingress's secret surface. M8-5 (#297) added `WINDKEEL_WEBHOOK_SIGNING_KEY` to it;
 * code holding a secret §1 does not name, with no amendment saying why, is the silent divergence
 * the ADR process exists to prevent.
 */
test("ADR-0023 records WINDKEEL_WEBHOOK_SIGNING_KEY as a permitted ingress secret, and why", () => {
  const name = adrFiles().find((f) => f.startsWith("0023-"));
  assert.ok(name, "ADR-0023 is missing");
  const body = readFileSync(adrPath(name), "utf8");
  const sections = body.split(/\n(?=#{2,3} )/);
  const amendment = sections.find(
    (s) => /^#{2,3} Amendment, 2026-09-25/.test(s) && s.includes("WINDKEEL_WEBHOOK_SIGNING_KEY"),
  );
  assert.ok(amendment, "no 2026-09-25 amendment names WINDKEEL_WEBHOOK_SIGNING_KEY");
  assert.match(amendment, /§1/, "the amendment does not say which section it bends");
  assert.match(amendment, /ADR-0014/, "the amendment does not give the seal-but-not-unseal reason");
  assert.match(amendment, /32 bytes/, "the amendment does not record the key-strength term");
});

test("ADR-0025 records Jira's webhook secret as a provider secret ingress holds (#310)", () => {
  const name = adrFiles().find((f) => f.startsWith("0025-"));
  assert.ok(name, "ADR-0025 is missing");
  const body = readFileSync(adrPath(name), "utf8");
  assert.match(body, /^#{2,3} Amendment, 2026-09-25 — Jira's webhook secret/m);
  assert.ok(body.includes("WINDKEEL_JIRA_WEBHOOK_SECRET"), "the variable is named");
  assert.ok(body.includes("0023-control-plane-api"), "ADR-0023 §1 is cross-referenced");
  assert.doesNotMatch(body, /secret\s+surface does not grow/, "the contradicted Consequence is amended");
});

/**
 * #288: captures are stored in the evidence bucket and were never pruned. ADR-0015's sweep now
 * prunes them too; the window, the anchor and the backfill-free behaviour must be on record.
 */
test("ADR-0015 records the capture retention window, its anchor, and what happens to older captures", () => {
  const name = adrFiles().find((f) => f.startsWith("0015-"));
  assert.ok(name, "ADR-0015 is missing");
  const body = readFileSync(adrPath(name), "utf8");
  const amendment = body
    .split(/\n(?=#{2,3} )/)
    .find((s) => /^#{2,3} Amendment, 2026-10-20/.test(s) && s.includes("issues/288"));
  assert.ok(amendment, "no 2026-10-20 amendment references #288");
  assert.match(amendment, /30 days/, "the amendment does not state the window");
  assert.match(amendment, /run_capture/, "the amendment does not name the anchor row");
  assert.match(amendment, /predate/, "the amendment does not say what happens to captures from before the row");
  assert.match(amendment, /Objects first/, "the amendment does not record the delete ordering");
});
