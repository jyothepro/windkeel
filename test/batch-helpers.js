/**
 * Shared set-up for the batch suites (#391): a throwaway schema, migrated, with fixture
 * repositories granted to the default organization, and a recording enqueuer that writes the
 * `workflow_run_binding` row as `startRun` does.
 */
import { join } from "node:path";
import { Pool } from "pg";
import { normaliseBatchInput } from "../dist/batches/batch-input.js";
import { insertBatch } from "../dist/batches/store.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

export const dbUrl = process.env.TEST_DATABASE_URL;
export const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

export const REPOS = [
  "11111111-1111-1111-1111-111111111111",
  "22222222-2222-2222-2222-222222222222",
  "33333333-3333-3333-3333-333333333333",
  "44444444-4444-4444-4444-444444444444",
];

let serial = 0;

export async function withBatchDb(fn, { poolMax = 8 } = {}) {
  const schema = `windkeel_batch_test_${Date.now()}_${process.pid}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, max: poolMax, idleTimeoutMillis: 1_000, options: `-c search_path=${schema}` });
  try {
    for (const id of REPOS) await seedFixtureRepository(pool, id);
    const orgId = (await pool.query("select id from organization where is_default")).rows[0].id;
    const operator = (await pool.query("select id from principal where is_bootstrap")).rows[0]?.id ?? null;
    const enqueued = [];
    const enqueuer = {
      startRun: async (runId) => {
        enqueued.push(runId);
        await pool.query(
          `insert into workflow_run_binding (engineering_run_id, provider, execution_handle)
           values ($1, 'fake', $2) on conflict do nothing`,
          [runId, `wrun_${runId}`],
        );
        return { enqueued: true };
      },
    };
    await fn({ pool, orgId, operator, enqueued, enqueuer, schema });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

/** A multi_repo batch over `repositories`, inserted directly (no dispatch). */
export async function makeBatch(pool, orgId, principalId, input = {}) {
  const normalised = normaliseBatchInput({
    kind: "multi_repo",
    title: "Bump the linter",
    description: "Upgrade eslint to the next major and fix what it reports.",
    criteria: ["npm run lint passes"],
    repositories: REPOS.slice(0, 3),
    ...input,
  });
  return insertBatch(pool, orgId, normalised, principalId);
}

/** Moves a run straight to a status (and a cost), as the stages would have. Test-only shortcut. */
export async function settleRun(pool, runId, status, { cost, verdict } = {}) {
  await pool.query(
    `update engineering_run set status = $2, cost = coalesce($3, cost), final_verdict = coalesce($4, final_verdict) where id = $1`,
    [runId, status, cost ?? null, verdict ?? null],
  );
}

export async function batchTasks(pool, batchId) {
  return (
    await pool.query(
      `select t.id, t.source_type, t.source_reference, t.created_by_principal_id, t.acceptance_criteria, t.criteria_provenance,
              r.id as run_id, r.status, r.spend_cap_usd, r.cost
         from engineering_task t join engineering_run r on r.task_id = t.id
        where t.batch_id = $1 order by t.source_reference`,
      [batchId],
    )
  ).rows;
}
