import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../dist/factory/migrate.js";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import {
  ENVIRONMENT_SNAPSHOT_WORKFLOW_ID,
  MERGE_PULL_REQUEST_WORKFLOW_ID,
  MODEL_CREDENTIAL_VALIDATION_WORKFLOW_ID,
  WINDKEEL_RUN_WORKFLOW_ID,
  SLACK_MENTION_FEEDBACK_WORKFLOW_ID,
  VercelWorkflowProvider,
} from "../dist/factory/workflow/vercel.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { SPINE, runConformanceSuite, stage } from "./workflow-conformance.js";
import {
  closeWorkflowRuntime,
  endExecutions,
  flowBuilt,
  runtimeSkip,
  settle,
  workflowRuntime,
} from "./workflow-runtime.js";

/**
 * #195. The acceptance criterion is the *existing* conformance suite, unmodified — so the only
 * question this file really had to answer was **how to run it against Vercel Workflow at all**,
 * which the issue recorded as not yet known.
 *
 * ## The answer: the real runtime, locally, with no Vercel account
 *
 * `workflow@5.0.0-beta.53` resolves its backing through a pluggable **World**, and
 * `@workflow/world-local` is a first-party one that keeps runs, steps, events and streams on
 * disk. So the setup below is:
 *
 * 1. `npm run build` compiles `src/factory/workflow/vercel-flow.ts` with the Workflow SWC
 *    transform into `src/.well-known/workflow/v1/flow.mjs` — the same artifact a Vercel
 *    deployment serves.
 * 2. This file serves that artifact over loopback HTTP and points a local World at it.
 * 3. The provider runs against that World.
 *
 * Everything under test is genuine: the durable journal, step replay, `sleep`, `wakeUp`, the
 * event log. **Nothing about the SDK is mocked** — substituting a mock for Vercel would test the
 * mock, which the issue rules out. What differs from production is the World (filesystem instead
 * of Vercel's queue and storage) and the transport (loopback instead of a deployment). Those are
 * the two things this harness cannot speak for, and they are named again in the PR.
 *
 * So the suite runs in CI on a machine with no Vercel credentials, which was the issue's
 * first-preference option. It is still Postgres-gated, because the provider's truth is Postgres.
 *
 * ## Why `npm test` runs with `--test-force-exit`
 *
 * The SDK's local delivery loop keeps timers inside the *workflow bundle's* realm — a module
 * graph this process can reach but not own. `world.close()` ends the World created here; it
 * cannot end that one, and three `Timeout` handles survive every teardown this file can
 * perform. Without the flag `node --test` completes every assertion and then never exits, which
 * does not read as a leak, it reads as a hung suite.
 *
 * `--test-force-exit` is Node's documented answer and it acts *after* all tests and hooks have
 * finished, so it cannot truncate work. It is recorded here rather than only in package.json
 * because the reason is not obvious from the flag, and because it should be removed if a later
 * SDK release stops holding those timers.
 *
 * ## Why the handler registry is reached through a process global
 *
 * A workflow function is compiled into its own bundle and does not share a module realm with the
 * process that registered the handlers. Handlers are constructed objects holding a pool, a
 * `SandboxProvider` and a `WorkerAdapter`, so no bundler can serialise them in. `vercel.ts`
 * publishes them on a `Symbol.for` global, which *is* shared, and the HTTP server below runs the
 * bundle in this process — so a conformance handler closing over `providerRef` or pushing to a
 * local array works exactly as it does for the other two backings.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);

let schemaCounter = 0;
function nextSchemaSuffix() {
  return `${Date.now()}_${process.pid}_${schemaCounter++}`;
}

/** The legal path from CREATED to any state a test wants to start a run in (ADR-0003). */
const SEED_PATHS = {
  CREATED: [],
  CLASSIFYING: ["CLASSIFYING"],
  PLANNING: ["CLASSIFYING", "PLANNING"],
  WAITING_FOR_APPROVAL: ["CLASSIFYING", "PLANNING", "WAITING_FOR_APPROVAL"],
  PROVISIONING: ["CLASSIFYING", "PLANNING", "PROVISIONING"],
  IMPLEMENTING: ["CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING"],
  VERIFYING: ["CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "VERIFYING"],
};

after(async () => {
  await closeWorkflowRuntime();
});

async function makeSchema() {
  const suffix = nextSchemaSuffix();
  const appSchema = `windkeel_wfv_${suffix}`;
  const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await setup.query(`create schema ${appSchema}`);
  await setup.end();

  const pool = new Pool({
    connectionString: dbUrl,
    ...TEST_POOL,
    options: `-c search_path=${appSchema}`,
  });
  await runMigrations(pool, join(repoRoot, "migrations"));
  await seedFixtureRepository(pool);
  return { appSchema, pool };
}

async function dropSchema(appSchema) {
  const teardown = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await teardown.query(`drop schema if exists ${appSchema} cascade`);
  await teardown.end();
}

function newProvider(appSchema, world, log) {
  return new VercelWorkflowProvider({
    connectionString: dbUrl,
    applicationSchema: appSchema,
    world,
    ...(log ? { log } : {}),
    // A parked run must not hold a test open for five minutes. `wakeUp` still does the real
    // work — this only bounds the case where nothing ever arrives.
    waitSleepMs: 2_000,
    retrySleepMs: 50,
  });
}

async function seedRun(pool, state) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "local",
    sourceReference: "conformance",
    title: "t",
    description: "d",
    acceptanceCriteria: [],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  const run = await insertEngineeringRun(pool, {
    taskId: task.id,
    spendCapUsd: 25,
    wallClockCapSeconds: 7200,
  });
  for (const next of SEED_PATHS[state]) await advanceRun(pool, run.id, next, "test seed");
  return { runId: run.id, seededTransitions: SEED_PATHS[state].length };
}

async function transitionsFor(pool, runId, offset) {
  const { rows } = await pool.query(
    "select from_state, to_state from run_state_transition where engineering_run_id = $1 order by at, id",
    [runId],
  );
  return rows.slice(offset).map((r) => `${r.from_state}->${r.to_state}`);
}

async function makeHarness(handlers) {
  const { world } = await workflowRuntime();
  const { appSchema, pool } = await makeSchema();
  const provider = newProvider(appSchema, world);
  for (const handler of handlers) provider.register(handler);
  await provider.start();

  let offset = 0;
  return {
    provider,
    async seed(state) {
      const { runId, seededTransitions } = await seedRun(pool, state);
      offset = seededTransitions;
      return runId;
    },
    startRun: (runId) => provider.startRun(runId),
    status: (runId) => provider.status(runId),
    settle: (runId) => settle(pool, runId),
    transitions: (runId) => transitionsFor(pool, runId, offset),
    async snapshot(runId) {
      const status = await provider.status(runId);
      return { state: status.state, stopReason: status.stopReason };
    },
    /** The at-least-once case, as it really arrives here: a redelivered start for a live run. */
    async deliverAgain(runId) {
      await provider.startRun(runId);
    },
    async cleanup() {
      await endExecutions(pool);
      await provider.stop();
      await pool.end();
      await dropSchema(appSchema);
    },
  };
}

runConformanceSuite("vercel", makeHarness, { skip });

// --- behaviours specific to this backing ---------------------------------------------------

test("the provider is constructible without a live Postgres — nothing connects in the constructor", () => {
  const provider = new VercelWorkflowProvider({
    connectionString: "postgresql://nobody:nobody@127.0.0.1:1/nope",
  });
  assert.equal(provider.name, "vercel-workflow");
  provider.register(stage("CREATED", "CLASSIFYING"));
});

test("capabilities are declared, and the honest one is false", () => {
  const provider = new VercelWorkflowProvider({ connectionString: "postgresql://x/y" });
  assert.deepEqual(provider.capabilities, {
    durableAcrossRestart: true,
    retriesFailedStages: true,
    // Nothing in this repository has observed a step invocation dying mid-execution and being
    // redelivered. Until something does, `true` here would be a claim a caller would rely on.
    reclaimsExpiredJobs: false,
  });
});

test("using the provider before start() refuses rather than connecting lazily", async () => {
  const provider = new VercelWorkflowProvider({ connectionString: "postgresql://x/y" });
  await assert.rejects(() => provider.startRun("x"), /call start\(\) before/);
  await assert.rejects(() => provider.status("x"), /call start\(\) before/);
});

/**
 * The constant `start()` uses is derived by the Workflow compiler from this file's path and the
 * exported function's name. Renaming either silently changes it, and the failure would surface
 * in production as "runs stopped starting" with nothing in the type system to catch it.
 */
test("the workflow id the provider starts matches the one the build produced", { skip: skip || !flowBuilt }, () => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "src", ".well-known", "workflow", "v1", "manifest.json"), "utf8"),
  );
  const ids = Object.values(manifest.workflows ?? {}).flatMap((file) =>
    Object.values(file).map((entry) => entry.workflowId),
  );
  assert.ok(
    ids.includes(WINDKEEL_RUN_WORKFLOW_ID),
    `WINDKEEL_RUN_WORKFLOW_ID is ${WINDKEEL_RUN_WORKFLOW_ID}; the build produced ${ids.join(", ")}`,
  );
  assert.ok(
    ids.includes(MODEL_CREDENTIAL_VALIDATION_WORKFLOW_ID),
    `MODEL_CREDENTIAL_VALIDATION_WORKFLOW_ID is ${MODEL_CREDENTIAL_VALIDATION_WORKFLOW_ID}; the build produced ${ids.join(", ")}`,
  );
  assert.ok(
    ids.includes(MERGE_PULL_REQUEST_WORKFLOW_ID),
    `MERGE_PULL_REQUEST_WORKFLOW_ID is ${MERGE_PULL_REQUEST_WORKFLOW_ID}; the build produced ${ids.join(", ")}`,
  );
  assert.ok(
    ids.includes(ENVIRONMENT_SNAPSHOT_WORKFLOW_ID),
    `ENVIRONMENT_SNAPSHOT_WORKFLOW_ID is ${ENVIRONMENT_SNAPSHOT_WORKFLOW_ID}; the build produced ${ids.join(", ")}`,
  );
  assert.ok(
    ids.includes(SLACK_MENTION_FEEDBACK_WORKFLOW_ID),
    `SLACK_MENTION_FEEDBACK_WORKFLOW_ID is ${SLACK_MENTION_FEEDBACK_WORKFLOW_ID}; the build produced ${ids.join(", ")}`,
  );
});

test(
  "the durable execution outlives the provider instance that started it",
  { skip },
  async () => {
    const { world } = await workflowRuntime();
    const { appSchema, pool } = await makeSchema();

    // A gate the first provider parks on, so the execution is provably still in flight when that
    // provider goes away.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const ranUnder = [];

    const a = newProvider(appSchema, world);
    for (const handler of SPINE) a.register(handler);
    a.register({
      state: "PROVISIONING",
      name: "parks-until-released",
      async handle() {
        ranUnder.push("a");
        return { kind: "wait", reason: "waiting for the second provider" };
      },
    });
    await a.start();

    const { runId } = await seedRun(pool, "CREATED");
    await a.startRun(runId);
    await settle(pool, runId);
    assert.equal((await a.status(runId)).state, "PROVISIONING");
    assert.deepEqual(ranUnder, ["a"]);

    // Provider A goes away entirely: its pool is closed and its handler registry is unpublished,
    // so nothing of A remains in this process. The execution is still parked in the World.
    await a.stop();

    const b = newProvider(appSchema, world);
    b.register({
      state: "PROVISIONING",
      name: "resumes-under-b",
      async handle() {
        ranUnder.push("b");
        release();
        return { kind: "transition", to: "IMPLEMENTING" };
      },
    });
    await b.start();

    try {
      // Nothing is re-started. The *same* execution is woken, and the step it runs next
      // dispatches into B's registry — which is the claim `durableAcrossRestart` makes: the
      // journal is in the World, not in the process.
      await b.signal(runId, { type: "human_response", actor: "op", text: "carry on" });
      await gate;
      await settle(pool, runId);

      assert.deepEqual(ranUnder, ["a", "b"]);
      assert.equal((await b.status(runId)).state, "IMPLEMENTING");
      assert.deepEqual(await transitionsFor(pool, runId, 0), [
        "CREATED->CLASSIFYING",
        "CLASSIFYING->PLANNING",
        "PLANNING->PROVISIONING",
        "PROVISIONING->IMPLEMENTING",
      ]);
    } finally {
      await endExecutions(pool);
      await b.stop();
      await pool.end();
      await dropSchema(appSchema);
    }
  },
);

test(
  "a stage that throws, and a stage that fails the run, each leave a log line naming the run and the error",
  { skip },
  async () => {
    const { world } = await workflowRuntime();
    const { appSchema, pool } = await makeSchema();
    const logs = [];
    const provider = newProvider(appSchema, world, (message, fields) => logs.push({ message, ...fields }));
    for (const handler of SPINE) provider.register(handler);
    let calls = 0;
    provider.register({
      state: "PROVISIONING",
      name: "flaky-provisioning",
      async handle() {
        calls += 1;
        if (calls === 1) throw new Error("sandbox create timed out");
        return { kind: "transition", to: "IMPLEMENTING", reason: "maker workspace ready" };
      },
    });
    provider.register({
      state: "IMPLEMENTING",
      name: "implementing",
      async handle() {
        return { kind: "transition", to: "FAILED", reason: "implementing failed: codex reports version 0.163.0", stopReason: "error" };
      },
    });
    await provider.start();
    try {
      const { runId } = await seedRun(pool, "CREATED");
      await provider.startRun(runId);
      await settle(pool, runId);
      assert.equal((await provider.status(runId)).state, "FAILED");

      // The retried throw, which used to leave no trace: named, with its stack, and not final.
      const threw = logs.find((l) => l.message === "stage threw");
      assert.ok(threw, `no "stage threw" line in ${JSON.stringify(logs.map((l) => l.message))}`);
      assert.equal(threw.engineeringRunId, runId);
      assert.equal(threw.stage, "flaky-provisioning");
      assert.equal(threw.state, "PROVISIONING");
      assert.equal(threw.attempt, 1);
      assert.equal(threw.final, false);
      assert.equal(threw.error, "sandbox create timed out");
      assert.match(threw.stack, /sandbox create timed out/);

      // The handler-returned failure: the full reason, which the issue comment withholds.
      const ended = logs.find((l) => l.message === "stage ended the run");
      assert.ok(ended);
      assert.equal(ended.engineeringRunId, runId);
      assert.equal(ended.stage, "implementing");
      assert.equal(ended.from, "IMPLEMENTING");
      assert.equal(ended.to, "FAILED");
      assert.equal(ended.stopReason, "error");
      assert.equal(ended.reason, "implementing failed: codex reports version 0.163.0");
    } finally {
      await endExecutions(pool);
      await provider.stop();
      await pool.end();
      await dropSchema(appSchema);
    }
  },
);

test(
  "cancel writes the latch and wakes the execution — it never hard-cancels the run",
  { skip },
  async () => {
    const harness = await makeHarness([
      {
        state: "WAITING_FOR_APPROVAL",
        name: "waits-forever",
        async handle() {
          return { kind: "wait", reason: "nothing will ever arrive" };
        },
      },
    ]);
    try {
      const runId = await harness.seed("WAITING_FOR_APPROVAL");
      await harness.startRun(runId);
      await harness.settle(runId);

      const result = await harness.provider.cancel(runId, "operator changed their mind");
      // Parked, not held by a handler: the latch is recorded and the loop has been woken, but
      // the run row has not moved yet. `settled: false` means "not yet", never "not going to" —
      // and it is what stops a caller assuming the sandbox is already gone.
      assert.equal(result.settled, false);
      assert.equal(result.cancelledJobs, 0, "nothing was deleted; the execution was asked to stop");

      await harness.settle(runId);
      assert.equal((await harness.snapshot(runId)).state, "CANCELLED");
      assert.deepEqual(await harness.transitions(runId), ["WAITING_FOR_APPROVAL->CANCELLED"]);
    } finally {
      await harness.cleanup();
    }
  },
);

test(
  "one engineering run gets one durable execution, by database invariant",
  { skip },
  async () => {
    const harness = await makeHarness([
      {
        state: "WAITING_FOR_APPROVAL",
        name: "parks",
        async handle() {
          return { kind: "wait", reason: "parked" };
        },
      },
    ]);
    try {
      const runId = await harness.seed("WAITING_FOR_APPROVAL");
      const first = await harness.startRun(runId);
      assert.equal(first.enqueued, true);

      // Ten concurrent redeliveries — the shape a retrying GitHub webhook actually has.
      const races = await Promise.all(Array.from({ length: 10 }, () => harness.startRun(runId)));
      assert.deepEqual(
        races.map((r) => r.enqueued),
        Array(10).fill(false),
        "the binding's primary key is what serialises, so concurrency cannot widen it",
      );

      await harness.settle(runId);
      // Still parked where it was, and still carried by exactly one execution: the ten losing
      // calls started nothing, so there is nothing extra to have moved it.
      assert.equal((await harness.snapshot(runId)).state, "WAITING_FOR_APPROVAL");
      assert.deepEqual(await harness.transitions(runId), []);
    } finally {
      await harness.cleanup();
    }
  },
);

// --- the seam holds: no Vercel name escapes this one file -----------------------------------

const srcDir = join(repoRoot, "src");
/**
 * The files allowed to name Vercel Workflow. Every one past the first is there because the SDK
 * forces it, not because it was convenient, and each has to say so in its own header:
 *
 * - `vercel-flow.ts`, because a workflow bundle evaluates its module's top-level imports inside
 *   a `node:vm` sandbox with no `require`, so the workflow function cannot sit beside `pg`.
 * - `deployed-runner.ts` (#213), because a *deployed* step runs in a process that constructed no
 *   provider, so it must build the graph itself — and it therefore imports exactly what
 *   `vercel-flow.ts` is forbidden to import, while needing the same `STAGE_RUNNER_KEY`.
 * - `vercel-deployment.ts` (#213), because checking a deployment means comparing against
 *   `WINDKEEL_RUN_WORKFLOW_ID`, and the alternative was `windkeel doctor` naming it — which is the
 *   exact thing this test exists to prevent. Doctor calls it through a backing-neutral verdict.
 *
 * Four is the whole list, and this test is what keeps it four. A fifth needs an argument of the
 * same kind, in the PR, not a line added here.
 */
const VERCEL_SURFACE = [
  join(srcDir, "factory", "workflow", "vercel.ts"),
  join(srcDir, "factory", "workflow", "vercel-flow.ts"),
  // M9-2's credential check: a workflow module, held to vercel-flow.ts's import rule.
  join(srcDir, "factory", "workflow", "credential-flow.ts"),
  // #371's merge as the person: the same shape, the same rule.
  join(srcDir, "factory", "workflow", "merge-flow.ts"),
  // #312's ignored-mention feedback: the same shape, the same rule.
  join(srcDir, "factory", "workflow", "slack-feedback-flow.ts"),
  join(srcDir, "factory", "workflow", "deployed-runner.ts"),
  join(srcDir, "factory", "workflow", "vercel-deployment.ts"),
];

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return name.endsWith(".ts") ? [p] : [];
  });
}

/** Comments and string literals blanked, so the scan reads code. See postgres-authoritative. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

test("the Workflow SDK is imported only by the files that are allowed to", () => {
  const offenders = [];
  for (const file of sourceFiles(srcDir)) {
    if (VERCEL_SURFACE.includes(file)) continue;
    const source = readFileSync(file, "utf8");
    const code = codeOnly(source);
    if (/from\s*["'](workflow|workflow\/[^"']*|@workflow\/[^"']*)["']/.test(source)) {
      offenders.push(relative(repoRoot, file).split(sep).join("/"));
    }
    if (/\bWINDKEEL_RUN_WORKFLOW_ID\b|\borqonRunFlow\b|\bSTAGE_RUNNER_KEY\b/.test(code)) {
      offenders.push(`${relative(repoRoot, file).split(sep).join("/")} (workflow identity)`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "ADR-0006 §5: a type that leaks its backing cannot be re-backed. Vercel Workflow's API " +
      "surface belongs to src/factory/workflow/vercel.ts alone.\n" +
      offenders.join("\n"),
  );
});

test("provider.ts still names no backing at all", () => {
  const code = codeOnly(readFileSync(join(srcDir, "factory", "workflow", "provider.ts"), "utf8"));
  for (const forbidden of [/\bvercel\b/i, /\bworkflowRun\b/, /\bpg-?boss\b/i]) {
    assert.ok(!forbidden.test(code), `provider.ts must stay backing-neutral; matched ${forbidden}`);
  }
});
