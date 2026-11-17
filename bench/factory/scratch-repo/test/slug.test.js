import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slug.js";

test("lowercases and joins words with dashes", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Release 2.0 notes  "), "release-2-0-notes");
  assert.equal(slugify("a -- b"), "a-b");
});
