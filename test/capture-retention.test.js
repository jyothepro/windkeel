/**
 * Retention for stored captures (#288, ADR-0015's 2026-10-20 amendment).
 *
 * A capture (`captures/<run-id>/`, #286) is recorded on `run_capture`, and the retention sweep
 * deletes it 30 days after it was taken: objects first, then `pruned_at`, and the row is kept so
 * the API can say "pruned". These are the issue's three cases — expiry, an interrupted sweep, and
 * a capture inside the window left alone — plus the edges the ordering argument rests on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import {
  CAPTURE_RETENTION_DAYS,
  getRunCapture,
  recordRunCapture,
  runCaptureRetentionSweep,
} from "../dist/factory/capture-retention.js";
import { captureObjectKey } from "../dist/factory/run-capture.js";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-20T00:00:00Z");
const BUCKET = "evidence-test";

/** Holds objects, so "the row says stored" and "it is stored" can disagree. */
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
      throw new Error("killed between deleting the objects and marking the row");
    }
  }
}

async function withSchema(fn) {
  const schema = `windkeel_capture_retention_${process.pid}_${Date.now()}`;
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
  return insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
}

/** A stored capture taken `ageDays` before NOW. */
async function capturedRun(pool, storage, ageDays) {
  const run = await newRun(pool);
  const objectKey = captureObjectKey(run.id);
  storage.objects.add(`${BUCKET}/${objectKey}`);
  await recordRunCapture(pool, {
    engineeringRunId: run.id,
    bucket: BUCKET,
    objectKey,
    byteTotal: 1234,
    capturedAt: new Date(NOW.getTime() - ageDays * DAY_MS),
  });
  return run;
}

test("the capture window is 30 days — shorter than evidence's 90, because a capture is diagnostic", () => {
  assert.equal(CAPTURE_RETENTION_DAYS, 30);
});

test("a capture past the window is deleted, and its row is kept and marked pruned", { skip }, async () => {
  await withSchema(async (pool) => {
    const storage = new FakeStorage();
    const old = await capturedRun(pool, storage, 31);

    const result = await runCaptureRetentionSweep(pool, storage, NOW);

    assert.deepEqual(result, { prunedRunIds: [old.id], interrupted: false });
    assert.deepEqual(storage.deletes, [`${BUCKET}/captures/${old.id}`]);
    assert.equal(storage.objects.size, 0);
    const row = await getRunCapture(pool, old.id);
    assert.ok(row, "the row survives the prune — it is how the API says 'pruned'");
    assert.deepEqual(row.prunedAt, NOW);
    assert.equal(row.byteTotal, 1234);

    const again = await runCaptureRetentionSweep(pool, storage, NOW);
    assert.deepEqual(again.prunedRunIds, [], "idempotent: a pruned capture is not swept twice");
    assert.equal(storage.deletes.length, 1);
  });
});

test("a capture inside the window is left alone, right up to its 30th day", { skip }, async () => {
  await withSchema(async (pool) => {
    const storage = new FakeStorage();
    const fresh = await capturedRun(pool, storage, 1);
    const almost = await capturedRun(pool, storage, 29.9);
    const expired = await capturedRun(pool, storage, 30);

    const result = await runCaptureRetentionSweep(pool, storage, NOW);

    assert.deepEqual(result.prunedRunIds, [expired.id]);
    for (const run of [fresh, almost]) {
      assert.ok(storage.objects.has(`${BUCKET}/captures/${run.id}`), "an in-window capture's objects are untouched");
      assert.equal((await getRunCapture(pool, run.id)).prunedAt, null);
    }
  });
});

test("an interrupted sweep repairs itself: objects gone, row unmarked, next sweep finishes it", { skip }, async () => {
  await withSchema(async (pool) => {
    const storage = new FakeStorage();
    const run = await capturedRun(pool, storage, 45);

    // The process dies after the objects are deleted and before `pruned_at` is written.
    storage.dieAfterDelete = true;
    await assert.rejects(runCaptureRetentionSweep(pool, storage, NOW), /killed between/);
    assert.equal(storage.objects.size, 0, "the objects went first");
    assert.equal((await getRunCapture(pool, run.id)).prunedAt, null, "the row was not marked");

    // The row still qualifies, so the next tick re-issues the (no-op) delete and marks it.
    const next = await runCaptureRetentionSweep(pool, storage, NOW);
    assert.deepEqual(next.prunedRunIds, [run.id]);
    assert.equal(storage.deletes.length, 2);
    assert.deepEqual((await getRunCapture(pool, run.id)).prunedAt, NOW);
  });
});

test("a stopping sweep finishes the capture it is on and leaves the rest for the next tick", { skip }, async () => {
  await withSchema(async (pool) => {
    const storage = new FakeStorage();
    const first = await capturedRun(pool, storage, 50);
    const second = await capturedRun(pool, storage, 40);
    const stop = new AbortController();
    const original = storage.deletePackage.bind(storage);
    storage.deletePackage = async (bucket, key) => {
      await original(bucket, key);
      stop.abort();
    };

    const result = await runCaptureRetentionSweep(pool, storage, NOW, undefined, { signal: stop.signal });
    assert.deepEqual(result, { prunedRunIds: [first.id], interrupted: true });
    assert.equal((await getRunCapture(pool, second.id)).prunedAt, null);

    storage.deletePackage = original;
    const next = await runCaptureRetentionSweep(pool, storage, NOW);
    assert.deepEqual(next.prunedRunIds, [second.id]);
  });
});

test("a re-capture replaces the row: the window restarts and a pruned capture is stored again", { skip }, async () => {
  await withSchema(async (pool) => {
    const storage = new FakeStorage();
    const run = await capturedRun(pool, storage, 31);
    await runCaptureRetentionSweep(pool, storage, NOW);
    assert.ok((await getRunCapture(pool, run.id)).prunedAt);

    const again = await recordRunCapture(pool, {
      engineeringRunId: run.id,
      bucket: BUCKET,
      objectKey: captureObjectKey(run.id),
      byteTotal: 99,
      capturedAt: NOW,
    });
    assert.equal(again.prunedAt, null);
    assert.equal(again.byteTotal, 99);
    assert.deepEqual((await runCaptureRetentionSweep(pool, storage, NOW)).prunedRunIds, []);
  });
});

test("a capture that predates run_capture has no row, so the sweep cannot see it and keeps it", { skip }, async () => {
  await withSchema(async (pool) => {
    const storage = new FakeStorage();
    const run = await newRun(pool);
    storage.objects.add(`${BUCKET}/captures/${run.id}`); // stored by #286 before migration 0037

    const result = await runCaptureRetentionSweep(pool, storage, new Date(NOW.getTime() + 365 * DAY_MS));
    assert.deepEqual(result.prunedRunIds, []);
    assert.deepEqual(storage.deletes, [], "no bucket scan, no guess at its age");
  });
});
