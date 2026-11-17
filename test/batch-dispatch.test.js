/**
 * The batch dispatcher (#391, ADR-0036) against real Postgres with a recording enqueuer: the
 * concurrency limits, the batch's rails, lazy materialisation through the one intake path, and
 * how a batch settles. Skips without `TEST_DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchBatches, dispatchOrganization } from "../dist/batches/dispatch.js";
import { createBatchNotifier } from "../dist/batches/notifier.js";
import { changeBatchLifecycle, getBatch, loadBatchChildren, summariseBatch } from "../dist/batches/store.js";
import { requeueStrandedCreatedRuns } from "../dist/factory/sweeps/stranded-created-runs.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { notifyRunOutcome, registerSourceNotifier, unregisterSourceNotifier } from "../dist/intake/notifiers.js";
import { batchTasks, makeBatch, REPOS, settleRun, skip, withBatchDb } from "./batch-helpers.js";

const status = async (pool, orgId, id) => (await getBatch(pool, orgId, id)).status;

test("dispatches only up to max_concurrency, and the next child only after one settles", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer, enqueued }) => {
    const batch = await makeBatch(pool, orgId, operator, { maxConcurrency: 2 });
    const first = await dispatchOrganization(pool, orgId, enqueuer);
    assert.equal(first.batches[0].started.length, 2);
    let tasks = await batchTasks(pool, batch.id);
    assert.equal(tasks.length, 2);
    assert.deepEqual(enqueued.sort(), tasks.map((t) => t.run_id).sort(), "each child enqueued after commit");

    // Every child is an ordinary intake task: source `batch`, its creator the batch's, criteria explicit.
    for (const [i, t] of tasks.entries()) {
      assert.equal(t.source_type, "batch");
      assert.equal(t.source_reference, `batch:${batch.id}:${i}`);
      assert.equal(t.created_by_principal_id, operator);
      assert.equal(t.criteria_provenance, "extracted");
      assert.deepEqual(t.acceptance_criteria.map((c) => c.text), ["npm run lint passes"]);
    }

    assert.equal((await dispatchOrganization(pool, orgId, enqueuer)).batches[0].started.length, 0, "no slot, nothing new");
    // A child in verification still holds its slot; one handed to a reviewer frees it.
    await settleRun(pool, tasks[0].run_id, "VERIFYING");
    assert.equal((await dispatchOrganization(pool, orgId, enqueuer)).batches[0].started.length, 0);
    await settleRun(pool, tasks[0].run_id, "WAITING_FOR_HUMAN", { verdict: "pass" });
    assert.equal((await dispatchOrganization(pool, orgId, enqueuer)).batches[0].started.length, 1);
    tasks = await batchTasks(pool, batch.id);
    assert.equal(tasks.length, 3);
    assert.equal(await status(pool, orgId, batch.id), "RUNNING");
  });
});

test("the organization's max_concurrent_runs caps dispatch across batches", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    await pool.query("update organization set max_concurrent_runs = 3 where id = $1", [orgId]);
    const a = await makeBatch(pool, orgId, operator, { maxConcurrency: 2 });
    const b = await makeBatch(pool, orgId, operator, { maxConcurrency: 2 });
    await dispatchOrganization(pool, orgId, enqueuer);
    const started = (await batchTasks(pool, a.id)).length + (await batchTasks(pool, b.id)).length;
    assert.equal(started, 3, "2 + 2 wanted, the organization allows 3");
    assert.equal((await batchTasks(pool, a.id)).length, 2, "oldest batch first");
  });
});

test("the deployment default applies when the organization sets none", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    const batch = await makeBatch(pool, orgId, operator, { repositories: REPOS, maxConcurrency: 4 });
    await dispatchOrganization(pool, orgId, { ...enqueuer, env: { WINDKEEL_DEFAULT_ORG_MAX_CONCURRENT_RUNS: "1" } });
    assert.equal((await batchTasks(pool, batch.id)).length, 1);
  });
});

test("concurrent dispatchers never double-create a child", { skip }, async () => {
  await withBatchDb(
    async ({ pool, orgId, operator, enqueuer }) => {
      const batch = await makeBatch(pool, orgId, operator, { repositories: REPOS, maxConcurrency: 2 });
      await Promise.all(Array.from({ length: 5 }, () => dispatchOrganization(pool, orgId, enqueuer)));
      assert.equal((await batchTasks(pool, batch.id)).length, 2);
      const items = (await pool.query("select state, count(*)::int as n from batch_item where batch_id = $1 group by state", [batch.id])).rows;
      assert.deepEqual(Object.fromEntries(items.map((r) => [r.state, r.n])), { dispatched: 2, pending: 2 });
    },
    { poolMax: 10 },
  );
});

test("an enqueue that fails after commit leaves a CREATED run the stranded sweep heals; pending items are never runs", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    const batch = await makeBatch(pool, orgId, operator, { maxConcurrency: 1 });
    const logged = [];
    const result = await dispatchOrganization(pool, orgId, {
      startRun: async () => {
        throw new Error("workflow unavailable");
      },
      log: (message) => logged.push(message),
    });
    assert.equal(result.enqueueFailed.length, 1);
    assert.ok(logged.includes("batch child enqueue failed"));
    const [task] = await batchTasks(pool, batch.id);
    assert.equal(task.status, "CREATED");
    assert.equal((await pool.query("select count(*)::int as n from workflow_run_binding")).rows[0].n, 0);

    const healed = await requeueStrandedCreatedRuns({ pool, startRun: enqueuer.startRun, minimumAgeMs: -60_000 });
    assert.equal(healed.examined, 1, "the one dispatched child, and none of the two pending items");
    assert.equal(healed.requeued, 1);
    assert.equal((await pool.query("select count(*)::int as n from batch_item where batch_id = $1 and state = 'pending'", [batch.id])).rows[0].n, 2);
  });
});

test("a grant withdrawn mid-batch skips that item, with the reason", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    const batch = await makeBatch(pool, orgId, operator, { maxConcurrency: 3 });
    await pool.query("delete from repository_grant where repository_id = $1", [REPOS[1]]);
    const result = await dispatchOrganization(pool, orgId, enqueuer);
    assert.deepEqual(result.batches[0].skipped, [{ ordinal: 1, reason: "repository_not_granted" }]);
    assert.equal(result.batches[0].started.length, 2);
    const item = (await pool.query("select state, skip_reason from batch_item where batch_id = $1 and ordinal = 1", [batch.id])).rows[0];
    assert.deepEqual(item, { state: "skipped", skip_reason: "repository_not_granted" });
  });
});

test("each child's spend cap is its own, lowered to the batch's remaining budget", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    const batch = await makeBatch(pool, orgId, operator, { maxConcurrency: 3, batchSpendCapUsd: 30, spendCapUsd: 12, wallClockCapSeconds: 900 });
    await dispatchOrganization(pool, orgId, enqueuer);
    const tasks = await batchTasks(pool, batch.id);
    // 12 + 12 reserved, 6 left for the third: in-flight children fit inside the cap together.
    assert.deepEqual(tasks.map((t) => Number(t.spend_cap_usd)), [12, 12, 6]);
    const wall = (await pool.query("select distinct wall_clock_cap_seconds as w from engineering_run")).rows;
    assert.deepEqual(wall, [{ w: 900 }]);
  });
});

test("at the batch cap: in-flight children finish, nothing new starts, and stop_reason is batch_spend_cap", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    const batch = await makeBatch(pool, orgId, operator, { repositories: REPOS, maxConcurrency: 2, batchSpendCapUsd: 10, spendCapUsd: 5 });
    await dispatchOrganization(pool, orgId, enqueuer);
    let tasks = await batchTasks(pool, batch.id);
    assert.deepEqual(tasks.map((t) => Number(t.spend_cap_usd)), [5, 5]);
    // The first child spends its whole cap and fails; the second is still working.
    await settleRun(pool, tasks[0].run_id, "FAILED", { cost: 5 });
    await settleRun(pool, tasks[1].run_id, "IMPLEMENTING", { cost: 5 });
    const result = await dispatchOrganization(pool, orgId, enqueuer);
    assert.equal(result.batches[0].started.length, 0);
    assert.equal(result.batches[0].status, "STOPPING");
    assert.equal(result.batches[0].stopReason, "batch_spend_cap");
    assert.deepEqual(result.batches[0].skipped.map((s) => s.reason), ["batch_stopped", "batch_stopped"]);
    tasks = await batchTasks(pool, batch.id);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[1].status, "IMPLEMENTING", "the in-flight child is let finish, not cancelled");

    await settleRun(pool, tasks[1].run_id, "WAITING_FOR_HUMAN", { verdict: "pass" });
    await dispatchOrganization(pool, orgId, enqueuer);
    const settled = await getBatch(pool, orgId, batch.id);
    assert.equal(settled.status, "PARTIAL");
    assert.equal(settled.stopReason, "batch_spend_cap");
    assert.ok(settled.completedAt);
  });
});

test("a child awaiting review keeps its unspent cap reserved: Make changes cannot take the batch past its cap", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    const batch = await makeBatch(pool, orgId, operator, { repositories: REPOS.slice(0, 2), maxConcurrency: 1, batchSpendCapUsd: 10, spendCapUsd: 8 });
    await dispatchOrganization(pool, orgId, enqueuer);
    let tasks = await batchTasks(pool, batch.id);
    assert.deepEqual(tasks.map((t) => Number(t.spend_cap_usd)), [8]);
    // The $8 child spends $3 and hands a verified PR to a reviewer: its slot frees, its $5 does not.
    await settleRun(pool, tasks[0].run_id, "WAITING_FOR_HUMAN", { cost: 3, verdict: "pass" });
    const result = await dispatchOrganization(pool, orgId, enqueuer);
    assert.equal(result.batches[0].started.length, 1, "the slot is free");
    assert.equal(result.batches[0].started[0].spendCapUsd, 2, "10 − 3 spent − 5 still reserved, not 10 − 3");
    tasks = await batchTasks(pool, batch.id);
    // *Make changes*: the reviewer hands the same run back (WAITING_FOR_HUMAN -> HUMAN_EDITING ->
    // IMPLEMENTING) and it spends up to its own cap again.
    await settleRun(pool, tasks[0].run_id, "HUMAN_EDITING");
    await settleRun(pool, tasks[0].run_id, "IMPLEMENTING", { cost: 8 });
    const caps = tasks.map((t) => Number(t.spend_cap_usd));
    assert.deepEqual(caps, [8, 2]);
    assert.ok(caps.reduce((a, b) => a + b, 0) <= 10, "worst case: every child spends its whole cap, still within the batch cap");
    const { items, runs } = await loadBatchChildren(pool, batch.id);
    const p = summariseBatch(batch, items, runs);
    assert.equal(p.totalCostUsd, 8);
    assert.equal(p.reservedUsd, 2, "the second child's whole cap; the first has spent all of its own");
    assert.ok(p.totalCostUsd + p.reservedUsd <= 10);
  });
});

test("a batch whose budget is held by children awaiting review waits for reviewers, then continues", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    const batch = await makeBatch(pool, orgId, operator, { repositories: REPOS.slice(0, 3), maxConcurrency: 1, batchSpendCapUsd: 10, spendCapUsd: 5 });
    await dispatchOrganization(pool, orgId, enqueuer);
    await settleRun(pool, (await batchTasks(pool, batch.id))[0].run_id, "WAITING_FOR_HUMAN", { verdict: "pass" });
    await dispatchOrganization(pool, orgId, enqueuer);
    let tasks = await batchTasks(pool, batch.id);
    assert.deepEqual(tasks.map((t) => Number(t.spend_cap_usd)), [5, 5]);
    await settleRun(pool, tasks[1].run_id, "WAITING_FOR_HUMAN", { verdict: "pass" });
    // Both slots are free but all $10 is held by the two awaiting review: nothing starts, and the
    // batch neither stops nor settles — it waits.
    const waiting = await dispatchOrganization(pool, orgId, enqueuer);
    assert.equal(waiting.batches[0].started.length, 0);
    assert.equal(waiting.batches[0].status, "RUNNING");
    assert.equal(waiting.batches[0].stopReason, null);
    assert.equal((await batchTasks(pool, batch.id)).length, 2);
    // A reviewer merges the first: its reservation is released and the third child starts.
    await settleRun(pool, tasks[0].run_id, "COMPLETED");
    const resumed = await dispatchOrganization(pool, orgId, enqueuer);
    assert.deepEqual(resumed.batches[0].started.map((s) => s.spendCapUsd), [5]);
  });
});

test("a cap so small the first child exhausts it stops the batch", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    const batch = await makeBatch(pool, orgId, operator, { maxConcurrency: 3, batchSpendCapUsd: 0.5 });
    await dispatchOrganization(pool, orgId, enqueuer);
    let tasks = await batchTasks(pool, batch.id);
    assert.equal(tasks.length, 1, "the whole budget is reserved for the first child");
    assert.equal(Number(tasks[0].spend_cap_usd), 0.5);
    await settleRun(pool, tasks[0].run_id, "FAILED", { cost: 0.5 });
    await dispatchOrganization(pool, orgId, enqueuer);
    tasks = await batchTasks(pool, batch.id);
    assert.equal(tasks.length, 1);
    const settled = await getBatch(pool, orgId, batch.id);
    assert.equal(settled.stopReason, "batch_spend_cap");
    assert.equal(settled.status, "FAILED");
  });
});

test("the failure-ratio breaker stops dispatch", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    const more = ["55555555-5555-5555-5555-555555555555"];
    const { seedFixtureRepository } = await import("./helpers.js");
    for (const id of more) await seedFixtureRepository(pool, id);
    const batch = await makeBatch(pool, orgId, operator, { repositories: [...REPOS, ...more], maxConcurrency: 3, stopOnFailureRatio: 0.6 });
    await dispatchOrganization(pool, orgId, enqueuer);
    const tasks = await batchTasks(pool, batch.id);
    await settleRun(pool, tasks[0].run_id, "FAILED");
    await settleRun(pool, tasks[1].run_id, "MAX_REPAIR_ATTEMPTS_REACHED", { verdict: "fail" });
    await settleRun(pool, tasks[2].run_id, "WAITING_FOR_HUMAN", { verdict: "pass" });
    const result = await dispatchOrganization(pool, orgId, enqueuer);
    assert.equal(result.batches[0].stopReason, "failure_ratio");
    assert.equal((await batchTasks(pool, batch.id)).length, 3, "2 of 3 failed: nothing more starts");
    assert.equal(await status(pool, orgId, batch.id), "PARTIAL", "nothing in flight, so it settles at once");
  });
});

test("a paused batch dispatches nothing until resumed", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    const batch = await makeBatch(pool, orgId, operator);
    await changeBatchLifecycle(pool, orgId, batch.id, "pause");
    await dispatchOrganization(pool, orgId, enqueuer);
    assert.equal((await batchTasks(pool, batch.id)).length, 0);
    await assert.rejects(changeBatchLifecycle(pool, orgId, batch.id, "pause"), (e) => e.code === "invalid_batch_state");
    await changeBatchLifecycle(pool, orgId, batch.id, "resume");
    await dispatchOrganization(pool, orgId, enqueuer);
    assert.equal((await batchTasks(pool, batch.id)).length, 3);
  });
});

test("cancel skips pending items and names the children still working, not the verified ones", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    const batch = await makeBatch(pool, orgId, operator, { repositories: REPOS, maxConcurrency: 3 });
    await dispatchOrganization(pool, orgId, enqueuer);
    const tasks = await batchTasks(pool, batch.id);
    await settleRun(pool, tasks[0].run_id, "COMPLETED", { verdict: "pass" });
    // A verified pull request waiting on a reviewer is finished work, not work in flight.
    await settleRun(pool, tasks[1].run_id, "WAITING_FOR_HUMAN", { verdict: "pass" });
    const { batch: cancelled, cancelRuns } = await changeBatchLifecycle(pool, orgId, batch.id, "cancel");
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(cancelled.stopReason, "cancelled");
    assert.deepEqual(cancelRuns, [tasks[2].run_id]);
    const skipped = (await pool.query("select ordinal, skip_reason from batch_item where batch_id = $1 and state = 'skipped'", [batch.id])).rows;
    assert.deepEqual(skipped, [{ ordinal: 3, skip_reason: "batch_cancelled" }]);
    await dispatchOrganization(pool, orgId, enqueuer);
    assert.equal((await batchTasks(pool, batch.id)).length, 3);
    await assert.rejects(changeBatchLifecycle(pool, orgId, batch.id, "cancel"), (e) => e.status === 409);
  });
});

test("a batch settles COMPLETED, PARTIAL or FAILED from its children", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    const outcomes = [
      [["WAITING_FOR_HUMAN", "pass"], ["COMPLETED", "pass"]],
      [["WAITING_FOR_HUMAN", "pass"], ["FAILED", null]],
      [["MAX_REPAIR_ATTEMPTS_REACHED", "fail"], ["CANCELLED", null]],
    ];
    const expected = ["COMPLETED", "PARTIAL", "FAILED"];
    for (const [i, children] of outcomes.entries()) {
      const batch = await makeBatch(pool, orgId, operator, { repositories: REPOS.slice(0, 2), maxConcurrency: 2 });
      await dispatchOrganization(pool, orgId, enqueuer);
      const tasks = await batchTasks(pool, batch.id);
      assert.equal(await status(pool, orgId, batch.id), "RUNNING");
      for (const [j, [s, verdict]] of children.entries()) await settleRun(pool, tasks[j].run_id, s, { verdict });
      await dispatchOrganization(pool, orgId, enqueuer);
      assert.equal(await status(pool, orgId, batch.id), expected[i], `case ${i}`);
    }
  });
});

test("a settling child dispatches its organization through the batch notifier, and the cron does the rest", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    const batch = await makeBatch(pool, orgId, operator, { maxConcurrency: 1 });
    registerSourceNotifier(createBatchNotifier(pool, enqueuer));
    try {
      await dispatchOrganization(pool, orgId, enqueuer);
      let [task] = await batchTasks(pool, batch.id);
      // A real transition, through the run service, as the workflow makes it.
      await advanceRun(pool, task.run_id, "CANCELLED", "test: cancelled");
      assert.equal((await batchTasks(pool, batch.id)).length, 2, "the notifier filled the freed slot");

      // Without the notifier, the cron's sweep fills it.
      unregisterSourceNotifier("batch");
      const tasks = await batchTasks(pool, batch.id);
      await settleRun(pool, tasks[1].run_id, "FAILED");
      const swept = await dispatchBatches(pool, enqueuer);
      assert.equal(swept.kind, "ran");
      assert.equal((await batchTasks(pool, batch.id)).length, 3);
      // A non-terminal transition does nothing.
      const run = (await pool.query("select * from engineering_run where id = $1", [tasks[0].run_id])).rows[0];
      await notifyRunOutcome(pool, { ...run, taskId: run.task_id }, { id: "x", toState: "CLASSIFYING", fromState: "CREATED", reason: null });
    } finally {
      unregisterSourceNotifier("batch");
    }
  });
});
