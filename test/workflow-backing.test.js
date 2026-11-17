import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../dist/factory/migrate.js";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import {
  DEFAULT_WORKFLOW_BACKING,
  RunBackingConflictError,
  UnknownWorkflowBackingError,
  WORKFLOW_BACKINGS,
  WORKFLOW_BACKING_ENV,
  assertBackingOwnsRun,
  backingCensus,
  recordBacking,
  resolveWorkflowBacking,
} from "../dist/factory/workflow/backing.js";
import { createAndStartTask } from "./start-task.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { VercelWorkflowProvider } from "../dist/factory/workflow/vercel.js";
import { closeWorkflowRuntime, runtimeSkip, workflowRuntime } from "./workflow-runtime.js";

/**
 * #199 asked: **can the backing be changed without touching domain code, and changed back?** The
 * answer was yes, both backings ran side by side, and #200 then deleted the older one.
 *
 * So what this file tests changed shape. There is one backing now, and the questions worth
 * asking are about the *edges of that*: that the retired name is refused with an explanation
 * rather than ignored, that the binding guard still refuses a run another machinery is carrying,
 * and that both producers still read the selection through one helper — which is the property
 * that stops them diverging again if a second backing ever returns.
 *
 * The reversibility this file used to prove is gone with pg-boss, deliberately and irreversibly.
 * `test/postgres-authoritative.test.js` carries the claim that made the deletion safe: no run
 * fact lives in the orchestrator, so swapping one is a wiring change rather than a migration.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

after(async () => {
  await closeWorkflowRuntime();
});

let counter = 0;

async function makeSchema() {
  const schema = `windkeel_backing_${Date.now()}_${process.pid}_${counter++}`;
  const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await setup.query(`create schema ${schema}`);
  await setup.end();
  const pool = new Pool({
    connectionString: dbUrl,
    ...TEST_POOL,
    options: `-c search_path=${schema}`,
  });
  await runMigrations(pool, join(repoRoot, "migrations"));
  await seedFixtureRepository(pool);
  return { schema, pool };
}

async function dropSchema(...schemas) {
  const teardown = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  for (const schema of schemas) await teardown.query(`drop schema if exists ${schema} cascade`);
  await teardown.end();
}

async function seedRun(pool) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "local",
    sourceReference: "backing",
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
  return run.id;
}

// --- the selection ---------------------------------------------------------------------------

test("there is one backing, and it is the default", () => {
  assert.equal(DEFAULT_WORKFLOW_BACKING, "vercel-workflow");
  assert.deepEqual([...WORKFLOW_BACKINGS], ["vercel-workflow"]);

  assert.deepEqual(resolveWorkflowBacking({}), { backing: "vercel-workflow", explicit: false });
  assert.deepEqual(resolveWorkflowBacking({ [WORKFLOW_BACKING_ENV]: "" }), {
    backing: "vercel-workflow",
    explicit: false,
  });
});

test("an explicit selection is honoured, and reported as explicit", () => {
  assert.deepEqual(resolveWorkflowBacking({ [WORKFLOW_BACKING_ENV]: "vercel-workflow" }), {
    backing: "vercel-workflow",
    explicit: true,
  });
  // Whitespace is an operator's typo in a dashboard field, not a different backing.
  assert.equal(
    resolveWorkflowBacking({ [WORKFLOW_BACKING_ENV]: "  vercel-workflow " }).backing,
    "vercel-workflow",
  );
});

/**
 * The migration hazard #200 leaves behind, and the one reason the variable still exists.
 *
 * #199 shipped `pg-boss` as the *default*, so a deployment that set it explicitly is not a typo —
 * it is a rollout that has not caught up. Silently running it on the surviving backing would be
 * the same class of mistake this file was written to prevent: a configuration that says one thing
 * while the system does another.
 */
test("a deployment still asking for pg-boss is told what happened to it", () => {
  assert.throws(
    () => resolveWorkflowBacking({ [WORKFLOW_BACKING_ENV]: "pg-boss" }),
    (err) => {
      assert.ok(err instanceof UnknownWorkflowBackingError);
      assert.match(err.message, /no longer exists/);
      assert.match(err.message, /#200/, "the message points at the change that removed it");
      assert.match(err.message, /vercel-workflow/, "and names what to set instead");
      return true;
    },
  );
});

test("an unrecognised value throws rather than silently selecting the default", () => {
  // A typo that fell back to the default would be indistinguishable from a deliberate choice,
  // and the operator would find out weeks later, if at all.
  assert.throws(
    () => resolveWorkflowBacking({ [WORKFLOW_BACKING_ENV]: "vercel" }),
    UnknownWorkflowBackingError,
  );
  assert.throws(
    () => resolveWorkflowBacking({ [WORKFLOW_BACKING_ENV]: "pgboss" }),
    /not a known backing/,
  );
});

// --- both producers honour it ----------------------------------------------------------------

/**
 * #255: this test was gated on Postgres alone, and it is the first in the file to reach the real
 * backing — `createAndStartTask` builds its own `VercelWorkflowProvider` and resolves the queue
 * from the environment, so it needs the runtime as much as the tests at the bottom of the file
 * do. Without it `WORKFLOW_LOCAL_BASE_URL` was unset at this point and `@workflow/world-local`
 * went looking for a listening port of its own, which is where CI's
 * `Unable to resolve base URL for workflow queue` came from. It passed locally because a laptop's
 * process usually has one.
 */
test("a producer outside the webhook binds the run to the backing that started it", { skip: runtimeSkip(dbUrl) }, async () => {
  await workflowRuntime();
  const { schema, pool } = await makeSchema();
  const url = `${dbUrl}?options=-c%20search_path%3D${schema}`;
  try {
    const created = await createAndStartTask({
      databaseUrl: url,
      title: "t",
      description: "d",
      criteria: [{ id: "c1", text: "works" }],
      riskLevel: "low",
      repositoryId: "11111111-1111-1111-1111-111111111111",
      backing: "vercel-workflow",
    });

    const { rows } = await pool.query(
      "select provider from workflow_run_binding where engineering_run_id = $1",
      [created.engineeringRunId],
    );
    assert.equal(
      rows[0]?.provider,
      "vercel-workflow",
      "the run is bound to the backing that started it",
    );
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("the ingress producer reports the backing it built", async () => {
  const { runEnqueuer } = await import("../apps/ingress/dist/src/windkeel-actions.js");

  // Construction alone must touch nothing — the provider's own posture — so this is safe
  // without a database.
  const enqueuer = runEnqueuer({ connectionString: "postgresql://x/y" });
  assert.equal(enqueuer.backing, "vercel-workflow");
});

test("every producer reads the selection through the same helper", () => {
  /*
   * There are two producers — the webhook and the API — and since ADR-0023 §10 removed
   * `windkeel-admin task create` they share one enqueuer, so only one file reads the selection.
   */
  const actions = readFileSync(join(repoRoot, "apps", "ingress", "src", "windkeel-actions.ts"), "utf8");
  assert.match(actions, /resolveWorkflowBacking\(/, "the enqueuer resolves the backing through the shared helper");
  assert.doesNotMatch(
    actions,
    new RegExp(`process\\.env\\[?["']${WORKFLOW_BACKING_ENV}`),
    "and must not read the variable directly",
  );
  for (const entry of ["webhook.ts", "v1.ts"]) {
    const source = readFileSync(join(repoRoot, "apps", "ingress", "api", entry), "utf8");
    assert.match(source, /runEnqueuer\(/, `api/${entry} must enqueue through runEnqueuer, not a provider of its own`);
  }
});

// --- exactly-once survives the switch ---------------------------------------------------------

/**
 * Exactly-once against a redelivered webhook lives in `test/workflow-vercel.test.js` — ten
 * concurrent `startRun` calls, one `enqueued: true` — because it needs the built workflow bundle
 * and a local World. Asserted here by reference rather than duplicated badly.
 *
 * There used to be a pg-boss twin of it in this file. It went with pg-boss; the property did not.
 */
test("the vercel backing's exactly-once guarantee is tested where its harness lives", () => {
  const source = readFileSync(join(repoRoot, "test", "workflow-vercel.test.js"), "utf8");
  assert.match(source, /one engineering run gets one durable execution, by database invariant/);
});

// --- disagreement is detected ------------------------------------------------------------------

/**
 * The guard outlives the second backing, and this is the case that makes it worth keeping.
 *
 * A run left in flight when #200 deployed is bound to `pg-boss` and nothing will ever tick it
 * again. The surviving backing must refuse to adopt it rather than start a second machinery over
 * a half-finished run — and must say *why*, because "bound to pg-boss" means nothing to an
 * operator who has never heard of it.
 */
test("a run left bound to the retired backing is refused, not adopted", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRun(pool);
    await recordBacking(pool, runId, "pg-boss", "job-1");

    await assert.rejects(
      () => assertBackingOwnsRun(pool, runId, "vercel-workflow"),
      RunBackingConflictError,
    );
    await assert.rejects(
      () => assertBackingOwnsRun(pool, runId, "vercel-workflow"),
      /#200/,
      "and the error explains that this is a run from before the deletion",
    );

    // The recorded owner is not refused by itself — which is what makes the check a guard
    // against two machineries rather than a lock on the run.
    await assertBackingOwnsRun(pool, runId, "pg-boss");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("a finished binding is not a conflict — a completed run stays reportable", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRun(pool);
    await recordBacking(pool, runId, "pg-boss", "job-1");
    await pool.query("update workflow_run_binding set phase = 'finished' where engineering_run_id = $1", [
      runId,
    ]);

    // The previous backing is done with the run, so adopting it is legitimate. Being able to
    // switch *back* is what makes #200 safe to do later rather than now.
    await assertBackingOwnsRun(pool, runId, "vercel-workflow");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("a run nothing has claimed is not a conflict", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRun(pool);
    await assertBackingOwnsRun(pool, runId, "vercel-workflow");
    await assertBackingOwnsRun(pool, runId, "pg-boss");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("a missing binding table does not stop a run from starting", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRun(pool);
    await pool.query("drop table workflow_run_binding");
    // A guard against a misconfiguration, not a precondition for running: a deployment whose
    // migrations are mid-flight must not stop accepting webhooks because a check could not run.
    await assertBackingOwnsRun(pool, runId, "pg-boss");
    await recordBacking(pool, runId, "pg-boss", "job-1");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("one backing never overwrites another's claim", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRun(pool);
    await recordBacking(pool, runId, "pg-boss", "job-1");
    await recordBacking(pool, runId, "vercel-workflow", "wrun_x");

    const { rows } = await pool.query(
      "select provider, execution_handle from workflow_run_binding where engineering_run_id = $1",
      [runId],
    );
    assert.equal(rows[0].provider, "pg-boss", "a provider records its own ownership, never another's");
    assert.equal(rows[0].execution_handle, "job-1");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("the census is what an operator reads to see a half-switched deployment", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    await recordBacking(pool, await seedRun(pool), "pg-boss", "job-1");
    await recordBacking(pool, await seedRun(pool), "pg-boss", "job-2");
    const finished = await seedRun(pool);
    await recordBacking(pool, finished, "vercel-workflow", "wrun_1");
    await pool.query("update workflow_run_binding set phase = 'finished' where engineering_run_id = $1", [
      finished,
    ]);

    // Only in-flight runs count: a finished binding is history, not a run nothing will pick up.
    assert.deepEqual(await backingCensus(pool), { "pg-boss": 2 });
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

// --- ADR-0007 §1 still holds -------------------------------------------------------------------

test("startRun refuses a run that does not exist", { skip: runtimeSkip(dbUrl) }, async () => {
  const { world } = await workflowRuntime();
  const { schema, pool } = await makeSchema();
  try {
    const provider = new VercelWorkflowProvider({
      connectionString: dbUrl,
      applicationSchema: schema,
      world,
      waitSleepMs: 2_000,
      retrySleepMs: 50,
    });
    await provider.start();
    try {
      // ADR-0007 §1/§4, which ADR-0021 keeps: the caller creates the row, transactionally,
      // first. A `startRun` that created one would be a side effect with nothing to check
      // against, and a duplicate delivery would produce a second run.
      await assert.rejects(
        () => provider.startRun("00000000-0000-0000-0000-0000000000ff"),
        /no engineering_run/,
      );
      const { rows } = await pool.query("select count(*)::int as n from engineering_run");
      assert.equal(rows[0].n, 0, "and nothing was created by asking");
    } finally {
      await provider.stop();
    }
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});
