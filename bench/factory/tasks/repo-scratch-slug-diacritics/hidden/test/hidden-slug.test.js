import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slug.js";

test("accented Latin letters lose their accents rather than becoming dashes", () => {
  assert.equal(slugify("Crème Brûlée"), "creme-brulee");
  assert.equal(slugify("São Paulo"), "sao-paulo");
  assert.equal(slugify("Ünïcödé"), "unicode");
  assert.equal(slugify("naïve café"), "naive-cafe");
});

test("decomposed input reads the same as composed input", () => {
  assert.equal(slugify("Crème"), "creme");
});

test("everything else is unchanged", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Release 2.0 notes  "), "release-2-0-notes");
  assert.equal(slugify("a -- b"), "a-b");
  assert.equal(slugify("日本"), "");
});
