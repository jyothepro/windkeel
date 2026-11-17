import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateOfTurn, sameFile, scopeToTurn, sections, unquoteGitPath } from "./turn-changes.ts";
import type { RunDiff } from "./types.ts";

const section = (path: string, line = "+x") =>
  [`diff --git a/${path} b/${path}`, "index 1..2 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", line, ""].join("\n");

const diff: RunDiff = {
  candidateSha: "b".repeat(40),
  workingBranch: "windkeel/1",
  filesChanged: ["src/a.ts", "src/b.ts", "test/a.test.ts"],
  truncated: false,
  patch: section("src/a.ts") + section("src/b.ts") + section("test/a.test.ts"),
  candidates: [
    { sha: "a".repeat(40), agentRunId: "ar-maker", role: "implementer", filesChanged: 2 },
    { sha: "b".repeat(40), agentRunId: "ar-repair", role: "repairer", filesChanged: 3 },
  ],
};

test("a turn's changes are its candidate cut to the files it edited", () => {
  const scope = scopeToTurn(diff, ["src/b.ts", "/vercel/sandbox/repo/test/a.test.ts", "src/gone.ts"], true);
  assert.equal(scope.diff.patch, section("src/b.ts") + section("test/a.test.ts"));
  assert.deepEqual(scope.diff.filesChanged, ["src/b.ts", "test/a.test.ts"]);
  assert.deepEqual(scope.notInPatch, ["src/gone.ts"], "an edit the candidate doesn't carry is named, not dropped silently");
  assert.equal(scope.ownCandidate, true);
  assert.equal(scope.diff.candidateSha, diff.candidateSha);
});

test("a turn that edited nothing in the patch scopes to an empty patch", () => {
  assert.equal(scopeToTurn(diff, ["README.md"], false).diff.patch, "");
});

test("a renamed file matches by its new name", () => {
  const renamed = { ...diff, patch: "diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n" };
  assert.equal(scopeToTurn(renamed, ["new.ts"], true).diff.patch, renamed.patch);
});

test("a relative path matches exactly; only an absolute one is matched by its tail", () => {
  assert.ok(sameFile("src/a.ts", "src/a.ts"));
  assert.ok(sameFile("./src/a.ts", "src/a.ts"));
  assert.ok(sameFile("/vercel/sandbox/src/a.ts", "src/a.ts"));
  assert.ok(!sameFile("lib/src/a.tsx", "src/a.ts"));
  assert.ok(!sameFile("xsrc/a.ts", "src/a.ts"));
  assert.ok(!sameFile("packages/widget/src/a.ts", "src/a.ts"), "a relative path in another package is another file");
  assert.ok(!sameFile("src/a.ts", "packages/widget/src/a.ts"));
});

test("an absolute path is read against the checkout root when it is known", () => {
  const root = "/vercel/sandbox/repo";
  assert.ok(sameFile("/vercel/sandbox/repo/src/a.ts", "src/a.ts", root));
  assert.ok(sameFile("/vercel/sandbox/repo/src/a.ts", "src/a.ts", `${root}/`));
  assert.ok(!sameFile("/vercel/sandbox/repo/packages/widget/src/a.ts", "src/a.ts", root));
  assert.ok(!sameFile("/elsewhere/src/a.ts", "src/a.ts", root), "outside the checkout is not in the patch");
  assert.ok(sameFile("/vercel/sandbox/repo/packages/widget/src/a.ts", "packages/widget/src/a.ts", root));
});

test("a turn in one package doesn't pull in the same-named file of another", () => {
  const two: RunDiff = { ...diff, filesChanged: ["src/a.ts", "packages/widget/src/a.ts"], patch: section("src/a.ts") + section("packages/widget/src/a.ts") };
  const scope = scopeToTurn(two, ["packages/widget/src/a.ts"], true);
  assert.equal(scope.diff.patch, section("packages/widget/src/a.ts"));
  assert.deepEqual(scope.diff.filesChanged, ["packages/widget/src/a.ts"]);
});

const awkward = [
  "diff --git a/bin.dat b/bin.dat",
  "new file mode 100644",
  "index 0000000..bdc955b",
  "Binary files /dev/null and b/bin.dat differ",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "index 286c5f5..0000000",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "diff --git a/old.ts b/new name.ts",
  "similarity index 100%",
  "rename from old.ts",
  "rename to new name.ts",
  'diff --git "a/say \\"hi\\".ts" "b/say \\"hi\\".ts"',
  "new file mode 100644",
  "index 0000000..bca70f3",
  "--- /dev/null",
  '+++ "b/say \\"hi\\".ts"\t',
  "@@ -0,0 +1 @@",
  "+q",
  'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
  "new file mode 100644",
  "index 0000000..eaa742c",
  "--- /dev/null",
  '+++ "b/src/caf\\303\\251.ts"',
  "@@ -0,0 +1 @@",
  "+añadir",
  "diff --git a/src/foo b/bar.ts b/src/foo b/bar.ts",
  "index d00491f..1191247 100644",
  "--- a/src/foo b/bar.ts\t",
  "+++ b/src/foo b/bar.ts\t",
  "@@ -1 +1,2 @@",
  " 1",
  "+2",
  "--- a/not-a-header.ts",
  'diff --git "a/tab\\there.ts" "b/tab\\there.ts"',
  "new file mode 100644",
  "index 0000000..718f4d2",
  "--- /dev/null",
  '+++ "b/tab\\there.ts"',
  "@@ -0,0 +1 @@",
  "+t",
  "",
].join("\n");

test("each section's files come from its ---/+++ lines, quoting and all", () => {
  assert.deepEqual(
    sections(awkward).map((s) => s.paths),
    [
      ["bin.dat"],
      ["gone.ts"],
      ["old.ts", "new name.ts"],
      ['say "hi".ts'],
      ["src/café.ts"],
      ["src/foo b/bar.ts"],
      ["tab\there.ts"],
    ],
  );
  assert.equal(sections(awkward).map((s) => s.text).join(""), awkward, "every byte of the patch is in some section");
});

test("a turn's changes find files whose names need quoting or contain ' b/'", () => {
  const d: RunDiff = { ...diff, filesChanged: [], patch: awkward };
  const scope = scopeToTurn(d, ["src/foo b/bar.ts", "src/café.ts", "gone.ts", "new name.ts"], true);
  assert.deepEqual(sections(scope.diff.patch).map((s) => s.paths[s.paths.length - 1]), ["gone.ts", "new name.ts", "src/café.ts", "src/foo b/bar.ts"]);
  assert.deepEqual(scope.notInPatch, []);
  assert.equal(scopeToTurn(d, ["foo b/bar.ts"], true).diff.patch, "", "a tail of a relative name is not the name");
  assert.equal(scopeToTurn(d, ["src/foo"], true).diff.patch, "", "the header's mis-split isn't a file");
});

test("Git's C-style quoting is unquoted, and malformed quoting is refused", () => {
  assert.deepEqual(unquoteGitPath('"a\\\\b\\"c\\td\\ne"'), { path: 'a\\b"c\td\ne', end: 15 });
  assert.equal(unquoteGitPath('"\\346\\227\\245\\346\\234\\254.md"')?.path, "日本.md");
  assert.equal(unquoteGitPath("plain"), null);
  assert.equal(unquoteGitPath('"unterminated'), null);
  assert.equal(unquoteGitPath('"bad \\q escape"'), null);
});

test("the candidate a turn made, by its agent run", () => {
  assert.equal(candidateOfTurn(diff, "ar-maker"), "a".repeat(40));
  assert.equal(candidateOfTurn(diff, "ar-other"), null);
});
