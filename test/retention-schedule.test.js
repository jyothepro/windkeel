/**
 * ADR-0015's retention sweep, and the operational properties a deletion job needs.
 *
 * It was `worker-retention-schedule.test.js` and the schedule was a `setInterval` inside the
 * worker container. #200 deleted that container and #226 put the sweep on an hourly Vercel cron,
 * which calls `sweepOnce()` rather than `start()`. **Every property below survived the move** —
 * interval validation, the skip-with-a-reason, immediate-first-sweep, advisory-lock exclusion
 * and the self-healing interruption are all the scheduler's, not the container's — so the file
 * is renamed rather than deleted.
 *
 * `start()` is still covered here although the cron no longer calls it: it remains the API for
 * anything that wants a timer of its own, and a sweep that waited out its first interval before
 * doing anything would be a real regression for such a caller.
 *
 * `runRetentionSweep` had been implemented and well tested since M5 and **nothing in a running
 * process ever called it** — the policy was real in code and inert in production. What is new
 * here is not the sweep but the four operational properties a deletion job needs, and those are
 * what this file is about. `test/evidence-retention.test.js` still owns the tiering rules and is
 * unchanged.
 *
 * Deletion is the one irreversible thing Windkeel does. Every other failure mode costs a wasted
 * run; this one destroys the artifact that makes a past verdict checkable. So the interesting
 * assertions are the concurrency one and the interruption one, and the interruption one is
 * deliberately written to prove the *transient* inconsistency is real and self-healing rather
 * than to pretend it cannot happen.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import {
  InvalidConfigError,
  loadWorkerConfig,
} from "../dist/factory/worker-config.js";
import { createRetentionScheduler } from "../dist/factory/sweeps/retention-sweep.js";
import {
  getVerificationRun,
  insertEngineeringRun,
  insertEngineeringTask,
  insertVerificationRun,
  updateVerificationRun,
} from "../dist/factory/repositories.js";
import { getRunCapture, recordRunCapture } from "../dist/factory/capture-retention.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-07T00:00:00Z");

/** The minimum `loadWorkerConfig` accepts. */
function env(overrides = {}) {
  return {
    DATABASE_URL: "postgres://windkeel:windkeel@127.0.0.1:1/windkeel",
    WINDKEEL_REPOSITORY_URL: "https://github.com/o/r",
    OPENAI_API_KEY: "sk-not-a-real-key",
    ...overrides,
  };
}

/**
 * An evidence store that actually holds objects, so "the row says it exists" and "it exists" can
 * disagree — which is the whole subject of the interruption test. A counting spy could not tell
 * a dangling reference from an orphan.
 */
class FakeEvidenceStorage {
  constructor(refs = []) {
    this.objects = new Set(refs);
    this.deletes = [];
    /** Set to a promise to hold the *next* delete open, for interrupting mid-sweep. */
    this.gate = null;
    this.onDelete = null;
  }
  async putPackage() {}
  async deletePackage(bucket, key) {
    this.onDelete?.(`${bucket}/${key}`);
    if (this.gate) {
      const gate = this.gate;
      this.gate = null;
      await gate;
    }
    this.deletes.push({ bucket, key });
    // S3 treats deleting an absent key as success, and the self-healing argument depends on it.
    this.objects.delete(`${bucket}/${key}`);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function withSchema(fn) {
  const schema = `windkeel_retention_sched_${process.pid}_${Date.now()}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pools = [];
  const connect = () => {
    const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
    pools.push(pool);
    return pool;
  };

  const pool = connect();
  try {
    await seedFixtureRepository(pool);
    await fn({ pool, connect });
  } finally {
    for (const p of pools) await p.end().catch(() => {});
    await dropMigratedDatabase(schema);
  }
}

/** One engineering run carrying a superseded, prunable verification and a current one. */
async function prunableRun(pool, storage, ageDays = 100) {
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
  const run = await insertEngineeringRun(pool, {
    taskId: task.id,
    spendCapUsd: 25,
    wallClockCapSeconds: 7200,
  });

  const seal = async (completedAt) => {
    const vr = await insertVerificationRun(pool, {
      engineeringRunId: run.id,
      candidateSha: "sha",
      policyVersion: "v1",
    });
    const ref = `bucket/${run.id}/${vr.id}`;
    storage.objects.add(ref);
    return updateVerificationRun(pool, vr.id, {
      completedAt,
      evidencePackageRef: ref,
      evidenceManifestDigest: `sha256:${vr.id}`,
    });
  };

  const superseded = await seal(new Date(NOW.getTime() - ageDays * DAY_MS));
  const current = await seal(new Date(NOW.getTime() - DAY_MS));
  return { superseded, current };
}

function scheduler(pool, storage, overrides = {}) {
  const logs = [];
  const instance = createRetentionScheduler({
    pool,
    storage,
    intervalMs: 60_000,
    log: (message, fields) => logs.push({ message, ...fields }),
    now: () => NOW,
    makerScreenshotBucket: "bucket",
    ...overrides,
  });
  return { instance, logs };
}

// --- configuration -----------------------------------------------------------------------

test("the sweep interval is validated at startup and defaults to a day", () => {
  assert.equal(loadWorkerConfig(env()).retentionSweepIntervalMs, 24 * 60 * 60 * 1000);
  assert.equal(
    loadWorkerConfig(env({ WINDKEEL_RETENTION_SWEEP_INTERVAL_MS: "3600000" }))
      .retentionSweepIntervalMs,
    3_600_000,
  );
});

test("a malformed sweep interval is refused by name, and so is zero", () => {
  for (const value of ["nightly", "-1", "0"]) {
    assert.throws(
      () => loadWorkerConfig(env({ WINDKEEL_RETENTION_SWEEP_INTERVAL_MS: value })),
      (error) => {
        assert.ok(error instanceof InvalidConfigError);
        assert.equal(error.variable, "WINDKEEL_RETENTION_SWEEP_INTERVAL_MS");
        return true;
      },
      `${JSON.stringify(value)} should be refused`,
    );
  }
});

test("zero is refused rather than read as 'disabled'", () => {
  // The distinction matters: `setInterval(fn, 0)` driving a delete job is a busy loop against
  // the database and the bucket, and an operator writing 0 means "off" — which ADR-0015 does
  // not offer. Guessing either way would be worse than refusing.
  assert.throws(
    () => loadWorkerConfig(env({ WINDKEEL_RETENTION_SWEEP_INTERVAL_MS: "0" })),
    /WINDKEEL_RETENTION_SWEEP_INTERVAL_MS.*(busy-loop|policy)/s,
  );
});

// --- opt-out -----------------------------------------------------------------------------

test("with no object store the sweep reports itself skipped, with the reason", async () => {
  // No pool is touched at all: a sweep that cannot apply must not open a connection to find out.
  const poolThatWouldThrow = {
    connect() {
      throw new Error("the sweep connected to Postgres with no object store configured");
    },
  };
  const { instance, logs } = scheduler(poolThatWouldThrow, undefined);

  const tick = await instance.sweepOnce();
  assert.equal(tick.kind, "skipped");
  assert.match(tick.reason, /S3_BUCKET/);
  assert.match(tick.reason, /not a sweep that found nothing/);

  instance.start();
  await instance.stop();
  assert.deepEqual(
    logs.map((l) => l.message),
    ["retention sweep skipped"],
    "a skipped sweep says so; it does not log a completed sweep of zero packages (#35)",
  );
});

// --- the schedule ------------------------------------------------------------------------

test("start() sweeps immediately rather than waiting out the first interval", { skip }, async () => {
  await withSchema(async ({ pool }) => {
    const storage = new FakeEvidenceStorage();
    const { superseded } = await prunableRun(pool, storage);
    const { instance, logs } = scheduler(pool, storage, { intervalMs: 24 * 60 * 60 * 1000 });

    // Waited for rather than assumed: `stop()` aborts before it drains, so calling it in the
    // same turn as `start()` would cancel the startup sweep at its first package boundary and
    // this test would be asserting that shutdown works, not that startup sweeps.
    const started = deferred();
    storage.onDelete = () => started.resolve();

    instance.start();
    await started.promise;
    await instance.stop();

    assert.deepEqual(storage.deletes.map((d) => `${d.bucket}/${d.key}`), [
      superseded.evidencePackageRef,
    ]);
    assert.deepEqual(logs, [
      { message: "retention sweep completed", pruned: 1, capturesPruned: 0, makerScreenshotsPruned: 0, interrupted: false },
    ]);
    assert.equal((await getVerificationRun(pool, superseded.id)).evidencePackageRef, null);
  });
});

test("the same tick prunes expired captures under the same lock, and its log line counts them", { skip }, async () => {
  await withSchema(async ({ pool }) => {
    const storage = new FakeEvidenceStorage();
    const { superseded } = await prunableRun(pool, storage);
    const expired = superseded.engineeringRunId;
    const { current } = await prunableRun(pool, storage);
    const inWindow = current.engineeringRunId;
    await recordRunCapture(pool, {
      engineeringRunId: expired,
      bucket: "bucket",
      objectKey: `captures/${expired}`,
      byteTotal: 10,
      capturedAt: new Date(NOW.getTime() - 31 * DAY_MS),
    });
    await recordRunCapture(pool, {
      engineeringRunId: inWindow,
      bucket: "bucket",
      objectKey: `captures/${inWindow}`,
      byteTotal: 10,
      capturedAt: new Date(NOW.getTime() - 2 * DAY_MS),
    });
    storage.objects.add(`bucket/captures/${expired}`);
    storage.objects.add(`bucket/captures/${inWindow}`);

    const { instance, logs } = scheduler(pool, storage);
    // Wait for the capture delete before stopping: `stop()` aborts at the next boundary, and this
    // test is about the tick reaching captures, not about shutdown.
    const reachedCaptures = deferred();
    storage.onDelete = (ref) => {
      if (ref === `bucket/captures/${expired}`) reachedCaptures.resolve();
    };
    instance.start();
    await reachedCaptures.promise;
    await instance.stop();

    assert.ok(!storage.objects.has(`bucket/captures/${expired}`));
    assert.ok(storage.objects.has(`bucket/captures/${inWindow}`));
    assert.deepEqual((await getRunCapture(pool, expired)).prunedAt, NOW);
    assert.equal((await getRunCapture(pool, inWindow)).prunedAt, null);
    assert.deepEqual(
      logs,
      [{ message: "retention sweep completed", pruned: 2, capturesPruned: 1, makerScreenshotsPruned: 0, interrupted: false }],
      "the log line reports how many captures were pruned",
    );
  });
});

/** A maker screenshot row (#392) on `runId`, taken `ageDays` before NOW, and its stored object. */
async function screenshotRow(pool, storage, runId, ageDays, n) {
  const sha = String(n).padStart(64, "0");
  await pool.query(
    `insert into maker_screenshot (engineering_run_id, sha256, object_key, bytes, captured_at)
     values ($1, $2, $3, 10, $4)`,
    [runId, sha, `maker-browser/${runId}/${sha}.png`, new Date(NOW.getTime() - ageDays * DAY_MS)],
  );
  storage.objects.add(`bucket/maker-browser/${runId}`);
}

test("the same tick prunes expired maker screenshots after captures, and its log line counts them", { skip }, async () => {
  await withSchema(async ({ pool }) => {
    const storage = new FakeEvidenceStorage();
    const { superseded } = await prunableRun(pool, storage);
    const expired = superseded.engineeringRunId;
    const { current } = await prunableRun(pool, storage);
    const inWindow = current.engineeringRunId;
    await screenshotRow(pool, storage, expired, 40, 1);
    await screenshotRow(pool, storage, expired, 31, 2);
    await screenshotRow(pool, storage, inWindow, 2, 3);

    const { instance, logs } = scheduler(pool, storage);
    // Wait for the screenshot delete before stopping: `stop()` aborts at the next boundary, and this
    // test is about the tick reaching screenshots, not about shutdown.
    const reached = deferred();
    storage.onDelete = (ref) => {
      if (ref === `bucket/maker-browser/${expired}`) reached.resolve();
    };
    instance.start();
    await reached.promise;
    await instance.stop();

    assert.ok(!storage.objects.has(`bucket/maker-browser/${expired}`), "the objects are deleted, not only the rows");
    assert.ok(storage.objects.has(`bucket/maker-browser/${inWindow}`));
    const { rows } = await pool.query("select engineering_run_id from maker_screenshot");
    assert.deepEqual(rows.map((r) => r.engineering_run_id), [inWindow]);
    const keys = storage.deletes.map((d) => d.key);
    assert.equal(keys.at(-1), `maker-browser/${expired}`, "screenshots are swept after evidence and captures");
    assert.deepEqual(
      logs,
      [{ message: "retention sweep completed", pruned: 2, capturesPruned: 0, makerScreenshotsPruned: 2, interrupted: false }],
      "the log line reports how many screenshots were pruned",
    );
  });
});

test("without the evidence bucket the tick says screenshots were skipped rather than reporting zero pruned", { skip }, async () => {
  await withSchema(async ({ pool }) => {
    const storage = new FakeEvidenceStorage();
    const { current } = await prunableRun(pool, storage);
    await screenshotRow(pool, storage, current.engineeringRunId, 40, 1);

    const { instance } = scheduler(pool, storage, { makerScreenshotBucket: undefined });
    const tick = await instance.sweepOnce();
    assert.equal(tick.kind, "swept");
    assert.equal(tick.makerScreenshotsPruned, 0);
    assert.match(tick.makerScreenshotsSkipped, /no evidence bucket/);
    assert.ok(storage.objects.has(`bucket/maker-browser/${current.engineeringRunId}`));
    assert.equal((await pool.query("select count(*)::int as n from maker_screenshot")).rows[0].n, 1);
  });
});

// --- concurrency -------------------------------------------------------------------------

test(
  "two containers sweeping at once: one works, one reports contended, nothing is deleted twice",
  { skip },
  async () => {
    await withSchema(async ({ pool, connect }) => {
      const storage = new FakeEvidenceStorage();
      const { superseded } = await prunableRun(pool, storage);

      // Separate pools, because the advisory lock is held by a *session*. One pool handing both
      // schedulers the same connection would prove nothing about two containers.
      const a = scheduler(pool, storage);
      const b = scheduler(connect(), storage);

      // Hold A's first delete open so the two sweeps genuinely overlap rather than merely being
      // started in the same tick of the event loop.
      const gate = deferred();
      storage.gate = gate.promise;
      const started = deferred();
      storage.onDelete = () => started.resolve();

      const first = a.instance.sweepOnce();
      await started.promise;
      const second = await b.instance.sweepOnce();
      gate.resolve();
      const firstResult = await first;

      assert.equal(second.kind, "contended", "the second container must not sweep concurrently");
      assert.match(second.reason, /advisory lock/);
      assert.equal(firstResult.kind, "swept");
      assert.deepEqual(firstResult.prunedIds, [superseded.id]);
      assert.equal(storage.deletes.length, 1, "the package was deleted once, not twice");

      // And the lock is released, so the next container to try gets it.
      const third = await b.instance.sweepOnce();
      assert.equal(third.kind, "swept", "the advisory lock was not released after the sweep");
      assert.deepEqual(third.prunedIds, [], "and there is nothing left to prune");
    });
  },
);

test("a sweep in a different schema is not blocked by one in this schema", { skip }, async () => {
  // The lock key is derived from `current_schema()` precisely so that two deployments sharing a
  // Postgres instance — and two test files sharing the scratch database — do not serialise
  // against each other for reasons unrelated to what they are doing.
  await withSchema(async ({ pool }) => {
    await withSchema(async ({ pool: other }) => {
      const here = new FakeEvidenceStorage();
      const there = new FakeEvidenceStorage();
      await prunableRun(pool, here);
      await prunableRun(other, there);

      const gate = deferred();
      here.gate = gate.promise;
      const started = deferred();
      here.onDelete = () => started.resolve();

      const first = scheduler(pool, here).instance.sweepOnce();
      await started.promise;
      const concurrent = await scheduler(other, there).instance.sweepOnce();
      gate.resolve();
      await first;

      assert.equal(concurrent.kind, "swept");
      assert.equal(concurrent.prunedIds.length, 1);
    });
  });
});

// --- interruption ------------------------------------------------------------------------

test(
  "SIGTERM mid-sweep stops at a package boundary, leaving at most one package mid-prune",
  { skip },
  async () => {
    await withSchema(async ({ pool }) => {
      const storage = new FakeEvidenceStorage();
      const first = await prunableRun(pool, storage, 200);
      const second = await prunableRun(pool, storage, 100);

      const { instance } = scheduler(pool, storage);
      const gate = deferred();
      storage.gate = gate.promise;
      const started = deferred();
      storage.onDelete = () => started.resolve();

      instance.start();
      await started.promise;

      const stopping = instance.stop(); // the SIGTERM path
      gate.resolve();
      await stopping;

      assert.equal(storage.deletes.length, 1, "the sweep did not start a second package");

      // Whichever of the two was reached is fully consistent; the other is entirely untouched.
      const rows = await Promise.all(
        [first.superseded, second.superseded].map((v) => getVerificationRun(pool, v.id)),
      );
      const pruned = rows.filter((r) => r.evidencePackageRef === null);
      const untouched = rows.filter((r) => r.evidencePackageRef !== null);
      assert.equal(pruned.length, 1);
      assert.equal(untouched.length, 1);
      assert.ok(pruned[0].evidencePrunedAt, "a pruned row carries the ADR-0015 §3 tombstone");
      assert.ok(
        storage.objects.has(untouched[0].evidencePackageRef),
        "the package the sweep never reached is still in the store — no orphan",
      );
    });
  },
);

test(
  "a prune interrupted between the object delete and the row update repairs itself next sweep",
  { skip },
  async () => {
    await withSchema(async ({ pool }) => {
      const storage = new FakeEvidenceStorage();
      const { superseded } = await prunableRun(pool, storage);

      // Exactly the state a container killed between `pruneVerificationRun`'s two steps leaves:
      // objects gone, row still claiming they exist. This is what the ordering chooses to risk,
      // and the claim being tested is that it is the *recoverable* inconsistency.
      const [bucket, ...key] = superseded.evidencePackageRef.split("/");
      await storage.deletePackage(bucket, key.join("/"));
      storage.deletes.length = 0;

      const dangling = await getVerificationRun(pool, superseded.id);
      assert.equal(dangling.evidencePackageRef, superseded.evidencePackageRef);
      assert.equal(
        storage.objects.has(dangling.evidencePackageRef),
        false,
        "precondition: the row points at a package that is gone",
      );

      const { instance } = scheduler(pool, storage);
      const tick = await instance.sweepOnce();

      assert.deepEqual(tick.prunedIds, [superseded.id], "the next sweep still finds the row");
      assert.equal(storage.deletes.length, 1, "and re-deletes, which the store treats as a no-op");

      const repaired = await getVerificationRun(pool, superseded.id);
      assert.equal(repaired.evidencePackageRef, null);
      assert.ok(repaired.evidencePrunedAt);
      assert.equal(
        repaired.evidenceManifestDigest,
        superseded.evidenceManifestDigest,
        "the digest is kept forever (ADR-0015 §3)",
      );
    });
  },
);

test(
  "no object is left in the store that no row references, after a full sweep",
  { skip },
  async () => {
    await withSchema(async ({ pool }) => {
      const storage = new FakeEvidenceStorage();
      const a = await prunableRun(pool, storage, 300);
      const b = await prunableRun(pool, storage, 120);

      const { instance } = scheduler(pool, storage);
      await instance.sweepOnce();

      const live = new Set();
      for (const v of [a.superseded, a.current, b.superseded, b.current]) {
        const row = await getVerificationRun(pool, v.id);
        if (row.evidencePackageRef) live.add(row.evidencePackageRef);
      }
      assert.deepEqual(
        [...storage.objects].sort(),
        [...live].sort(),
        "every object in the store is referenced by a row, and every row's reference resolves",
      );
      assert.equal(live.size, 2, "the two current verdicts of record survive");
    });
  },
);
