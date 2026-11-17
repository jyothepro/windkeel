/**
 * Retention for the maker's screenshots (#421, ADR-0035's 2026-10-27 amendment).
 *
 * A run's screenshots live under `maker-browser/<run-id>/` and in `maker_screenshot` (#392). The
 * retention sweep deletes them 30 days after the run's newest one: objects first, then rows. These
 * are the capture tier's cases — expiry, the window's edge, an interrupted sweep, a stopping sweep —
 * plus the per-run anchor and the race guard on the row delete.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import {
  MAKER_SCREENSHOT_RETENTION_DAYS,
  listPrunableScreenshotRuns,
  pruneScreenshotRun,
  runScreenshotRetentionSweep,
} from "../dist/factory/maker-screenshot-retention.js";
import { CAPTURE_RETENTION_DAYS } from "../dist/factory/capture-retention.js";
import { makerScreenshotPrefix } from "../dist/factory/maker-screenshots.js";
import { insertAgentRun, insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-27T00:00:00Z");
const BUCKET = "evidence-test";

/** Holds one entry per run prefix, so "the rows say stored" and "it is stored" can disagree. */
class FakeStorage {
  constructor() {
    this.objects = new Set();
    this.deletes = [];
    /** When set, the next delete removes the objects and then throws — the process dying mid-prune. */
    this.dieAfterDelete = false;
  }
  async putPackage() {}
  async deletePackage(bucket, key) {
    this.deletes.push(`${bucket}/${key}`);
    this.objects.delete(`${bucket}/${key}`); // S3: deleting an absent key succeeds.
    if (this.dieAfterDelete) {
      this.dieAfterDelete = false;
      throw new Error("killed between deleting the objects and deleting the rows");
    }
  }
}

async function withSchema(fn) {
  const schema = `windkeel_shot_retention_${process.pid}_${Date.now()}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    await fn(pool);
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

async function newRun(pool) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "github_issue",
    sourceReference: `${Math.random()}`,
    title: "t",
    description: "d",
    acceptanceCriteria: [],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
  const agentRun = await insertAgentRun(pool, {
    engineeringRunId: run.id,
    workerType: "scripted",
    model: "m",
    role: "implementer",
    tokenUsage: null,
  });
  return { ...run, agentRunId: agentRun.id };
}

let shaCounter = 0;
/** One stored screenshot on `runId`, taken `ageDays` before NOW, with its `screenshot` feed event. */
async function shoot(pool, storage, run, ageDays) {
  const runId = run.id;
  const sha = (++shaCounter).toString(16).padStart(64, "0");
  const { rows } = await pool.query(
    `insert into maker_screenshot (engineering_run_id, agent_run_id, sha256, object_key, bytes, name, captured_at)
     values ($1, $5, $2, $3, 10, 'home', $4) returning id`,
    [runId, sha, `${makerScreenshotPrefix(runId)}/${sha}.png`, new Date(NOW.getTime() - ageDays * DAY_MS), run.agentRunId],
  );
  await pool.query(
    `insert into agent_event (engineering_run_id, agent_run_id, ordinal, type, payload)
     values ($1, $3, null, 'screenshot', $2::jsonb)`,
    [runId, JSON.stringify({ screenshotId: rows[0].id, name: "home", url: null }), run.agentRunId],
  );
  storage.objects.add(`${BUCKET}/${makerScreenshotPrefix(runId)}`);
  return rows[0].id;
}

async function countRows(pool, runId) {
  const { rows } = await pool.query("select count(*)::int as n from maker_screenshot where engineering_run_id = $1", [
    runId,
  ]);
  return rows[0].n;
}

test("the screenshot window is 30 days — the capture tier's, because a screenshot is diagnostic too", () => {
  assert.equal(MAKER_SCREENSHOT_RETENTION_DAYS, 30);
  assert.equal(MAKER_SCREENSHOT_RETENTION_DAYS, CAPTURE_RETENTION_DAYS);
});

test("a run's screenshots past the window are deleted — objects and rows — and the feed keeps its events", { skip }, async () => {
  await withSchema(async (pool) => {
    const storage = new FakeStorage();
    const run = await newRun(pool);
    await shoot(pool, storage, run, 35);
    await shoot(pool, storage, run, 31);

    const result = await runScreenshotRetentionSweep(pool, storage, BUCKET, NOW);

    assert.deepEqual(result, { prunedRunIds: [run.id], screenshotsPruned: 2, interrupted: false });
    assert.deepEqual(storage.deletes, [`${BUCKET}/maker-browser/${run.id}`]);
    assert.equal(storage.objects.size, 0, "the stored objects go, not only the rows");
    assert.equal(await countRows(pool, run.id), 0);
    const events = await pool.query("select count(*)::int as n from agent_event where engineering_run_id = $1 and type = 'screenshot'", [run.id]);
    assert.equal(events.rows[0].n, 2, "the run's history stays; the file route answers 404 for an expired id");

    const again = await runScreenshotRetentionSweep(pool, storage, BUCKET, NOW);
    assert.deepEqual(again, { prunedRunIds: [], screenshotsPruned: 0, interrupted: false }, "idempotent");
    assert.equal(storage.deletes.length, 1);
  });
});

test("a run inside the window is left alone, right up to its 30th day", { skip }, async () => {
  await withSchema(async (pool) => {
    const storage = new FakeStorage();
    const fresh = await newRun(pool);
    const almost = await newRun(pool);
    const expired = await newRun(pool);
    await shoot(pool, storage, fresh, 1);
    await shoot(pool, storage, almost, 29.9);
    await shoot(pool, storage, expired, 30);

    const result = await runScreenshotRetentionSweep(pool, storage, BUCKET, NOW);

    assert.deepEqual(result.prunedRunIds, [expired.id]);
    for (const run of [fresh, almost]) {
      assert.ok(storage.objects.has(`${BUCKET}/maker-browser/${run.id}`), "an in-window run's objects are untouched");
      assert.equal(await countRows(pool, run.id), 1);
    }
  });
});

test("the window runs from the run's newest screenshot: an old one beside a recent one is kept with it", { skip }, async () => {
  await withSchema(async (pool) => {
    const storage = new FakeStorage();
    const run = await newRun(pool);
    await shoot(pool, storage, run, 60);
    await shoot(pool, storage, run, 10);

    assert.deepEqual(await listPrunableScreenshotRuns(pool, NOW, 30), []);
    assert.deepEqual((await runScreenshotRetentionSweep(pool, storage, BUCKET, NOW)).prunedRunIds, []);
    assert.equal(await countRows(pool, run.id), 2, "a run's set is never half-pruned");

    const later = new Date(NOW.getTime() + 20 * DAY_MS);
    assert.deepEqual((await runScreenshotRetentionSweep(pool, storage, BUCKET, later)).prunedRunIds, [run.id]);
    assert.equal(await countRows(pool, run.id), 0);
  });
});

test("an interrupted sweep repairs itself: objects gone, rows kept, next sweep finishes them", { skip }, async () => {
  await withSchema(async (pool) => {
    const storage = new FakeStorage();
    const run = await newRun(pool);
    await shoot(pool, storage, run, 45);

    storage.dieAfterDelete = true;
    await assert.rejects(runScreenshotRetentionSweep(pool, storage, BUCKET, NOW), /killed between/);
    assert.equal(storage.objects.size, 0, "the objects went first");
    assert.equal(await countRows(pool, run.id), 1, "the rows were not deleted");

    const next = await runScreenshotRetentionSweep(pool, storage, BUCKET, NOW);
    assert.deepEqual(next, { prunedRunIds: [run.id], screenshotsPruned: 1, interrupted: false });
    assert.equal(storage.deletes.length, 2, "the next tick re-issues the (no-op) delete");
    assert.equal(await countRows(pool, run.id), 0);
  });
});

test("a stopping sweep finishes the run it is on and leaves the rest for the next tick", { skip }, async () => {
  await withSchema(async (pool) => {
    const storage = new FakeStorage();
    const first = await newRun(pool);
    const second = await newRun(pool);
    await shoot(pool, storage, first, 50);
    await shoot(pool, storage, second, 40);
    const stop = new AbortController();
    const original = storage.deletePackage.bind(storage);
    storage.deletePackage = async (bucket, key) => {
      await original(bucket, key);
      stop.abort();
    };

    const result = await runScreenshotRetentionSweep(pool, storage, BUCKET, NOW, undefined, { signal: stop.signal });
    assert.deepEqual(result, { prunedRunIds: [first.id], screenshotsPruned: 1, interrupted: true });
    assert.equal(await countRows(pool, first.id), 0, "the run it was on is finished, rows and all");
    assert.equal(await countRows(pool, second.id), 1);

    storage.deletePackage = original;
    assert.deepEqual((await runScreenshotRetentionSweep(pool, storage, BUCKET, NOW)).prunedRunIds, [second.id]);
  });
});

test("a screenshot harvested between the list and the row delete keeps its row", { skip }, async () => {
  await withSchema(async (pool) => {
    const storage = new FakeStorage();
    const run = await newRun(pool);
    await shoot(pool, storage, run, 40);
    const [candidate] = await listPrunableScreenshotRuns(pool, NOW, 30);

    const late = await shoot(pool, storage, run, 0);
    assert.equal(await pruneScreenshotRun(pool, storage, BUCKET, candidate), 1);
    const { rows } = await pool.query("select id from maker_screenshot where engineering_run_id = $1", [run.id]);
    assert.deepEqual(rows.map((r) => r.id), [late]);
  });
});
