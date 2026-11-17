/**
 * A run's feed read backwards (`?last=` / `?before=`) and narrowed (`?kind=`): what lets the
 * console render a long run's newest page and follow live from it, instead of paging the whole
 * feed before painting anything.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { recordCost } from "../dist/factory/cost-ledger.js";
import { listRunEvents, listRunEventsBefore } from "../dist/factory/run-events.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const TOKEN = "test-operator-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";

async function newRun(pool) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: REPO_ID,
    sourceType: "api",
    sourceReference: `api:operator:${Math.random()}`,
    title: "Make the gauge read zero when empty",
    description: "- [ ] the gauge reads zero",
    acceptanceCriteria: [],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  return (await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 })).id;
}

async function withApi(fn) {
  const schema = `windkeel_tail_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const deps = { pool, control: {} };
    const auth = { token: TOKEN, subject: "operator" };
    const call = (path, params = {}) =>
      handleApiRequest(deps, auth, { method: "GET", path, query: { get: (name) => params[name] }, headers: { authorization: `Bearer ${TOKEN}` } });
    await fn({ pool, call });
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

/** A run with three transitions and a cost between them: four events, two kinds. */
async function busyRun(pool) {
  const runId = await newRun(pool);
  await advanceRun(pool, runId, "CLASSIFYING");
  await advanceRun(pool, runId, "PLANNING");
  await recordCost(pool, { engineeringRunId: runId, stageType: "workspace", stageId: runId, kind: "sandbox", usd: 0.01 });
  await advanceRun(pool, runId, "WAITING_FOR_APPROVAL");
  return runId;
}

test("a run's feed opens at its tail, pages backwards, and follows forward from the tail's end", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const runId = await busyRun(pool);

    const all = (await call(`/v1/runs/${runId}/events`, { limit: "200" })).body.items;
    assert.equal(all.length, 4);

    const tail = await call(`/v1/runs/${runId}/events`, { last: "2" });
    assert.equal(tail.status, 200);
    assert.deepEqual(tail.body.items.map((e) => e.cursor), all.slice(2).map((e) => e.cursor), "the newest two, oldest first");
    assert.equal(tail.body.hasPreviousPage, true);
    assert.equal(tail.body.endCursor, all.at(-1).cursor, "follow from the newest event");
    assert.equal(tail.body.startCursor, all[2].cursor);
    assert.equal(tail.body.runStatus, "WAITING_FOR_APPROVAL");

    const older = await call(`/v1/runs/${runId}/events`, { before: tail.body.startCursor, last: "2" });
    assert.deepEqual(older.body.items.map((e) => e.cursor), all.slice(0, 2).map((e) => e.cursor));
    assert.equal(older.body.hasPreviousPage, false);

    // Following forward from the tail's end sees exactly what comes next, and nothing twice.
    await advanceRun(pool, runId, "CANCELLED");
    const next = await call(`/v1/runs/${runId}/events`, { after: tail.body.endCursor });
    assert.deepEqual(next.body.items.map((e) => e.to), ["CANCELLED"]);
  });
});

test("a narrowed read returns only the kinds asked for, forward or backward", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const runId = await busyRun(pool);

    const transitions = await call(`/v1/runs/${runId}/events`, { kind: "transition", limit: "200" });
    assert.deepEqual(transitions.body.items.map((e) => e.to), ["CLASSIFYING", "PLANNING", "WAITING_FOR_APPROVAL"]);

    const lastTransition = await call(`/v1/runs/${runId}/events`, { kind: "transition", last: "1" });
    assert.deepEqual(lastTransition.body.items.map((e) => e.to), ["WAITING_FOR_APPROVAL"]);

    const costs = await call(`/v1/runs/${runId}/events`, { kind: "cost" });
    assert.deepEqual(costs.body.items.map((e) => e.kind), ["cost"]);
    assert.equal(costs.body.items[0].usd, 0.01);

    // Every branch of the union names its columns: an agent-only page still reads as agent events.
    const agentOnly = await listRunEvents(pool, runId, "0", 50, new Set(["agent"]));
    assert.deepEqual(agentOnly.items, []);
    const both = await listRunEventsBefore(pool, runId, null, 50, new Set(["cost", "transition"]));
    assert.equal(both.items.length, 4);
    assert.equal(both.items.find((e) => e.kind === "transition").to, "CLASSIFYING");
  });
});

test("an empty run's tail is empty, and following it starts from the beginning", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const runId = await newRun(pool);
    const none = await call(`/v1/runs/${runId}/events`, { last: "50" });
    assert.deepEqual(none.body.items, []);
    assert.equal(none.body.endCursor, "0");
    assert.equal(none.body.startCursor, null);
    assert.equal(none.body.hasPreviousPage, false);
  });
});

test("the backward and narrowed reads refuse what they cannot mean", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const runId = await newRun(pool);
    assert.equal((await call(`/v1/runs/${runId}/events`, { kind: "gossip" })).body.code, "invalid_kind");
    assert.equal((await call(`/v1/runs/${runId}/events`, { before: "x" })).body.code, "invalid_cursor");
    assert.equal((await call(`/v1/runs/${runId}/events`, { before: "5", after: "1" })).status, 400);
    assert.equal((await call(`/v1/runs/${runId}/events`, { last: "5", stream: "sse" })).status, 400, "the stream is the whole feed forward");
    assert.equal((await call(`/v1/runs/${runId}/events`, { kind: "transition", stream: "sse" })).status, 400);
  });
});
