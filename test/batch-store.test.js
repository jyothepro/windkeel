/**
 * The batch store (#391, migrations/0048): insert, read, list, the derived roll-up, and
 * organization isolation. Real Postgres; skips without `TEST_DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { batchDetail, getBatch, listBatches } from "../dist/batches/store.js";
import { dispatchOrganization } from "../dist/batches/dispatch.js";
import { batchTasks, makeBatch, REPOS, settleRun, skip, withBatchDb } from "./batch-helpers.js";

test("the migration adds the tables, the task column, the organization limit and the admin permission", { skip }, async () => {
  await withBatchDb(async ({ pool }) => {
    const columns = async (table) =>
      (await pool.query("select column_name from information_schema.columns where table_schema = current_schema() and table_name = $1", [table])).rows.map((r) => r.column_name);
    assert.ok((await columns("batch")).includes("batch_spend_cap_usd"));
    assert.ok((await columns("batch_item")).includes("ordinal"));
    assert.ok((await columns("engineering_task")).includes("batch_id"));
    assert.ok((await columns("organization")).includes("max_concurrent_runs"));
    const roles = (await pool.query("select key, permissions from access_role where account_id is null")).rows;
    assert.ok(roles.find((r) => r.key === "admin").permissions.includes("batches.manage"));
    for (const r of roles.filter((r) => r.key !== "admin")) assert.ok(!r.permissions.includes("batches.manage"), r.key);
  });
});

test("insert, get and list; items start pending in order; an ordinal is unique per batch", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator }) => {
    const first = await makeBatch(pool, orgId, operator);
    const second = await makeBatch(pool, orgId, operator, { title: "Second", repositories: [REPOS[3]] });
    assert.equal(first.status, "RUNNING");
    assert.equal(first.maxConcurrency, 3);
    assert.equal(first.batchSpendCapUsd, 100);
    assert.deepEqual(first.template.criteria, ["npm run lint passes"]);

    assert.equal((await getBatch(pool, orgId, first.id)).title, "Bump the linter");
    assert.equal(await getBatch(pool, orgId, "not-a-uuid"), null);
    const page = await listBatches(pool, orgId);
    assert.deepEqual(page.items.map((b) => b.id), [second.id, first.id], "newest first");
    const one = await listBatches(pool, orgId, { limit: 1 });
    assert.equal(one.hasNextPage, true);
    assert.deepEqual((await listBatches(pool, orgId, { cursor: one.endCursor })).items.map((b) => b.id), [first.id]);
    assert.deepEqual((await listBatches(pool, orgId, { status: "PAUSED" })).items, []);

    const items = (await pool.query("select ordinal, repository_id, state from batch_item where batch_id = $1 order by ordinal", [first.id])).rows;
    assert.deepEqual(items.map((i) => [i.ordinal, i.repository_id, i.state]), REPOS.slice(0, 3).map((r, i) => [i, r, "pending"]));
    await assert.rejects(
      pool.query("insert into batch_item (batch_id, ordinal, repository_id, spec) values ($1, 0, $2, '{}')", [first.id, REPOS[0]]),
      (e) => e.code === "23505",
    );
    // Nothing is a run yet: a pending item is a row the stranded sweep cannot see.
    assert.equal((await pool.query("select count(*)::int as n from engineering_task where batch_id is not null")).rows[0].n, 0);
  });
});

test("an ungranted repository is refused, naming it", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator }) => {
    await pool.query("delete from repository_grant where repository_id = $1", [REPOS[2]]);
    await assert.rejects(makeBatch(pool, orgId, operator), (e) => e.code === "repository_not_granted" && e.detail.ungranted[0] === REPOS[2]);
    assert.equal((await pool.query("select count(*)::int as n from batch")).rows[0].n, 0);
  });
});

test("the roll-up counts mixed child states and its cost is SUM(engineering_run.cost) over the children", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator, enqueuer }) => {
    const batch = await makeBatch(pool, orgId, operator, { repositories: REPOS, maxConcurrency: 4 });
    await dispatchOrganization(pool, orgId, enqueuer);
    const tasks = await batchTasks(pool, batch.id);
    assert.equal(tasks.length, 4);
    await settleRun(pool, tasks[0].run_id, "WAITING_FOR_HUMAN", { cost: 1.25, verdict: "pass" });
    await settleRun(pool, tasks[1].run_id, "MAX_REPAIR_ATTEMPTS_REACHED", { cost: 2.5, verdict: "fail" });
    await settleRun(pool, tasks[2].run_id, "VERIFYING", { cost: 0.75 });
    await pool.query("update engineering_run set pr_number = 12 where id = $1", [tasks[0].run_id]);

    const { progress, items } = await batchDetail(pool, batch);
    const sum = Number((await pool.query(
      "select sum(r.cost) as s from engineering_run r join engineering_task t on t.id = r.task_id where t.batch_id = $1",
      [batch.id],
    )).rows[0].s);
    assert.equal(progress.totalCostUsd, sum);
    assert.equal(progress.totalCostUsd, 4.5);
    assert.deepEqual(progress.byStatus, { WAITING_FOR_HUMAN: 1, MAX_REPAIR_ATTEMPTS_REACHED: 1, VERIFYING: 1, CREATED: 1 });
    assert.deepEqual(progress.verdicts, { pass: 1, warn: 0, fail: 1, none: 2 });
    assert.equal(progress.active, 2);
    assert.equal(progress.succeeded, 1);
    assert.equal(progress.failed, 1);
    const withPr = items.find((i) => i.run?.id === tasks[0].run_id);
    assert.match(withPr.pullRequestUrl, /^https:\/\/github\.com\/jyothepro\/windkeel-fixture-[0-9a-f]{8}\/pull\/12$/);
  });
});

test("another organization cannot read a batch", { skip }, async () => {
  await withBatchDb(async ({ pool, orgId, operator }) => {
    const batch = await makeBatch(pool, orgId, operator);
    const other = (
      await pool.query("insert into organization (account_id, name) select account_id, 'Elsewhere' from organization where id = $1 returning id", [orgId])
    ).rows[0].id;
    assert.equal(await getBatch(pool, other, batch.id), null);
    assert.deepEqual((await listBatches(pool, other)).items, []);
  });
});
