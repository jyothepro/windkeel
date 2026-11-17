import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMakerPrompt } from "../dist/factory/workflow/handlers/implementing.js";
import { renderKnowledgeSection } from "../dist/factory/knowledge-render.js";

const TASK = {
  title: "Add a greeting",
  description: "Make index.js print hello.",
  acceptanceCriteria: [{ id: "ac-1", text: "index.js prints hello" }],
};

/** What `buildMakerPrompt` produced before knowledge existed, spelled out. */
const BEFORE = [
  "# Add a greeting",
  "",
  "Make index.js print hello.",
  "",
  "## Acceptance criteria",
  "- [ac-1] index.js prints hello",
  "",
  "Make the change in this checkout. Run the repository's own tests before you finish.",
].join("\n");

test("without knowledge the maker prompt is byte-identical to what it was before #388", () => {
  assert.equal(buildMakerPrompt(TASK), BEFORE);
  assert.equal(buildMakerPrompt(TASK, ""), BEFORE);
  assert.equal(buildMakerPrompt(TASK, undefined), BEFORE);
});

test("knowledge goes after the description and before the acceptance criteria (#388, #390: knowledge, playbook, criteria)", () => {
  const knowledge = renderKnowledgeSection([
    {
      noteId: "n1",
      noteVersion: 1,
      digestSha: null,
      sourceKind: "human",
      risk: null,
      title: "Use pnpm",
      body: "This repository uses pnpm workspaces.",
      provenance: "repository note, v1, by alice",
    },
  ]);
  const prompt = buildMakerPrompt(TASK, knowledge);
  const description = prompt.indexOf("Make index.js print hello.");
  const section = prompt.indexOf("## Repository knowledge");
  const criteria = prompt.indexOf("## Acceptance criteria");
  const closing = prompt.indexOf("Make the change in this checkout.");
  assert.ok(description < section && section < criteria && criteria < closing, "description, knowledge, criteria, then the instruction");
  assert.ok(prompt.includes("Make index.js print hello.\n\n## Repository knowledge\n"));
  assert.ok(prompt.includes("pnpm workspaces.\n\n## Acceptance criteria\n- [ac-1] index.js prints hello\n\nMake the change in this checkout."));
});
