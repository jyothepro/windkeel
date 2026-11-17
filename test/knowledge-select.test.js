import assert from "node:assert/strict";
import { test } from "node:test";
import { renderKnowledgeSection, TRUNCATION_MARKER } from "../dist/factory/knowledge-render.js";
import { globMatches, mentionedPaths, selectKnowledge } from "../dist/factory/knowledge-select.js";

const REPO = "11111111-1111-1111-1111-111111111111";
let seq = 0;
const note = (overrides = {}) => {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    repositoryId: REPO,
    title: `Note ${seq}`,
    body: `Body ${seq}`,
    pathGlobs: [],
    status: "active",
    sourceKind: "human",
    sourceRef: {},
    risk: null,
    version: 1,
    createdBy: "alice",
    updatedBy: "alice",
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
};

test("priority: repository notes, then organization notes, then learned lessons, then the digest", () => {
  const learned = note({ sourceKind: "verifier_finding", risk: "low", createdBy: "orqon", updatedBy: "orqon", sourceRef: { runId: "abcdef0123" }, title: "Learned" });
  const org = note({ repositoryId: null, title: "Org" });
  const repo = note({ title: "Repo" });
  const { injected } = selectKnowledge({
    notes: [learned, org, repo],
    digest: { commitSha: "a".repeat(40), body: "Top-level layout:\n- src/" },
    taskText: "anything",
  });
  assert.deepEqual(injected.map((e) => e.title), ["Repo", "Org", "Learned", "Codebase digest"]);
  assert.match(injected[2].provenance, /learned from run abcdef01, low risk, applied automatically, v1/);
  assert.match(injected[1].provenance, /^organization note, v1, by alice$/);
  assert.equal(injected[3].digestSha, "a".repeat(40));
});

test("suggested, rejected and archived notes are never selected", () => {
  const { injected } = selectKnowledge({
    notes: ["suggested", "rejected", "archived"].map((status) => note({ status })),
    taskText: "",
  });
  assert.deepEqual(injected, []);
});

test("the budget drops the lowest priority first, whole notes only, and reports what it dropped", () => {
  const notes = [note({ title: "A", body: "a".repeat(300) }), note({ title: "B", body: "b".repeat(300), repositoryId: null }), note({ title: "C", body: "c".repeat(300), sourceKind: "verifier_finding", risk: "low" })];
  const { injected, dropped } = selectKnowledge({ notes, taskText: "", budgetChars: 900 });
  assert.deepEqual(injected.map((e) => e.title), ["A", "B"]);
  assert.deepEqual(dropped.map((d) => d.title), ["C"]);
  assert.ok(renderKnowledgeSection(injected).length <= 900);
  for (const e of injected) assert.ok(!e.body.includes(TRUNCATION_MARKER.trim()), "no note was cut");
});

test("a single note larger than the whole budget is cut, and marked as cut", () => {
  const { injected, dropped } = selectKnowledge({ notes: [note({ title: "Huge", body: "x".repeat(5000) })], taskText: "", budgetChars: 1000 });
  assert.equal(injected.length, 1);
  assert.ok(injected[0].body.endsWith(TRUNCATION_MARKER));
  assert.ok(renderKnowledgeSection(injected).length <= 1000);
  assert.deepEqual(dropped, []);
});

test("a path-glob note applies only when the task names a matching path", () => {
  const scoped = note({ title: "Legacy", pathGlobs: ["legacy/**"] });
  const always = note({ title: "Always" });
  assert.deepEqual(
    selectKnowledge({ notes: [scoped, always], taskText: "Fix the parser in src/parse.ts" }).injected.map((e) => e.title),
    ["Always"],
  );
  assert.deepEqual(
    selectKnowledge({ notes: [scoped, always], taskText: "Port legacy/old/thing.js to TypeScript" }).injected.map((e) => e.title).sort(),
    ["Always", "Legacy"],
  );
  assert.ok(globMatches("legacy/**", "legacy/"));
  assert.ok(globMatches("src/**/*.ts", "src/a/b/c.ts"));
  assert.ok(globMatches("src/**/*.ts", "src/c.ts"));
  assert.ok(!globMatches("src/*.ts", "src/a/c.ts"));
  assert.ok(globMatches("*.{md,txt}", "README.md"));
  assert.deepEqual(mentionedPaths("see ./src/a.ts, and docs/ plus README.md."), ["src/a.ts", "docs/", "README.md"]);
});

test("ordering is deterministic for equal timestamps: ties break on id", () => {
  const at = new Date("2026-10-01T00:00:00Z");
  const a = note({ id: "00000000-0000-4000-8000-00000000000b", title: "b", updatedAt: at });
  const b = note({ id: "00000000-0000-4000-8000-00000000000a", title: "a", updatedAt: at });
  const first = selectKnowledge({ notes: [a, b], taskText: "" }).injected.map((e) => e.title);
  const second = selectKnowledge({ notes: [b, a], taskText: "" }).injected.map((e) => e.title);
  assert.deepEqual(first, ["a", "b"]);
  assert.deepEqual(second, first);
});

test("a learned lesson a person accepted says who accepted it", () => {
  const accepted = note({ sourceKind: "verifier_finding", risk: "high", createdBy: "orqon", updatedBy: "carol", sourceRef: { runId: "12345678abcd" }, version: 2 });
  const [entry] = selectKnowledge({ notes: [accepted], taskText: "" }).injected;
  assert.equal(entry.provenance, "learned from run 12345678, accepted by carol, v2");
});
