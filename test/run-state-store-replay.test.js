/**
 * `advanceRun`'s replay rule, held by both run-state stores (#302, review note on #305): a commit
 * that repeats the one just committed — same `to`, same `reason` — is a replay (a workflow step
 * retried after its transition committed): it writes nothing and answers the committed state. A
 * self-move with a different reason is still `IllegalTransitionError`.
 *
 * The same script runs against `InMemoryRunStateStore` (always) and `PostgresRunStateStore`
 * (Postgres-gated), so the fake cannot drift from the store it stands in for.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { InMemoryRunStateStore } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { IllegalTransitionError } from "../dist/factory/run-state-machine.js";
import { createTaskAndRun } from "../dist/billing/admitted-runs.js";
import { FIXTURE_REPOSITORY_ID, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

/** The script both stores must answer identically. Returns the observed sequence. */
async function script(store, runId) {
  const seen = [];
  const commit = async (to, reason) => {
    try {
      const snap = await store.commit(runId, to, reason);
      seen.push(`${to}:${reason}=>${snap.state}`);
    } catch (error) {
      seen.push(`${to}:${reason}=>${error instanceof IllegalTransitionError ? "illegal" : error.message}`);
    }
  };
  await commit("CREATED", "seeded"); // never entered by a transition: not a replay, illegal
  await commit("CLASSIFYING", "picked up");
  await commit("CLASSIFYING", "picked up"); // the replay
  await commit("CLASSIFYING", "another reason"); // a self-move, still illegal
  await commit("PLANNING", null);
  await commit("PLANNING", null); // a replay with a null reason
  await commit("CLASSIFYING", "picked up"); // not the latest state any more: illegal
  const final = await store.read(runId);
  seen.push(`final=${final.state}`);
  return seen;
}

const EXPECTED = [
  "CREATED:seeded=>illegal",
  "CLASSIFYING:picked up=>CLASSIFYING",
  "CLASSIFYING:picked up=>CLASSIFYING",
  "CLASSIFYING:another reason=>illegal",
  "PLANNING:null=>PLANNING",
  "PLANNING:null=>PLANNING",
  "CLASSIFYING:picked up=>illegal",
  "final=PLANNING",
];

test("the in-memory store replays a repeated (to, reason) like advanceRun does", async () => {
  const store = new InMemoryRunStateStore();
  store.seed("run-1");
  assert.deepEqual(await script(store, "run-1"), EXPECTED);
});

test("the Postgres store answers the same script identically, writing one row per real transition", { skip }, async () => {
  const schema = `windkeel_replay_test_${Date.now()}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const { run } = await createTaskAndRun(pool, {
      repositoryId: FIXTURE_REPOSITORY_ID,
      sourceType: "local",
      sourceReference: "replay-parity",
      title: "t",
      description: "d",
      criteria: [],
      riskLevel: "low",
    });
    assert.deepEqual(await script(new PostgresRunStateStore(pool), run.id), EXPECTED);
    const { rows } = await pool.query(
      "select to_state from run_state_transition where engineering_run_id = $1 order by at",
      [run.id],
    );
    assert.deepEqual(rows.map((r) => r.to_state), ["CLASSIFYING", "PLANNING"], "replays wrote nothing");
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
});
