/**
 * #306: a run whose enqueue failed, and whose provider retry was refused, must not sit in
 * `CREATED` forever. The sweep re-enqueues runs still `CREATED` with no `workflow_run_binding`
 * ten minutes after creation — exactly once — and leaves bound, young and ancient runs alone.
 * Linear is the concrete case: its retries (1 min / 1 h / 6 h) land outside the 5-minute replay
 * window, which stays strict.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { runIntake } from "../dist/intake/pipeline.js";
import { createLinearIntakeSource } from "../dist/intake/linear.js";
import { addRoute, createConnection } from "../dist/integrations/connections.js";
import { FakeProviderTokenSource } from "../dist/integrations/token-source.js";
import { fakeConnectForwardVerifier } from "../dist/integrations/vercel-connect.js";
import {
  DEFAULT_MINIMUM_CREATED_AGE_MS,
  requeueStrandedCreatedRuns,
  requeueStrandedCreatedRunsLocked,
} from "../dist/factory/sweeps/stranded-created-runs.js";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const REPO = "11111111-1111-1111-1111-111111111111";
const LINEAR_ORG = "7c3a1f0e-2b4d-4e6f-9a8b-1c2d3e4f5a6b";
const INSTALLATION = "inst_linear_1";
const OIDC = "test-connect-oidc";
const NOW = 1_790_330_400_000;

let serial = 0;
async function withSchema(fn) {
  const schema = `windkeel_stranded_${Date.now()}_${process.pid}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool, REPO);
    await fn(pool);
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

/** A `startRun` that does what the real one does to the table the sweep reads: claims a binding. */
function bindingEnqueuer(pool) {
  const started = [];
  return {
    started,
    async startRun(runId) {
      const { rowCount } = await pool.query(
        `insert into workflow_run_binding (engineering_run_id, provider, execution_handle)
         values ($1, 'test', 'wrun_test') on conflict do nothing`,
        [runId],
      );
      if (rowCount === 1) started.push(runId);
      return { enqueued: rowCount === 1 };
    },
  };
}

async function backdate(pool, runId, ms) {
  await pool.query(
    "update engineering_run set created_at = now() - ($2::bigint * interval '1 millisecond') where id = $1",
    [runId, String(ms)],
  );
}

async function seedRun(pool) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: REPO,
    sourceType: "api",
    sourceReference: `ref-${Math.random()}`,
    title: "t",
    description: "- [ ] a",
    acceptanceCriteria: [],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  return insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 5, wallClockCapSeconds: 600 });
}

test("enqueue fails → Linear's retry is refused by the replay window → the sweep starts the run exactly once", { skip }, async () => {
  await withSchema(async (pool) => {
    const org = (await pool.query("select id from organization where is_default")).rows[0].id;
    const { connection } = await createConnection(pool, {
      organizationId: org,
      provider: "linear",
      installationId: INSTALLATION,
      externalTenantId: LINEAR_ORG,
      externalTenantName: "Acme",
      createdByPrincipalId: null,
    });
    await addRoute(pool, org, connection.id, { repositoryId: REPO });

    let clock = NOW;
    const source = createLinearIntakeSource({
      startRun: async () => {
        throw new Error("queue unavailable");
      },
      tokenSource: new FakeProviderTokenSource().install("linear", INSTALLATION, { tenantId: LINEAR_ORG, name: "Acme" }),
      verifyForward: fakeConnectForwardVerifier(OIDC),
      fetch: async () => new Response("{}", { status: 200 }),
      now: () => clock,
      log: () => {},
    });
    const payload = readFileSync(join(repoRoot, "test/fixtures/linear/issue-create-with-label.json"), "utf8");
    const req = {
      headers: { authorization: `Bearer ${OIDC}`, "linear-delivery": "d-stranded" },
      rawBody: JSON.stringify({ ...JSON.parse(payload), webhookTimestamp: NOW }),
    };

    const first = await runIntake(source, req, { pool, log: () => {} });
    assert.equal(first.status, 500, "the enqueue failed; the delivery is released for a retry");

    clock = NOW + 60 * 60 * 1000; // Linear's second retry, an hour later
    const retry = await runIntake(source, req, { pool, log: () => {} });
    assert.equal(retry.status, 401, "the replay window stays strict");

    const { rows } = await pool.query("select r.id, r.status from engineering_run r join engineering_task t on t.id = r.task_id where t.source_type = 'linear'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "CREATED", "stranded: nothing is carrying it");
    const runId = rows[0].id;

    const enqueuer = bindingEnqueuer(pool);
    const logs = [];
    const young = await requeueStrandedCreatedRuns({ pool, startRun: enqueuer.startRun, log: () => {} });
    assert.equal(young.examined, 0, "not before ten minutes");

    await backdate(pool, runId, DEFAULT_MINIMUM_CREATED_AGE_MS + 60_000);
    const tick = await requeueStrandedCreatedRunsLocked({
      pool,
      startRun: enqueuer.startRun,
      log: (message, fields) => logs.push({ message, ...fields }),
    });
    assert.equal(tick.kind, "ran");
    assert.deepEqual(tick.result, { examined: 1, requeued: 1, skipped: 0, failed: 0 });
    assert.deepEqual(enqueuer.started, [runId]);
    assert.equal(logs[0].message, "re-enqueued a run stranded in CREATED");
    assert.equal(logs[0].engineeringRunId, runId);
    assert.equal(logs[0].sourceType, "linear");

    const again = await requeueStrandedCreatedRuns({ pool, startRun: enqueuer.startRun, log: () => {} });
    assert.equal(again.examined, 0, "the binding now exists: exactly once");
    assert.deepEqual(enqueuer.started, [runId]);
  });
});

test("a run with a binding, a run past CREATED, and an ancient run are left alone; a throw is counted, not fatal", { skip }, async () => {
  await withSchema(async (pool) => {
    const bound = await seedRun(pool);
    await pool.query(
      `insert into workflow_run_binding (engineering_run_id, provider, execution_handle, phase)
       values ($1, 'vercel-workflow', 'wrun_x', 'finished')`,
      [bound.id],
    );
    await backdate(pool, bound.id, DEFAULT_MINIMUM_CREATED_AGE_MS * 2);

    const moving = await seedRun(pool);
    await pool.query("update engineering_run set status = 'CLASSIFYING' where id = $1", [moving.id]);
    await backdate(pool, moving.id, DEFAULT_MINIMUM_CREATED_AGE_MS * 2);

    const ancient = await seedRun(pool);
    await backdate(pool, ancient.id, 30 * 24 * 60 * 60 * 1000);

    const failing = await seedRun(pool);
    await backdate(pool, failing.id, DEFAULT_MINIMUM_CREATED_AGE_MS * 2);

    const calls = [];
    const result = await requeueStrandedCreatedRuns({
      pool,
      startRun: async (id) => {
        calls.push(id);
        throw new Error("queue unavailable");
      },
      log: () => {},
    });
    assert.deepEqual(calls, [failing.id], "only the unbound, recent, CREATED run is a candidate");
    assert.deepEqual(result, { examined: 1, requeued: 0, skipped: 0, failed: 1 });
  });
});
