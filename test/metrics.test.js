import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { collectMetrics } from "../dist/factory/metrics.js";
import { formatMetrics } from "../packages/cli/dist/commands/operator.js";
import {
  insertEngineeringRun,
  insertEngineeringTask,
  insertVerificationRun,
  updateEngineeringRun,
} from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { recordCost } from "../dist/factory/cost-ledger.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

test("formatMetrics renders summary and per-run views without throwing on empty data", () => {
  const text = formatMetrics({ summary: { task_success_rate: {} }, perRun: { time_to_pr: [] } });
  assert.match(text, /task_success_rate/);
  assert.match(text, /time_to_pr \(0 rows\)/);
  assert.match(text, /\(none\)/);
});

test("formatMetrics prints null values as an em dash, not the string 'null'", () => {
  const text = formatMetrics({ summary: { merge_rate: { merge_rate_pct: null } }, perRun: {} });
  assert.match(text, /merge_rate_pct: —/);
});

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

test(
  "collectMetrics reads every ADR-0013 §20 view against a populated schema",
  { skip },
  async () => {
    const schema = `windkeel_metrics_test_${Date.now()}`;
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
      const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });

      await advanceRun(pool, run.id, "CLASSIFYING");
      await advanceRun(pool, run.id, "PLANNING");
      await advanceRun(pool, run.id, "PROVISIONING");
      await advanceRun(pool, run.id, "IMPLEMENTING");
      await advanceRun(pool, run.id, "VERIFYING");
      await advanceRun(pool, run.id, "PR_CREATING");
      await advanceRun(pool, run.id, "PR_READY");
      await advanceRun(pool, run.id, "WAITING_FOR_HUMAN");
      await advanceRun(pool, run.id, "COMPLETED");
      // engineering_task.status is a coarse projection nothing maintains yet (ADR-0003:
      // "maintained by the factory service" — not built as of this PR), so it's set
      // directly here to exercise task_success_rate against realistic data.
      await pool.query("update engineering_task set status = 'COMPLETED' where id = $1", [task.id]);

      await updateEngineeringRun(pool, run.id, {
        finalVerdict: "pass",
        prNumber: 42,
        prMergedAt: new Date(),
        humanCommitsAfterPr: 0,
      });

      const verificationRun = await insertVerificationRun(pool, {
        engineeringRunId: run.id,
        candidateSha: "sha",
        policyVersion: "v1",
      });
      await pool.query("update verification_run set verdict = 'pass', completed_at = now() where id = $1", [
        verificationRun.id,
      ]);

      await recordCost(pool, {
        engineeringRunId: run.id,
        stageType: "agent_run",
        stageId: "22222222-2222-2222-2222-222222222222",
        kind: "model",
        tokensIn: 100,
        tokensOut: 20,
        usd: 0.5,
      });
      await recordCost(pool, {
        engineeringRunId: run.id,
        stageType: "workspace",
        stageId: "33333333-3333-3333-3333-333333333333",
        kind: "sandbox",
        usd: 0.2,
      });
      await recordCost(pool, {
        engineeringRunId: run.id,
        stageType: "verification_run",
        stageId: verificationRun.id,
        kind: "model",
        tokensIn: 10,
        tokensOut: 5,
        usd: 0.1,
      });

      const report = await collectMetrics(pool);

      assert.equal(report.summary.task_success_rate.completed, "1");
      assert.equal(report.summary.merge_rate.merge_rate_pct, "100.00");
      assert.equal(report.summary.verified_work_merged_without_rework.clean_merges, "1");
      assert.equal(report.summary.cost_per_verified_pr.verified_prs, "1");

      assert.equal(report.perRun.time_to_pr.length, 1);
      assert.ok(report.perRun.time_to_pr[0].time_to_pr);
      assert.equal(report.perRun.sandbox_duration.length, 2, "one row each for the maker and verifier occurrence");
      assert.equal(report.perRun.model_cost[0].model_cost_usd, "0.6");
      assert.equal(report.perRun.sandbox_cost[0].sandbox_cost_usd, "0.2");
      assert.equal(report.perRun.verification_cost[0].verification_cost_usd, "0.1");
      assert.equal(report.perRun.model_tokens[0].tokens_in, "110");

      const rendered = formatMetrics(report);
      assert.match(rendered, /task_success_rate/);
      assert.match(rendered, /sandbox_duration \(2 rows\)/);
    } finally {
      await dropMigratedDatabase(schema);
      await pool.end();
    }
  },
);
