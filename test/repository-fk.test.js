/**
 * `migrations/0010` — the foreign key `migrations/0005` deferred, and the question it turns on.
 *
 * 0005's comment is the thing to read before this file. It refused the constraint because every
 * task created before it carried a uuid the local CLI invented, and refused `not valid` for the
 * usual reason ("it leaves a constraint that claims to hold and does not"), and named an exit
 * condition: *once no pre-0005 task remains*. Whether that condition holds is a property of the
 * data, and it differs between a fresh database and one with history.
 *
 * So the tests here are about that decision rather than about the constraint's syntax:
 *
 * - the orphan-detection query, run against a database that **has** pre-0005 history, built here
 *   rather than asserted against whatever the local database happens to hold;
 * - the migration applying cleanly on a fresh database, and refusing — by name, with a count and
 *   a query — on a historied one;
 * - neither intake path being able to produce an orphan, which is the guarantee the constraint
 *   is a second line of defence for.
 */

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeGitHubClient } from "../dist/github/fake.js";
import { createTaskFromIssue } from "../dist/intake/issue-intake.js";
import { runMigrations } from "../dist/factory/migrate.js";
import { createTaskAndRun } from "../dist/billing/admitted-runs.js";
import {
  findOrphanTasks,
  upsertRepository,
} from "../dist/factory/repository-entity.js";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { repoRoot, TEST_POOL } from "./helpers.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const MIGRATIONS = join(repoRoot, "migrations");
const FK_MIGRATION = "0010_engineering_task_repository_fk.sql";

let serial = 0;

/**
 * A schema migrated to `upTo`, exclusive of anything after it.
 *
 * The migrations are copied into a temp directory rather than filtered in memory, because the
 * runner reads a directory — using it as-is is what makes "the migration applies on a historied
 * database" a claim about the real runner rather than about a reimplementation of it.
 */
async function withSchema(fn, { upTo } = {}) {
  const schema = `windkeel_repo_fk_${process.pid}_${Date.now()}_${serial++}`;
  const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await setup.query(`create schema ${schema}`);
  await setup.end();

  const pool = new Pool({ connectionString: dbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  let dir = null;
  try {
    if (upTo) {
      dir = mkdtempSync(join(tmpdir(), "windkeel-migrations-"));
      for (const name of readdirSync(MIGRATIONS).sort()) {
        if (name > upTo) continue;
        cpSync(join(MIGRATIONS, name), join(dir, name));
      }
      await runMigrations(pool, dir);
    } else {
      await runMigrations(pool, MIGRATIONS);
    }
    await fn(pool);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    await pool.end().catch(() => {});
    const teardown = new Pool({ connectionString: dbUrl, ...TEST_POOL });
    await teardown.query(`drop schema ${schema} cascade`);
    await teardown.end();
  }
}

const REPOSITORY = {
  owner: "jyothepro",
  name: "windkeel-fixture",
  defaultBranch: "trunk",
  cloneUrl: "https://github.com/jyothepro/windkeel-fixture.git",
  githubInstallationId: 42,
};

/** Exactly what `src/commands/task.ts` did before M6.3: a uuid invented out of thin air. */
async function preZeroFiveTask(pool, { withRun = false } = {}) {
  /*
   * Raw SQL in the columns that existed then, not `insertEngineeringTask`: that function writes
   * today's schema (it gained `organization_id` in migrations/0021), and these schemas stop at 0009.
   */
  const { rows } = await pool.query(
    `insert into engineering_task
       (repository_id, source_type, source_reference, title, description, risk_level, status)
     values ('22222222-2222-2222-2222-222222222222', 'local', 'cli', 'An M4-era task',
             'Created when repository_id pointed at nothing.', 'low', 'OPEN')
     returning id`,
  );
  const task = { id: rows[0].id };
  if (withRun) {
    await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: 25,
      wallClockCapSeconds: 7200,
    });
  }
  return task;
}

// --- The orphan-detection query, which is the whole decision -----------------------------

test(
  "the orphan query finds pre-0005 tasks, and says whether each is dead or has history",
  { skip },
  async () => {
    // Stopping at 0009 is what makes this a database *with history*: the constraint is not there
    // yet, so the rows the query is looking for can exist at all.
    await withSchema(
      async (pool) => {
        assert.deepEqual(await findOrphanTasks(pool), [], "a fresh database has none");

        const dead = await preZeroFiveTask(pool);
        const alive = await preZeroFiveTask(pool, { withRun: true });

        const orphans = await findOrphanTasks(pool);
        assert.deepEqual(
          orphans.map((o) => ({ id: o.id, runCount: o.runCount })).sort((a, b) => a.id < b.id ? -1 : 1),
          [{ id: dead.id, runCount: 0 }, { id: alive.id, runCount: 1 }].sort((a, b) => a.id < b.id ? -1 : 1),
        );
        // `runCount` is what decides an orphan's fate: 0 means deleting it destroys nothing,
        // and anything else means the constraint stays out rather than history being rewritten.
        assert.equal(orphans.filter((o) => o.runCount === 0).length, 1);

        // A task whose repository row exists is not an orphan, whatever its source.
        // Raw SQL for the same reason as `preZeroFiveTask`: this schema stops at 0009.
        const { rows: repository } = await pool.query(
          `insert into repository (owner, name, default_branch, clone_url)
           values ($1, $2, $3, $4) returning id`,
          [REPOSITORY.owner, REPOSITORY.name, REPOSITORY.defaultBranch, REPOSITORY.cloneUrl],
        );
        await pool.query(
          `insert into engineering_task
             (repository_id, source_type, source_reference, title, description, risk_level, status)
           values ($1, 'github_issue', '7', 't', 'd', 'low', 'OPEN')`,
          [repository[0].id],
        );
        assert.equal((await findOrphanTasks(pool)).length, 2, "still just the two");
      },
      { upTo: "0009_human_commits_measured_or_unknown.sql" },
    );
  },
);

// --- The migration -----------------------------------------------------------------------

test("the migration applies cleanly on a fresh database", { skip }, async () => {
  await withSchema(async (pool) => {
    const { rows } = await pool.query(
      "select filename from schema_migrations where filename = $1",
      [FK_MIGRATION],
    );
    assert.equal(rows.length, 1, "0010 is applied by the ordinary run over migrations/");
  });
});

test(
  "on a database carrying pre-0005 tasks the migration refuses, naming the count and the query",
  { skip },
  async () => {
    await withSchema(
      async (pool) => {
        await preZeroFiveTask(pool);
        await preZeroFiveTask(pool, { withRun: true });

        // A raw foreign-key violation would say "violates foreign key constraint" and name no
        // row — true, and useless to someone deciding what to do about it.
        await assert.rejects(
          () => runMigrations(pool, MIGRATIONS),
          (error) => {
            assert.match(error.message, new RegExp(FK_MIGRATION));
            assert.match(error.message, /2 engineering_task row\(s\)/);
            return true;
          },
        );

        // Failed migrations are transactional: the constraint is absent and 0010 is unrecorded,
        // so a re-run after the data is fixed does the work.
        const { rows } = await pool.query(
          "select filename from schema_migrations where filename = $1",
          [FK_MIGRATION],
        );
        assert.deepEqual(rows, []);
        assert.equal((await findOrphanTasks(pool)).length, 2, "and nothing was deleted");
      },
      { upTo: "0009_human_commits_measured_or_unknown.sql" },
    );
  },
);

test("migrations remain idempotent: a second run applies nothing", { skip }, async () => {
  await withSchema(async (pool) => {
    const second = await runMigrations(pool, MIGRATIONS);
    assert.deepEqual(second.applied, []);
  });
});

// --- Neither intake path can produce one -------------------------------------------------

test("the local CLI's task core cannot create an orphan", { skip }, async () => {
  await withSchema(async (pool) => {
    // `createTaskAndRun` is the core both intakes share. The CLI reaches it through
    // `resolveRepositoryId`, which upserts a real row and refuses outright when it cannot —
    // so the only way to call this with a dangling id is to invent one, and the database now
    // refuses that.
    await assert.rejects(
      () =>
        createTaskAndRun(pool, {
          repositoryId: "22222222-2222-2222-2222-222222222222",
          sourceType: "local",
          sourceReference: "cli",
          title: "t",
          description: "d",
          criteria: [],
          riskLevel: "low",
          rails: { spendCapUsd: 25, wallClockCapSeconds: 7200, uncappedConfirmed: true },
        }),
      (error) => {
        assert.equal(error.code, "23503");
        return true;
      },
    );
    assert.deepEqual(await findOrphanTasks(pool), []);

    const repository = await upsertRepository(pool, REPOSITORY);
    await createTaskAndRun(pool, {
      repositoryId: repository.id,
      sourceType: "local",
      sourceReference: "cli",
      title: "t",
      description: "d",
      criteria: [],
      riskLevel: "low",
      rails: { spendCapUsd: 25, wallClockCapSeconds: 7200, uncappedConfirmed: true },
    });
    assert.deepEqual(await findOrphanTasks(pool), [], "and the real path leaves none");
  });
});

test("the GitHub issue intake cannot create an orphan", { skip }, async () => {
  await withSchema(async (pool) => {
    // The ingress upserts the repository inside the delivery's transaction before it calls the
    // intake (apps/ingress/src/handler.ts), so the intake is always handed a real id. This
    // asserts the outcome that matters — after intake, nothing is orphaned.
    const repository = await upsertRepository(pool, REPOSITORY);
    const github = new FakeGitHubClient({
      repositories: [
        {
          owner: "jyothepro",
          name: "windkeel-fixture",
          issues: [{ number: 7, title: "Uploader retries are missing", labels: ["windkeel"] }],
        },
      ],
    });

    const result = await createTaskFromIssue(
      { db: pool, github, startRun: async () => ({ enqueued: true }) },
      {
        repository: { id: repository.id, owner: REPOSITORY.owner, name: REPOSITORY.name },
        issue: {
          number: 7,
          title: "Uploader retries are missing",
          body: "The uploader gives up.\n\n- [ ] retries a 500 three times",
          labels: ["windkeel"],
          htmlUrl: "https://github.com/jyothepro/windkeel-fixture/issues/7",
          state: "open",
          locked: false,
        },
      },
    );
    await result.afterCommit();

    assert.equal(result.outcome.kind, "started");
    assert.deepEqual(await findOrphanTasks(pool), []);
  });
});
