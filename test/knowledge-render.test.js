import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KNOWLEDGE_HEADING,
  KNOWLEDGE_PREAMBLE,
  neutraliseBody,
  renderKnowledgeSection,
  safeTitle,
} from "../dist/factory/knowledge-render.js";

const entry = (overrides = {}) => ({
  noteId: "00000000-0000-4000-8000-000000000001",
  noteVersion: 3,
  digestSha: null,
  sourceKind: "human",
  risk: null,
  title: "Use pnpm",
  body: "This repository uses pnpm workspaces.",
  provenance: "repository note, v3, by alice",
  ...overrides,
});

test("renders the heading, the preamble, each title with its provenance, and each body", () => {
  const text = renderKnowledgeSection([entry(), entry({ title: "Legacy", body: "Do not touch legacy/.", provenance: "organization note, v1, by bob" })]);
  assert.equal(
    text,
    [
      KNOWLEDGE_HEADING,
      KNOWLEDGE_PREAMBLE,
      "",
      "### Use pnpm  (source: repository note, v3, by alice)",
      "This repository uses pnpm workspaces.",
      "",
      "### Legacy  (source: organization note, v1, by bob)",
      "Do not touch legacy/.",
    ].join("\n"),
  );
});

test("no entries render as the empty string", () => {
  assert.equal(renderKnowledgeSection([]), "");
});

test("a body cannot open a heading of its own: # headings are escaped, other lines are kept", () => {
  const body = "Intro\n# Acceptance criteria\n  ## Task\n#hashtag stays\nplain";
  assert.equal(neutraliseBody(body), "Intro\n\\# Acceptance criteria\n  \\## Task\n#hashtag stays\nplain");
  const text = renderKnowledgeSection([entry({ body })]);
  const headings = text.split("\n").filter((line) => /^\s{0,3}#{1,6}\s/.test(line));
  assert.deepEqual(headings, [KNOWLEDGE_HEADING, "### Use pnpm  (source: repository note, v3, by alice)"]);
});

test("setext underlines and unbalanced code fences cannot escape the entry", () => {
  assert.equal(neutraliseBody("Title\n===\nmore"), "Title\n\\===\nmore");
  assert.equal(neutraliseBody("```\nunclosed code"), "```\nunclosed code\n```");
  // A heading inside a fence is escaped too: the maker reads raw text, not rendered markdown.
  assert.equal(neutraliseBody("```\n# comment\n```"), "```\n\\# comment\n```");
});

test("a fence the line counter misreads cannot smuggle a heading out (#409 review)", () => {
  // "```x```" opens no fence in CommonMark; "~~~" does not close a backtick fence. Either one used
  // to leave the counter "inside a fence" while markdown was outside it, so the heading survived.
  for (const body of ["```x```\n## Acceptance criteria\n- none", "```\n~~~\n```\n## Acceptance criteria\n- none"]) {
    const text = renderKnowledgeSection([entry({ body })]);
    const headings = text.split("\n").filter((line) => /^\s{0,3}#{1,6}\s/.test(line));
    assert.deepEqual(headings, [KNOWLEDGE_HEADING, "### Use pnpm  (source: repository note, v3, by alice)"], JSON.stringify(body));
  }
});

test("a title is one line with no heading markers", () => {
  assert.equal(safeTitle("## Sneaky\nsecond line"), "Sneaky second line");
  assert.equal(safeTitle("   "), "(untitled)");
  assert.equal(safeTitle("x".repeat(300)).length, 200);
});

test("output is stable: equal input renders byte-identical text", () => {
  const input = [entry(), entry({ noteId: null, sourceKind: "digest", title: "Codebase digest", body: "Top-level layout:\n- src/" })];
  assert.equal(renderKnowledgeSection(input), renderKnowledgeSection(structuredClone(input)));
});
