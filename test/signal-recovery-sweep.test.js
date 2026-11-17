import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../dist/factory/migrate.js";
import {
  insertEngineeringRun,
  insertEngineeringTask,
} from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import {
  DEFAULT_MINIMUM_SIGNAL_AGE_MS,
  recoverStrandedSignals,
} from "../dist/factory/sweeps/signal-recovery.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";

/**
 * #269, the half `signal()` structurally cannot reach.
 *
 * `signal()` recovers a run whose execution had *already* ended when the signal arrived. The
 * failure this issue was filed from is the other order: the signal arrives, `wakeUp()` succeeds,
 * and then the queue delivery carrying that wake fails and the execution ends. Everything that
 * could have noticed has already run, and no further signal is coming — the event that would
 * have produced one has been and gone.
 *
 * So the test is about *who gets asked about*. The decision itself belongs to the provider's
 * `recoverStranded` and is tested against a real execution in `undelivered-signal.test.js`; here
 * it is a spy, because what is being checked is the candidate query and nothing else.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
let counter = 0;
let seeded = 0;

async function withSchema(fn) {
  const schema = `windkeel_recovery_${Date.now()}_${process.pid}_${counter++}`;
  const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await setup.query(`create schema ${schema}`);
  await setup.end();
  const pool = new Pool({
    connectionString: dbUrl,
    ...TEST_POOL,
    options: `-c search_path=${schema}`,
  });
  try {
    await runMigrations(pool, join(repoRoot, "migrations"));
    await seedFixtureRepository(pool);
    await fn(pool);
  } finally {
    const teardown = new Pool({ connectionString: dbUrl, ...TEST_POOL });
    await teardown.query(`drop schema if exists ${schema} cascade`);
    await teardown.end();
    await pool.end();
  }
}

async function seedRun(pool, states) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "github_issue",
    sourceReference: `jyothepro/content-machine#${++seeded}`,
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
  for (const state of states) await advanceRun(pool, run.id, state, "test seed");
  return run.id;
}

const PARKED = [
  "CLASSIFYING",
  "PLANNING",
  "PROVISIONING",
  "IMPLEMENTING",
  "VERIFYING",
  "PR_CREATING",
  "PR_READY",
  "WAITING_FOR_HUMAN",
];

/** A signal written `ageMs` ago, still unconsumed. */
async function strandSignal(pool, runId, ageMs, kind = "pull_request_closed") {
  const { rows } = await pool.query(
    `insert into run_signal (engineering_run_id, kind, payload, received_at)
     values ($1, $2, '{}'::jsonb, now() - ($3::bigint * interval '1 millisecond'))
     returning id`,
    [runId, kind, String(ageMs)],
  );
  return rows[0].id;
}

test("a parked run holding an old unconsumed signal is handed to the provider", { skip }, async () => {
  await withSchema(async (pool) => {
    const runId = await seedRun(pool, PARKED);
    await strandSignal(pool, runId, DEFAULT_MINIMUM_SIGNAL_AGE_MS + 60_000);

    const asked = [];
    const result = await recoverStrandedSignals({
      pool,
      recoverStranded: async (id) => {
        asked.push(id);
        return true;
      },
    });

    assert.deepEqual(asked, [runId]);
    assert.deepEqual(result, { examined: 1, recovered: 1, skipped: 0, failed: 0 });
  });
});

test("a signal written moments ago is left to the execution it was written for", { skip }, async () => {
  await withSchema(async (pool) => {
    const runId = await seedRun(pool, PARKED);
    await strandSignal(pool, runId, 1_000);

    const asked = [];
    const result = await recoverStrandedSignals({
      pool,
      recoverStranded: async (id) => {
        asked.push(id);
        return true;
      },
    });

    // Racing the normal path gains nothing and risks a second execution's worth of confusion.
    assert.deepEqual(asked, []);
    assert.equal(result.examined, 0);
  });
});

test("a terminal run's unconsumed signal is correctly unconsumed, and left alone", { skip }, async () => {
  await withSchema(async (pool) => {
    const runId = await seedRun(pool, [...PARKED, "COMPLETED"]);
    await strandSignal(pool, runId, DEFAULT_MINIMUM_SIGNAL_AGE_MS + 60_000);

    const asked = [];
    await recoverStrandedSignals({
      pool,
      recoverStranded: async (id) => {
        asked.push(id);
        return true;
      },
    });

    // ADR-0003: nothing leaves a terminal state. A command that arrived late is a human being
    // slightly late, which `issue-commands.ts` already says — restarting the run would be the
    // sweep inventing work.
    assert.deepEqual(asked, []);
  });
});

test("a consumed signal is not a stranded one", { skip }, async () => {
  await withSchema(async (pool) => {
    const runId = await seedRun(pool, PARKED);
    const id = await strandSignal(pool, runId, DEFAULT_MINIMUM_SIGNAL_AGE_MS + 60_000);
    await pool.query("update run_signal set consumed_at = now() where id = $1", [id]);

    const asked = [];
    await recoverStrandedSignals({
      pool,
      recoverStranded: async (id2) => {
        asked.push(id2);
        return true;
      },
    });
    assert.deepEqual(asked, []);
  });
});

test("one run's failure does not end the sweep", { skip }, async () => {
  await withSchema(async (pool) => {
    const first = await seedRun(pool, PARKED);
    const second = await seedRun(pool, PARKED);
    for (const id of [first, second]) {
      await strandSignal(pool, id, DEFAULT_MINIMUM_SIGNAL_AGE_MS + 60_000);
    }

    const logged = [];
    const result = await recoverStrandedSignals({
      pool,
      log: (message, fields) => logged.push({ message, fields }),
      recoverStranded: async (id) => {
        if (id === first) throw new Error("transport is down");
        return true;
      },
    });

    // The next candidate may be the one that matters, and every signal row is durable, so the
    // next tick tries the failed one again.
    assert.equal(result.examined, 2);
    assert.equal(result.recovered, 1);
    assert.equal(result.failed, 1);
    assert.ok(logged.some((l) => /could not restart/.test(l.message)));
  });
});

test("a healthy run the provider declines is counted, not narrated", { skip }, async () => {
  await withSchema(async (pool) => {
    const runId = await seedRun(pool, PARKED);
    await strandSignal(pool, runId, DEFAULT_MINIMUM_SIGNAL_AGE_MS + 60_000);

    const logged = [];
    const result = await recoverStrandedSignals({
      pool,
      log: (message) => logged.push(message),
      // What a live execution that simply has not reached the signal yet looks like.
      recoverStranded: async () => false,
    });

    assert.deepEqual(result, { examined: 1, recovered: 0, skipped: 1, failed: 0 });
    // A sweep that narrates every healthy row teaches its reader to skip the log.
    assert.deepEqual(logged, []);
  });
});

test("several waiting signals on one run are one candidate", { skip }, async () => {
  await withSchema(async (pool) => {
    const runId = await seedRun(pool, PARKED);
    const old = DEFAULT_MINIMUM_SIGNAL_AGE_MS + 60_000;
    await strandSignal(pool, runId, old, "pull_request_closed");
    await strandSignal(pool, runId, old + 1_000, "approval_granted");

    const asked = [];
    const result = await recoverStrandedSignals({
      pool,
      recoverStranded: async (id) => {
        asked.push(id);
        return true;
      },
    });

    // One execution reads them all; starting two would be the thing this sweep exists to avoid.
    assert.deepEqual(asked, [runId]);
    assert.equal(result.examined, 1);
  });
});
