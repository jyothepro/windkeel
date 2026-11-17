import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { recordCost, sumCostEvents } from "../dist/factory/cost-ledger.js";
import {
  insertEngineeringRun,
  insertEngineeringTask,
} from "../dist/factory/repositories.js";
import { assembleRunReport } from "../dist/factory/run-report.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * #242: the checker's spend was `usd: 0` as a literal and `ModelResponse` was `{ text: string }`,
 * so no usage crossed the gateway seam. Every cost Windkeel reported was maker-only — ADR-0011's
 * spend cap enforced against a number missing one of ADR-0010's two vendors, and run `f28748b2`
 * recorded $4.2384 for four verifications that cost something real and unrecorded.
 *
 * The three states below are deliberately distinguishable in the row, not collapsed.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
let counter = 0;

async function withRun(fn) {
  const schema = `windkeel_ckcost_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "local", sourceReference: "checker-cost",
      title: "t", description: "d", acceptanceCriteria: [], riskLevel: "low",
      priority: null, status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, {
      taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200,
    });
    await fn({ pool, runId: run.id });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

test("a priced checker call adds to the run's cost", { skip }, async () => {
  await withRun(async ({ pool, runId }) => {
    await recordCost(pool, {
      engineeringRunId: runId, stageType: "agent_run", stageId: runId,
      kind: "model", tokensIn: 1000, tokensOut: 100, usd: 0.5,
    });
    await recordCost(pool, {
      engineeringRunId: runId, stageType: "verification_run", stageId: runId,
      kind: "model", tokensIn: 2000, tokensOut: 200, usd: 0.25,
    });
    // Maker plus checker, not maker alone — the whole point of the issue.
    assert.equal(await sumCostEvents(pool, runId), 0.75);
  });
});

/**
 * **The regression that matters.** `cost.reconciles` passes by checking the ledger against
 * itself, so a systematically incomplete ledger is internally consistent and reports as healthy.
 * That assertion was true and useless for the whole of this bug's life. This one would fail if
 * verification spend were dropped again.
 */
test("a report notices when verification spend is missing entirely", { skip }, async () => {
  await withRun(async ({ pool, runId }) => {
    await recordCost(pool, {
      engineeringRunId: runId, stageType: "agent_run", stageId: runId,
      kind: "model", tokensIn: 1000, tokensOut: 100, usd: 0.5,
    });
    const report = await assembleRunReport(pool, runId);
    assert.equal(report.cost.totalUsd, 0.5);
    assert.equal(report.cost.unpricedModelCalls, 0, "nothing here reported tokens without a price");

    // Now the shape #242 describes: tokens recorded, no price known — `usd` null since #324.
    await recordCost(pool, {
      engineeringRunId: runId, stageType: "verification_run", stageId: runId,
      kind: "model", tokensIn: 2000, tokensOut: 200, usd: null, keySource: "orqon",
    });
    const after = await assembleRunReport(pool, runId);
    assert.equal(after.cost.unpricedModelCalls, 1);
    assert.equal(after.cost.totalUsd, 0.5, "the total is unchanged, which is why it is a lower bound");
    assert.equal(after.cost.reconciles, true, "an unpriced call adds nothing to the run row either");
  });
});

test("a price of zero is a price, not an unpriced call (#324)", { skip }, async () => {
  await withRun(async ({ pool, runId }) => {
    // An operator who pinned a rate of 0 said the call was free; that is a measurement.
    await recordCost(pool, {
      engineeringRunId: runId, stageType: "verification_run", stageId: runId,
      kind: "model", tokensIn: 2000, tokensOut: 200, usd: 0, keySource: "orqon",
    });
    assert.equal((await assembleRunReport(pool, runId)).cost.unpricedModelCalls, 0);
  });
});

test("a run on a customer key reports its model cost as the customer's, split from Windkeel's (#324)", { skip }, async () => {
  await withRun(async ({ pool, runId }) => {
    const { rows: [org] } = await pool.query("select id from organization where is_default");
    const { rows: [credential] } = await pool.query(
      `insert into model_credential (id, organization_id, provider, label, last4, sealed_value, keypair_id)
       values (gen_random_uuid(), $1, 'anthropic', 'mine', 'abcd', 'sealed', 'kp') returning id`,
      [org.id],
    );
    await recordCost(pool, {
      engineeringRunId: runId, stageType: "agent_run", stageId: runId,
      kind: "model", tokensIn: 1000, tokensOut: 100, usd: 0.5, keySource: "orqon",
    });
    const event = await recordCost(pool, {
      engineeringRunId: runId, stageType: "verification_run", stageId: runId,
      kind: "model", tokensIn: 2000, tokensOut: 200, usd: 0.25, keySource: "customer", credentialId: credential.id,
    });
    await recordCost(pool, {
      engineeringRunId: runId, stageType: "criteria", stageId: runId,
      kind: "model", tokensIn: 300, tokensOut: 30, usd: null, keySource: "customer", credentialId: credential.id,
    });
    assert.equal(event.keySource, "customer");
    assert.equal(event.credentialId, credential.id);

    const report = await assembleRunReport(pool, runId);
    assert.deepEqual(
      report.cost.modelBySource.map((s) => [s.keySource, s.usd, s.calls, s.unpricedCalls]),
      [["orqon", 0.5, 1, 0], ["customer", 0.25, 2, 1]],
    );
    assert.equal(report.cost.unpricedModelCalls, 1);

    // The ledger refuses a credential on a row Windkeel's key paid for, and a customer row without one.
    await assert.rejects(
      recordCost(pool, {
        engineeringRunId: runId, stageType: "agent_run", stageId: runId,
        kind: "model", usd: 0, keySource: "customer",
      }),
      /cost_event_customer_credential_check/,
    );
  });
});

test("an unpriced call is distinguishable from a free one", { skip }, async () => {
  await withRun(async ({ pool, runId }) => {
    // No usage at all — a scripted fake. Not the same thing as tokens with no price.
    await recordCost(pool, {
      engineeringRunId: runId, stageType: "verification_run", stageId: runId,
      kind: "model", usd: 0,
    });
    const report = await assembleRunReport(pool, runId);
    assert.equal(
      report.cost.unpricedModelCalls,
      0,
      "no tokens means nothing was measured; only tokens-without-a-price is a lower bound",
    );
  });
});
