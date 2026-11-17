import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePatch } from "./patch.ts";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 3b1f2e0..8c4d9a1 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,3 +10,4 @@ export function a() {",
  "   const x = 1;",
  "-  return x;",
  "+  // keep it",
  "+  return x + 1;",
  " }",
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1 @@",
  "+hello",
  "\\ No newline at end of file",
  "diff --git a/img.png b/img.png",
  "Binary files a/img.png and b/img.png differ",
  "",
].join("\n");

test("splits a patch into files with counts and statuses", () => {
  const files = parsePatch(PATCH);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary]),
    [
      ["src/a.ts", "modified", 2, 1, false],
      ["docs/new.md", "added", 1, 0, false],
      ["img.png", "modified", 0, 0, true],
    ],
  );
});

test("numbers old and new lines from the hunk header", () => {
  const [file] = parsePatch(PATCH);
  const lines = file!.hunks[0]!.lines.map((l) => [l.kind, l.oldNumber, l.newNumber]);
  assert.deepEqual(lines, [
    ["context", 10, 10],
    ["remove", 11, null],
    ["add", null, 11],
    ["add", null, 12],
    ["context", 12, 13],
  ]);
});

test("a rename keeps where it came from", () => {
  const [file] = parsePatch(["diff --git a/old.ts b/new.ts", "similarity index 90%", "rename from old.ts", "rename to new.ts"].join("\n"));
  assert.equal(file!.status, "renamed");
  assert.equal(file!.oldPath, "old.ts");
  assert.equal(file!.path, "new.ts");
});

test("an empty patch has no files", () => {
  assert.deepEqual(parsePatch(""), []);
});
