import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../dist/factory/migrate.js";
import {
  insertEngineeringRun,
  insertEngineeringTask,
  updateEngineeringRun,
} from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { createWaitingForHumanHandler } from "../dist/factory/workflow/handlers/pr-creating.js";
import { VercelWorkflowProvider } from "../dist/factory/workflow/vercel.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { closeWorkflowRuntime, endExecutions, runtimeSkip, settle, workflowRuntime } from "./workflow-runtime.js";

/**
 * #261: a run parked for a human outliving the loop that carries it.
 *
 * `orqonRunFlow` is a bounded loop, and the bound was budgeted for a run parked for its 7200 s
 * wall-clock cap — 24 sleeps. `WAITING_FOR_HUMAN` is the one state that is explicitly *not* that:
 * its handler says a run parked there "can wait as long as the human takes". At 2000 ticks of
 * 300 s that promise expired after 6.9 days, and the merge that followed was recorded as a
 * `run_signal` row and then ignored, because `wake()` has nothing left to wake.
 *
 * The question these cases ask is the one an operator asks: **can a run that waited too long
 * still be finished by a human?** Everything else here exists to keep the answer from being
 * bought at the price of something else — a signal that now takes the slow path, or a second
 * execution over one run.
 *
 * The tick bound is injected rather than waited out: `maxTicks` travels on the same options
 * object `waitSleepMs` does, so a run exhausts its budget in two ticks and a couple of seconds.
 * Nothing else about the run differs from the one that took a week.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);

let counter = 0;

after(async () => {
  await closeWorkflowRuntime();
});

async function makeSchema() {
  const schema = `windkeel_ticks_${Date.now()}_${process.pid}_${counter++}`;
  const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await setup.query(`create schema ${schema}`);
  await setup.end();
  const pool = new Pool({
    connectionString: dbUrl,
    ...TEST_POOL,
    options: `-c search_path=${schema}`,
  });
  await runMigrations(pool, join(repoRoot, "migrations"));
  await seedFixtureRepository(pool);
  return { schema, pool };
}

async function dropSchema(schema) {
  const teardown = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await teardown.query(`drop schema if exists ${schema} cascade`);
  await teardown.end();
}

/** The ADR-0003 path to the parking state, and the PR number the merge signal arrives about. */
const PR_NUMBER = 90;

let seeded = 0;

async function seedParkedRun(pool) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "github_issue",
    // Unique per task: a `github_issue` source reference is one issue, and one schema here holds
    // more than one run.
    sourceReference: `jyothepro/content-machine#${++seeded}`,
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
  for (const state of [
    "CLASSIFYING",
    "PLANNING",
    "PROVISIONING",
    "IMPLEMENTING",
    "VERIFYING",
    "PR_CREATING",
    "PR_READY",
    "WAITING_FOR_HUMAN",
  ]) {
    await advanceRun(pool, run.id, state, "test seed");
  }
  await updateEngineeringRun(pool, run.id, { prNumber: PR_NUMBER });
  return run.id;
}

/**
 * The real `WAITING_FOR_HUMAN` handler, with no GitHub client.
 *
 * ADR-0016's hermetic shape, and it is the right one here: `measureHumanCommits` then records
 * `unknown` with a reason rather than a flattering zero, and the transition these cases turn on
 * — merged → COMPLETED — is the handler's own, not a stand-in for it.
 */
function handlerFor(pool) {
  return createWaitingForHumanHandler({
    pool,
    github: undefined,
    config: { gitAuthorEmail: "factory@windkeel.invalid" },
  });
}

function newProvider(schema, world, overrides = {}) {
  return new VercelWorkflowProvider({
    connectionString: dbUrl,
    applicationSchema: schema,
    world,
    waitSleepMs: 2_000,
    retrySleepMs: 50,
    ...overrides,
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Waits until the loop stops calling the handler — the end of the execution, observed from
 * outside it and without asking the SDK anything.
 *
 * `quietMs` is several wait intervals wide on purpose. A loop that is merely between ticks goes
 * quiet for one interval; a loop that has returned goes quiet forever, and the difference is the
 * only thing the failing case is about.
 */
async function waitForTicksToStop(ticks, quietMs = 4_000, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let since = Date.now();
  while (Date.now() < deadline) {
    const now = ticks();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return now;
    }
    await sleep(50);
  }
  throw new Error(
    `the loop was still ticking after ${timeoutMs}ms (${ticks()} ticks) — its bound never stopped it`,
  );
}

async function bindingRow(pool, runId) {
  const { rows } = await pool.query(
    "select * from workflow_run_binding where engineering_run_id = $1",
    [runId],
  );
  return rows[0] ?? null;
}

const MERGED = {
  type: "external_event",
  source: "github",
  name: "pull_request.closed",
  payload: { merged: true, pullNumber: PR_NUMBER, mergedAt: null },
};

/**
 * The case as it fails without adoption: the execution has ended, and the human merges anyway.
 *
 * The run is driven to `WAITING_FOR_HUMAN` with a three-tick budget, the handler is counted until
 * it stops being called — which is the execution ending, observed from outside — and only then is
 * the merge delivered. Without `signal()` adopting, the `run_signal` row lands, `wake()` finds a
 * binding with nothing behind it, and the run sits at `WAITING_FOR_HUMAN` forever.
 */
test("a merge delivered after the tick budget ran out still completes the run", { skip }, async () => {
  const { world } = await workflowRuntime();
  const { schema, pool } = await makeSchema();
  const provider = newProvider(schema, world, { waitSleepMs: 50, maxTicks: 3 });
  let ticks = 0;
  const handler = handlerFor(pool);
  provider.register({
    ...handler,
    async handle(context) {
      ticks += 1;
      return await handler.handle(context);
    },
  });
  await provider.start();
  try {
    const runId = await seedParkedRun(pool);
    await provider.startRun(runId);

    // The budget is spent, and then the handler stops being called — which is what the end of
    // the execution looks like to anyone outside it.
    assert.equal(
      await waitForTicksToStop(() => ticks),
      3,
      "the loop stopped at its bound rather than ticking on",
    );
    assert.equal(
      (await provider.status(runId)).state,
      "WAITING_FOR_HUMAN",
      "the run is exactly where the week-long one is: parked, non-terminal, nothing carrying it",
    );

    await provider.signal(runId, MERGED);
    await settle(pool, runId);

    const status = await provider.status(runId);
    assert.equal(status.state, "COMPLETED", "the human's merge finished the run");
    assert.equal(status.pendingSignals, 0, "and the signal was consumed rather than stranded");
  } finally {
    await endExecutions(pool);
    await provider.stop();
    await pool.end();
    await dropSchema(schema);
  }
});

/**
 * Reaching the bound is described in the loop's own comment as "a bug, not a state", and it was
 * indistinguishable from an orderly finish — so this asserts both halves: that a run which fell
 * off its bound says so, and that a run which simply finished does not.
 *
 * The binding's `phase` matters as much as the timestamp. The loop used to return without
 * touching it, leaving a row claiming a live execution that no longer existed — which is both a
 * lie to `status()` and the reason nothing could ever pick the run up again.
 */
test("a run that reaches its tick bound records that it did", { skip }, async () => {
  const { world } = await workflowRuntime();
  const { schema, pool } = await makeSchema();
  const provider = newProvider(schema, world, { waitSleepMs: 50, maxTicks: 2 });
  provider.register(handlerFor(pool));
  await provider.start();
  try {
    const exhausted = await seedParkedRun(pool);
    await provider.startRun(exhausted);
    await waitFor(
      "the exhausted run to be recorded",
      async () => (await bindingRow(pool, exhausted))?.tick_budget_exhausted_at != null,
    );

    const binding = await bindingRow(pool, exhausted);
    assert.equal(
      binding.phase,
      "finished",
      "the execution has ended, and the binding says so rather than claiming a live one",
    );
    assert.equal(
      (await provider.status(exhausted)).state,
      "WAITING_FOR_HUMAN",
      "and the run row is untouched — running out of ticks says nothing about where the run is",
    );

    // An orderly finish, for contrast: the same handler, the same provider, a run that ends
    // because it ran out of work rather than out of ticks.
    const orderly = await seedParkedRun(pool);
    await provider.startRun(orderly);
    await provider.signal(orderly, MERGED);
    await settle(pool, orderly);

    const finished = await bindingRow(pool, orderly);
    assert.equal((await provider.status(orderly)).state, "COMPLETED");
    assert.equal(finished.phase, "finished");
    assert.equal(
      finished.tick_budget_exhausted_at,
      null,
      "an orderly finish is distinguishable from a run that fell off its bound",
    );
  } finally {
    await endExecutions(pool);
    await provider.stop();
    await pool.end();
    await dropSchema(schema);
  }
});

// --- and the normal path is not paid for it ---------------------------------------------------

/**
 * The regression adoption could easily cause.
 *
 * A signal to a *live* execution must still be carried by `wakeUp()` — a fix that routed every
 * signal through `startRun` would pass the case above and quietly make every merge start a new
 * execution. The evidence is the binding row rather than a call count: `startRun`'s conditional
 * insert rewrites `execution_handle` and `started_at`, so an unchanged pair means the run was
 * finished by the execution that was already carrying it.
 */
test("a merge delivered to a live execution is still carried by the same one", { skip }, async () => {
  const { world } = await workflowRuntime();
  const { schema, pool } = await makeSchema();
  const provider = newProvider(schema, world);
  provider.register(handlerFor(pool));
  await provider.start();
  try {
    const runId = await seedParkedRun(pool);
    await provider.startRun(runId);
    await settle(pool, runId);

    const before = await bindingRow(pool, runId);
    assert.equal(before.phase, "waiting", "the execution is alive and parked on a sleep");

    await provider.signal(runId, MERGED);
    await settle(pool, runId);

    assert.equal((await provider.status(runId)).state, "COMPLETED");
    const after = await bindingRow(pool, runId);
    assert.equal(after.execution_handle, before.execution_handle, "no second execution was started");
    assert.deepEqual(after.started_at, before.started_at, "and the binding was never re-claimed");
  } finally {
    await endExecutions(pool);
    await provider.stop();
    await pool.end();
    await dropSchema(schema);
  }
});

/**
 * Production's actual shape, and the one a provider-local handler map gets wrong.
 *
 * The process that receives `pull_request.closed` is the webhook ingress, and it registers **no
 * handlers at all** — structurally, so that ADR-0002 §3's "the ingress never orchestrates" cannot
 * be violated by accident. The process that runs stages is the deployed step host, which
 * registers every one. So "is there a handler for this state" is not a question the signalling
 * process can answer about itself, and an adoption that asked it that way would do nothing in the
 * only deployment that matters.
 *
 * Here the two processes are two providers over one schema and one World: `host` holds the
 * handlers and the published stage runner, `ingress` holds neither and does nothing but signal.
 */
test("a signalling process with no handlers of its own still gets the run picked up", { skip }, async () => {
  const { world } = await workflowRuntime();
  const { schema, pool } = await makeSchema();
  const host = newProvider(schema, world, { waitSleepMs: 50, maxTicks: 2 });
  host.register(handlerFor(pool));
  await host.start();
  const ingress = newProvider(schema, world);
  await ingress.start();
  try {
    const runId = await seedParkedRun(pool);
    await host.startRun(runId);
    await waitFor(
      "the run to exhaust its tick budget",
      async () => (await bindingRow(pool, runId))?.tick_budget_exhausted_at != null,
    );

    // Everything from here is the ingress's: it persists the merge and returns, and it cannot
    // execute a stage even by mistake. The steps of the execution it starts are served by the
    // stage runner `host` published, exactly as a deployment's flow route serves them.
    await ingress.signal(runId, MERGED);
    await settle(pool, runId);

    const status = await ingress.status(runId);
    assert.equal(status.state, "COMPLETED");
    assert.equal(status.pendingSignals, 0);
  } finally {
    await endExecutions(pool);
    await ingress.stop();
    await host.stop();
    await pool.end();
    await dropSchema(schema);
  }
});

/**
 * Adoption is a `startRun`, and `startRun` races itself by design: its conditional update is
 * guarded by `where workflow_run_binding.phase = 'finished'`, so the loser writes nothing. A
 * signal arriving at the same moment as an operator's redelivery must therefore still produce
 * **one** execution.
 *
 * The invariant asserted is the binding's primary key — one row, one handle — rather than how
 * many times anything was called.
 */
test("a signal racing a startRun over an exhausted run produces one execution", { skip }, async () => {
  const { world } = await workflowRuntime();
  const { schema, pool } = await makeSchema();
  const provider = newProvider(schema, world, { waitSleepMs: 50, maxTicks: 2 });
  provider.register(handlerFor(pool));
  await provider.start();
  try {
    const runId = await seedParkedRun(pool);
    await provider.startRun(runId);
    await waitFor(
      "the run to exhaust its tick budget",
      async () => (await bindingRow(pool, runId))?.tick_budget_exhausted_at != null,
    );

    const outcomes = await Promise.all([
      provider.signal(runId, MERGED),
      provider.startRun(runId),
      provider.startRun(runId),
      provider.startRun(runId),
    ]);
    const enqueued = outcomes.slice(1).filter((r) => r.enqueued).length;
    assert.ok(enqueued <= 1, `at most one caller may claim the run; ${enqueued} did`);

    await settle(pool, runId);
    const { rows } = await pool.query("select count(*)::int as n from workflow_run_binding");
    assert.equal(rows[0].n, 1, "one engineering run, one binding row, one execution");
    assert.equal((await provider.status(runId)).state, "COMPLETED");

    const { rows: transitions } = await pool.query(
      "select count(*)::int as n from run_state_transition where engineering_run_id = $1 and to_state = 'COMPLETED'",
      [runId],
    );
    assert.equal(transitions[0].n, 1, "and the run was completed once, not twice");
  } finally {
    await endExecutions(pool);
    await provider.stop();
    await pool.end();
    await dropSchema(schema);
  }
});
