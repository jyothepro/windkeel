/**
 * ADF → markdown-ish text (M8-8): Jira descriptions arrive as Atlassian Document Format, and the
 * factory reads them as text (criteria extraction looks for headings and lists).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as adf from "../dist/integrations/adf.js";
import {
  ADF_MAX_DEPTH,
  adfDoc,
  adfLink,
  adfParagraph,
  adfText,
  adfToText,
  MAX_DESCRIPTION_CHARS,
  TRUNCATION_MARKER,
  truncateDescription,
} from "../dist/integrations/adf.js";
import { repoRoot } from "./helpers.js";

const samples = JSON.parse(readFileSync(join(repoRoot, "test", "fixtures", "jira", "adf_samples.json"), "utf8"));

for (const [name, { doc, text }] of Object.entries(samples)) {
  test(`ADF sample "${name}" becomes the expected text`, () => {
    assert.equal(adfToText(doc), text);
  });
}

test("task lists render as checkboxes", () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { state: "DONE" }, content: [{ type: "text", text: "shipped" }] },
          { type: "taskItem", attrs: { state: "TODO" }, content: [{ type: "text", text: "to do" }] },
        ],
      },
    ],
  };
  assert.equal(adfToText(doc), "- [x] shipped\n- [ ] to do");
});

test("blockquote, rule and marks", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }] },
      { type: "rule" },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "bold", marks: [{ type: "strong" }] },
          { type: "text", text: " and " },
          { type: "text", text: "it", marks: [{ type: "em" }] },
        ],
      },
    ],
  };
  assert.equal(adfToText(doc), "> quoted\n\n---\n\n**bold** and *it*");
});

test("malformed trees and plain strings never throw", () => {
  assert.equal(adfToText(null), "");
  assert.equal(adfToText(undefined), "");
  assert.equal(adfToText(42), "");
  assert.equal(adfToText("  plain v2 description  "), "plain v2 description");
  assert.equal(adfToText({ type: "doc", content: [null, 3, { type: "paragraph", content: "nope" }] }), "");
});

test("a real description yields extractable criteria text", () => {
  const issue = JSON.parse(readFileSync(join(repoRoot, "test", "fixtures", "jira", "issue_created.json"), "utf8"));
  const text = adfToText(issue.issue.fields.description);
  assert.match(text, /## Acceptance criteria\n\n- GET \/health answers 200\n- The response body is/);
});

const para = (...content) => ({ type: "paragraph", content });
const doc = (...content) => ({ type: "doc", version: 1, content });

test("SF: table rows become pipe lines", () => {
  const cell = (text) => ({ type: "tableCell", content: [para({ type: "text", text })] });
  const table = {
    type: "table",
    content: [
      { type: "tableRow", content: [{ type: "tableHeader", content: [para({ type: "text", text: "Field" })] }, cell("Value")] },
      { type: "tableRow", content: [cell("status"), cell("200")] },
    ],
  };
  assert.equal(adfToText(doc(table)), "| Field | Value |\n| status | 200 |");
});

test("SF: mention, emoji, status and date render inline", () => {
  const text = adfToText(
    doc(
      para(
        { type: "mention", attrs: { id: "abc", text: "@Mia" } },
        { type: "text", text: " " },
        { type: "emoji", attrs: { shortName: ":tada:", text: "🎉" } },
        { type: "text", text: " " },
        { type: "emoji", attrs: { shortName: ":ship:" } },
        { type: "text", text: " " },
        { type: "status", attrs: { text: "IN PROGRESS", color: "blue" } },
        { type: "text", text: " by " },
        { type: "date", attrs: { timestamp: "1790000000000" } },
      ),
    ),
  );
  assert.equal(text, "@Mia 🎉 :ship: [IN PROGRESS] by 2026-09-21");
});

test("SF: blockCard renders its url; a card without one renders nothing", () => {
  assert.equal(
    adfToText(doc(para({ type: "text", text: "See" }), { type: "blockCard", attrs: { url: "https://acme.atlassian.net/browse/ENG-1" } }, { type: "blockCard", attrs: {} })),
    "See\n\nhttps://acme.atlassian.net/browse/ENG-1",
  );
});

test("MF4: nesting past ADF_MAX_DEPTH renders flat, without recursion, and keeps every word", () => {
  let node = para({ type: "text", text: "bottom" });
  for (let i = 0; i < 100_000; i += 1) {
    node = i % 2 ? { type: "blockquote", content: [node] } : { type: "bulletList", content: [{ type: "listItem", content: [node] }] };
  }
  const text = adfToText(doc(para({ type: "text", text: "top" }), node));
  assert.match(text, /^top/);
  assert.match(text, /bottom/);
  // The rendered part is bounded by the cap: at most ADF_MAX_DEPTH levels of structure.
  assert.ok((text.match(/>/g) ?? []).length <= ADF_MAX_DEPTH * ADF_MAX_DEPTH);
});

test("MF4: truncateDescription caps and marks", () => {
  assert.equal(truncateDescription("short"), "short");
  const long = truncateDescription("a".repeat(MAX_DESCRIPTION_CHARS + 10));
  assert.equal(long.length, MAX_DESCRIPTION_CHARS + 2 + TRUNCATION_MARKER.length);
  assert.ok(long.endsWith(TRUNCATION_MARKER));
});

test("SF: the unused adfCode builder is gone", () => {
  assert.equal("adfCode" in adf, false);
});

test("builders produce a valid ADF doc that round-trips", () => {
  const doc = adfDoc(adfParagraph(adfText("See "), adfLink("run", "https://c.example/runs/1")));
  assert.equal(doc.type, "doc");
  assert.equal(doc.version, 1);
  assert.equal(adfToText(doc), "See [run](https://c.example/runs/1)");
});
