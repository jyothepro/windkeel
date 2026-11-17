import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_TASK_CAP_USD,
  DEFAULT_TOTAL_CAP_USD,
  TaskValidationError,
  apiBenchClient,
  formatFactoryReport,
  githubFullName,
  loadTasks,
  planFactoryBench,
  runFactoryBench,
  scoreFactoryBench,
  snapshotFromReport,
  submissionText,
} from "../packages/cli/dist/commands/bench-factory.js";
import { WindkeelApi } from "../packages/cli/dist/client/api.js";
import { repoRoot, runCli, tempDir } from "./helpers.js";

const TASKS = join(repoRoot, "bench", "factory", "tasks");

/** A valid task.json, overridable field by field. */
function taskJson(overrides = {}) {
  return {
    id: "t-1",
    source: "real-repo",
    repository: "https://github.com/acme/scratch",
    base_ref: "0123456789abcdef0123456789abcdef01234567",
    title: "Do the thing",
    description: "Make the thing happen.",
    acceptance_criteria: ["the thing happens"],
    hidden_tests: { command: "node --test test/hidden.test.js", files: ["test/hidden.test.js"] },
    budget_usd: 1,
    timeout_minutes: 10,
    ...overrides,
  };
}

/** Writes tasks into a fresh directory, each with its hidden files present. */
function tasksDir(tasks) {
  const root = tempDir("bf-tasks");
  for (const [index, task] of tasks.entries()) {
    const dir = join(root, task.dirName ?? `task-${index}`);
    mkdirSync(dir, { recursive: true });
    const { dirName: _dirName, ...json } = task;
    writeFileSync(join(dir, "task.json"), JSON.stringify(json, null, 2));
    for (const file of json.hidden_tests?.files ?? []) {
      if (file.includes("..") || file.startsWith("/")) continue;
      mkdirSync(dirname(join(dir, "hidden", file)), { recursive: true });
      writeFileSync(join(dir, "hidden", file), "// hidden\n");
    }
  }
  return root;
}

function problemsOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TaskValidationError, `expected a TaskValidationError, got ${error}`);
    return error.problems;
  }
  assert.fail("expected loadTasks to refuse");
}

// --- loadTasks -------------------------------------------------------------------------------

test("loadTasks reads a valid task and records its directory", () => {
  const root = tasksDir([taskJson()]);
  const [task] = loadTasks(root);
  assert.equal(task.id, "t-1");
  assert.equal(task.dir, join(root, "task-0"));
});

test("loadTasks rejects a duplicate id, naming both directories", () => {
  const root = tasksDir([taskJson(), taskJson()]);
  const problems = problemsOf(() => loadTasks(root));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /duplicate id t-1/);
});

test("loadTasks rejects a missing repository", () => {
  const { repository: _r, ...json } = taskJson();
  const problems = problemsOf(() => loadTasks(tasksDir([json])));
  assert.ok(problems.some((p) => /repository is required/.test(p)), problems.join("\n"));
});

test("loadTasks rejects a bad source", () => {
  const problems = problemsOf(() => loadTasks(tasksDir([taskJson({ source: "kaggle" })])));
  assert.ok(problems.some((p) => /source must be one of swe-bench, real-repo/.test(p)), problems.join("\n"));
});

test("loadTasks rejects a non-positive budget, and one over the per-task cap", () => {
  for (const budget of [0, -1, "2", null]) {
    const problems = problemsOf(() => loadTasks(tasksDir([taskJson({ budget_usd: budget })])));
    assert.ok(problems.some((p) => /budget_usd must be a positive number/.test(p)), `${budget}: ${problems}`);
  }
  const over = problemsOf(() => loadTasks(tasksDir([taskJson({ budget_usd: DEFAULT_TASK_CAP_USD + 0.01 })])));
  assert.ok(over.some((p) => /over the per-task cap of \$2/.test(p)), over.join("\n"));
  // A raised cap is a deliberate flag, not an edit to a task file.
  assert.equal(loadTasks(tasksDir([taskJson({ budget_usd: 3 })]), { taskCapUsd: 5 }).length, 1);
});

test("loadTasks rejects a hidden test path that escapes the task directory", () => {
  for (const file of ["../outside.js", "/etc/passwd", "test/../../x.js"]) {
    const problems = problemsOf(() =>
      loadTasks(tasksDir([taskJson({ hidden_tests: { command: "true", files: [file] } })])),
    );
    assert.ok(problems.some((p) => /escapes the task directory/.test(p)), `${file}: ${problems}`);
  }
});

test("loadTasks rejects a hidden test file that is not there", () => {
  const root = tasksDir([taskJson()]);
  const dir = join(root, "task-0");
  writeFileSync(
    join(dir, "task.json"),
    JSON.stringify(taskJson({ hidden_tests: { command: "true", files: ["test/absent.test.js"] } })),
  );
  const problems = problemsOf(() => loadTasks(root));
  assert.ok(problems.some((p) => /hidden\/test\/absent.test.js does not exist/.test(p)), problems.join("\n"));
});

test("loadTasks rejects a task whose text names its hidden test file", () => {
  const problems = problemsOf(() =>
    loadTasks(tasksDir([taskJson({ description: "Make test/hidden.test.js pass." })])),
  );
  assert.ok(problems.some((p) => /hidden tests must stay hidden/.test(p)), problems.join("\n"));
});

test("loadTasks refuses to target the windkeel repository itself", () => {
  for (const overrides of [
    { repository: "https://github.com/jyothepro/windkeel" },
    { repository: "https://github.com/JyothePro/Windkeel.git" },
    { repository: "git@github.com:jyothepro/windkeel.git" },
    { windkeel_repository: "jyothepro/windkeel" },
  ]) {
    const problems = problemsOf(() => loadTasks(tasksDir([taskJson(overrides)])));
    assert.ok(problems.some((p) => /factory's own repository/.test(p)), `${JSON.stringify(overrides)}: ${problems}`);
  }
  // A similarly named scratch repository is fine.
  assert.equal(loadTasks(tasksDir([taskJson({ repository: "https://github.com/jyothepro/windkeel-bench-scratch" })])).length, 1);
});

test("loadTasks reports every problem at once", () => {
  const problems = problemsOf(() =>
    loadTasks(tasksDir([taskJson({ source: "x", budget_usd: 0 }), taskJson({ id: "t-2", title: "" })])),
  );
  assert.ok(problems.length >= 3, problems.join("\n"));
});

test("githubFullName reads https and ssh URLs and nothing else", () => {
  assert.equal(githubFullName("https://github.com/acme/widgets"), "acme/widgets");
  assert.equal(githubFullName("https://github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(githubFullName("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(githubFullName("/tmp/bare-repo"), null);
});

test("submissionText appends the criteria as the checklist the server extracts", () => {
  const text = submissionText({ description: "Fix it.\n", acceptance_criteria: ["one", "two"] });
  assert.equal(text, "Fix it.\n\n## Acceptance criteria\n\n- [ ] one\n- [ ] two\n");
  assert.equal(submissionText({ description: "Fix it." }), "Fix it.");
});

// --- the seeded tasks --------------------------------------------------------------------------

test("the seeded tasks load: at least five SWE-bench-style and three real-repo, within the caps", () => {
  const tasks = loadTasks(TASKS);
  assert.ok(tasks.filter((t) => t.source === "swe-bench").length >= 5);
  assert.ok(tasks.filter((t) => t.source === "real-repo").length >= 3);
  for (const task of tasks) {
    assert.ok(task.budget_usd <= DEFAULT_TASK_CAP_USD, task.id);
    if (task.source === "swe-bench") {
      assert.ok(task.upstream?.repo && task.upstream.fix_commit, `${task.id} names the upstream fix it is checked against`);
      assert.match(task.upstream.license ?? "", /MIT|Apache|BSD|ISC/, `${task.id} records a permissive licence`);
      assert.match(readFileSync(join(task.dir, "UPSTREAM-LICENSE"), "utf8"), /Permission is hereby granted/);
    } else {
      assert.ok(task.reference_patch, `${task.id} carries a reference solution`);
    }
  }
  assert.ok(planFactoryBench(tasks).worst_case_usd <= DEFAULT_TOTAL_CAP_USD, "the whole set fits the $50 cap");
});

test("the real-repo tasks' base_ref is what seed-scratch-repo.sh builds", () => {
  const target = join(tempDir("bf-seed"), "repo");
  const seeded = spawnSync("sh", [join(repoRoot, "bench", "factory", "seed-scratch-repo.sh"), target], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);
  const sha = seeded.stdout.trim();
  for (const task of loadTasks(TASKS).filter((t) => t.source === "real-repo")) {
    assert.equal(task.base_ref, sha, `${task.id}: re-run seed-scratch-repo.sh and update base_ref`);
  }
});

test("the M5 task's description.md is what the bench would submit", () => {
  const task = loadTasks(TASKS).find((t) => t.id === "repo-scratch-duration-hours");
  assert.equal(readFileSync(join(task.dir, "description.md"), "utf8"), submissionText(task));
});

// --- scoring -------------------------------------------------------------------------------------

function row(overrides) {
  return {
    id: "x",
    source: "real-repo",
    run_id: "r",
    state: "WAITING_FOR_HUMAN",
    stop_reason: null,
    verdict: "pass",
    first_verdict: "pass",
    hidden_tests: "pass",
    hidden_detail: "exit 0",
    repair_turns: 0,
    cost_usd: 0.1,
    cost_lower_bound: false,
    wall_seconds: 60,
    pr_url: null,
    head_sha: "abc1234",
    ...overrides,
  };
}

test("scoreFactoryBench: each rate over its own denominator", () => {
  const report = scoreFactoryBench([
    row({ id: "ok", cost_usd: 0.2 }),
    row({ id: "repaired", first_verdict: "fail", repair_turns: 1, cost_usd: 0.4 }),
    row({ id: "false-accept", hidden_tests: "fail", cost_usd: 0.3 }),
    row({ id: "false-reject", verdict: "fail", first_verdict: "fail", hidden_tests: "pass", state: "MAX_REPAIR_ATTEMPTS_REACHED", cost_usd: 0.5 }),
    row({ id: "plain-fail", verdict: "fail", first_verdict: "fail", hidden_tests: "fail", cost_usd: 0.6 }),
  ]);
  assert.equal(report.attempted, 5);
  assert.equal(report.successes, 2);
  assert.equal(report.success_rate, 0.4);
  assert.equal(report.verified_false_accept_rate, Number((1 / 3).toFixed(4)));
  assert.equal(report.verified_false_reject_rate, 0.5);
  assert.equal(report.repair_conversion_rate, Number((1 / 3).toFixed(4)));
  assert.deepEqual(report.cost_per_task_usd, { mean: 0.4, p50: 0.4, p90: 0.6 });
  assert.equal(report.cost_per_success_usd, 1);
  assert.equal(report.total_cost_usd, 2);
  assert.deepEqual(report.counts, {
    accepted: 3,
    false_accepts: 1,
    rejected: 2,
    false_rejects: 1,
    failed_first: 3,
    converted: 1,
  });
});

test("scoreFactoryBench: a warn is not the verifier vouching for a change", () => {
  const report = scoreFactoryBench([row({ verdict: "warn", hidden_tests: "pass" })]);
  assert.equal(report.successes, 0);
  assert.equal(report.counts.accepted, 0);
  assert.equal(report.verified_false_reject_rate, 1);
});

test("scoreFactoryBench: empty denominators answer 0, not NaN, and cost per success is null", () => {
  const report = scoreFactoryBench([]);
  assert.equal(report.attempted, 0);
  assert.equal(report.success_rate, 0);
  assert.equal(report.verified_false_accept_rate, 0);
  assert.equal(report.verified_false_reject_rate, 0);
  assert.equal(report.repair_conversion_rate, 0);
  assert.deepEqual(report.cost_per_task_usd, { mean: null, p50: null, p90: null });
  assert.equal(report.cost_per_success_usd, null);
  assert.match(formatFactoryReport(report), /n\/a\s+\(no verifier passes\)/);
});

test("scoreFactoryBench: excluded tasks are listed and counted in no score, but their spend is", () => {
  const report = scoreFactoryBench([
    row({ id: "ok", cost_usd: 0.25 }),
    row({ id: "over", excluded: "budget: too much", verdict: "pass", hidden_tests: "fail", cost_usd: 2.5 }),
  ]);
  assert.equal(report.attempted, 1);
  assert.equal(report.success_rate, 1);
  assert.equal(report.verified_false_accept_rate, 0);
  assert.deepEqual(report.excluded, [{ id: "over", reason: "budget: too much" }]);
  assert.deepEqual(report.cost_per_task_usd, { mean: 0.25, p50: 0.25, p90: 0.25 }, "one task: p50 = p90 = it");
  assert.equal(report.total_cost_usd, 2.75);
});

test("formatFactoryReport names each outcome and every exclusion", () => {
  const text = formatFactoryReport(
    scoreFactoryBench([
      row({ id: "good", pr_url: "https://github.com/acme/scratch/pull/3" }),
      row({ id: "fa", hidden_tests: "fail" }),
      row({ id: "fr", verdict: "fail", hidden_tests: "pass" }),
      row({ id: "gone", excluded: "infra: submit failed: boom" }),
    ]),
  );
  assert.match(text, /ok {3}good .*pull\/3/);
  assert.match(text, /FA {3}fa/);
  assert.match(text, /FR {3}fr/);
  assert.match(text, /success rate:\s+33\.3%/);
  assert.match(text, /1 task\(s\) excluded from every score:\n {2}gone: infra: submit failed: boom/);
});

// --- reading a run report -----------------------------------------------------------------------

test("snapshotFromReport reads the verdict of record's candidate, the cycles, and the ledger", () => {
  const snapshot = snapshotFromReport(
    {
      state: "WAITING_FOR_HUMAN",
      terminal: false,
      finalVerdict: "pass",
      stopReason: null,
      verifications: [
        { candidateSha: "aaa1111", verdict: "fail", completedAt: "2026-10-21T00:00:00Z", verdictOfRecord: false },
        { candidateSha: "bbb2222", verdict: "pass", completedAt: "2026-10-21T00:01:00Z", verdictOfRecord: true },
      ],
      repairAttemptsTaken: 1,
      cost: { totalUsd: 0.42, unpricedModelCalls: 1 },
    },
    { prNumber: 9 },
  );
  assert.deepEqual(snapshot, {
    state: "WAITING_FOR_HUMAN",
    terminal: false,
    settled: true,
    finalVerdict: "pass",
    stopReason: null,
    verdicts: ["fail", "pass"],
    repairTurns: 1,
    costUsd: 0.42,
    costLowerBound: true,
    headSha: "bbb2222",
    prNumber: 9,
  });
  assert.equal(snapshotFromReport({ state: "VERIFYING", terminal: false }).settled, false);
  assert.equal(snapshotFromReport(null).state, "UNKNOWN");
});

// --- the loop, against fakes ----------------------------------------------------------------------

function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms) => void (now += ms) };
}

function fakeClient(script) {
  const calls = { submitted: [], cancelled: [] };
  const polls = new Map();
  return {
    calls,
    client: {
      async submit(task) {
        calls.submitted.push(task.id);
        if (script[task.id] === "throw") throw new Error("deployment said no");
        return { runId: `run-${task.id}` };
      },
      async snapshot(runId) {
        const id = runId.slice(4);
        const n = (polls.get(id) ?? 0) + 1;
        polls.set(id, n);
        const steps = script[id];
        return steps[Math.min(n, steps.length) - 1];
      },
      async cancel(runId, reason) {
        calls.cancelled.push([runId, reason]);
      },
    },
  };
}

const settled = (overrides = {}) => ({
  state: "WAITING_FOR_HUMAN",
  terminal: false,
  settled: true,
  finalVerdict: "pass",
  stopReason: null,
  verdicts: ["pass"],
  repairTurns: 0,
  costUsd: 0.1,
  costLowerBound: false,
  headSha: "abc1234",
  prNumber: 4,
  ...overrides,
});
const running = (overrides = {}) => settled({ state: "IMPLEMENTING", settled: false, finalVerdict: null, verdicts: [], headSha: null, prNumber: null, ...overrides });

function task(id, overrides = {}) {
  return { ...taskJson({ id }), dir: "/nowhere", ...overrides };
}

test("runFactoryBench: follows each run to settled, then asks the hidden tests about its head", async () => {
  const { client } = fakeClient({ a: [running(), running(), settled()], b: [settled({ finalVerdict: "fail", verdicts: ["fail", "fail"], repairTurns: 1, state: "MAX_REPAIR_ATTEMPTS_REACHED", terminal: true })] });
  const asked = [];
  const report = await runFactoryBench([task("a"), task("b")], {
    client,
    clock: fakeClock(),
    runHiddenTests: async (t, head) => {
      asked.push([t.id, head.sha, head.prNumber]);
      return { outcome: "pass" };
    },
  });
  assert.deepEqual(asked, [["a", "abc1234", 4], ["b", "abc1234", 4]]);
  assert.equal(report.tasks[0].pr_url, "https://github.com/acme/scratch/pull/4");
  assert.equal(report.tasks[0].wall_seconds, 20, "two polls of 10s on the injected clock");
  assert.equal(report.successes, 1);
  assert.equal(report.counts.false_rejects, 1);
});

test("runFactoryBench: a run past its budget is cancelled and excluded, not scored", async () => {
  const { client, calls } = fakeClient({ a: [running({ costUsd: 0.5 }), running({ costUsd: 1.2 }), running({ state: "CANCELLED", costUsd: 1.25 })] });
  const report = await runFactoryBench([task("a", { budget_usd: 1 })], {
    client,
    clock: fakeClock(),
    runHiddenTests: async () => assert.fail("an excluded run is not tested"),
  });
  assert.equal(calls.cancelled.length, 1);
  assert.match(calls.cancelled[0][1], /budget/);
  assert.match(report.excluded[0].reason, /^budget: cancelled client-side at \$1\.2000/);
  assert.equal(report.tasks[0].cost_usd, 1.25, "the spend after the cancel");
  assert.equal(report.attempted, 0);
});

test("runFactoryBench: the deployment's own spend cap is a budget exclusion too", async () => {
  const { client } = fakeClient({ a: [settled({ state: "FAILED", terminal: true, stopReason: "spend_cap", finalVerdict: null, verdicts: ["fail"] })] });
  const report = await runFactoryBench([task("a")], { client, clock: fakeClock(), runHiddenTests: async () => assert.fail() });
  assert.match(report.excluded[0].reason, /^budget:/);
});

test("runFactoryBench: a run that never settles is cancelled at its timeout and excluded", async () => {
  const { client, calls } = fakeClient({ a: [running()] });
  const report = await runFactoryBench([task("a", { timeout_minutes: 1 })], {
    client,
    clock: fakeClock(),
    runHiddenTests: async () => assert.fail(),
  });
  assert.equal(calls.cancelled.length, 1);
  assert.match(report.excluded[0].reason, /^timeout: not settled after 1 minute/);
});

test("runFactoryBench: infrastructure outcomes are excluded with a reason, never dropped", async () => {
  const { client } = fakeClient({
    boom: "throw",
    noverify: [settled({ state: "FAILED", terminal: true, finalVerdict: null, verdicts: [], stopReason: "error" })],
    hiddenbroke: [settled()],
  });
  const report = await runFactoryBench([task("boom"), task("noverify"), task("hiddenbroke")], {
    client,
    clock: fakeClock(),
    runHiddenTests: async () => ({ outcome: "not_run", reason: "clone failed" }),
  });
  assert.deepEqual(
    report.excluded.map((e) => [e.id, e.reason.split(":")[0]]),
    [["boom", "infra"], ["noverify", "infra"], ["hiddenbroke", "hidden_tests_not_run"]],
  );
  assert.equal(report.tasks.length, 3);
});

test("runFactoryBench: the total cap stops submitting once a task's budget no longer fits", async () => {
  const { client, calls } = fakeClient({ a: [settled({ costUsd: 1.5 })], b: [settled()], c: [settled()] });
  const report = await runFactoryBench([task("a", { budget_usd: 2 }), task("b", { budget_usd: 2 }), task("c", { budget_usd: 0.5 })], {
    client,
    clock: fakeClock(),
    runHiddenTests: async () => ({ outcome: "pass" }),
  }, { totalCapUsd: 3 });
  assert.deepEqual(calls.submitted, ["a", "c"], "b's $2 would pass $3 after a's $1.50");
  assert.match(report.excluded[0].reason, /^total_budget:/);
});

test("runFactoryBench: with concurrency, in-flight budgets are reserved against the total", async () => {
  const { client, calls } = fakeClient({ a: [running(), settled()], b: [running(), settled()], c: [settled()] });
  const report = await runFactoryBench([task("a", { budget_usd: 2 }), task("b", { budget_usd: 2 }), task("c", { budget_usd: 2 })], {
    client,
    clock: fakeClock(),
    runHiddenTests: async () => ({ outcome: "pass" }),
  }, { totalCapUsd: 4, concurrency: 3 });
  // a and b have spent nothing yet, but either could still spend its whole $2.
  assert.deepEqual(calls.submitted, ["a", "b"]);
  assert.match(report.tasks[2].excluded, /^total_budget: \$4\.00 spent or reserved/);
});

test("runFactoryBench never submits a task aimed at the windkeel repository, however it was built", async () => {
  const { client, calls } = fakeClient({});
  const report = await runFactoryBench([task("self", { repository: "https://github.com/jyothepro/windkeel" })], {
    client,
    clock: fakeClock(),
    runHiddenTests: async () => assert.fail(),
  });
  assert.deepEqual(calls.submitted, []);
  assert.match(report.excluded[0].reason, /^refused:/);
});

// --- the API client, against a fake fetch ----------------------------------------------------------

test("apiBenchClient submits with the budget as the spend cap and reads the report and PR back", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    requests.push([init.method, u.pathname + u.search, init.body ? JSON.parse(init.body) : undefined]);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/v1/repositories") return json({ items: [{ id: "repo-uuid", fullName: "acme/scratch" }], hasNextPage: false, endCursor: null });
    if (u.pathname === "/v1/tasks") return json({ accepted: true, engineeringRunId: "run-1", taskId: "task-1" });
    if (u.pathname === "/v1/runs/run-1") {
      return json({ report: { state: "WAITING_FOR_HUMAN", terminal: false, finalVerdict: "pass", verifications: [{ candidateSha: "abc1234", verdict: "pass", completedAt: "x", verdictOfRecord: true }], repairAttemptsTaken: 0, cost: { totalUsd: 0.3, unpricedModelCalls: 0 }, task: { id: "task-1" } }, rendered: "", terminal: false, cursor: "0" });
    }
    if (u.pathname === "/v1/runs") return json({ items: [{ id: "run-1", prNumber: 12 }], hasNextPage: false, endCursor: null });
    if (u.pathname === "/v1/runs/run-1/cancel") return json({ accepted: true });
    return new Response("{}", { status: 404 });
  };
  const client = apiBenchClient(new WindkeelApi({ baseUrl: "https://factory.example", token: "t", fetch }));
  const t = task("a", { budget_usd: 1.5, timeout_minutes: 30, acceptance_criteria: ["it works"] });
  assert.deepEqual(await client.submit(t), { runId: "run-1" });
  const submitted = requests.find(([, path]) => path === "/v1/tasks")[2];
  assert.deepEqual(submitted, {
    repositoryId: "repo-uuid",
    title: "Do the thing",
    description: "Make the thing happen.\n\n## Acceptance criteria\n\n- [ ] it works\n",
    riskLevel: "low",
    spendCapUsd: 1.5,
    wallClockCapSeconds: 1800,
  });
  const snapshot = await client.snapshot("run-1");
  assert.equal(snapshot.prNumber, 12);
  assert.equal(snapshot.headSha, "abc1234");
  assert.equal(snapshot.costUsd, 0.3);
  await client.cancel("run-1", "why");
  assert.deepEqual(requests.at(-1), ["POST", "/v1/runs/run-1/cancel", { reason: "why" }]);
});

// --- the CLI -------------------------------------------------------------------------------------

test("windkeel bench-factory --dry-run lists the seeded tasks and exits 0", () => {
  const result = runCli(["bench-factory", "bench/factory/tasks", "--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /nothing submitted/);
  const listed = readdirSync(TASKS).filter((d) => !d.startsWith("."));
  for (const id of listed) assert.match(result.stdout, new RegExp(id));
  assert.ok(listed.length >= 8);
});

test("windkeel bench-factory --dry-run --json is the plan, with the caps", () => {
  const result = runCli(["bench-factory", "bench/factory/tasks", "--dry-run", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.dry_run, true);
  assert.ok(plan.tasks.length >= 8);
  assert.equal(plan.task_cap_usd, 2);
  assert.equal(plan.total_cap_usd, 50);
  assert.deepEqual(plan.over_total_cap, []);
});

test("windkeel bench-factory --only narrows the set and refuses an unknown id", () => {
  const one = runCli(["bench-factory", "bench/factory/tasks", "--dry-run", "--json", "--only", "swe-slugify-69"]);
  assert.equal(one.code, 0, one.stderr);
  assert.deepEqual(JSON.parse(one.stdout).tasks.map((t) => t.id), ["swe-slugify-69"]);
  const bad = runCli(["bench-factory", "bench/factory/tasks", "--dry-run", "--only", "nope"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown task\(s\): nope/);
});

test("windkeel bench-factory exits 2 on invalid tasks, listing the problems", () => {
  const root = tasksDir([taskJson({ budget_usd: 0 })]);
  const result = runCli(["bench-factory", root, "--dry-run"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /budget_usd must be a positive number/);
});

test("windkeel bench-factory refuses a live run without WINDKEEL_API_URL, and submits nothing", () => {
  const result = runCli(["bench-factory", "bench/factory/tasks"], { env: { WINDKEEL_API_URL: "", WINDKEEL_API_TOKEN: "" } });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /set WINDKEEL_API_URL/);
});

test("runFactoryBench never submits a task excluded before the run, and says why", async () => {
  const { client, calls } = fakeClient({ b: [settled()] });
  const report = await runFactoryBench(
    [task("a"), task("b")],
    { client, clock: fakeClock(), runHiddenTests: async () => ({ outcome: "pass" }) },
    { preExcluded: new Map([["a", "unchecked_hidden_tests: on base_ref the hidden tests already pass"]]) },
  );
  assert.deepEqual(calls.submitted, ["b"]);
  assert.deepEqual(report.excluded, [{ id: "a", reason: "unchecked_hidden_tests: on base_ref the hidden tests already pass" }]);
  assert.equal(report.attempted, 1);
});

test("windkeel bench-factory checks every task's hidden tests before a live run, and never submits one that does not check out", () => {
  const root = tasksDir([taskJson({ id: "unverifiable", repository: join(tempDir("bf-gone"), "absent.git") })]);
  const result = runCli(["bench-factory", root, "--json"], {
    // Unroutable: a submit would fail loudly rather than reach anything.
    env: { WINDKEEL_API_URL: "http://127.0.0.1:9", WINDKEEL_API_TOKEN: "orq_test_not_a_real_token" },
  });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.attempted, 0);
  assert.equal(report.tasks[0].run_id, null, "never submitted");
  assert.match(report.excluded[0].reason, /^unchecked_hidden_tests: /);
  assert.match(result.stderr, /unverifiable: excluded, its hidden tests did not check out/);
});
