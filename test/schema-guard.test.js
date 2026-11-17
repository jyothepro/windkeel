/**
 * #337: a deployment whose migrations are not applied is visibly unhealthy within one request,
 * and refuses with `schema_behind` instead of answering raw relation errors.
 *
 * The comparison is unit-tested without a database; the gated test at the bottom builds a real
 * schema missing the latest migration and asserts that both the health route and `windkeel doctor`
 * name it.
 */

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import {
  bundledMigrationFilenames,
  pendingMigrationNames,
  readSchemaStatus,
  schemaBehindBody,
  schemaGuard,
} from "../dist/factory/schema-guard.js";
import { runMigrations } from "../dist/factory/migrate.js";
import { checkMigrations } from "../dist/commands/doctor.js";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { repoRoot, TEST_POOL } from "./helpers.js";

const MIGRATIONS = readdirSync(join(repoRoot, "migrations")).filter((n) => n.endsWith(".sql")).sort();
const LATEST = MIGRATIONS.at(-1);

/** A queryable whose `schema_migrations` holds `applied`, or throws `error`. */
function db({ applied = [], error = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (sql === "select 1") return { rows: [{ "?column?": 1 }] };
      if (error) throw error;
      return { rows: applied.map((filename) => ({ filename })) };
    },
  };
}

// --- the comparison ------------------------------------------------------------------------

test("pending is every bundled file not applied, in filename order", () => {
  assert.deepEqual(
    pendingMigrationNames(["0003_c.sql", "0001_a.sql", "0002_b.sql"], ["0001_a.sql"]),
    ["0002_b.sql", "0003_c.sql"],
  );
});

test("nothing is pending once every bundled file is applied", () => {
  assert.deepEqual(pendingMigrationNames(["0001_a.sql"], ["0001_a.sql"]), []);
});

test("a database ahead of the bundle is not behind (old code serving after a newer migrate)", () => {
  assert.deepEqual(pendingMigrationNames(["0001_a.sql"], ["0001_a.sql", "0002_b.sql"]), []);
});

test("a gap is pending even when later files are applied", () => {
  assert.deepEqual(
    pendingMigrationNames(["0001_a.sql", "0002_b.sql", "0003_c.sql"], ["0001_a.sql", "0003_c.sql"]),
    ["0002_b.sql"],
  );
});

test("readSchemaStatus: current, behind, no table, unreadable, nothing bundled", async () => {
  assert.deepEqual(await readSchemaStatus(db({ applied: ["0001_a.sql"] }), ["0001_a.sql"]), {
    state: "current",
    bundled: 1,
  });
  assert.deepEqual(await readSchemaStatus(db({ applied: [] }), ["0001_a.sql"]), {
    state: "behind",
    pending: ["0001_a.sql"],
  });
  const missing = Object.assign(new Error('relation "schema_migrations" does not exist'), { code: "42P01" });
  assert.deepEqual(await readSchemaStatus(db({ error: missing }), ["0001_a.sql", "0002_b.sql"]), {
    state: "behind",
    pending: ["0001_a.sql", "0002_b.sql"],
  });
  const denied = Object.assign(new Error("permission denied"), { code: "42501" });
  assert.equal((await readSchemaStatus(db({ error: denied }), ["0001_a.sql"])).state, "unknown");
  assert.equal((await readSchemaStatus(db(), null)).state, "unverifiable");
  assert.equal((await readSchemaStatus(db(), [])).state, "unverifiable");
});

test("the compiled guard finds the repository's migrations as its bundle", () => {
  assert.deepEqual(bundledMigrationFilenames(), MIGRATIONS);
});

test("the refusal names every pending file and carries one code", () => {
  const body = schemaBehindBody(["0002_b.sql", "0003_c.sql"]);
  assert.equal(body.code, "schema_behind");
  assert.equal(body.ok, false);
  assert.deepEqual(body.pending, ["0002_b.sql", "0003_c.sql"]);
  assert.match(body.error, /npm run db:migrate/);
});

// --- caching per instance ------------------------------------------------------------------

test("current is cached for the life of the instance: one query, however many requests", async () => {
  const database = db({ applied: ["0001_a.sql"] });
  const guard = schemaGuard({ bundled: ["0001_a.sql"] });
  await Promise.all([guard.status(database), guard.status(database), guard.refusal(database)]);
  await guard.status(database);
  assert.equal(database.calls.length, 1);
});

test("behind is re-checked after the window, so an instance recovers once migrations land", async () => {
  let clock = 0;
  const applied = [];
  const database = db({ applied });
  const guard = schemaGuard({ bundled: ["0001_a.sql"], recheckMs: 1_000, now: () => clock });

  assert.deepEqual((await guard.refusal(database))?.pending, ["0001_a.sql"]);
  applied.push("0001_a.sql"); // the migrate job runs
  clock = 500;
  assert.ok(await guard.refusal(database), "inside the window the cached answer stands");
  clock = 1_500;
  assert.equal(await guard.refusal(database), null, "after it, the database is asked again");
  assert.equal(database.calls.length, 2);
});

test("an unreadable database is never cached, and never refuses a request", async () => {
  const database = db({ error: new Error("connection reset") });
  const guard = schemaGuard({ bundled: ["0001_a.sql"] });
  assert.equal(await guard.refusal(database), null);
  assert.equal(await guard.refusal(database), null);
  assert.equal(database.calls.length, 2);
});

// --- the API: health and the refusal -------------------------------------------------------

const request = (path) => ({ method: "GET", path, query: { get: () => undefined }, headers: {} });

test("health answers 503 naming the pending migrations", async () => {
  const pool = db({ applied: MIGRATIONS.slice(0, -1) });
  const result = await handleApiRequest(
    { pool, control: {}, schema: schemaGuard({ bundled: MIGRATIONS }) },
    { token: "t" },
    request("/v1/health"),
  );
  assert.equal(result.status, 503);
  assert.equal(result.body.schema, "behind");
  assert.deepEqual(result.body.pending, [LATEST]);
});

test("health is 200 with a current schema, and 503 when the bundle is missing", async () => {
  const pool = db({ applied: MIGRATIONS });
  const current = await handleApiRequest(
    { pool, control: {}, schema: schemaGuard({ bundled: MIGRATIONS }) },
    { token: "t" },
    request("/v1/health"),
  );
  assert.equal(current.status, 200);
  assert.deepEqual(current.body, { ok: true, database: "reachable", schema: "current" });

  const lost = await handleApiRequest(
    { pool, control: {}, schema: schemaGuard({ bundled: null }) },
    { token: "t" },
    request("/v1/health"),
  );
  assert.equal(lost.status, 503);
  assert.equal(lost.body.schema, "unverifiable");
});

test("every other route refuses with schema_behind before touching a table", async () => {
  const pool = db({ applied: MIGRATIONS.slice(0, -1) });
  const result = await handleApiRequest(
    { pool, control: {}, schema: schemaGuard({ bundled: MIGRATIONS }) },
    { token: "t" },
    { ...request("/v1/self"), headers: { authorization: "Bearer orq_whatever" } },
  );
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "schema_behind");
  assert.deepEqual(result.body.pending, [LATEST]);
  assert.deepEqual(
    pool.calls,
    ["select filename from schema_migrations"],
    "no token lookup ran against a table that may not exist",
  );
});

// --- the Action ----------------------------------------------------------------------------

test("migrate.yml: main only, one concurrency group never cancelled, secret only in step env", () => {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "migrate.yml"), "utf8");
  assert.match(workflow, /^on:\n(?:.*\n)*?  push:\n(?:\s+#.*\n)*\s+branches: \[main\]/m);
  assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+dry-run:/);
  assert.match(workflow, /^concurrency:\n  group: migrate-production\n  cancel-in-progress: false\s*$/m);
  assert.match(workflow, /^permissions:\n  contents: read\s*$/m);
  assert.match(workflow, /^    if: github\.ref == 'refs\/heads\/main'\s*$/m);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm run db:migrate -- --dry-run/);
  // The secret appears only as a step's env, never at workflow or job level.
  for (const line of workflow.split("\n").filter((l) => l.includes("secrets."))) {
    assert.match(line, /^ {10}DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}$/);
  }
});

// --- against a real Postgres ---------------------------------------------------------------

const dbUrl = process.env.TEST_DATABASE_URL;

test(
  "a schema missing the latest migration fails health and the doctor check, naming the file",
  { skip: dbUrl ? false : "TEST_DATABASE_URL not set" },
  async () => {
    const schema = `windkeel_schema_guard_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
    await setup.query(`create schema ${schema}`);
    await setup.end();

    // Every real migration but the last, applied for real.
    const allButLatest = mkdtempSync(join(tmpdir(), "windkeel-migrations-behind-"));
    for (const file of MIGRATIONS.slice(0, -1)) {
      copyFileSync(join(repoRoot, "migrations", file), join(allButLatest, file));
    }
    const pool = new Pool({ connectionString: dbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
    try {
      await runMigrations(pool, allButLatest);

      const guard = schemaGuard({ recheckMs: 0 }); // the bundle as deployed: the whole directory
      const health = await handleApiRequest({ pool, control: {}, schema: guard }, { token: "t" }, request("/v1/health"));
      assert.equal(health.status, 503);
      assert.deepEqual(health.body.pending, [LATEST]);

      const refused = await handleApiRequest(
        { pool, control: {}, schema: guard },
        { token: "t" },
        { ...request("/v1/self"), headers: { authorization: "Bearer t" } },
      );
      assert.equal(refused.status, 503);
      assert.equal(refused.body.code, "schema_behind");

      const environment = {
        env: {},
        migrationsDir: join(repoRoot, "migrations"),
        connect: async () =>
          new Pool({ connectionString: dbUrl, ...TEST_POOL, options: `-c search_path=${schema}` }),
      };
      const doctor = await checkMigrations(environment, { databaseUrl: dbUrl });
      assert.equal(doctor.status, "fail");
      assert.ok(doctor.summary.includes(LATEST));
      assert.ok(doctor.details.includes(`pending: ${LATEST}`));

      // The migrate job runs; the same guard recovers without a redeploy.
      await runMigrations(pool, join(repoRoot, "migrations"));
      const healed = await handleApiRequest({ pool, control: {}, schema: guard }, { token: "t" }, request("/v1/health"));
      assert.equal(healed.status, 200);
      assert.equal((await checkMigrations(environment, { databaseUrl: dbUrl })).status, "pass");
    } finally {
      await pool.query(`drop schema ${schema} cascade`).catch(() => {});
      await pool.end();
    }
  },
);
