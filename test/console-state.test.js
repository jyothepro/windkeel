import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, rmSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { privateConsoleStateDirectory } from "./console-state.js";

function fixture(t) {
  const cwd = `/windkeel-console-state-test/${randomUUID()}`;
  const path = privateConsoleStateDirectory(cwd);
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return { cwd, path };
}

test("console daemon state is private and reusable by its owner", (t) => {
  const { cwd, path } = fixture(t);
  assert.equal(lstatSync(path).mode & 0o777, 0o700);
  assert.equal(privateConsoleStateDirectory(cwd), path);
});

test("console daemon refuses state directories writable by other users", (t) => {
  const { cwd, path } = fixture(t);
  chmodSync(path, 0o777);
  assert.throws(() => privateConsoleStateDirectory(cwd), /refusing unsafe console state directory/);
});

test("console daemon refuses a symlink in place of its private directory", (t) => {
  const { cwd, path } = fixture(t);
  rmSync(path, { recursive: true });
  symlinkSync(process.cwd(), path, "dir");
  assert.throws(() => privateConsoleStateDirectory(cwd), /refusing unsafe console state directory/);
});
