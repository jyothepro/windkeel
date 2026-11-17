import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { FakeGitHubClient } from "../dist/github/fake.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { ScriptedWorkerAdapter } from "../dist/worker/scripted.js";
import { getEngineeringRun } from "../dist/factory/repositories.js";
import { assembleRunReport } from "../dist/factory/run-report.js";
import { createTaskAndRun } from "../dist/billing/admitted-runs.js";
import {
  loadTasks,
  runFactoryBench,
  snapshotFromReport,
  submissionText,
} from "../packages/cli/dist/commands/bench-factory.js";
import { runHiddenTests } from "../packages/cli/dist/commands/bench-factory-hidden.js";
import { bareFixtureRepo, branchHeadsIn, repoRoot, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { startFactory } from "./factory-stack.js";
import { closeWorkflowRuntime, endExecutions, runtimeSkip } from "./workflow-runtime.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * `windkeel bench-factory`'s loop, end to end, against a real factory (#386).
 *
 * Real Postgres, the real workflow runtime and stage handlers, the real verifier running the
 * repository's own `npm test` in a `FakeSandboxProvider` checkout, real pushes to a bare git
 * remote, `FakeGitHubClient` for the pull request, and `ScriptedWorkerAdapter` for the agent — so
 * the factory's verdicts are its own, from a command that really ran, and the hidden tests are the
 * bench's own runner cloning what the factory really pushed. The only thing scripted is what the
 * "agent" writes.
 *
 * Five tasks, one per outcome the report must tell apart:
 *
 * | task          | agent writes                    | verifier | hidden tests | counts as          |
 * |---------------|---------------------------------|----------|--------------|--------------------|
 * | pass          | the fix                         | pass     | pass         | success            |
 * | repaired      | a defect, then the fix          | fail→pass| pass         | success, converted |
 * | false-accept  | the fix, but misses a hidden ask| pass     | fail         | false accept       |
 * | false-reject  | a fix the visible test rejects  | fail     | pass         | false reject       |
 * | plain-fail    | a defect, every turn            | fail     | fail         | plain failure      |
 * | budget        | the fix, at a ruinous token bill| —        | —            | excluded: budget   |
 *
 * **The same honesty caveat as every e2e suite here**: this proves the bench's orchestration and
 * arithmetic against a real factory, not a real agent's success rate. That number comes from the
 * live run recorded in `bench/factory/RESULTS.md`.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);

const REPOSITORY_ID = "11111111-1111-1111-1111-111111111111";
const OWNER = "jyothepro";
const NAME = `windkeel-fixture-${REPOSITORY_ID.slice(0, 8)}`;
const CRITERIA = [{ id: "ac-1", text: "`node index.js` prints the greeting and the farewell" }];

/** The repository's own check: exact output. The verifier runs it; nothing tells it what to think. */
const CHECK_JS = `const { execFileSync } = require("node:child_process");
const out = execFileSync(process.execPath, ["index.js"], { encoding: "utf8" }).trim();
if (out !== "hello\\nbye") {
  console.error("expected 'hello\\\\nbye', got " + JSON.stringify(out));
  process.exit(1);
}
console.log("ok");
`;
const BASE = `console.log("hello");\n`;
const FIX = `console.log("hello");\nconsole.log("bye");\n`;
const DEFECT = `console.log("hello");\nconsole.log("goodbye");\n`;
/** Right by the hidden tests' reading of the task, rejected by the repository's over-strict check. */
const EMPHATIC = `console.log("hello");\nconsole.log("bye!");\n`;

/** Hidden tests: ground truth the maker and the verifier never see. */
const HIDDEN_FAREWELL = `const { execFileSync } = require("node:child_process");
const [first, second] = execFileSync(process.execPath, ["index.js"], { encoding: "utf8" }).trim().split("\\n");
if (first !== "hello" || !/^bye\\b/.test(second ?? "")) { console.error("wrong: " + first + " / " + second); process.exit(1); }
`;
const HIDDEN_SHOUT = `const { execFileSync } = require("node:child_process");
const out = execFileSync(process.execPath, ["index.js", "--shout"], { encoding: "utf8" }).trim();
if (out !== "HELLO\\nBYE") { console.error("did not shout: " + JSON.stringify(out)); process.exit(1); }
`;

const turn = (content, usage = { inputTokens: 500, outputTokens: 100 }) => ({
  apply: async (sandbox) => sandbox.writeFile("index.js", content),
  events: [
    { type: "started", sessionId: "scripted-thread-1" },
    { type: "file_changed", path: "index.js", kind: "update" },
    { type: "completed", usage },
  ],
  diff: { patch: `+${content}`, filesChanged: ["index.js"], truncated: false },
  usage,
});

/** What the "agent" does for each task, picked by the tag in the task's title. */
const SCRIPTS = {
  pass: () => [turn(FIX)],
  repaired: () => [turn(DEFECT), turn(FIX, { inputTokens: 60, outputTokens: 20 })],
  "false-accept": () => [turn(FIX)],
  "false-reject": () => Array.from({ length: 6 }, () => turn(EMPHATIC)),
  "plain-fail": () => Array.from({ length: 6 }, () => turn(DEFECT)),
  // $10 of input at the suite's $0.000001/token: far past a $0.50 budget on the first turn.
  budget: () => [turn(FIX, { inputTokens: 10_000_000, outputTokens: 100 }), turn(FIX)],
};

/**
 * One scripted session per run, chosen from the prompt. Runs are sequential (concurrency 1), so
 * "the current session" is unambiguous.
 */
class RoutingWorker {
  name = "scripted";
  capabilities = { resumableSessions: true, reattachableSessions: false, reattachedSessionsAcceptNewTurns: false };
  current = null;
  started = [];
  async start(input) {
    const tag = /\[bf:([a-z-]+)\]/.exec(input.prompt)?.[1];
    if (!tag || !SCRIPTS[tag]) throw new Error(`no script for prompt: ${input.prompt.slice(0, 80)}`);
    this.started.push(tag);
    this.current = new ScriptedWorkerAdapter(SCRIPTS[tag]());
    return this.current.start(input);
  }
  send(session, message) {
    return this.current.send(session, message);
  }
  events(session) {
    return this.current.events(session);
  }
  poll(session) {
    return this.current.poll(session);
  }
  cancel(session) {
    return this.current.cancel(session);
  }
  result(session) {
    return this.current.result(session);
  }
  reference() {
    return this.current.reference();
  }
  attach() {
    return this.current.attach();
  }
}

function writeTask(root, { tag, base, repository, hidden, budget = 1.5 }) {
  const dir = join(root, tag);
  mkdirSync(join(dir, "hidden"), { recursive: true });
  writeFileSync(join(dir, "hidden", "farewell.check.js"), hidden);
  writeFileSync(
    join(dir, "task.json"),
    JSON.stringify({
      id: `bf-${tag}`,
      source: "real-repo",
      repository,
      base_ref: base,
      title: `[bf:${tag}] Say goodbye too`,
      description: "Add a farewell line to index.js: `node index.js` must print hello then bye.",
      acceptance_criteria: [CRITERIA[0].text],
      hidden_tests: { command: "node farewell.check.js", files: ["farewell.check.js"], timeout_seconds: 60 },
      budget_usd: budget,
      timeout_minutes: 5,
    }),
  );
}

/** The bench's client, in process: the same intake and the same report the API serves. */
function inProcessClient(pool, provider) {
  const cancelled = [];
  return {
    cancelled,
    async submit(task) {
      const { run } = await createTaskAndRun(pool, {
        repositoryId: REPOSITORY_ID,
        sourceType: "local",
        sourceReference: `bench-factory:${task.id}`,
        title: task.title,
        description: submissionText(task),
        criteria: CRITERIA,
        riskLevel: "low",
        // What `POST /v1/tasks` does with `spendCapUsd` / `wallClockCapSeconds`.
        rails: { spendCapUsd: task.budget_usd, wallClockCapSeconds: task.timeout_minutes * 60 },
      });
      await provider.startRun(run.id);
      return { runId: run.id };
    },
    async snapshot(runId) {
      // Through JSON, as the report crosses the API.
      const report = JSON.parse(JSON.stringify(await assembleRunReport(pool, runId)));
      const run = await getEngineeringRun(pool, runId);
      return snapshotFromReport(report, { prNumber: run.prNumber });
    },
    async cancel(runId, reason) {
      cancelled.push([runId, reason]);
    },
  };
}

after(async () => {
  await closeWorkflowRuntime();
});

test(
  "bench-factory against a real factory: success, repair conversion, false accept, false reject, budget",
  { skip, timeout: 600_000 },
  async () => {
    const schema = `windkeel_bfe2e_${Date.now()}_${process.pid}`;
    const schemaDbUrl = await createMigratedDatabase(schema);
    const schemaUrl = `${schemaDbUrl}${schemaDbUrl.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
    const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
    const remote = bareFixtureRepo({ test: "node check.js" }, { "check.js": CHECK_JS, "index.js": BASE });
    const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: remote.source, encoding: "utf8" }).stdout.trim();
    const defaultBranch = spawnSync("git", ["--git-dir", remote.bare, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim() || "main";
    const github = new FakeGitHubClient(
      {
        repositories: [
          { owner: OWNER, name: NAME, defaultBranch, issues: [], collaborators: { jyothepro: { permission: "admin", roleName: "admin" } } },
        ],
      },
      { resolveBranchHead: branchHeadsIn(remote.bare) },
    );
    const worker = new RoutingWorker();
    let stack;
    try {
      await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
      stack = await startFactory(
        {
          databaseUrl: schemaUrl,
          repository: { url: remote.bare, baseRevision: "HEAD" },
          makerModel: "gpt-5-codex",
          makerVendor: "openai",
          modelApiDomain: "api.openai.com",
          modelKeyEnvVar: "OPENAI_API_KEY",
          modelPricing: { usdPerInputToken: 0.000_001, usdPerOutputToken: 0.000_01 },
          usdPerCpuMs: 0,
          usdPerEgressByte: 0,
          railsCheckIntervalMs: 1_000,
          workspaceTtlMs: 600_000,
          gitHost: "github.com",
          gitAuthorName: "Windkeel Factory",
          gitAuthorEmail: "factory@windkeel.invalid",
          policyVersion: "bench-factory-e2e",
          codex: { binary: "codex", pinnedVersion: "0.0.0-e2e", allowVersionDrift: false },
          checkerEndpoints: [],
        },
        { applicationSchema: schema, sandboxes: new FakeSandboxProvider(), worker, github },
      );
      stack.deps.config.fakeSecurity = join(repoRoot, "test", "fixtures", "no-scanners.json");
      const scripted = (name, value) => {
        const path = join(tempDir(name), `${name}.json`);
        writeFileSync(path, JSON.stringify(value));
        return path;
      };
      // Clean and constant for every run: the repository's own check is what decides.
      stack.deps.config.checkerModels.fakes = {
        review: scripted("review", { summary: "no defects found", findings: [] }),
        mapping: scripted("mapping", {
          mappings: [{ criterion: "ac-1", status: "satisfied", evidence: ["ev-01"], reason: "the repo's own checks decide" }],
        }),
      };
      stack.deps.evidence = {
        storage: { putPackage: async () => {}, deletePackage: async () => {} },
        bucket: "evidence",
      };

      const root = tempDir("bf-e2e-tasks");
      const order = ["pass", "repaired", "false-accept", "false-reject", "plain-fail", "budget"];
      for (const tag of order) {
        writeTask(root, {
          tag,
          base,
          repository: remote.bare,
          hidden: tag === "false-accept" ? HIDDEN_SHOUT : HIDDEN_FAREWELL,
          ...(tag === "budget" ? { budget: 0.5 } : {}),
        });
      }
      // loadTasks sorts by directory; keep the table's order by naming the ids explicitly.
      const byId = new Map(loadTasks(root).map((t) => [t.id, t]));
      const tasks = order.map((tag) => byId.get(`bf-${tag}`));

      const client = inProcessClient(pool, stack.provider);
      const report = await runFactoryBench(
        tasks,
        { client, runHiddenTests: (task, head) => runHiddenTests(task, head) },
        { pollMs: 250, totalCapUsd: 50 },
      );
      const row = (tag) => report.tasks.find((t) => t.id === `bf-${tag}`);
      const describe = JSON.stringify(report.tasks, null, 2);

      assert.deepEqual(worker.started, order, "every task reached the maker, in order");

      // (1) success
      assert.equal(row("pass").verdict, "pass", describe);
      assert.equal(row("pass").hidden_tests, "pass", describe);
      assert.equal(row("pass").state, "WAITING_FOR_HUMAN");
      assert.match(row("pass").head_sha, /^[0-9a-f]{40}$/);

      // (2) a genuine fail → repair → pass
      assert.equal(row("repaired").first_verdict, "fail", describe);
      assert.equal(row("repaired").verdict, "pass", describe);
      assert.equal(row("repaired").repair_turns, 1);
      assert.equal(row("repaired").hidden_tests, "pass");

      // (3) the verifier passed a change the hidden tests reject
      assert.equal(row("false-accept").verdict, "pass", describe);
      assert.equal(row("false-accept").hidden_tests, "fail", describe);

      // (4) stuck on a change the hidden tests accept → false reject; on one they reject → plain failure
      assert.equal(row("false-reject").verdict, "fail", describe);
      assert.equal(row("false-reject").hidden_tests, "pass", describe);
      assert.equal(row("plain-fail").verdict, "fail", describe);
      assert.equal(row("plain-fail").hidden_tests, "fail", describe);
      for (const tag of ["false-reject", "plain-fail"]) {
        assert.equal(row(tag).state, "MAX_REPAIR_ATTEMPTS_REACHED", `${tag}: ${describe}`);
      }

      // (5) over budget → excluded, with the reason, and in no score
      assert.match(row("budget").excluded ?? "", /^budget:/, describe);
      assert.equal(row("budget").hidden_tests, "not_run");

      assert.equal(report.attempted, 5);
      assert.equal(report.successes, 2);
      assert.equal(report.success_rate, 0.4);
      assert.equal(report.verified_false_accept_rate, Number((1 / 3).toFixed(4)));
      assert.equal(report.verified_false_reject_rate, 0.5);
      assert.equal(report.repair_conversion_rate, Number((1 / 3).toFixed(4)), "repaired / (repaired, false-reject, plain-fail)");
      assert.deepEqual(report.excluded.map((e) => e.id), ["bf-budget"]);

      // Cost is the ledger's: each row equals the run's cost_event sum.
      for (const result of report.tasks) {
        const { rows } = await pool.query("select coalesce(sum(usd), 0)::float8 as usd from cost_event where engineering_run_id = $1", [result.run_id]);
        assert.equal(result.cost_usd, Number(rows[0].usd.toFixed(6)), `${result.id}: report cost vs ledger`);
      }
      const scoredCost = report.tasks.filter((t) => !t.excluded).reduce((s, t) => s + t.cost_usd, 0);
      assert.equal(report.cost_per_success_usd, Number((scoredCost / 2).toFixed(6)));
      assert.ok(row("budget").cost_usd > 0.5, "the budget run really did spend past its cap");

      // Every passing run delivered a draft PR, and the report links it from the run row.
      const pulls = await github.listPullRequests({ repository: { owner: OWNER, name: NAME }, state: "all" });
      assert.equal(pulls.length, 3, "pass, repaired and false-accept opened pull requests");
      /*
       * Whichever sees it first stops the budget run: the deployment's spend rail at its next stage
       * boundary, or the bench's own poll reading the ledger past the cap. Both are correct, so the
       * assertion is that nothing *else* was ever cancelled.
       */
      for (const [runId] of client.cancelled) assert.equal(runId, row("budget").run_id);
    } finally {
      await endExecutions(pool).catch(() => {});
      await stack?.stop().catch(() => {});
      await pool.end();
      await dropMigratedDatabase(schema);
    }
  },
);
