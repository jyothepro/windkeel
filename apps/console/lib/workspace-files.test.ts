import { test } from "node:test";
import assert from "node:assert/strict";
import { crumbs, numberedLines, parentOf, refusalText, sizeLabel } from "./workspace-files.ts";

test("a path's breadcrumb starts at the workspace root", () => {
  assert.deepEqual(crumbs(""), [{ label: "workspace", path: "" }]);
  assert.deepEqual(crumbs("src/lib/a.ts"), [
    { label: "workspace", path: "" },
    { label: "src", path: "src" },
    { label: "lib", path: "src/lib" },
    { label: "a.ts", path: "src/lib/a.ts" },
  ]);
  assert.equal(parentOf("src/lib/a.ts"), "src/lib");
  assert.equal(parentOf("a.ts"), "");
  assert.equal(parentOf(""), "");
});

test("a file's lines are numbered, a final newline isn't a line, and long files are cut", () => {
  assert.deepEqual(numberedLines("a\nb\n"), { lines: ["a", "b"], total: 2, cut: false });
  assert.deepEqual(numberedLines("a\r\nb"), { lines: ["a", "b"], total: 2, cut: false });
  assert.deepEqual(numberedLines(""), { lines: [""], total: 1, cut: false });
  assert.deepEqual(numberedLines("1\n2\n3\n4\n", 2), { lines: ["1", "2"], total: 4, cut: true });
});

test("sizes read the way a file browser says them", () => {
  assert.equal(sizeLabel(null), "");
  assert.equal(sizeLabel(812), "812 B");
  assert.equal(sizeLabel(14_540), "14.2 KB");
  assert.equal(sizeLabel(1_153_434), "1.1 MB");
});

test("a refusal reads as what to do, keeping the server's specifics where they matter", () => {
  assert.match(refusalText("turn_running", "run is IMPLEMENTING"), /readable between turns/);
  assert.match(refusalText("run_terminal", "x"), /ended/);
  assert.equal(refusalText("binary_file", "binary, 6 bytes"), "Not shown: binary, 6 bytes.");
  const tooLarge = "big.log is 2,000,000 bytes; the workspace view reads files up to 1,048,576 bytes";
  assert.equal(refusalText("file_too_large", tooLarge), tooLarge);
});
