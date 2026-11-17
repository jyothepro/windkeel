import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { recordCost } from "../dist/factory/cost-ledger.js";
import { enforceRepairLoopRails, enforceSpendAndTimeRails } from "../dist/factory/workflow/rails-gate.js";
import { insertEngineeringRun, insertEngineeringTask, insertRepairAttempt, insertVerificationRun } from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

async function withStartedRun(pool, overrides = {}) {
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
    ...overrides,
  });
  await advanceRun(pool, run.id, "CLASSIFYING");
  await advanceRun(pool, run.id, "PLANNING");
  await advanceRun(pool, run.id, "PROVISIONING");
  await advanceRun(pool, run.id, "IMPLEMENTING");
  const { run: verifying } = await advanceRun(pool, run.id, "VERIFYING");
  return verifying;
}

async function withSchema(fn) {
  const schema = `windkeel_rails_gate_test_${Date.now()}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    await fn(pool);
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

test("a run under both caps is not stopped", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await withStartedRun(pool);
    const result = await enforceSpendAndTimeRails(pool, run.id);
    assert.deepEqual(result, { stopped: false, reason: null });
  });
});

test(
  "a run at or past its spend cap is moved to FAILED with stop_reason spend_cap",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const run = await withStartedRun(pool, { spendCapUsd: 1 });
      await recordCost(pool, {
        engineeringRunId: run.id,
        stageType: "agent_run",
        stageId: "22222222-2222-2222-2222-222222222222",
        kind: "model",
        usd: 1,
      });

      const result = await enforceSpendAndTimeRails(pool, run.id);
      assert.deepEqual(result, { stopped: true, reason: "spend_cap" });

      const { rows } = await pool.query("select status, stop_reason from engineering_run where id = $1", [run.id]);
      assert.deepEqual(rows[0], { status: "FAILED", stop_reason: "spend_cap" });
    });
  },
);

test(
  "an uncapped run (spend_cap_usd: null) is never stopped on spend",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const run = await withStartedRun(pool, { spendCapUsd: null });
      await recordCost(pool, {
        engineeringRunId: run.id,
        stageType: "agent_run",
        stageId: "22222222-2222-2222-2222-222222222222",
        kind: "model",
        usd: 999,
      });
      const result = await enforceSpendAndTimeRails(pool, run.id);
      assert.deepEqual(result, { stopped: false, reason: null });
    });
  },
);

test(
  "a run past its wall-clock cap is moved to FAILED with stop_reason wall_clock_cap",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const run = await withStartedRun(pool, { wallClockCapSeconds: 1 });
      const later = new Date(Date.now() + 5000);
      const result = await enforceSpendAndTimeRails(pool, run.id, later);
      assert.deepEqual(result, { stopped: true, reason: "wall_clock_cap" });
    });
  },
);

test(
  "the repair cap for a high-risk task stops after its single allowed attempt",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const task = await insertEngineeringTask(pool, {
        repositoryId: "11111111-1111-1111-1111-111111111111",
        sourceType: "github_issue",
        sourceReference: "1",
        title: "t",
        description: "d",
        acceptanceCriteria: [],
        riskLevel: "high",
        priority: null,
        status: "OPEN",
      });
      const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
      await advanceRun(pool, run.id, "CLASSIFYING");
      await advanceRun(pool, run.id, "PLANNING");
      await advanceRun(pool, run.id, "PROVISIONING");
      await advanceRun(pool, run.id, "IMPLEMENTING");
      await advanceRun(pool, run.id, "VERIFYING");

      const verificationRun = await insertVerificationRun(pool, {
        engineeringRunId: run.id,
        candidateSha: "sha1",
        policyVersion: "v1",
      });
      const packet = (n) => ({
        failed_acceptance_criteria: [{ id: `c${n}`, text: "x", reason: "still failing" }],
        failed_checks: [],
        security_findings: [],
        review_findings: [],
        browser_findings: [],
        evidence_links: [],
        recommended_focus: [],
        repair_constraints: [],
      });
      await insertRepairAttempt(pool, {
        engineeringRunId: run.id,
        verificationRunId: verificationRun.id,
        attemptNumber: 1,
        repairPacket: packet(1),
      });

      // high risk allows 1 attempt (REPAIR_ATTEMPT_CAPS.high); a second packet exceeds it.
      await insertRepairAttempt(pool, {
        engineeringRunId: run.id,
        verificationRunId: verificationRun.id,
        attemptNumber: 2,
        repairPacket: packet(2),
      });

      const result = await enforceRepairLoopRails(pool, run.id, "high");
      assert.deepEqual(result, { stopped: true, reason: "repair_cap" });

      const { rows } = await pool.query("select status, stop_reason from engineering_run where id = $1", [run.id]);
      assert.deepEqual(rows[0], { status: "MAX_REPAIR_ATTEMPTS_REACHED", stop_reason: "repair_cap" });
    });
  },
);

test(
  "two consecutive identical repair packets trip the stuck rail before the cap does",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const run = await withStartedRun(pool, { spendCapUsd: 25, wallClockCapSeconds: 7200 });
      const verificationRun = await insertVerificationRun(pool, {
        engineeringRunId: run.id,
        candidateSha: "sha1",
        policyVersion: "v1",
      });
      const samePacket = {
        failed_acceptance_criteria: [{ id: "c1", text: "x", reason: "still failing" }],
        failed_checks: [],
        security_findings: [],
        review_findings: [],
        browser_findings: [],
        evidence_links: [],
        recommended_focus: [],
        repair_constraints: [],
      };
      await insertRepairAttempt(pool, {
        engineeringRunId: run.id,
        verificationRunId: verificationRun.id,
        attemptNumber: 1,
        repairPacket: samePacket,
      });
      await insertRepairAttempt(pool, {
        engineeringRunId: run.id,
        verificationRunId: verificationRun.id,
        attemptNumber: 2,
        repairPacket: samePacket,
      });

      // low risk allows 3 attempts, so only the stuck check (not the cap) can fire here.
      const result = await enforceRepairLoopRails(pool, run.id, "low");
      assert.deepEqual(result, { stopped: true, reason: "stuck" });
    });
  },
);

// --- unpriced calls and the spend cap (#324) ----------------------------------------------------

/**
 * The ledger records a call on a model nobody priced as `usd` null, and the run row does not
 * include it. The rail must still count it, or "unknown is not zero" becomes "unknown is
 * unbounded": it charges the tokens at the catalog's highest rates ($15 in, $75 out per million,
 * claude-opus-4-1) and says the cap was met on an estimate.
 */
test("an unpriced maker model trips the cap at the conservative rate; the ledger still says null", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await withStartedRun(pool, { spendCapUsd: 25 });
    const unpricedTurn = (tokensIn) =>
      recordCost(pool, {
        engineeringRunId: run.id,
        stageType: "agent_run",
        stageId: "22222222-2222-2222-2222-222222222222",
        kind: "model",
        tokensIn,
        tokensOut: 100_000,
        usd: null,
        keySource: "orqon",
        model: "someone/unpriced-model",
      });
    // 1,000,000 in + 100,000 out at $15/$75 per million = $22.50: under the $25 cap.
    await unpricedTurn(1_000_000);
    assert.deepEqual(await enforceSpendAndTimeRails(pool, run.id), { stopped: false, reason: null });
    // Another 200,000 in: $25.50 estimated. Recorded spend is still $0.
    await unpricedTurn(200_000);
    assert.deepEqual(await enforceSpendAndTimeRails(pool, run.id), { stopped: true, reason: "spend_cap" });

    const { rows } = await pool.query("select status, stop_reason, cost from engineering_run where id = $1", [run.id]);
    assert.equal(rows[0].status, "FAILED");
    assert.equal(rows[0].stop_reason, "spend_cap");
    assert.equal(Number(rows[0].cost), 0, "the run's recorded cost is untouched by the estimate");
    const ledger = await pool.query("select usd from cost_event where engineering_run_id = $1", [run.id]);
    assert.ok(ledger.rows.every((r) => r.usd === null), "the ledger stays honest: unpriced, not estimated");

    const [last] = (
      await pool.query(
        "select reason from run_state_transition where engineering_run_id = $1 order by seq desc limit 1",
        [run.id],
      )
    ).rows;
    assert.match(last.reason, /estimated, model someone\/unpriced-model is unpriced/);
    assert.match(last.reason, /\$15\/\$75 per million/);
  });
});

test("WINDKEEL_UNPRICED_USD_PER_* replaces the catalog's highest rate for the estimate", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await withStartedRun(pool, { spendCapUsd: 25 });
    await recordCost(pool, {
      engineeringRunId: run.id, stageType: "agent_run", stageId: "22222222-2222-2222-2222-222222222222",
      kind: "model", tokensIn: 1_200_000, tokensOut: 100_000, usd: null, keySource: "orqon", model: "x/y",
    });
    const cheap = { input: 1e-6, output: 1e-6 };
    assert.deepEqual(await enforceSpendAndTimeRails(pool, run.id, new Date(), { unpricedRate: cheap }), {
      stopped: false,
      reason: null,
    });
  });
});

// --- the organization budget (#394, ADR-0037 §5) -------------------------------------------------

async function spendDefaultOrganization(pool, run, usd, limit) {
  const { setBudget } = await import("../dist/billing/budget.js");
  await recordCost(pool, {
    engineeringRunId: run.id,
    stageType: "agent_run",
    stageId: "22222222-2222-2222-2222-222222222222",
    kind: "model",
    usd,
    keySource: "orqon",
  });
  const { rows } = await pool.query("select id from organization where is_default");
  await setBudget(pool, rows[0].id, { monthlyLimitUsd: limit }, null);
}

test("a spent organization budget stops a fail verdict before the repair turn, with org_budget", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await withStartedRun(pool);
    const verificationRun = await insertVerificationRun(pool, { engineeringRunId: run.id, candidateSha: "sha1", policyVersion: "v1" });
    await insertRepairAttempt(pool, {
      engineeringRunId: run.id,
      verificationRunId: verificationRun.id,
      attemptNumber: 1,
      repairPacket: {
        failed_acceptance_criteria: [{ id: "c1", text: "x", reason: "failing" }],
        failed_checks: [], security_findings: [], review_findings: [], browser_findings: [],
        evidence_links: [], recommended_focus: [], repair_constraints: [],
      },
    });
    await spendDefaultOrganization(pool, run, 2, 2);

    // The repair loop has budget (1 of 3 attempts); the organization does not.
    const result = await enforceRepairLoopRails(pool, run.id, "low");
    assert.deepEqual(result, { stopped: true, reason: "org_budget" });
    const { rows } = await pool.query("select status, stop_reason from engineering_run where id = $1", [run.id]);
    assert.deepEqual(rows[0], { status: "FAILED", stop_reason: "org_budget" });
    const path = (await pool.query("select to_state from run_state_transition where engineering_run_id = $1", [run.id])).rows.map((r) => r.to_state);
    assert.ok(!path.includes("PR_READY") && !path.includes("PR_CREATING"), "nothing moved toward a pull request");
  });
});

test("a spent organization budget never stops verification: only maker checkpoints ask for it", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await withStartedRun(pool); // at VERIFYING, a candidate waiting to be judged
    await spendDefaultOrganization(pool, run, 3, 1);
    // The verifying stage's gate (no organizationBudget): the in-flight verification goes ahead.
    assert.deepEqual(await enforceSpendAndTimeRails(pool, run.id), { stopped: false, reason: null });
    const { rows } = await pool.query("select status from engineering_run where id = $1", [run.id]);
    assert.equal(rows[0].status, "VERIFYING");
    // A maker checkpoint on the same run is where the budget stops it.
    assert.deepEqual(await enforceSpendAndTimeRails(pool, run.id, new Date(), { organizationBudget: true }), {
      stopped: true,
      reason: "org_budget",
    });
  });
});

test("with no budget the organization rail never stops anything", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await withStartedRun(pool);
    assert.deepEqual(await enforceSpendAndTimeRails(pool, run.id, new Date(), { organizationBudget: true }), {
      stopped: false,
      reason: null,
    });
  });
});

// --- credits (#431, ADR-0040) ------------------------------------------------------------------

test("out of credits stops a run at its next maker checkpoint, never the verification under way", { skip }, async () => {
  await withSchema(async (pool) => {
    const { enableCredits, grantCredits } = await import("../dist/billing/credit-ledger.js");
    const run = await withStartedRun(pool); // at VERIFYING
    const { rows } = await pool.query("select account_id from organization where is_default");
    const accountId = rows[0].account_id;
    const since = new Date(Date.now() - 60_000);
    await enableCredits(pool, accountId, since);
    await grantCredits(pool, {
      accountId,
      source: "topup",
      product: "topup_10",
      amountMicro: 1_000_000,
      startsAt: since,
      expiresAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: "rails:topup",
    });
    // One credit, spent exactly: 30 sandbox-seconds.
    await recordCost(pool, {
      engineeringRunId: run.id, stageType: "workspace", stageId: "22222222-2222-2222-2222-222222222222",
      kind: "sandbox", usd: 0.001, sandboxMs: 30_000,
    });
    assert.deepEqual(await enforceSpendAndTimeRails(pool, run.id), { stopped: false, reason: null }, "the verification goes ahead");
    assert.deepEqual(await enforceSpendAndTimeRails(pool, run.id, new Date(), { organizationBudget: true }), {
      stopped: true,
      reason: "org_budget",
    });
    const { rows: stopped } = await pool.query(
      `select r.status, r.stop_reason, t.reason from engineering_run r
         join run_state_transition t on t.engineering_run_id = r.id and t.to_state = 'FAILED' where r.id = $1`,
      [run.id],
    );
    assert.deepEqual([stopped[0].status, stopped[0].stop_reason], ["FAILED", "org_budget"]);
    assert.match(stopped[0].reason, /out of credits/);
  });
});
