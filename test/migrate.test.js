import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { loadMigrations, pendingMigrations, runMigrations } from "../dist/factory/migrate.js";
import { TEST_POOL } from "./helpers.js";

function migrationsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "windkeel-migrations-"));
  for (const [filename, sql] of Object.entries(files)) {
    writeFileSync(join(dir, filename), sql);
  }
  return dir;
}

test("loadMigrations reads only .sql files, sorted by filename", () => {
  const dir = migrationsDir({
    "0002_second.sql": "select 2;",
    "0001_first.sql": "select 1;",
    "README.md": "not a migration",
  });
  const files = loadMigrations(dir).map((m) => m.filename);
  assert.deepEqual(files, ["0001_first.sql", "0002_second.sql"]);
});

test("pendingMigrations excludes filenames already recorded as applied", () => {
  const all = [
    { filename: "0001_first.sql", sql: "select 1;" },
    { filename: "0002_second.sql", sql: "select 2;" },
    { filename: "0003_third.sql", sql: "select 3;" },
  ];
  const pending = pendingMigrations(all, ["0001_first.sql"]).map((m) => m.filename);
  assert.deepEqual(pending, ["0002_second.sql", "0003_third.sql"]);
});

test("pendingMigrations is a no-op once every file is applied", () => {
  const all = [{ filename: "0001_first.sql", sql: "select 1;" }];
  assert.deepEqual(pendingMigrations(all, ["0001_first.sql"]), []);
});

/**
 * Exercises runMigrations against a real Postgres — the pure ordering logic above is
 * covered without one, but "the SQL actually applies and schema_migrations actually
 * records it" needs the real thing. Skipped when no database is available (CI does not
 * run a Postgres service yet); set TEST_DATABASE_URL to run it locally against the
 * ADR-0016 docker-compose Postgres.
 */
const dbUrl = process.env.TEST_DATABASE_URL;

test(
  "runMigrations applies pending files in order, once each, recording them in schema_migrations",
  { skip: dbUrl ? false : "TEST_DATABASE_URL not set" },
  async () => {
    const schema = `windkeel_migrate_test_${Date.now()}`;
    const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
    await setup.query(`create schema ${schema}`);
    await setup.end();

    // search_path is set per-connection via the `options` startup parameter, not a
    // `set search_path` query, because pool.connect() may hand out any pooled connection.
    const pool = new Pool({ connectionString: dbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
    try {
      const dir = migrationsDir({
        "0001_create_widgets.sql": "create table widgets (id uuid primary key);",
        "0002_add_widget_name.sql": "alter table widgets add column name text;",
      });

      const first = await runMigrations(pool, dir);
      assert.deepEqual(first.applied, ["0001_create_widgets.sql", "0002_add_widget_name.sql"]);

      const { rows } = await pool.query(`select column_name from information_schema.columns
        where table_schema = $1 and table_name = 'widgets' order by column_name`, [schema]);
      assert.deepEqual(rows.map((r) => r.column_name), ["id", "name"]);

      // Re-running is a no-op: both files are already recorded.
      const second = await runMigrations(pool, dir);
      assert.deepEqual(second.applied, []);
    } finally {
      await pool.query(`drop schema ${schema} cascade`);
      await pool.end();
    }
  },
);

test(
  "a failing migration rolls back and is not recorded, so re-running retries it",
  { skip: dbUrl ? false : "TEST_DATABASE_URL not set" },
  async () => {
    const schema = `windkeel_migrate_test_${Date.now()}_fail`;
    const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
    await setup.query(`create schema ${schema}`);
    await setup.end();

    const pool = new Pool({ connectionString: dbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
    try {
      const dir = migrationsDir({
        "0001_ok.sql": "create table ok (id uuid primary key);",
        "0002_broken.sql": "this is not valid sql;",
      });

      await assert.rejects(() => runMigrations(pool, dir), /0002_broken\.sql failed/);

      const { rows } = await pool.query("select filename from schema_migrations order by filename");
      assert.deepEqual(rows.map((r) => r.filename), ["0001_ok.sql"]);
    } finally {
      await pool.query(`drop schema ${schema} cascade`);
      await pool.end();
    }
  },
);


/**
 * #394: the billing migration on top of a database that already has work in it. Found by its
 * `_billing.sql` suffix rather than its number, so a renumbering at merge does not break this.
 */
test(
  "the billing migration applies over existing rows: the default account is internal, nothing is budgeted",
  { skip: dbUrl ? false : "TEST_DATABASE_URL not set" },
  async () => {
    const { cpSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { repoRoot, seedFixtureRepository } = await import("./helpers.js");
    const { insertEngineeringRun, insertEngineeringTask } = await import("../dist/factory/repositories.js");
    const all = join(repoRoot, "migrations");
    const billing = readdirSync(all).find((f) => f.endsWith("_billing.sql"));
    assert.ok(billing, "the billing migration exists");
    const before = migrationsDir({});
    cpSync(all, before, { recursive: true, filter: (src) => !src.endsWith(".sql") || src.split("/").pop() < billing });

    const schema = `windkeel_migrate_billing_${Date.now()}`;
    const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
    await setup.query(`create schema ${schema}`);
    await setup.end();
    const pool = new Pool({ connectionString: dbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
    try {
      await runMigrations(pool, before);
      await seedFixtureRepository(pool);
      const task = await insertEngineeringTask(pool, {
        repositoryId: "11111111-1111-1111-1111-111111111111", sourceType: "local", sourceReference: "m",
        title: "t", description: "d", acceptanceCriteria: [], riskLevel: "low", priority: null, status: "OPEN",
      });
      const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
      await pool.query("update engineering_run set stop_reason = 'model_policy' where id = $1", [run.id]);

      const { applied } = await runMigrations(pool, all);
      // The billing migration and any after it (#431's credits came next).
      assert.deepEqual(applied, readdirSync(all).filter((f) => f.endsWith(".sql") && f >= billing).sort());

      const { rows } = await pool.query("select a.is_default, b.provider, b.plan from billing_account b join account a on a.id = b.account_id");
      assert.deepEqual(rows, [{ is_default: true, provider: "none", plan: "internal" }]);
      assert.equal((await pool.query("select 1 from organization_budget")).rowCount, 0);
      // #431: no existing account is moved onto credits; it stays billed as it was.
      assert.equal((await pool.query("select 1 from billing_account where credit_billing_since is not null")).rowCount, 0);
      assert.equal((await pool.query("select 1 from credit_grant")).rowCount, 0);
      // An existing stop reason is still valid, and the new one is accepted.
      await pool.query("update engineering_run set stop_reason = 'org_budget' where id = $1", [run.id]);
      await assert.rejects(pool.query("update engineering_run set stop_reason = 'bogus' where id = $1", [run.id]), /stop_reason_check/);
    } finally {
      await pool.query(`drop schema ${schema} cascade`);
      await pool.end();
    }
  },
);
