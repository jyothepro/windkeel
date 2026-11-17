/**
 * ORQ-10: a run whose organization loses its repository grant stops at its next stage, whatever
 * stage that is — including one the recovery sweeps re-dispatch — instead of provisioning a sandbox
 * with the repository's write token, steering a maker or opening a pull request.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { registerStageHandlers } from "../dist/factory/stage-wiring.js";
import { GRANT_REVOKED_REASON, LIVE_SESSION_STATES, withRepositoryGrant } from "../dist/factory/workflow/repository-grant-gate.js";
import { FIXTURE_REPOSITORY_ID, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let serial = 0;
async function withRun(fn) {
  const schema = `windkeel_grant_gate_test_${Date.now()}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const task = await insertEngineeringTask(pool, {
      repositoryId: FIXTURE_REPOSITORY_ID,
      sourceType: "api",
      sourceReference: "api:grant-gate:1",
      title: "t",
      description: "- [ ] works",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    await fn({ pool, task, run });
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

function context(run, state) {
  return {
    engineeringRunId: run.id,
    state,
    attempt: 1,
    isCancellationRequested: async () => false,
    takeSignals: async () => [],
    runs: null,
  };
}

const revoke = (pool) =>
  pool.query("delete from repository_grant where repository_id = $1 and organization_id = (select id from organization where is_default)", [
    FIXTURE_REPOSITORY_ID,
  ]);

test("a granted run's stage runs as before; once the grant is gone the stage cancels the run without running", { skip }, async () => {
  await withRun(async ({ pool, run }) => {
    let calls = 0;
    const inner = {
      state: "PROVISIONING",
      name: "provisioning",
      async handle() {
        calls++;
        return { kind: "transition", to: "IMPLEMENTING", reason: "maker workspace ready" };
      },
    };
    const gated = withRepositoryGrant({ pool }, inner);
    assert.equal(gated.state, "PROVISIONING");
    assert.equal(gated.name, "provisioning");

    assert.deepEqual(await gated.handle(context(run, "PROVISIONING")), {
      kind: "transition",
      to: "IMPLEMENTING",
      reason: "maker workspace ready",
    });
    assert.equal(calls, 1);

    await revoke(pool);
    assert.deepEqual(await gated.handle(context(run, "PROVISIONING")), {
      kind: "transition",
      to: "CANCELLED",
      reason: GRANT_REVOKED_REASON,
    });
    assert.equal(calls, 1, "the stage itself never ran: no token minted, no sandbox, no PR");
  });
});

test("every registered stage is gated, so nothing a sweep re-dispatches can act on an ungranted repository", { skip }, async () => {
  await withRun(async ({ pool, run }) => {
    const registered = [];
    const provider = { register: (handler) => registered.push(handler) };
    registerStageHandlers(provider, { pool, config: {} });
    const states = registered.map((h) => h.state);
    for (const expected of ["CREATED", "CLASSIFYING", "PLANNING", "WAITING_FOR_APPROVAL", "PROVISIONING", "IMPLEMENTING", "VERIFYING", "REPAIRING", "PR_CREATING", "PR_READY", "WAITING_FOR_HUMAN"]) {
      assert.ok(states.includes(expected), `${expected} has a handler`);
    }

    await revoke(pool);
    // The stages that hold nothing live are refused without running (these deps could not run them).
    for (const handler of registered.filter((h) => !LIVE_SESSION_STATES.has(h.state))) {
      const outcome = await handler.handle(context(run, handler.state));
      assert.deepEqual(outcome, { kind: "transition", to: "CANCELLED", reason: GRANT_REVOKED_REASON }, handler.name);
    }
  });
});

test("a live stage runs its own cancellation path when the grant is gone, then the run is cancelled", { skip }, async () => {
  await withRun(async ({ pool, run }) => {
    const seen = [];
    const live = (outcome) => ({
      state: "IMPLEMENTING",
      name: "implementing",
      async handle(ctx) {
        seen.push(await ctx.isCancellationRequested());
        return outcome;
      },
    });

    // Granted: the stage sees no cancellation, and its outcome stands.
    const granted = await withRepositoryGrant({ pool }, live({ kind: "poll", afterMs: 1000, reason: "working" })).handle(context(run, "IMPLEMENTING"));
    assert.equal(granted.kind, "poll");
    assert.deepEqual(seen, [false]);

    await revoke(pool);
    // Gone: the stage is told cancellation is requested (so it stops the agent and tears down),
    // and whatever it answers, the run ends CANCELLED with the reason.
    const settled = await withRepositoryGrant({ pool }, live({ kind: "settled", observed: "IMPLEMENTING", note: "cancellation observed" })).handle(
      context(run, "IMPLEMENTING"),
    );
    assert.deepEqual(settled, { kind: "transition", to: "CANCELLED", reason: GRANT_REVOKED_REASON });
    assert.deepEqual(seen, [false, true]);

    // A stage that ended the run itself (a rail, an error) keeps its terminal outcome.
    const failed = { kind: "transition", to: "FAILED", reason: "spend_cap", stopReason: "spend_cap" };
    assert.deepEqual(await withRepositoryGrant({ pool }, live(failed)).handle(context(run, "IMPLEMENTING")), failed);
  });
});

test("a grant held by another organization does not count: the run's own organization must hold it", { skip }, async () => {
  await withRun(async ({ pool, run }) => {
    const other = (
      await pool.query(
        `insert into organization (account_id, name) select account_id, 'platform' from organization where is_default returning id`,
      )
    ).rows[0].id;
    await revoke(pool);
    await pool.query("insert into repository_grant (organization_id, repository_id, intake) values ($1, $2, true)", [
      other,
      FIXTURE_REPOSITORY_ID,
    ]);
    const gated = withRepositoryGrant({ pool }, { state: "CREATED", name: "x", handle: async () => assert.fail("ran") });
    assert.equal((await gated.handle(context(run, "CREATED"))).to, "CANCELLED");
  });
});

test("createTaskFromIntake refuses a task for an organization with no grant on the repository", { skip }, async () => {
  await withRun(async ({ pool }) => {
    const createTask = await import("../dist/intake/create-task.js");
    const { createTaskFromIntake } = createTask;
    const other = (
      await pool.query(
        `insert into organization (account_id, name) select account_id, 'platform' from organization where is_default returning id`,
      )
    ).rows[0].id;
    const before = (await pool.query("select count(*)::int as n from engineering_task")).rows[0].n;
    await assert.rejects(
      createTaskFromIntake(
        pool,
        {
          organizationId: other,
          repositoryId: FIXTURE_REPOSITORY_ID,
          sourceType: "slack",
          sourceReference: "slack:T1:ev1",
          title: "fix it",
          description: "fix it",
        },
        { startRun: async () => assert.fail("nothing may be enqueued") },
      ),
      createTask.RepositoryNotGrantedError,
    );
    assert.equal((await pool.query("select count(*)::int as n from engineering_task")).rows[0].n, before);
  });
});

test("a retried keyed delivery does not re-enqueue the first attempt's run once that task's grant is gone", { skip }, async () => {
  await withRun(async ({ pool }) => {
    const { createTaskFromIntake } = await import("../dist/intake/create-task.js");
    const org = (await pool.query("select id from organization where is_default")).rows[0].id;
    const input = {
      organizationId: org,
      repositoryId: FIXTURE_REPOSITORY_ID,
      sourceType: "slack",
      sourceReference: "slack:T1:retry",
      title: "fix it",
      description: "fix it",
    };
    const started = [];
    const deps = {
      startRun: async (runId) => {
        started.push(runId);
        return { enqueued: true };
      },
    };
    const first = await createTaskFromIntake(pool, input, deps);
    // The hand-over failed, so the run is still CREATED and a retry would normally re-enqueue it.
    const healed = await createTaskFromIntake(pool, input, deps);
    assert.equal(healed.created, false);
    await healed.afterCommit();
    assert.deepEqual(started, [first.runId]);

    await revoke(pool);
    const retried = await createTaskFromIntake(pool, input, deps);
    assert.equal(retried.taskId, first.taskId);
    assert.deepEqual(await retried.afterCommit(), { enqueued: false });
    assert.deepEqual(started, [first.runId], "not re-enqueued on a repository its organization lost");
  });
});
