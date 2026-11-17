/**
 * ADR-0013 §3's `human_commits_after_pr`, which for the whole of M1–M6 was a column nothing
 * wrote and two SQL views read.
 *
 * The failure being fixed is not "a metric was missing". It is that `integer not null default 0`
 * made *not measured* and *a human added nothing* the same value, so `human_rework_rate`
 * answered 0% and `verified_work_merged_without_rework` answered 100% from an empty column.
 * Those are not unknowns; they are wrong in the flattering direction. So this file has two
 * halves: the attribution rule, and the proof that a run the rule cannot speak about is excluded
 * from the views rather than counted as clean.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import {
  GITHUB_PR_COMMITS_CAP,
  countHumanCommits,
  measureHumanCommits,
} from "../dist/factory/human-rework.js";
import {
  insertEngineeringRun,
  insertEngineeringTask,
  updateEngineeringRun,
} from "../dist/factory/repositories.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const WINDKEEL = { authorEmail: "factory@windkeel.invalid" };

/** A commit, defaulting to the shape the rule considers ordinary: one parent, an author. */
function commit(overrides = {}) {
  return {
    sha: "a".repeat(40),
    authorEmail: "someone@example.com",
    authorLogin: "someone",
    authoredAt: "2026-01-01T00:00:00Z",
    parentCount: 1,
    ...overrides,
  };
}

const windkeelCommit = (overrides = {}) =>
  commit({ authorEmail: "factory@windkeel.invalid", authorLogin: "windkeel-app[bot]", ...overrides });

// --- the attribution rule --------------------------------------------------------------

test("a pull request with only Windkeel's commits has no human rework", () => {
  const result = countHumanCommits(
    [windkeelCommit({ sha: "1".repeat(40) }), windkeelCommit({ sha: "2".repeat(40) })],
    WINDKEEL,
  );
  assert.deepEqual(result, { kind: "counted", count: 0 });
});

test("commits authored by anyone else count", () => {
  const result = countHumanCommits(
    [windkeelCommit({ sha: "1".repeat(40) }), commit({ sha: "2".repeat(40) }), commit({ sha: "3".repeat(40) })],
    WINDKEEL,
  );
  assert.deepEqual(result, { kind: "counted", count: 2 });
});

test("Windkeel's own repair commits do not count, however late they were pushed", () => {
  // ADR-0017 lets the maker outlive verification, so repair commits land *after* the pull
  // request opened. They are excluded by identity rather than by timestamp, which is why this
  // needs no special handling and why a timestamp-based rule would have got it wrong.
  const result = countHumanCommits(
    [
      windkeelCommit({ sha: "1".repeat(40), authoredAt: "2026-01-01T00:00:00Z" }),
      windkeelCommit({ sha: "2".repeat(40), authoredAt: "2026-01-05T00:00:00Z" }),
      windkeelCommit({ sha: "3".repeat(40), authoredAt: "2026-01-09T00:00:00Z" }),
    ],
    WINDKEEL,
  );
  assert.deepEqual(result, { kind: "counted", count: 0 });
});

test("a merge commit does not count, whoever GitHub says made it", () => {
  // GitHub's "Update branch" button produces a merge commit under the clicking user's name.
  // Counting it would report rework where a human authored nothing.
  const result = countHumanCommits(
    [windkeelCommit({ sha: "1".repeat(40) }), commit({ sha: "2".repeat(40), parentCount: 2 })],
    WINDKEEL,
  );
  assert.deepEqual(result, { kind: "counted", count: 0 });
});

test("author identity is matched case-insensitively", () => {
  const result = countHumanCommits([commit({ authorEmail: "Factory@Windkeel.Invalid" })], WINDKEEL);
  assert.deepEqual(result, { kind: "counted", count: 0 });
});

test("a pull request at GitHub's commit cap is unknown, not a count", () => {
  const commits = Array.from({ length: GITHUB_PR_COMMITS_CAP }, (_, i) =>
    windkeelCommit({ sha: String(i).padStart(40, "0") }),
  );
  const result = countHumanCommits(commits, WINDKEEL);
  assert.equal(result.kind, "unknown");
  assert.match(result.reason, /floor, not a number/);
});

test("a commit with no author email makes the whole count unknown", () => {
  // It cannot be attributed to Windkeel or to anyone else, and guessing either way produces a
  // number that is wrong in a direction nobody can predict.
  const result = countHumanCommits(
    [windkeelCommit({ sha: "1".repeat(40) }), commit({ sha: "bad".padEnd(40, "0"), authorEmail: "" })],
    WINDKEEL,
  );
  assert.equal(result.kind, "unknown");
  assert.match(result.reason, /no author email/);
});

test("a failed API call is unknown with the reason, and never throws at the caller", async () => {
  const result = await measureHumanCommits(
    {
      async listPullRequestCommits() {
        throw new Error("403 the installation cannot read pull requests");
      },
    },
    { owner: "o", name: "r" },
    9,
    WINDKEEL,
  );
  assert.equal(result.kind, "unknown");
  assert.match(result.reason, /could not be read.*403/);
});

test("measureHumanCommits asks for the right pull request and applies the rule", async () => {
  const calls = [];
  const result = await measureHumanCommits(
    {
      async listPullRequestCommits(repository, pullNumber) {
        calls.push({ repository, pullNumber });
        return [windkeelCommit({ sha: "1".repeat(40) }), commit({ sha: "2".repeat(40) })];
      },
    },
    { owner: "jyothepro", name: "windkeel" },
    42,
    WINDKEEL,
  );
  assert.deepEqual(calls, [{ repository: { owner: "jyothepro", name: "windkeel" }, pullNumber: 42 }]);
  assert.deepEqual(result, { kind: "counted", count: 1 });
});

// --- the views -------------------------------------------------------------------------

async function withSchema(fn) {
  const schema = `windkeel_human_rework_${process.pid}_${Date.now()}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    await fn(pool);
  } finally {
    await pool.end().catch(() => {});
    await dropMigratedDatabase(schema);
  }
}

/** One run, merged or not, with the metric measured, unmeasured, or measured as rework. */
async function seedRun(pool, { merged, humanCommits }) {
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
  await updateEngineeringRun(pool, run.id, {
    prNumber: 1,
    ...(merged ? { prMergedAt: new Date() } : {}),
    humanCommitsAfterPr: humanCommits,
  });
  return run;
}

const view = async (pool, name) => (await pool.query(`select * from ${name}`)).rows[0];

test("the column is nullable and defaults to nothing, so unmeasured is a state", { skip }, async () => {
  await withSchema(async (pool) => {
    const { rows } = await pool.query(
      `select is_nullable, column_default from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'engineering_run'
          and column_name = 'human_commits_after_pr'`,
    );
    assert.equal(rows[0].is_nullable, "YES");
    assert.equal(rows[0].column_default, null);

    // And a freshly inserted run is unmeasured rather than "measured as clean".
    const run = await seedRun(pool, { merged: false, humanCommits: undefined });
    const { rows: fresh } = await pool.query(
      "select human_commits_after_pr from engineering_run where id = $1",
      [run.id],
    );
    assert.equal(fresh[0].human_commits_after_pr, null);
  });
});

test(
  "a merged run with no measurement is excluded from both views, not counted as clean",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      await seedRun(pool, { merged: true, humanCommits: null });

      const rework = await view(pool, "human_rework_rate");
      assert.equal(rework.merged, "0", "the denominator holds only measured runs");
      assert.equal(rework.merged_unmeasured, "1", "and says how many were set aside");
      assert.equal(
        rework.human_rework_rate_pct,
        null,
        "no measured merged run means no rate — 0% would be a claim this data cannot support",
      );

      const clean = await view(pool, "verified_work_merged_without_rework");
      assert.equal(clean.clean_merges, "0");
      assert.equal(clean.merged_unmeasured, "1");
      assert.equal(clean.total_runs, "0");
      assert.equal(
        clean.clean_merge_rate_pct,
        null,
        "this is the exact 100%-from-nothing the old coalesce(…, 0) produced",
      );
    });
  },
);

test("a measured clean merge and a measured reworked merge produce a real rate", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedRun(pool, { merged: true, humanCommits: 0 });
    await seedRun(pool, { merged: true, humanCommits: 3 });

    const rework = await view(pool, "human_rework_rate");
    assert.equal(rework.reworked, "1");
    assert.equal(rework.merged, "2");
    assert.equal(rework.merged_unmeasured, "0");
    assert.equal(rework.human_rework_rate_pct, "50.00");

    const clean = await view(pool, "verified_work_merged_without_rework");
    assert.equal(clean.clean_merges, "1");
    assert.equal(clean.total_runs, "2");
    assert.equal(clean.clean_merge_rate_pct, "50.00");
  });
});

test(
  "one unmeasurable run narrows the headline metric rather than suppressing it",
  { skip },
  async () => {
    // A hermetic run (ADR-0016) can never have this measured. Nulling the whole rate would let
    // one such run silence the project's key business metric forever; excluding it narrows the
    // claim to the runs that support it and reports how many were left out.
    await withSchema(async (pool) => {
      await seedRun(pool, { merged: true, humanCommits: 0 });
      await seedRun(pool, { merged: true, humanCommits: null });
      await seedRun(pool, { merged: false, humanCommits: null });

      const clean = await view(pool, "verified_work_merged_without_rework");
      assert.equal(clean.clean_merges, "1");
      assert.equal(clean.merged_unmeasured, "1");
      assert.equal(clean.total_runs, "2", "the measured merge and the run that never merged");
      assert.equal(clean.clean_merge_rate_pct, "50.00");
    });
  },
);

test("a run that never merged is not clean, and is not unmeasured either", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedRun(pool, { merged: false, humanCommits: null });

    const rework = await view(pool, "human_rework_rate");
    assert.equal(rework.merged, "0");
    assert.equal(rework.merged_unmeasured, "0", "it never merged; the metric does not apply");

    const clean = await view(pool, "verified_work_merged_without_rework");
    assert.equal(clean.clean_merges, "0");
    assert.equal(clean.total_runs, "1", "\"did not merge\" is a fact, and it is not a clean merge");
    assert.equal(clean.clean_merge_rate_pct, "0.00");
  });
});
