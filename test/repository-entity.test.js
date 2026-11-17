import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import {
  getRepository,
  getRepositoryByFullName,
  parseFullName,
  repositoryFullName,
  upsertRepository,
} from "../dist/factory/repository-entity.js";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import {
  MissingRepositoryError,
  resolveRepositoryTarget,
} from "../dist/factory/workflow/repository-target.js";
import { FIXTURE_REPOSITORY_ID, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase, migratedDatabaseUrl } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let schemaSerial = 0;

/** One schema per case, migrated once, dropped after — the pattern test/repositories.test.js set. */
async function withSchema(fn) {
  const schema = `windkeel_repository_entity_test_${Date.now()}_${schemaSerial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await fn(pool, schema);
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

const FIXTURE = {
  owner: "jyothepro",
  name: "windkeel-fixture",
  defaultBranch: "trunk",
  cloneUrl: "https://github.com/jyothepro/windkeel-fixture.git",
  githubInstallationId: 42,
};

/**
 * A task and a run. The repository row is seeded first unless the caller names its own id —
 * `migrations/0010`'s foreign key means a task cannot exist without one, which is the point of
 * that migration and is why this helper now has to say which repository it means.
 */
async function seedTask(pool, overrides = {}) {
  if (overrides.repositoryId === undefined) await seedFixtureRepository(pool);
  const task = await insertEngineeringTask(pool, {
    repositoryId: FIXTURE_REPOSITORY_ID,
    sourceType: "github_issue",
    sourceReference: "7",
    title: "Fix the uploader",
    description: "It gives up on the first 500.",
    acceptanceCriteria: [],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
    ...overrides,
  });
  const run = await insertEngineeringRun(pool, {
    taskId: task.id,
    spendCapUsd: 25,
    wallClockCapSeconds: 7200,
  });
  return { task, run };
}

// --- Pure helpers, no database ---

test("parseFullName accepts owner/name and refuses everything else", () => {
  assert.deepEqual(parseFullName("jyothepro/windkeel"), { owner: "jyothepro", name: "windkeel" });
  for (const bad of ["windkeel", "a/b/c", "/windkeel", "jyothepro/", ""]) {
    assert.throws(() => parseFullName(bad), /owner\/name/);
  }
  assert.equal(repositoryFullName({ owner: "a", name: "b" }), "a/b");
});

// --- The entity ---

test("a repository round-trips, and bigint installation ids come back as numbers", { skip }, async () => {
  await withSchema(async (pool) => {
    const inserted = await upsertRepository(pool, FIXTURE);
    assert.equal(inserted.githubInstallationId, 42);
    assert.equal(inserted.defaultBranch, "trunk", "the default branch is data, not 'main'");

    assert.deepEqual(await getRepository(pool, inserted.id), inserted);
    assert.deepEqual(await getRepositoryByFullName(pool, FIXTURE.owner, FIXTURE.name), inserted);
    assert.equal(await getRepositoryByFullName(pool, "nobody", "nothing"), null);
  });
});

test("upsert is upsert: the same owner/name twice is one row, with the later facts", { skip }, async () => {
  await withSchema(async (pool) => {
    const first = await upsertRepository(pool, FIXTURE);
    // A repository whose default branch was renamed — the case that makes "do update" right
    // rather than "do nothing".
    const second = await upsertRepository(pool, { ...FIXTURE, defaultBranch: "main" });

    assert.equal(second.id, first.id, "one row per repository, not one per delivery");
    assert.equal(second.defaultBranch, "main");
    assert.ok(second.updatedAt >= first.updatedAt);
    const { rows } = await pool.query("select count(*)::int as n from repository");
    assert.equal(rows[0].n, 1);
  });
});

test("two concurrent upserts on separate connections both succeed and leave one row", { skip }, async () => {
  await withSchema(async (pool, schema) => {
    // Separate pools, so this is two real connections racing rather than one queued behind the
    // other — webhook deliveries arrive that way.
    const a = new Pool({ connectionString: migratedDatabaseUrl(schema), ...TEST_POOL, options: `-c search_path=${schema}` });
    const b = new Pool({ connectionString: migratedDatabaseUrl(schema), ...TEST_POOL, options: `-c search_path=${schema}` });
    try {
      const [first, second] = await Promise.all([
        upsertRepository(a, FIXTURE),
        upsertRepository(b, { ...FIXTURE, defaultBranch: "main" }),
      ]);
      assert.equal(first.id, second.id, "the database arbitrated; neither caller had to");
      const { rows } = await pool.query("select count(*)::int as n from repository");
      assert.equal(rows[0].n, 1);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

// --- Per-task resolution (ADR-0018 §3, §4) ---

const FALLBACK = { url: "/local/bare/repo.git", baseRevision: "HEAD" };

test("a task whose repository row exists resolves to that row", { skip }, async () => {
  await withSchema(async (pool) => {
    const repository = await upsertRepository(pool, FIXTURE);
    const { run } = await seedTask(pool, { repositoryId: repository.id });

    assert.deepEqual(await resolveRepositoryTarget(pool, run.id, FALLBACK), {
      url: FIXTURE.cloneUrl,
      // ADR-0009 §5 cuts the working branch from the repository's default branch, whatever it
      // is called — reading `main` here would be a bug the fixture is chosen to catch.
      baseRevision: "trunk",
    });
  });
});

/**
 * The next three cases need a task whose `repository_id` points at no row — which
 * `migrations/0010` now makes impossible to insert. So they drop the constraint inside their own
 * throwaway schema first, and that is not a way of dodging the test: it is precisely the state
 * of a database that has not run 0010, and the enforcement being exercised here is the *code's*,
 * which is the only enforcement such a database has. `resolveRepositoryTarget` is a first line
 * of defence, not something the constraint replaces.
 */
async function withoutTheForeignKey(pool) {
  await pool.query(
    "alter table engineering_task drop constraint engineering_task_repository_id_fkey",
  );
}

test("a local task with no repository row falls back to the configured repository", { skip }, async () => {
  await withSchema(async (pool) => {
    await withoutTheForeignKey(pool);
    const { run } = await seedTask(pool, {
      sourceType: "local",
      sourceReference: "cli",
      repositoryId: "33333333-3333-3333-3333-333333333333",
    });
    assert.deepEqual(await resolveRepositoryTarget(pool, run.id, FALLBACK), FALLBACK);
  });
});

test("a non-local task pointing at a missing repository fails loudly", { skip }, async () => {
  await withSchema(async (pool) => {
    await withoutTheForeignKey(pool);
    const { run, task } = await seedTask(pool, {
      repositoryId: "22222222-2222-2222-2222-222222222222",
    });
    await assert.rejects(
      () => resolveRepositoryTarget(pool, run.id, FALLBACK),
      (error) => {
        // Silently falling back would run the factory against whichever repository the
        // container was configured for — ADR-0018 §4.
        assert.ok(error instanceof MissingRepositoryError);
        assert.equal(error.taskId, task.id);
        assert.equal(error.sourceType, "github_issue");
        assert.match(error.message, /Refusing to fall back/);
        return true;
      },
    );
  });
});

// --- The FK gap, closed ---

test(
  "engineering_task.repository_id has a validated foreign key (migrations/0010, issue #180)",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      // This test used to assert the constraint was *absent*, with the note "when this fails,
      // migrations/0005's comment needs updating too". It has been updated, and so has 0005.
      const { rows } = await pool.query(
        `select c.conname, c.convalidated, c.confdeltype
           from pg_constraint c
           join pg_class t on t.oid = c.conrelid
           join pg_namespace n on n.oid = t.relnamespace
          where t.relname = 'engineering_task' and c.contype = 'f'
            and n.nspname = current_schema()`,
      );
      // Two since migrations/0021: a task also belongs to an organization (ADR-0024 §3). Three since
      // migrations/0023/0024 (both add it; 0024 only if absent): the principal that created it.
      assert.deepEqual(rows.map((r) => r.conname).sort(), [
        // migrations/0048 (#391): the batch a task was fanned out from.
        "engineering_task_batch_id_fkey",
        "engineering_task_created_by_principal_id_fkey",
        "engineering_task_organization_id_fkey",
        // migrations/0034 (ADR-0029 §1): who asked for Pair mode.
        "engineering_task_pair_principal_id_fkey",
        "engineering_task_repository_id_fkey",
      ]);
      rows.splice(0, rows.length, rows.find((r) => r.conname === "engineering_task_repository_id_fkey"));
      assert.equal(
        rows[0].convalidated,
        true,
        "0005 rejected `not valid` for a stated reason: it leaves a constraint that claims to " +
          "hold and does not. That reason has not changed.",
      );
      assert.equal(
        rows[0].confdeltype,
        "a",
        "no action on delete: a repository with tasks against it cannot be deleted. `cascade` " +
          "would let one delete take a run's whole history with it.",
      );
    });
  },
);

test(
  "engineering_task.created_by_principal_id has exactly one foreign key after 0023 and 0024 both add it",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const { rows } = await pool.query(
        `select c.conname, c.confdeltype, r.relname as referenced
           from pg_constraint c
           join pg_class t on t.oid = c.conrelid
           join pg_namespace n on n.oid = t.relnamespace
           join pg_class r on r.oid = c.confrelid
           join pg_attribute a on a.attrelid = t.oid and a.attnum = any (c.conkey)
          where t.relname = 'engineering_task' and c.contype = 'f'
            and n.nspname = current_schema()
            and a.attname = 'created_by_principal_id'`,
      );
      assert.equal(rows.length, 1, "0024 must not add a second FK beside 0023's");
      assert.equal(rows[0].conname, "engineering_task_created_by_principal_id_fkey");
      assert.equal(rows[0].referenced, "principal");
      assert.equal(rows[0].confdeltype, "n", "0023's `on delete set null` is the one kept");
      const { rows: columns } = await pool.query(
        `select count(*)::int as n from information_schema.columns
          where table_schema = current_schema() and table_name = 'engineering_task'
            and column_name = 'created_by_principal_id'`,
      );
      assert.equal(columns[0].n, 1);
    });
  },
);

test("an orphan task can no longer be inserted at all", { skip }, async () => {
  await withSchema(async (pool) => {
    await assert.rejects(
      () => seedTask(pool, { repositoryId: "22222222-2222-2222-2222-222222222222" }),
      (error) => {
        assert.equal(error.code, "23503", "a foreign key violation");
        assert.match(error.constraint, /repository_id_fkey/);
        return true;
      },
    );
  });
});

test("a repository with tasks against it cannot be deleted", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedTask(pool);
    await assert.rejects(
      () => pool.query("delete from repository where id = $1", [FIXTURE_REPOSITORY_ID]),
      (error) => {
        assert.equal(error.code, "23503");
        return true;
      },
    );
  });
});
