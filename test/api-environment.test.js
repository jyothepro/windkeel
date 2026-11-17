/**
 * #387: `/v1/repositories/{id}/environment` — the read, the rebuild intent and the invalidation,
 * behind the secrets guard, and nothing in a response that a snapshot's provider id or a secret's
 * value could leak through.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { claimSnapshotBuild, markSnapshotReady, pendingSnapshotRequest } from "../dist/factory/environment-snapshots.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const TOKEN = "test-environment-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";

const request = (method, path, extra = {}) => ({
  method,
  path,
  query: { get: () => undefined },
  headers: extra.headers ?? { authorization: `Bearer ${TOKEN}` },
  body: extra.body,
});

async function withApi(fn, overrides = {}) {
  const schema = `windkeel_api_env_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const { rows } = await pool.query("select id from organization where is_default");
    const deps = { pool, control: {}, ...overrides };
    const auth = { token: TOKEN, subject: "operator" };
    await fn({ pool, org: rows[0].id, call: (m, p, e) => handleApiRequest(deps, auth, request(m, p, e)) });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

test("GET environment lists snapshots and the suggestion, never the provider snapshot id", { skip }, async () => {
  await withApi(async ({ pool, org, call }) => {
    const empty = await call("GET", `/v1/repositories/${REPO_ID}/environment`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.items, []);
    assert.equal(empty.body.current, null);

    const row = await claimSnapshotBuild(pool, {
      organizationId: org,
      repositoryId: REPO_ID,
      sandboxProvider: "vercel",
      cacheKey: "c".repeat(64),
      keyPaths: ["windkeel.config.json"],
      baseSha: "b".repeat(40),
      builtBy: "system",
    });
    await pool.query("update environment_snapshot set proposed_setup = $2 where id = $1", [
      row.id,
      JSON.stringify({ setup: { commands: [{ name: "bootstrap", run: "make bootstrap", timeoutSec: 900 }] }, reasons: ["Makefile"] }),
    ]);
    await markSnapshotReady(pool, row.id, { providerSnapshotId: "snap_private_id", sizeBytes: 99, detail: "built", ttlDays: 14 });

    const listed = await call("GET", `/v1/repositories/${REPO_ID}/environment`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.current.id, row.id);
    assert.equal(listed.body.current.baseSha, "b".repeat(40));
    assert.equal(listed.body.current.sizeBytes, 99);
    assert.equal(listed.body.proposedSetup.setup.commands[0].run, "make bootstrap");
    assert.ok(!JSON.stringify(listed.body).includes("snap_private_id"), "the provider's id stays on the stage side");

    const missing = await call("GET", "/v1/repositories/22222222-2222-2222-2222-222222222222/environment");
    assert.equal(missing.status, 404);
  });
});

test("rebuild records an intent (202) or starts the build on the stage side; invalidate is the row change (200)", { skip }, async () => {
  await withApi(async ({ pool, org, call }) => {
    const rebuild = await call("POST", `/v1/repositories/${REPO_ID}/environment/rebuild`);
    assert.equal(rebuild.status, 202);
    assert.equal(rebuild.body.started, false);
    const pending = await pendingSnapshotRequest(pool, org, REPO_ID);
    assert.match(pending.reason, /rebuild requested by operator/);

    const row = await claimSnapshotBuild(pool, {
      organizationId: org, repositoryId: REPO_ID, sandboxProvider: "fake", cacheKey: "k", keyPaths: [], baseSha: "a".repeat(40), builtBy: "system",
    });
    await markSnapshotReady(pool, row.id, { providerSnapshotId: "fakesnap-1", detail: "", ttlDays: 14 });
    const invalidated = await call("POST", `/v1/repositories/${REPO_ID}/environment/invalidate`);
    assert.equal(invalidated.status, 200);
    assert.equal(invalidated.body.invalidated, 1);
    const { rows } = await pool.query("select status, detail from environment_snapshot where id = $1", [row.id]);
    assert.equal(rows[0].status, "invalidated");
    assert.match(rows[0].detail, /invalidated by operator/);
  });

  const started = [];
  await withApi(
    async ({ pool, org, call }) => {
      const rebuild = await call("POST", `/v1/repositories/${REPO_ID}/environment/rebuild`);
      assert.equal(rebuild.status, 202);
      assert.equal(rebuild.body.started, true);
      assert.deepEqual(started, [[org, REPO_ID]], "two ids go to the stage side, nothing else");
      assert.equal(await pendingSnapshotRequest(pool, org, REPO_ID), null);
    },
    { environmentBuilds: { request: async (o, r) => void started.push([o, r]) } },
  );
});

test("all three need secrets.manage, which a default token lacks", { skip }, async () => {
  await withApi(async ({ call }) => {
    const executor = (await call("POST", "/v1/tokens", { body: { name: "t", preset: "execute" } })).body.secret;
    const as = { headers: { authorization: `Bearer ${executor}` } };
    for (const [method, path] of [
      ["GET", `/v1/repositories/${REPO_ID}/environment`],
      ["POST", `/v1/repositories/${REPO_ID}/environment/rebuild`],
      ["POST", `/v1/repositories/${REPO_ID}/environment/invalidate`],
    ]) {
      const refused = await call(method, path, as);
      assert.equal(refused.status, 403, `${method} ${path}`);
      assert.equal(refused.body.missing, "secrets.manage");
    }
  });
});
