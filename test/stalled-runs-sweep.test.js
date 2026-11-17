/**
 * #340 issue B, item 1: a run whose driving step dies without throwing, and is not redelivered,
 * used to sit at its state forever. The stalled-run sweep re-dispatches it through the normal
 * workflow path, fences off the execution it replaced, and fails it by name once re-dispatch has
 * been tried enough.
 *
 * Run against the real Workflow runtime over `@workflow/world-local` (see workflow-vercel.test.js
 * for why that is the honest harness). A "dead step" is a handler that never returns — the step
 * is in flight and will never touch its binding again, which is exactly what a killed function
 * looks like from Postgres. Staleness is produced by back-dating the binding's heartbeat rather
 * than by waiting thirty minutes.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Pool } from "pg";
import { getRun } from "workflow/api";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { VercelWorkflowProvider } from "../dist/factory/workflow/vercel.js";
import {
  DEFAULT_MAX_RECLAIMS,
  reclaimStalledRuns,
  reclaimStalledRunsLocked,
  stalledAfterMs,
} from "../dist/factory/sweeps/stalled-runs.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { closeWorkflowRuntime, endExecutions, runtimeSkip, settle, workflowRuntime } from "./workflow-runtime.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(async () => {
  await closeWorkflowRuntime();
});

let counter = 0;

async function withProvider(handlers, fn) {
  const { world } = await workflowRuntime();
  const appSchema = `windkeel_stalled_${Date.now()}_${process.pid}_${counter++}`;
  const appSchemaDbUrl = await createMigratedDatabase(appSchema);
  const pool = new Pool({ connectionString: appSchemaDbUrl, ...TEST_POOL, options: `-c search_path=${appSchema}` });
  await seedFixtureRepository(pool);
  const log = [];
  const provider = new VercelWorkflowProvider({
    connectionString: appSchemaDbUrl,
    applicationSchema: appSchema,
    world,
    waitSleepMs: 2_000,
    retrySleepMs: 50,
    log: (message, fields) => log.push({ message, ...fields }),
  });
  for (const handler of handlers) provider.register(handler);
  await provider.start();
  try {
    await fn({ pool, provider, log });
  } finally {
    await endExecutions(pool);
    await provider.stop();
    await pool.end();
    await dropMigratedDatabase(appSchema);
  }
}

async function seedImplementing(pool) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "local",
    sourceReference: "stalled",
    title: "t",
    description: "d",
    acceptanceCriteria: [],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
  for (const to of ["CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING"]) {
    await advanceRun(pool, run.id, to, "test seed");
  }
  return run.id;
}

/** The binding's heartbeat, pushed into the past: what a dead step looks like after `minutes`. */
async function backdate(pool, runId, minutes) {
  await pool.query(
    "update workflow_run_binding set updated_at = now() - ($2::int * interval '1 minute') where engineering_run_id = $1",
    [runId, minutes],
  );
}

async function binding(pool, runId) {
  const { rows } = await pool.query(
    `select phase, execution_handle, execution_token, reclaim_count, reclaimed_at,
            extract(epoch from now() - updated_at) as heartbeat_age_s
       from workflow_run_binding where engineering_run_id = $1`,
    [runId],
  );
  return rows[0];
}

async function runRow(pool, runId) {
  const { rows } = await pool.query("select status, stop_reason from engineering_run where id = $1", [runId]);
  return rows[0];
}

async function transitions(pool, runId) {
  const { rows } = await pool.query(
    "select from_state, to_state, reason from run_state_transition where engineering_run_id = $1 order by at, id",
    [runId],
  );
  return rows.slice(4);
}

async function until(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * An IMPLEMENTING handler whose first delivery dies: it never returns, so its step is in flight
 * forever and never touches the binding again. Later deliveries do `then`.
 */
function dyingFirstDelivery(then) {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    calls,
    release: (outcome) => release(outcome),
    handler: {
      state: "IMPLEMENTING",
      name: "dies-on-first-delivery",
      async handle(context) {
        calls.push(context.attempt);
        if (calls.length === 1) return await gate;
        return then();
      },
    },
  };
}

const reclaimVia = (provider) => (id, options) => provider.reclaimStalled(id, options);

test("the threshold is 30 poll ticks, floored above the longest gap a live step can leave", () => {
  assert.equal(stalledAfterMs(), 30 * 60_000, "30 min at the default 60 s poll");
  assert.ok(stalledAfterMs() > 2 * (800_000 + 60_000), "over twice one step plus one poll sleep");
  assert.equal(stalledAfterMs(1_000), 2 * (800_000 + 1_000), "a short poll interval cannot pull it below the floor");
  assert.equal(stalledAfterMs(5 * 60_000), 150 * 60_000, "a long one moves it up");
  assert.equal(DEFAULT_MAX_RECLAIMS, 3);
});

test(
  "#340 item 1: a run whose step died at `running` is re-dispatched by the sweep, and the dead execution is fenced off",
  { skip },
  async () => {
    const dying = dyingFirstDelivery(() => ({ kind: "transition", to: "VERIFYING", reason: "resumed" }));
    await withProvider([dying.handler], async ({ pool, provider, log }) => {
      const runId = await seedImplementing(pool);
      await provider.startRun(runId);
      await until(() => dying.calls.length === 1, "the first delivery");
      const first = await binding(pool, runId);
      assert.equal(first.phase, "running");

      // The hypothesis, confirmed: neither of the provider's own recovery paths touches it.
      assert.equal(await provider.recoverStranded(runId), false, "signal recovery refuses a `running` binding");
      assert.equal((await provider.startRun(runId)).enqueued, false, "startRun refuses it too");
      assert.equal(dying.calls.length, 1, "and nothing else redelivered the dead step");

      // A live heartbeat is not stalled — the sweep leaves it alone.
      const live = await reclaimStalledRuns({ pool, reclaim: reclaimVia(provider) });
      assert.equal(live.examined, 0);

      // Thirty-one minutes without a heartbeat: provably not a live step.
      await backdate(pool, runId, 31);
      const swept = await reclaimStalledRunsLocked({ pool, reclaim: reclaimVia(provider), log: () => {} });
      assert.equal(swept.kind, "ran");
      assert.equal(swept.result.redispatched, 1, JSON.stringify(swept));

      await until(async () => (await runRow(pool, runId)).status === "VERIFYING", "the re-dispatched run to move");
      await settle(pool, runId);
      assert.equal(dying.calls.length, 2, "the handler ran once more, through the normal path");
      const after = await binding(pool, runId);
      assert.equal(after.reclaim_count, 0, "the committed transition reset the per-state bound");
      assert.ok(after.reclaimed_at, "while the reclaim itself stays on the record");
      assert.notEqual(after.execution_token, first.execution_token, "a new execution, a new token");
      assert.notEqual(after.execution_handle, first.execution_handle);

      // The dead step wakes after all — a late redelivery, or a step that outlived its cap — and
      // tries to commit an outcome for a run someone else is now driving. It must write nothing.
      dying.release({ kind: "transition", to: "FAILED", reason: "the zombie's account", stopReason: "error" });
      await until(() => log.some((l) => /stood down/.test(l.message)), "the replaced execution to stand down");
      await sleep(200);
      assert.equal((await runRow(pool, runId)).status, "VERIFYING", "the replaced execution committed nothing");
      assert.deepEqual(
        (await transitions(pool, runId)).map((t) => `${t.from_state}->${t.to_state}`),
        ["IMPLEMENTING->VERIFYING"],
      );
      assert.equal((await binding(pool, runId)).phase, after.phase, "nor did it touch the new execution's binding");
    });
  },
);

test(
  "#340 item 1: past the re-dispatch bound the run is failed by name, with a recorded transition",
  { skip },
  async () => {
    const dying = dyingFirstDelivery(() => ({ kind: "transition", to: "VERIFYING" }));
    await withProvider([dying.handler], async ({ pool, provider }) => {
      const runId = await seedImplementing(pool);
      await provider.startRun(runId);
      await until(() => dying.calls.length === 1, "the first delivery");
      await pool.query("update workflow_run_binding set reclaim_count = $2 where engineering_run_id = $1", [
        runId,
        DEFAULT_MAX_RECLAIMS,
      ]);
      await backdate(pool, runId, 45);

      const swept = await reclaimStalledRuns({ pool, reclaim: reclaimVia(provider) });
      assert.equal(swept.failedRuns, 1, JSON.stringify(swept));
      const row = await runRow(pool, runId);
      assert.equal(row.status, "FAILED");
      assert.equal(row.stop_reason, "error");
      const [transition] = await transitions(pool, runId);
      assert.equal(`${transition.from_state}->${transition.to_state}`, "IMPLEMENTING->FAILED");
      assert.match(transition.reason, /stopped making progress at IMPLEMENTING.*re-dispatched 3 time/);
      assert.equal((await binding(pool, runId)).phase, "finished");
      assert.equal(dying.calls.length, 1, "no further execution was started");

      dying.release({ kind: "transition", to: "VERIFYING" });
      await sleep(300);
      assert.equal((await runRow(pool, runId)).status, "FAILED", "and the dead one cannot revive it");
    });
  },
);

test(
  "#340 item 1: two sweeps racing over one stalled run dispatch it exactly once",
  { skip },
  async () => {
    const dying = dyingFirstDelivery(() => ({ kind: "transition", to: "VERIFYING" }));
    await withProvider([dying.handler], async ({ pool, provider }) => {
      const runId = await seedImplementing(pool);
      await provider.startRun(runId);
      await until(() => dying.calls.length === 1, "the first delivery");
      await backdate(pool, runId, 31);

      const options = { stalledForMs: stalledAfterMs(), maxReclaims: DEFAULT_MAX_RECLAIMS };
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => provider.reclaimStalled(runId, options)));
      assert.deepEqual(
        outcomes.map((o) => o.kind).sort(),
        ["redispatched", "skipped", "skipped", "skipped", "skipped"],
        "the compare-and-set on staleness admits one",
      );
      await until(async () => (await runRow(pool, runId)).status === "VERIFYING", "the run to move");
      await settle(pool, runId);
      assert.equal(dying.calls.length, 2, "one re-dispatch, one more delivery");
      assert.ok((await binding(pool, runId)).reclaimed_at);
      dying.release({ kind: "settled", observed: "IMPLEMENTING" });
    });
  },
);

test(
  "#340 item 1: a terminal run whose binding still claims a live execution is released, not restarted",
  { skip },
  async () => {
    await withProvider([], async ({ pool, provider }) => {
      const runId = await seedImplementing(pool);
      await advanceRun(pool, runId, "FAILED", "test seed", { stopReason: "error" });
      await pool.query(
        `insert into workflow_run_binding (engineering_run_id, provider, execution_handle, phase, updated_at)
         values ($1, 'vercel-workflow', 'wrun_gone', 'running', now() - interval '2 hours')`,
        [runId],
      );
      const swept = await reclaimStalledRuns({ pool, reclaim: reclaimVia(provider) });
      assert.equal(swept.released, 1, JSON.stringify(swept));
      const after = await binding(pool, runId);
      assert.equal(after.phase, "finished");
      assert.equal(after.execution_handle, "wrun_gone", "nothing was started");
      assert.equal(after.reclaim_count, 0);
    });
  },
);

// --- waiting: a parked run's execution still has a heartbeat -------------------------------

async function seedWaitingForApproval(pool) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "local",
    sourceReference: "stalled-waiting",
    title: "t",
    description: "d",
    acceptanceCriteria: [],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
  for (const to of ["CLASSIFYING", "PLANNING", "WAITING_FOR_APPROVAL"]) {
    await advanceRun(pool, run.id, to, "test seed");
  }
  return run.id;
}

function parksForApproval() {
  const calls = [];
  return {
    calls,
    handler: {
      state: "WAITING_FOR_APPROVAL",
      name: "parks-for-approval",
      async handle(context) {
        calls.push(context.attempt);
        return { kind: "wait", reason: "waiting for an approval" };
      },
    },
  };
}

test(
  "#340 item 1: a `waiting` run whose execution died is re-dispatched and resumes waiting — no stage re-runs, nothing fails",
  { skip },
  async () => {
    const parked = parksForApproval();
    await withProvider([parked.handler], async ({ pool, provider }) => {
      const runId = await seedWaitingForApproval(pool);
      await provider.startRun(runId);
      await settle(pool, runId);
      const before = await binding(pool, runId);
      assert.equal(before.phase, "waiting");

      // The execution dies while parked: hard-cancelled, so nothing it could do on the way out
      // updates the binding — which goes on saying `waiting` about something that is not there.
      await getRun(before.execution_handle).cancel({ cancelReason: "simulated death" });
      await sleep(500);
      const callsAtDeath = parked.calls.length;
      await backdate(pool, runId, 31);

      const swept = await reclaimStalledRuns({ pool, reclaim: reclaimVia(provider) });
      assert.equal(swept.redispatched, 1, JSON.stringify(swept));
      await until(() => parked.calls.length > callsAtDeath, "the new execution's first tick");
      await settle(pool, runId);

      const after = await binding(pool, runId);
      assert.equal(after.phase, "waiting", "the new execution re-entered the wait");
      assert.notEqual(after.execution_handle, before.execution_handle);
      assert.equal(after.reclaim_count, 1);
      assert.equal((await runRow(pool, runId)).status, "WAITING_FOR_APPROVAL", "still waiting, not failed");
      assert.deepEqual(await transitions(pool, runId), [], "no transition: nothing re-ran, nothing moved");

      // And it is live: the parked loop re-ticks on its own (2 s here, 300 s in production),
      // so the heartbeat keeps moving and the sweep will not pick it up again.
      const touched = parked.calls.length;
      await until(() => parked.calls.length > touched, "a re-tick of the parked run", 10_000);
      assert.ok(Number((await binding(pool, runId)).heartbeat_age_s) < 10);
      assert.equal((await reclaimStalledRuns({ pool, reclaim: reclaimVia(provider) })).examined, 0);
    });
  },
);

test(
  "#340 item 1: a live approval wait of hours is never a candidate and never counts against the bound",
  { skip },
  async () => {
    const parked = parksForApproval();
    await withProvider([parked.handler], async ({ pool, provider }) => {
      const runId = await seedWaitingForApproval(pool);
      await provider.startRun(runId);
      await settle(pool, runId);

      // Parked for six hours — but its execution is alive, so its last re-tick was recent. Model
      // the worst a live one can show: one full production wait sleep (5 min) since the touch.
      await pool.query(
        `update workflow_run_binding
            set started_at = now() - interval '6 hours', updated_at = now() - interval '5 minutes'
          where engineering_run_id = $1`,
        [runId],
      );
      const swept = await reclaimStalledRuns({ pool, reclaim: reclaimVia(provider) });
      assert.equal(swept.examined, 0, "a heartbeat younger than the threshold is not stalled, however long the wait");

      // Even asked directly, the compare-and-set refuses it.
      const direct = await provider.reclaimStalled(runId, { stalledForMs: stalledAfterMs(), maxReclaims: DEFAULT_MAX_RECLAIMS });
      assert.equal(direct.kind, "skipped");

      // And the live loop keeps moving the heartbeat on its own.
      const ticks = parked.calls.length;
      await until(() => parked.calls.length > ticks, "a re-tick of the parked run", 10_000);
      const after = await binding(pool, runId);
      assert.ok(Number(after.heartbeat_age_s) < 10, "the re-tick touched the heartbeat");
      assert.equal(after.reclaim_count, 0);
      assert.equal(after.phase, "waiting");
    });
  },
);
