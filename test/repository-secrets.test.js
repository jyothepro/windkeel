/**
 * The repository-secret store, and the refusal list that bounds what a name may be.
 *
 * The refusal list is the part worth testing carefully, because it is the one place where a feature
 * could quietly undo ADR-0014 §1. A secret named `CODEX_API_KEY` would put a real, reusable model
 * key into the environment of a VM running model-authored commands — the exact posture that ADR
 * exists to prevent — and it would do so through an endpoint, not through a bug. So the set is
 * asserted by example, in both directions: the names that must be refused, and the ordinary names
 * that must still work.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../dist/factory/migrate.js";
import {
  InvalidSecretKeyError,
  assertSecretKey,
  deleteRepositorySecret,
  listRepositorySecrets,
  putRepositorySecret,
  resolveRepositorySecrets,
} from "../dist/factory/repository-secrets.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const REPO_ID = "11111111-1111-1111-1111-111111111111";

const PAIR = generateSecretKeyPair();

let counter = 0;

async function withSchema(fn) {
  const schema = `windkeel_secrets_${Date.now()}_${process.pid}_${counter++}`;
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
    await pool.end();
    const teardown = new Pool({ connectionString: dbUrl, ...TEST_POOL });
    await teardown.query(`drop schema if exists ${schema} cascade`);
    await teardown.end();
  }
}

// --- names -----------------------------------------------------------------

test("the names that would undo ADR-0014 §1 are refused", () => {
  for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "VERCEL_TOKEN"]) {
    assert.throws(() => assertSecretKey(key), InvalidSecretKeyError, key);
  }
});

test("names that redirect an interpreter are refused", () => {
  for (const key of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "PYTHONPATH", "BASH_ENV", "HOME"]) {
    assert.throws(() => assertSecretKey(key), InvalidSecretKeyError, key);
  }
});

test("the WINDKEEL_ prefix is refused wholesale, not name by name", () => {
  /*
   * Wholesale because the worker's configuration under this prefix grows, and a list that had to be
   * extended per variable would silently stop covering the next one added.
   */
  for (const key of ["WINDKEEL_MAKER_MODEL", "WINDKEEL_SECRET_PRIVATE_KEY", "WINDKEEL_ANYTHING_AT_ALL"]) {
    assert.throws(() => assertSecretKey(key), InvalidSecretKeyError, key);
  }
});

test("a name that is not shaped like an environment variable is refused", () => {
  for (const key of ["", "lower_case", "1LEADING_DIGIT", "HAS-DASH", "HAS SPACE", "A".repeat(64)]) {
    assert.throws(() => assertSecretKey(key), InvalidSecretKeyError, JSON.stringify(key));
  }
});

test("the names an operator actually needs are allowed", () => {
  for (const key of ["NPM_TOKEN", "PIP_INDEX_URL", "GOPRIVATE", "ARTIFACTORY_PASSWORD", "A"]) {
    assert.equal(assertSecretKey(key), key);
  }
});

test("every refusal says which rule, because a bare rejection is unactionable", () => {
  for (const key of ["OPENAI_API_KEY", "PATH", "WINDKEEL_X", "lower"]) {
    try {
      assertSecretKey(key);
      assert.fail(`${key} should have been refused`);
    } catch (err) {
      assert.match(err.message, /not a usable secret name — ./);
      assert.ok(err.message.length > 50, `the reason for ${key} is too short to act on`);
    }
  }
});

// --- the store -------------------------------------------------------------

/** The organization every pre-tenancy row belongs to (ADR-0024 §10). */
async function defaultOrg(pool) {
  const { rows } = await pool.query("select id from organization where is_default");
  return rows[0].id;
}

test("two organizations sharing a repository never see each other's secrets", { skip }, async () => {
  await withSchema(async (pool) => {
    const first = await defaultOrg(pool);
    const { rows } = await pool.query(
      `insert into organization (account_id, name) select account_id, 'second' from organization where is_default
       returning id`,
    );
    const second = rows[0].id;
    for (const [organizationId, value] of [[first, "first-org"], [second, "second-org"]]) {
      await putRepositorySecret(pool, {
        organizationId,
        repositoryId: REPO_ID,
        key: "NPM_TOKEN",
        value,
        setBy: "operator",
        publicKey: PAIR.publicKey,
      });
    }
    const { values } = await resolveRepositorySecrets(pool, second, REPO_ID, PAIR.privateKey);
    assert.deepEqual(values, { NPM_TOKEN: "second-org" }, "a run gets its own organization's credential only");
    assert.equal((await listRepositorySecrets(pool, first, REPO_ID)).length, 1);
  });
});

test("a stored secret is a sealed box, never a plaintext column", { skip }, async () => {
  await withSchema(async (pool) => {
    await putRepositorySecret(pool, {
      organizationId: await defaultOrg(pool),
      repositoryId: REPO_ID,
      key: "NPM_TOKEN",
      value: "npm_verylongsecretvalue",
      note: "read-only",
      setBy: "operator",
      publicKey: PAIR.publicKey,
    });

    // Asserted against the whole row, dumped as text, rather than against the one column it is
    // expected to be in: a future column that happened to carry it would pass the narrower check.
    const { rows } = await pool.query("select row_to_json(t) as row from repository_secret t");
    const dumped = JSON.stringify(rows[0].row);
    assert.ok(
      !dumped.includes("npm_verylongsecretvalue"),
      "a database dump must not be a list of credentials",
    );
    assert.match(dumped, /orqonsealv1\./);

    const { values, unopenable } = await resolveRepositorySecrets(pool, await defaultOrg(pool), REPO_ID, PAIR.privateKey);
    assert.deepEqual(values, { NPM_TOKEN: "npm_verylongsecretvalue" });
    assert.deepEqual(unopenable, []);
  });
});

test("listing returns names, notes and authorship — and has no value field", { skip }, async () => {
  await withSchema(async (pool) => {
    await putRepositorySecret(pool, {
      organizationId: await defaultOrg(pool),
      repositoryId: REPO_ID,
      key: "NPM_TOKEN",
      value: "x",
      note: "read-only",
      setBy: "operator",
      publicKey: PAIR.publicKey,
    });
    const [secret] = await listRepositorySecrets(pool, await defaultOrg(pool), REPO_ID);
    assert.deepEqual(Object.keys(secret).sort(), [
      "createdAt",
      "key",
      "note",
      "setBy",
      "updatedAt",
    ]);
  });
});

test("an empty value is refused rather than stored as a secret nothing can use", { skip }, async () => {
  await withSchema(async (pool) => {
    await assert.rejects(
      putRepositorySecret(pool, {
        organizationId: await defaultOrg(pool),
        repositoryId: REPO_ID,
        key: "NPM_TOKEN",
        value: "",
        setBy: "operator",
        publicKey: PAIR.publicKey,
      }),
      /use delete to remove a secret/,
    );
  });
});

test("a secret sealed to another pair is reported by name, not thrown past the caller", { skip }, async () => {
  await withSchema(async (pool) => {
    const other = generateSecretKeyPair();
    await putRepositorySecret(pool, {
      organizationId: await defaultOrg(pool),
      repositoryId: REPO_ID,
      key: "GOOD",
      value: "good",
      setBy: "operator",
      publicKey: PAIR.publicKey,
    });
    await putRepositorySecret(pool, {
      organizationId: await defaultOrg(pool),
      repositoryId: REPO_ID,
      key: "STALE",
      value: "stale",
      setBy: "operator",
      publicKey: other.publicKey,
    });

    const { values, unopenable } = await resolveRepositorySecrets(pool, await defaultOrg(pool), REPO_ID, PAIR.privateKey);
    /*
     * One stale secret must not cost a repository the ones that are fine. A throw here would turn a
     * rotation into a failed provision for every run against this repository.
     */
    assert.deepEqual(values, { GOOD: "good" });
    assert.deepEqual(
      unopenable.map((entry) => entry.key),
      ["STALE"],
    );
    assert.match(unopenable[0].reason, /authentication failed/);
  });
});

test("deleting a repository takes its secrets with it", { skip }, async () => {
  await withSchema(async (pool) => {
    await putRepositorySecret(pool, {
      organizationId: await defaultOrg(pool),
      repositoryId: REPO_ID,
      key: "NPM_TOKEN",
      value: "x",
      setBy: "operator",
      publicKey: PAIR.publicKey,
    });
    await pool.query("delete from repository where id = $1", [REPO_ID]);
    const { rows } = await pool.query("select 1 from repository_secret");
    assert.equal(rows.length, 0, "an orphaned credential outliving its repository is a liability");
  });
});

test("deleting a secret that is not there reports false rather than throwing", { skip }, async () => {
  await withSchema(async (pool) => {
    assert.equal(await deleteRepositorySecret(pool, await defaultOrg(pool), REPO_ID, "ABSENT"), false);
  });
});
