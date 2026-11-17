import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { getEngineeringRun, insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { RunNotFoundError, advanceRun } from "../dist/factory/run-service.js";
import { IllegalTransitionError } from "../dist/factory/run-state-machine.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

async function withRun(fn) {
  const schema = `windkeel_run_service_test_${Date.now()}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "github_issue",
      sourceReference: "1",
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
    await fn(pool, run);
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

test(
  "advanceRun moves status, stamps started_at on first move out of CREATED, and records the transition",
  { skip },
  async () => {
    await withRun(async (pool, run) => {
      const { run: advanced, transition } = await advanceRun(pool, run.id, "CLASSIFYING");
      assert.equal(advanced.status, "CLASSIFYING");
      assert.ok(advanced.startedAt, "started_at is stamped on the first move");
      assert.deepEqual(
        { from: transition.fromState, to: transition.toState, reason: transition.reason },
        { from: "CREATED", to: "CLASSIFYING", reason: null },
      );

      const refetched = await getEngineeringRun(pool, run.id);
      assert.equal(refetched.status, "CLASSIFYING");
    });
  },
);

test(
  "advanceRun stamps completed_at on reaching a terminal state",
  { skip },
  async () => {
    await withRun(async (pool, run) => {
      await advanceRun(pool, run.id, "CLASSIFYING");
      await advanceRun(pool, run.id, "PLANNING");
      await advanceRun(pool, run.id, "WAITING_FOR_APPROVAL");
      await advanceRun(pool, run.id, "PROVISIONING");
      await advanceRun(pool, run.id, "IMPLEMENTING");
      await advanceRun(pool, run.id, "VERIFYING");
      const { run: failed } = await advanceRun(pool, run.id, "FAILED", "error");
      assert.equal(failed.status, "FAILED");
      assert.ok(failed.completedAt);
    });
  },
);

test(
  "an illegal transition throws, writes no transition row, and leaves the run's status untouched",
  { skip },
  async () => {
    await withRun(async (pool, run) => {
      await assert.rejects(() => advanceRun(pool, run.id, "COMPLETED"), IllegalTransitionError);

      const refetched = await getEngineeringRun(pool, run.id);
      assert.equal(refetched.status, "CREATED", "the rollback left status untouched");

      const { rows } = await pool.query("select count(*)::int as n from run_state_transition where engineering_run_id = $1", [
        run.id,
      ]);
      assert.equal(rows[0].n, 0, "no transition row from the rejected move");
    });
  },
);

test(
  "advanceRun resolves BLOCKED's return address from history, and resumes only to that state",
  { skip },
  async () => {
    await withRun(async (pool, run) => {
      await advanceRun(pool, run.id, "CLASSIFYING");
      await advanceRun(pool, run.id, "PLANNING");
      await advanceRun(pool, run.id, "BLOCKED", "waiting on external dependency");

      await assert.rejects(() => advanceRun(pool, run.id, "VERIFYING"), IllegalTransitionError);

      const { run: resumed } = await advanceRun(pool, run.id, "PLANNING");
      assert.equal(resumed.status, "PLANNING");
    });
  },
);

test("advanceRun rejects an unknown run id", { skip }, async () => {
  await withRun(async (pool) => {
    await assert.rejects(
      () => advanceRun(pool, "00000000-0000-0000-0000-000000000000", "CLASSIFYING"),
      RunNotFoundError,
    );
  });
});
