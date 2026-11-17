import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { recordCost, sumCostEvents } from "../dist/factory/cost-ledger.js";
import { runMigrations } from "../dist/factory/migrate.js";
import { getEngineeringRun, insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

async function withRun(fn) {
  const schema = `windkeel_cost_ledger_test_${Date.now()}`;
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
  "EngineeringRun.cost never drifts from SUM(cost_event.usd) — the ADR-0013 invariant",
  { skip },
  async () => {
    await withRun(async (pool, run) => {
      const agentRunId = "22222222-2222-2222-2222-222222222222";
      const workspaceId = "33333333-3333-3333-3333-333333333333";

      await recordCost(pool, {
        engineeringRunId: run.id,
        stageType: "agent_run",
        stageId: agentRunId,
        kind: "model",
        tokensIn: 1000,
        tokensOut: 200,
        usd: 0.42,
      });
      await recordCost(pool, {
        engineeringRunId: run.id,
        stageType: "workspace",
        stageId: workspaceId,
        kind: "sandbox",
        usd: 0.1,
      });
      await recordCost(pool, {
        engineeringRunId: run.id,
        stageType: "agent_run",
        stageId: agentRunId,
        kind: "model",
        tokensIn: 500,
        tokensOut: 50,
        usd: 0.08,
      });

      const refetched = await getEngineeringRun(pool, run.id);
      const summed = await sumCostEvents(pool, run.id);
      assert.equal(summed, 0.6);
      assert.equal(refetched.cost, summed);
    });
  },
);

test("recordCost returns the inserted row with tokens null for non-model events", { skip }, async () => {
  await withRun(async (pool, run) => {
    const event = await recordCost(pool, {
      engineeringRunId: run.id,
      stageType: "workspace",
      stageId: "33333333-3333-3333-3333-333333333333",
      kind: "sandbox",
      usd: 0.05,
    });
    assert.equal(event.tokensIn, null);
    assert.equal(event.tokensOut, null);
    assert.equal(event.usd, 0.05);
  });
});

test(
  "a failed insert (bad stage_type) leaves EngineeringRun.cost untouched",
  { skip },
  async () => {
    await withRun(async (pool, run) => {
      await assert.rejects(() =>
        recordCost(pool, {
          engineeringRunId: run.id,
          stageType: "not_a_real_stage_type",
          stageId: "22222222-2222-2222-2222-222222222222",
          kind: "model",
          usd: 100,
        }),
      );
      const refetched = await getEngineeringRun(pool, run.id);
      assert.equal(refetched.cost, 0);
    });
  },
);

test("an unpriced model call is stored as null, attributed, and adds nothing to the run (#324)", { skip }, async () => {
  await withRun(async (pool, run) => {
    await recordCost(pool, {
      engineeringRunId: run.id, stageType: "agent_run", stageId: run.id,
      kind: "model", tokensIn: 100, tokensOut: 10, usd: 0.25, keySource: "orqon",
    });
    const unpriced = await recordCost(pool, {
      engineeringRunId: run.id, stageType: "criteria", stageId: run.id,
      kind: "model", tokensIn: 100, tokensOut: 10, usd: null, keySource: "orqon",
      // Dropped: a credential is recorded only when the organization's key paid.
      credentialId: "55555555-5555-5555-5555-555555555555",
    });
    assert.equal(unpriced.usd, null);
    assert.equal(unpriced.keySource, "orqon");
    assert.equal(unpriced.credentialId, null);
    assert.equal(unpriced.stageType, "criteria");
    const sandbox = await recordCost(pool, {
      engineeringRunId: run.id, stageType: "workspace", stageId: run.id, kind: "sandbox", usd: 0.01,
    });
    assert.equal(sandbox.keySource, null, "no model key paid for a sandbox");
    assert.equal((await getEngineeringRun(pool, run.id)).cost, 0.26);
    assert.equal(await sumCostEvents(pool, run.id), 0.26);
  });
});

/**
 * Migration 0031 (#324) against rows written before it: M9-4's criteria rows move to their own
 * stage, a pre-#324 "unpriced" zero becomes null, and every view keeps reading what it read.
 */
test("0031 moves criteria rows, nulls the old unpriced zeros, and keeps the views' figures", { skip }, async () => {
  const schema = `windkeel_cost_0031_${Date.now()}_${process.pid}`;
  const before = mkdtempSync(join(tmpdir(), "windkeel-0031-"));
  for (const file of readdirSync(join(repoRoot, "migrations"))) {
    if (file < "0031") copyFileSync(join(repoRoot, "migrations", file), join(before, file));
  }
  const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await setup.query(`create schema ${schema}`);
  await setup.end();
  const pool = new Pool({ connectionString: dbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await runMigrations(pool, before);
    await seedFixtureRepository(pool);
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "local", sourceReference: "0031", title: "t", description: "d",
      acceptanceCriteria: [], riskLevel: "low", priority: null, status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    const insert = (stageType, stageId, kind, tokensIn, usd) =>
      pool.query(
        `insert into cost_event (engineering_run_id, stage_type, stage_id, kind, tokens_in, tokens_out, usd)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [run.id, stageType, stageId, kind, tokensIn, tokensIn === null ? null : 10, usd],
      );
    await insert("agent_run", "33333333-3333-3333-3333-333333333333", "model", 1000, 0.5);
    await insert("verification_run", "22222222-2222-2222-2222-222222222222", "model", 2000, 0); // unpriced (#242)
    await insert("verification_run", run.id, "model", 300, 0.01); // M9-4's criteria row
    await insert("workspace", "44444444-4444-4444-4444-444444444444", "sandbox", null, 0.02);
    const views = () =>
      pool.query(
        `select (select model_cost_usd from model_cost) as model,
                (select verification_cost_usd from verification_cost) as verification,
                (select sandbox_cost_usd from sandbox_cost) as sandbox,
                (select tokens_in from model_tokens) as tokens_in`,
      );
    const viewsBefore = (await views()).rows;

    await runMigrations(pool, join(repoRoot, "migrations"));

    const { rows } = await pool.query(
      "select stage_type, stage_id, usd, key_source from cost_event where kind = 'model' order by tokens_in",
    );
    assert.deepEqual(
      rows.map((r) => [r.stage_type, r.usd === null ? null : Number(r.usd), r.key_source]),
      [
        ["criteria", 0.01, null],
        ["agent_run", 0.5, null],
        ["verification_run", null, null],
      ],
    );
    assert.equal(rows[0].stage_id, run.id);
    assert.deepEqual((await views()).rows, viewsBefore, "the existing views read the same figures");

    // New rows attribute; the by-source view splits them and counts the unpriced.
    await recordCost(pool, {
      engineeringRunId: run.id, stageType: "agent_run", stageId: run.id,
      kind: "model", tokensIn: 50, tokensOut: 5, usd: null, keySource: "orqon",
    });
    const bySource = await pool.query(
      "select key_source, model_cost_usd, unpriced_calls, calls from model_cost_by_source order by key_source nulls last",
    );
    assert.deepEqual(
      bySource.rows.map((r) => [
        r.key_source,
        r.model_cost_usd === null ? null : Number(r.model_cost_usd),
        Number(r.unpriced_calls),
        Number(r.calls),
      ]),
      [
        ["orqon", null, 1, 1],
        [null, 0.51, 1, 3],
      ],
    );
  } finally {
    await pool.end();
    const teardown = new Pool({ connectionString: dbUrl, ...TEST_POOL });
    await teardown.query(`drop schema if exists ${schema} cascade`);
    await teardown.end();
    rmSync(before, { recursive: true, force: true });
  }
});

test("ORQ-09: the ledger refuses a negative or non-finite cost and leaves the run's total alone", { skip }, async () => {
  await withRun(async (pool, run) => {
    const base = {
      engineeringRunId: run.id,
      stageType: "agent_run",
      stageId: "22222222-2222-2222-2222-222222222222",
      kind: "model",
    };
    await recordCost(pool, { ...base, tokensIn: 1000, tokensOut: 10, usd: 1.25 });
    for (const forged of [
      { usd: -22.5 },
      { usd: Number.NaN },
      { usd: Number.POSITIVE_INFINITY },
      { usd: 0, tokensIn: -9000000 },
      { usd: 0, tokensOut: -1 },
    ]) {
      await assert.rejects(recordCost(pool, { ...base, ...forged }), /negative or non-finite/);
    }
    assert.equal((await getEngineeringRun(pool, run.id)).cost, 1.25);
    assert.equal(await sumCostEvents(pool, run.id), 1.25);
  });
});
