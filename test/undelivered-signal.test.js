import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../dist/factory/migrate.js";
import {
  insertEngineeringRun,
  insertEngineeringTask,
  listPendingSignals,
  updateEngineeringRun,
} from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { pendingSignalLines } from "../dist/factory/run-report.js";
import { VercelWorkflowProvider } from "../dist/factory/workflow/vercel.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { closeWorkflowRuntime, runtimeSkip, workflowRuntime } from "./workflow-runtime.js";

/**
 * #269: a signal nothing is carrying must not be silent.
 *
 * #261 fixed the case the system can recover from — an execution that ended at its tick bound
 * leaves a `finished` binding, and the next signal adopts it. This is the case it cannot: the
 * delivery fails, or the execution dies without recording why, and the binding goes on claiming
 * an execution that is not there. The row is written, `consumed_at` stays null, and until now
 * there was no log, no state change and no error — a merged pull request simply went unnoticed.
 *
 * The fix is not to make it impossible. It is that `signal()` says whether anything is coming
 * for the row, says so out loud when nothing is, and `windkeel run report` shows the waiting signal
 * to whoever asks what the run is doing.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);
let counter = 0;

after(async () => {
  await closeWorkflowRuntime();
});

async function makeSchema() {
  const schema = `windkeel_undelivered_${Date.now()}_${process.pid}_${counter++}`;
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

let seeded = 0;

async function seedParkedRun(pool) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "github_issue",
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
  await updateEngineeringRun(pool, run.id, { prNumber: 90 });
  return run.id;
}

// ------------------------------------------------------------------ rendering (no database)

test("a run with nothing waiting says nothing", () => {
  const row = (label, value) => `${label}: ${value}`;
  assert.deepEqual(pendingSignalLines({ pendingSignals: [] }, row), []);
  // A report built before the field existed. Same rule the other shared renderers follow.
  assert.deepEqual(pendingSignalLines({}, row), []);
});

test("a waiting signal is named, with how long it has been waiting", () => {
  const row = (label, value) => `${label}: ${value}`;
  const now = new Date("2026-09-22T12:00:00Z");
  const at = (msAgo) => new Date(now.getTime() - msAgo);

  const [line] = pendingSignalLines(
    { pendingSignals: [{ kind: "pull_request.closed", receivedAt: at(9 * 60_000) }] },
    row,
    now,
  );
  assert.match(line, /Signals not yet consumed: 1/);
  assert.match(line, /pull_request\.closed 9m ago/);

  // Ages that matter are the long ones: #261's cliff is measured in days, and "4320m ago" is
  // not a sentence anybody reads correctly at a glance.
  const [hours] = pendingSignalLines(
    { pendingSignals: [{ kind: "approval_granted", receivedAt: at(5 * 3600_000) }] },
    row,
    now,
  );
  assert.match(hours, /approval_granted 5h ago/);
  const [days] = pendingSignalLines(
    { pendingSignals: [{ kind: "pull_request.closed", receivedAt: at(7 * 86_400_000) }] },
    row,
    now,
  );
  assert.match(days, /pull_request\.closed 7d ago/);
});

// ------------------------------------------------------------------ driven against Postgres

test(
  "a signal with nothing to carry it reports undelivered, and stays visible",
  { skip },
  async () => {
    const { world } = await workflowRuntime();
    const { schema, pool } = await makeSchema();
    // No handler is registered for WAITING_FOR_HUMAN and no run is started, so there is no
    // execution to wake and no finished binding to adopt — the shape a failed delivery leaves.
    const logged = [];
    const provider = new VercelWorkflowProvider({
      connectionString: dbUrl,
      applicationSchema: schema,
      world,
      waitSleepMs: 2_000,
      retrySleepMs: 50,
      log: (message, fields) => logged.push({ message, fields }),
    });
    await provider.start();
    try {
      const runId = await seedParkedRun(pool);

      const receipt = await provider.signal(runId, {
        type: "pull_request_closed",
        merged: true,
        prNumber: 90,
      });

      // The row is durable either way — this is not a lost write, it is a write nobody is
      // coming for, and the two used to be indistinguishable.
      assert.ok(receipt.id, "the signal is still persisted");
      assert.equal(receipt.handledInline, false);
      assert.equal(receipt.delivered, false, "nothing was woken and nothing was adopted");

      const complaint = logged.find((l) => /nothing is carrying the run/.test(l.message));
      assert.ok(complaint, `expected a log line, got ${JSON.stringify(logged)}`);
      assert.equal(complaint.fields.engineeringRunId, runId);
      assert.equal(complaint.fields.signal, "pull_request_closed");

      // And it is answerable from the database afterwards, by an operator who was not watching
      // the logs at the moment it happened — which is everybody.
      const pending = await listPendingSignals(pool, runId);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].kind, "pull_request_closed");
    } finally {
      await provider.stop();
      await pool.end();
      await dropSchema(schema);
    }
  },
);

test(
  "a signal a live execution will read reports delivered, and logs nothing",
  { skip },
  async () => {
    const { world } = await workflowRuntime();
    const { schema, pool } = await makeSchema();
    const logged = [];
    const provider = new VercelWorkflowProvider({
      connectionString: dbUrl,
      applicationSchema: schema,
      world,
      waitSleepMs: 2_000,
      retrySleepMs: 50,
      log: (message, fields) => logged.push({ message, fields }),
    });
    // A handler that parks, so the run has a live execution sitting in `wait`.
    provider.register({
      state: "WAITING_FOR_HUMAN",
      name: "test:park",
      async handle() {
        return { kind: "wait", reason: "waiting for the human" };
      },
    });
    await provider.start();
    try {
      const runId = await seedParkedRun(pool);
      await provider.startRun(runId);
      // Let the execution reach its first `wait` before signalling it.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const receipt = await provider.signal(runId, {
        type: "pull_request_closed",
        merged: true,
        prNumber: 90,
      });

      assert.equal(receipt.delivered, true, "a live execution was woken");
      // The quiet case has to stay quiet, or the noisy one will not be read.
      assert.deepEqual(
        logged.filter((l) => /nothing is carrying the run/.test(l.message)),
        [],
      );
    } finally {
      await provider.stop();
      await pool.end();
      await dropSchema(schema);
    }
  },
);
