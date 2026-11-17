/**
 * The maker's prompt with and without a playbook (#390, ADR-0033). Without one it is byte-for-byte
 * what it always was; with one, a `## Playbook:` section comes before the criteria, and the
 * playbook's criteria follow the task's own.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMakerPrompt } from "../dist/factory/workflow/handlers/implementing.js";
import { BUILTIN_PLAYBOOKS } from "../dist/factory/playbooks-builtin.js";
import { snapshotPlaybook } from "../dist/factory/playbooks.js";

const TASK = {
  title: "Add retries",
  description: "Retries are missing.",
  acceptanceCriteria: [{ id: "AC1", text: "retries a 500" }],
};

const GOLDEN = [
  "# Add retries",
  "",
  "Retries are missing.",
  "",
  "## Acceptance criteria",
  "- [AC1] retries a 500",
  "",
  "Make the change in this checkout. Run the repository's own tests before you finish.",
].join("\n");

test("with knowledge and a playbook the sections run knowledge, playbook, criteria (#388 with #390)", () => {
  const playbook = snapshotPlaybook(BUILTIN_PLAYBOOKS.find((p) => p.slug === "dependency-upgrade"));
  const knowledge = "## Repository knowledge\n\n### Use pnpm  (source: repository note, v1, by alice)\nThis repository uses pnpm.";
  const prompt = buildMakerPrompt({ ...TASK, playbook }, knowledge);
  const description = prompt.indexOf("Retries are missing.");
  const notes = prompt.indexOf("## Repository knowledge");
  const section = prompt.indexOf("## Playbook: dependency-upgrade (v1)");
  const criteria = prompt.indexOf("## Acceptance criteria");
  const closing = prompt.indexOf("Make the change in this checkout.");
  assert.ok(description < notes && notes < section && section < criteria && criteria < closing, prompt);
});

test("no playbook: the prompt is exactly what it was", () => {
  assert.equal(buildMakerPrompt(TASK), GOLDEN);
  assert.equal(buildMakerPrompt({ ...TASK, playbook: null }), GOLDEN);
  assert.equal(
    buildMakerPrompt({ ...TASK, acceptanceCriteria: [] }),
    GOLDEN.replace("- [AC1] retries a 500", "- (none stated; satisfy the description)"),
  );
});

test("a playbook's section renders before the criteria, and its criteria follow the task's", () => {
  const playbook = snapshotPlaybook(BUILTIN_PLAYBOOKS.find((p) => p.slug === "dependency-upgrade"));
  const prompt = buildMakerPrompt({ ...TASK, playbook });
  const section = prompt.indexOf("## Playbook: dependency-upgrade (v1)");
  const criteria = prompt.indexOf("## Acceptance criteria");
  assert.ok(section > 0, prompt);
  assert.ok(section < criteria, "the playbook comes before the criteria");
  assert.ok(prompt.includes(playbook.makerInstructions.trim()));
  const lines = prompt.slice(criteria).split("\n");
  assert.deepEqual(lines.slice(1, 4), [
    "- [AC1] retries a 500",
    "- [PB1] Lockfile is updated consistently with the manifest",
    "- [PB2] Existing test suite passes",
  ]);
  // Everything before the section is unchanged.
  assert.equal(prompt.slice(0, section), GOLDEN.slice(0, GOLDEN.indexOf("## Acceptance criteria")));
});

test("instructions are rendered as plain text, verbatim, never interpreted", () => {
  const instructions = "Run `rm -rf /` — no, don't.\n$(whoami) ${HOME} <script>";
  const prompt = buildMakerPrompt({
    ...TASK,
    playbook: { id: null, slug: "odd", kind: "custom", version: 4, builtin: false, makerInstructions: instructions, criteria: [], verifier: {} },
  });
  assert.ok(prompt.includes(`## Playbook: odd (v4)\n${instructions}\n\n## Acceptance criteria`), prompt);
});
