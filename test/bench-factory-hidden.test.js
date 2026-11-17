import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadTasks } from "../packages/cli/dist/commands/bench-factory.js";
import { checkHiddenTests, hiddenTestEnv, runHiddenTests } from "../packages/cli/dist/commands/bench-factory-hidden.js";
import { bareFixtureRepo, repoRoot, tempDir } from "./helpers.js";

/**
 * Hidden tests run against a real git history — a `bareFixtureRepo` standing in for the scratch
 * repository — with no network: the clone is a local path, which is exactly the substitution
 * ADR-0016 asks for.
 */

const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/**
 * A repository whose base prints "hello", and a head on a run branch that prints "hello\nbye".
 * Returns the bare remote, the base SHA and the head SHA.
 */
function scratchRepo() {
  const { bare, source } = bareFixtureRepo({ test: "node index.js" }, { "index.js": 'console.log("hello");\n' });
  const base = git(source, "rev-parse", "HEAD");
  git(source, "checkout", "-q", "-b", "windkeel/run-1");
  writeFileSync(join(source, "index.js"), 'console.log("hello");\nconsole.log("bye");\n');
  git(source, "commit", "-qam", "candidate");
  const head = git(source, "rev-parse", "HEAD");
  git(source, "push", "-q", bare, "windkeel/run-1");
  return { bare, base, head };
}

/** A task directory with one hidden test file. */
function hiddenTask(repository, base, { command = "node hidden.test.js", body, timeout_seconds } = {}) {
  const dir = tempDir("bf-hidden-task");
  mkdirSync(join(dir, "hidden"), { recursive: true });
  writeFileSync(
    join(dir, "hidden", "hidden.test.js"),
    body ??
      `const { execFileSync } = require("node:child_process");
const out = execFileSync(process.execPath, ["index.js"], { encoding: "utf8" });
if (!out.includes("bye")) { console.error("no farewell: " + JSON.stringify(out)); process.exit(1); }
console.log("hidden ok");
`,
  );
  return {
    id: "hidden-task",
    source: "real-repo",
    repository,
    base_ref: base,
    title: "t",
    description: "d",
    hidden_tests: { command, files: ["hidden.test.js"], ...(timeout_seconds ? { timeout_seconds } : {}) },
    budget_usd: 1,
    timeout_minutes: 1,
    dir,
  };
}

test("hidden tests pass against a head that satisfies them", async () => {
  const { bare, base, head } = scratchRepo();
  const result = await runHiddenTests(hiddenTask(bare, base), { sha: head });
  assert.equal(result.outcome, "pass", JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.match(result.outputTail, /hidden ok/);
});

test("hidden tests fail against a head that does not", async () => {
  const { bare, base } = scratchRepo();
  const result = await runHiddenTests(hiddenTask(bare, base), { sha: base });
  assert.equal(result.outcome, "fail");
  assert.equal(result.exitCode, 1);
  assert.match(result.outputTail, /no farewell/);
});

test("a hidden test that outlives its timeout is not_run, and its process group is killed", async () => {
  const { bare, base, head } = scratchRepo();
  const started = Date.now();
  const result = await runHiddenTests(
    hiddenTask(bare, base, { body: "setInterval(() => {}, 1000);\n", timeout_seconds: 1 }),
    { sha: head },
  );
  assert.equal(result.outcome, "not_run");
  assert.match(result.reason, /^timeout/);
  assert.ok(Date.now() - started < 30_000);
});

test("a missing command is not_run, never a failure of the change", async () => {
  const { bare, base, head } = scratchRepo();
  const empty = await runHiddenTests(hiddenTask(bare, base, { command: "  " }), { sha: head });
  assert.deepEqual([empty.outcome, empty.reason], ["not_run", "no hidden test command"]);
  const absent = await runHiddenTests(hiddenTask(bare, base, { command: "definitely-not-a-binary-windkeel" }), { sha: head });
  assert.equal(absent.outcome, "not_run");
  assert.match(absent.reason, /command not found/);
});

test("a head the repository does not have, or one not descended from base_ref, is not_run", async () => {
  const { bare, base, head } = scratchRepo();
  const unknown = await runHiddenTests(hiddenTask(bare, base), { sha: "0123456789abcdef0123456789abcdef01234567" });
  assert.equal(unknown.outcome, "not_run");
  assert.match(unknown.reason, /not found/);

  // A commit in the same repository that the head does not descend from: a sibling of base.
  const { source } = bareFixtureRepo({}, { "other.txt": "unrelated history\n" });
  git(source, "push", "-q", bare, "HEAD:refs/heads/elsewhere");
  const elsewhere = git(source, "rev-parse", "HEAD");
  assert.notEqual(elsewhere, base);
  const unrelated = await runHiddenTests(hiddenTask(bare, elsewhere), { sha: head });
  assert.equal(unrelated.outcome, "not_run");
  assert.match(unrelated.reason, /does not descend from base_ref/);
});

test("a clone that fails is not_run", async () => {
  const result = await runHiddenTests(hiddenTask(join(tempDir("bf-nowhere"), "absent.git"), "abc1234"), { sha: "abc1234" });
  assert.equal(result.outcome, "not_run");
  assert.match(result.reason, /clone failed/);
});

test("hidden test files never reach the repository the maker sees", async () => {
  const { bare, base, head } = scratchRepo();
  const before = git(bare, "for-each-ref", "--format=%(refname) %(objectname)");
  await runHiddenTests(hiddenTask(bare, base), { sha: head });
  assert.equal(git(bare, "for-each-ref", "--format=%(refname) %(objectname)"), before, "no ref moved");
  const files = git(bare, "ls-tree", "-r", "--name-only", head);
  assert.ok(!files.includes("hidden.test.js"));
});

test("the hidden command runs without the operator's credentials in its environment", async () => {
  const env = hiddenTestEnv({ PATH: "/bin", HOME: "/h", WINDKEEL_API_TOKEN: "orq_secret", OPENAI_API_KEY: "sk-x", AWS_SECRET_ACCESS_KEY: "y" });
  assert.deepEqual(env, { CI: "1", PATH: "/bin", HOME: "/h" });

  const { bare, base, head } = scratchRepo();
  const previous = process.env.WINDKEEL_API_TOKEN;
  process.env.WINDKEEL_API_TOKEN = "orq_should_not_leak";
  try {
    const result = await runHiddenTests(
      hiddenTask(bare, base, {
        body:
          'if (process.env.WINDKEEL_API_TOKEN) { console.error("leaked"); process.exit(1); }\n' +
          `if (process.env.HOME === ${JSON.stringify(process.env.HOME ?? "")}) { console.error("real HOME"); process.exit(1); }\n`,
      }),
      { sha: head },
    );
    assert.equal(result.outcome, "pass", result.outputTail);
  } finally {
    if (previous === undefined) delete process.env.WINDKEEL_API_TOKEN;
    else process.env.WINDKEEL_API_TOKEN = previous;
  }
});

test("checkHiddenTests: fails on base, passes on the reference — and says which half is wrong", async () => {
  const { bare, base, head } = scratchRepo();
  const task = hiddenTask(bare, base);
  const patch = git(join(bare), "diff", base, head);
  writeFileSync(join(task.dir, "fix.patch"), `${patch}\n`);
  const good = await checkHiddenTests({ ...task, reference_patch: "fix.patch" });
  assert.equal(good.ok, true, good.problem);
  assert.equal(good.base.outcome, "fail");
  assert.equal(good.reference.outcome, "pass");

  const tooEasy = await checkHiddenTests({ ...hiddenTask(bare, base, { body: "process.exit(0);\n" }), reference_patch: undefined });
  assert.equal(tooEasy.ok, false);
  assert.match(tooEasy.problem, /already pass/);
  assert.match(tooEasy.problem, /no reference_patch or upstream.fix_commit/);

  // The upstream form: a fix commit in another repository.
  const upstream = await checkHiddenTests({ ...task, repository: join(tempDir("bf-absent"), "x.git"), upstream: { repo: bare, fix_commit: head } });
  assert.equal(upstream.reference.outcome, "pass");
  assert.equal(upstream.base.outcome, "not_run", "the scratch repo is not there, so base cannot be checked");
  assert.equal(upstream.ok, false);
});

/**
 * The seeded real-repo tasks, end to end, offline: the scratch repository built exactly as the
 * operator will build it, each task's hidden tests failing on its base_ref and passing with its
 * reference solution. For the M5 candidate it also holds the design together — the naive
 * solution fails the repository's *own* tests, which is what lets the verifier catch it without a
 * model.
 */
test("the seeded real-repo tasks: hidden tests fail on base and pass on the reference solution", async () => {
  const work = tempDir("bf-scratch");
  const seeded = spawnSync("sh", [join(repoRoot, "bench", "factory", "seed-scratch-repo.sh"), join(work, "repo")], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);
  const tasks = loadTasks(join(repoRoot, "bench", "factory", "tasks")).filter((t) => t.source === "real-repo");
  assert.ok(tasks.length >= 3);
  for (const task of tasks) {
    const result = await checkHiddenTests({ ...task, repository: join(work, "repo") });
    assert.equal(result.ok, true, `${task.id}: ${result.problem} ${result.base.outputTail ?? ""} ${result.reference?.outputTail ?? ""}`);
  }

  const m5 = tasks.find((t) => t.id === "repo-scratch-duration-hours");
  const naive = await runHiddenTests({ ...m5, repository: join(work, "repo") }, { sha: m5.base_ref }, { applyPatch: join(m5.dir, "reference", "naive.patch") });
  assert.equal(naive.outcome, "fail", "the naive solution does not pass the hidden tests");
  const visible = await runHiddenTests(
    { ...m5, repository: join(work, "repo"), hidden_tests: { ...m5.hidden_tests, command: "npm test" } },
    { sha: m5.base_ref },
    { applyPatch: join(m5.dir, "reference", "naive.patch") },
  );
  assert.equal(visible.outcome, "fail", "and the repository's own tests catch it");
  assert.match(visible.outputTail, /not ok \d+ - parseDuration reads back everything formatDuration writes/);
  const visibleCorrect = await runHiddenTests(
    { ...m5, repository: join(work, "repo"), hidden_tests: { ...m5.hidden_tests, command: "npm test" } },
    { sha: m5.base_ref },
    { applyPatch: join(m5.dir, "reference", "correct.patch") },
  );
  assert.equal(visibleCorrect.outcome, "pass", visibleCorrect.outputTail);
});
