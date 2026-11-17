import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommand } from "../dist/worker/command-classification.js";
import { CodexEventNormalizer } from "../dist/worker/codex/events.js";

const isTest = (command, args) => classifyCommand(command, args).isTest;

test("bare runners and package-manager scripts classify as tests", () => {
  for (const command of [
    "npm test",
    "npm t",
    "npm run test",
    "npm run test:unit",
    "npm run --silent test",
    "yarn test",
    "pnpm test",
    "pnpm run test:ci",
    "bun test",
    "pytest",
    "pytest -q tests/",
    "python -m pytest tests/",
    "python3 -m unittest discover",
    "go test ./...",
    "cargo test --all-features",
    "node --test test/*.test.js",
    "make check",
    "npx jest --ci",
    "poetry run pytest",
    "bundle exec rspec spec/",
    "CI=1 FORCE_COLOR=0 npm test",
    "./gradlew test",
    "dotnet test",
    "vitest run",
  ]) {
    assert.equal(isTest(command), true, `expected a test: ${command}`);
  }
});

test("`npm run --silent test` — what M0's check discovery emits — classifies as a test", () => {
  // src/config.ts's `fromScripts` builds exactly this string for a repo declaring a `test`
  // script. The two code paths answer different questions (declared vs observed), but the
  // command they meet on must not be classified differently by them.
  assert.equal(isTest("npm run --silent test"), true);
});

test("non-test commands are unaffected", () => {
  for (const command of [
    "npm ci",
    "npm install",
    "npm run build",
    "ls",
    "ls test/",
    "cat package.json",
    "cat test.txt",
    "git status",
    "git commit -m 'add tests'",
    "go build ./...",
    "echo npm test",
    "grep -r pytest src/",
  ]) {
    assert.equal(isTest(command), false, `expected not a test: ${command}`);
  }
});

test("near-misses are pinned deliberately", () => {
  // Accepted false positive, documented in the classifier: a `test:`-prefixed script counts,
  // even when it only sets a fixture up. The cost is a mislabelled event, not a wrong verdict.
  assert.equal(isTest("npm run test:setup"), true);
  // `cat test.txt` names a file, not a runner — the first token decides.
  assert.equal(isTest("cat test.txt"), false);
  // `npm run pretest` is not a test script name under the pinned rule.
  assert.equal(isTest("npm run pretest"), false);
  // A wrapper script that shells out to the tests is a known blind spot, stated not hidden.
  assert.equal(isTest("./scripts/ci.sh"), false);
});

test("both exec styles are handled, mirroring isGitPush's coverage", () => {
  assert.equal(isTest("npm", ["test"]), true);
  assert.equal(isTest("npm", ["run", "--silent", "test:unit"]), true);
  assert.equal(isTest("pytest", ["-q", "tests/"]), true);
  assert.equal(isTest("npm", ["ci"]), false);
  assert.equal(isTest("git", ["status"]), false);
});

test("a cd-then-test one-liner is handled; the shell operator does not hide it", () => {
  assert.equal(isTest("cd packages/api && npm test"), true);
  assert.equal(isTest("npm ci && npm run test:unit"), true);
  assert.equal(isTest("cd packages/api && npm run build"), false);
});

test("the matched token is reported, so a surprising call can be explained", () => {
  assert.equal(classifyCommand("cd api && pnpm run test:e2e").matched, "pnpm run test:e2e");
});

test("end to end: npm ci yields command_*, npm test yields test_*", () => {
  const normalizer = new CodexEventNormalizer();
  const run = (command, exitCode, id) => [
    ...normalizer.normalize({
      type: "item.started",
      item: { id, item_type: "command_execution", command },
    }),
    ...normalizer.normalize({
      type: "item.completed",
      item: { id, item_type: "command_execution", command, exit_code: exitCode },
    }),
  ];

  assert.deepEqual(run("npm ci", 0, "c1"), [
    { type: "command_started", command: "npm ci" },
    { type: "command_finished", command: "npm ci", exitCode: 0 },
  ]);
  assert.deepEqual(run("npm test", 0, "c2"), [
    { type: "test_started", command: "npm test" },
    { type: "test_finished", command: "npm test", exitCode: 0, passed: true },
  ]);
});

test("a failing test command is distinguishable from a passing one", () => {
  const normalizer = new CodexEventNormalizer();
  normalizer.normalize({
    type: "item.started",
    item: { id: "c3", item_type: "command_execution", command: "pytest -q" },
  });
  assert.deepEqual(
    normalizer.normalize({
      type: "item.completed",
      item: { id: "c3", item_type: "command_execution", command: "pytest -q", exit_code: 1 },
    }),
    [{ type: "test_finished", command: "pytest -q", exitCode: 1, passed: false }],
  );
});

test("a test command killed with no exit code is not reported as passing", () => {
  const normalizer = new CodexEventNormalizer();
  assert.deepEqual(
    normalizer.normalize({
      type: "item.completed",
      item: { id: "c4", item_type: "command_execution", command: "npm test" },
    }),
    [{ type: "test_finished", command: "npm test", exitCode: null, passed: false }],
  );
});
