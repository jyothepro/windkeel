/**
 * #387: the `environment_snapshot` table and its repository functions — the build lock, ready and
 * lookup, invalidation on a secret write, the expiry sweep, and the build-request queue.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import {
  claimSnapshotBuild,
  findReadySnapshot,
  invalidateSnapshots,
  listSnapshots,
  markSnapshotFailed,
  markSnapshotReady,
  pendingSnapshotRequest,
  requestSnapshotBuild,
} from "../dist/factory/environment-snapshots.js";
import { deleteRepositorySecret, putRepositorySecret } from "../dist/factory/repository-secrets.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { sweepEnvironmentSnapshots } from "../dist/factory/sweeps/environment-snapshots.js";
import { FIXTURE_REPOSITORY_ID, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
let counter = 0;

async function withSchema(fn) {
  const schema = `windkeel_env_snapshots_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, max: 4, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const { rows } = await pool.query("select id from organization where is_default");
    await fn(pool, rows[0].id);
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

const claim = (org, key, extra = {}) => ({
  organizationId: org,
  repositoryId: FIXTURE_REPOSITORY_ID,
  sandboxProvider: "fake",
  cacheKey: key,
  keyPaths: ["windkeel.config.json"],
  baseSha: "a".repeat(40),
  builtBy: "system",
  ...extra,
});

test("the claim is the build lock: two concurrent claims for one key leave one building row", { skip }, async () => {
  await withSchema(async (pool, org) => {
    const [a, b] = await Promise.all([claimSnapshotBuild(pool, claim(org, "k1")), claimSnapshotBuild(pool, claim(org, "k1"))]);
    assert.equal([a, b].filter(Boolean).length, 1, "exactly one claim wins");
    const { rows } = await pool.query("select status from environment_snapshot");
    assert.deepEqual(rows.map((r) => r.status), ["building"]);
    // A ready row holds the key too; a different key does not contend.
    await markSnapshotReady(pool, (a ?? b).id, { providerSnapshotId: "fakesnap-1", detail: "ok", ttlDays: 14 });
    assert.equal(await claimSnapshotBuild(pool, claim(org, "k1")), null);
    assert.ok(await claimSnapshotBuild(pool, claim(org, "k2")));
  });
});

test("markReady publishes, findReadySnapshot finds the newest usable one", { skip }, async () => {
  await withSchema(async (pool, org) => {
    assert.equal(await findReadySnapshot(pool, org, FIXTURE_REPOSITORY_ID, "fake"), null);
    const first = await claimSnapshotBuild(pool, claim(org, "k1"));
    const ready = await markSnapshotReady(pool, first.id, { providerSnapshotId: "fakesnap-1", sizeBytes: 123, detail: "built", ttlDays: 14 });
    assert.equal(ready.status, "ready");
    assert.equal(ready.sizeBytes, 123);
    assert.ok(ready.expiresAt > new Date(Date.now() + 13 * 86_400_000));
    const found = await findReadySnapshot(pool, org, FIXTURE_REPOSITORY_ID, "fake");
    assert.equal(found.id, first.id);
    assert.equal((await findReadySnapshot(pool, org, FIXTURE_REPOSITORY_ID, "fake", "k1")).id, first.id);
    assert.equal(await findReadySnapshot(pool, org, FIXTURE_REPOSITORY_ID, "fake", "other"), null);
    assert.equal(await findReadySnapshot(pool, org, FIXTURE_REPOSITORY_ID, "vercel"), null, "provider-scoped");
    // Another organization never sees it: it was built with this organization's secrets.
    const other = await pool.query(
      "insert into organization (account_id, name) select account_id, 'other' from organization where id = $1 returning id",
      [org],
    );
    assert.equal(await findReadySnapshot(pool, other.rows[0].id, FIXTURE_REPOSITORY_ID, "fake"), null);
    // Expired by time is not usable even before the sweep marks it.
    await pool.query("update environment_snapshot set expires_at = now() - interval '1 minute'");
    assert.equal(await findReadySnapshot(pool, org, FIXTURE_REPOSITORY_ID, "fake"), null);
  });
});

test("a failed build leaves no ready row, and a failed row cannot be published", { skip }, async () => {
  await withSchema(async (pool, org) => {
    const row = await claimSnapshotBuild(pool, claim(org, "k1"));
    await markSnapshotFailed(pool, row.id, "setup command bootstrap exited 2");
    assert.equal(await markSnapshotReady(pool, row.id, { providerSnapshotId: "x", detail: "", ttlDays: 1 }), null);
    assert.equal(await findReadySnapshot(pool, org, FIXTURE_REPOSITORY_ID, "fake"), null);
    const [listed] = await listSnapshots(pool, org, FIXTURE_REPOSITORY_ID);
    assert.equal(listed.status, "failed");
    assert.match(listed.detail, /bootstrap exited 2/);
    // The key is free again: a failed row is not a lock.
    assert.ok(await claimSnapshotBuild(pool, claim(org, "k1")));
  });
});

test("putting or deleting a repository secret invalidates that organization's ready snapshots", { skip }, async () => {
  await withSchema(async (pool, org) => {
    const { publicKey } = generateSecretKeyPair();
    const publish = async (key) => {
      const row = await claimSnapshotBuild(pool, claim(org, key));
      return markSnapshotReady(pool, row.id, { providerSnapshotId: `fakesnap-${key}`, detail: "", ttlDays: 14 });
    };
    await publish("k1");
    await putRepositorySecret(pool, { organizationId: org, repositoryId: FIXTURE_REPOSITORY_ID, key: "NPM_TOKEN", value: "npm_secret_value_1", setBy: "op", publicKey });
    let [row] = await listSnapshots(pool, org, FIXTURE_REPOSITORY_ID);
    assert.equal(row.status, "invalidated");
    assert.match(row.detail, /NPM_TOKEN was set/);
    assert.ok(!row.detail.includes("npm_secret_value_1"), "the value never reaches the detail");

    await publish("k2");
    assert.equal(await deleteRepositorySecret(pool, org, FIXTURE_REPOSITORY_ID, "NPM_TOKEN"), true);
    [row] = await listSnapshots(pool, org, FIXTURE_REPOSITORY_ID);
    assert.equal(row.status, "invalidated");
    assert.match(row.detail, /NPM_TOKEN was deleted/);
    // Deleting nothing invalidates nothing.
    await publish("k3");
    assert.equal(await deleteRepositorySecret(pool, org, FIXTURE_REPOSITORY_ID, "NOPE"), false);
    assert.ok(await findReadySnapshot(pool, org, FIXTURE_REPOSITORY_ID, "fake"));
    // Manual invalidation, as the API does it.
    assert.equal(await invalidateSnapshots(pool, FIXTURE_REPOSITORY_ID, "by hand", org), 1);
    assert.equal(await findReadySnapshot(pool, org, FIXTURE_REPOSITORY_ID, "fake"), null);
  });
});

test("the expiry sweep keeps the newest two, expires the rest and by TTL, and deletes provider snapshots", { skip }, async () => {
  await withSchema(async (pool, org) => {
    const ids = [];
    for (const key of ["k1", "k2", "k3", "k4"]) {
      const row = await claimSnapshotBuild(pool, claim(org, key));
      await markSnapshotReady(pool, row.id, { providerSnapshotId: `fakesnap-${key}`, detail: "", ttlDays: 14 });
      await pool.query("update environment_snapshot set ready_at = now() - ($2 || ' minutes')::interval where id = $1", [row.id, String(10 - ids.length)]);
      ids.push(row.id);
    }
    // An abandoned build, and a stale invalidated row whose provider snapshot still exists.
    const stuck = await claimSnapshotBuild(pool, claim(org, "k5"));
    await pool.query("update environment_snapshot set created_at = now() - interval '4 hours' where id = $1", [stuck.id]);

    const deleted = [];
    const providers = { fake: { deleteSnapshot: async (id) => void deleted.push(id) } };
    const result = await sweepEnvironmentSnapshots({ pool, providers });
    assert.deepEqual(result.abandoned, [stuck.id]);
    assert.deepEqual(result.expired.sort(), [ids[0], ids[1]].sort(), "the two oldest of four ready rows expire");
    assert.deepEqual(deleted.sort(), ["fakesnap-k1", "fakesnap-k2"]);
    const { rows } = await pool.query("select id, status, provider_snapshot_id from environment_snapshot order by created_at");
    assert.deepEqual(rows.filter((r) => r.status === "ready").map((r) => r.id).sort(), [ids[2], ids[3]].sort());
    assert.ok(rows.filter((r) => r.status === "expired").every((r) => r.provider_snapshot_id === null));

    // TTL: a ready row past expires_at goes even when it is one of the newest two.
    await pool.query("update environment_snapshot set expires_at = now() - interval '1 second' where id = $1", [ids[3]]);
    const again = await sweepEnvironmentSnapshots({ pool, providers });
    assert.deepEqual(again.expired, [ids[3]]);
  });
});

test("build requests queue once per repository, and the sweep dispatches them by id or puts them back", { skip }, async () => {
  await withSchema(async (pool, org) => {
    const request = { organizationId: org, repositoryId: FIXTURE_REPOSITORY_ID, requestedBy: "system", reason: "cold" };
    await requestSnapshotBuild(pool, request);
    await requestSnapshotBuild(pool, { ...request, reason: "cold again" });
    assert.equal((await pendingSnapshotRequest(pool, org, FIXTURE_REPOSITORY_ID)).reason, "cold again");
    const { rows } = await pool.query("select count(*)::int as n from environment_snapshot_request");
    assert.equal(rows[0].n, 1);

    // A start that fails puts the request back.
    const failing = await sweepEnvironmentSnapshots({ pool, providers: {}, startBuild: async () => { throw new Error("queue down"); } });
    assert.deepEqual(failing.dispatched, []);
    assert.ok(await pendingSnapshotRequest(pool, org, FIXTURE_REPOSITORY_ID));

    const started = [];
    const result = await sweepEnvironmentSnapshots({ pool, providers: {}, startBuild: async (o, r) => void started.push([o, r]) });
    assert.deepEqual(started, [[org, FIXTURE_REPOSITORY_ID]]);
    assert.equal(result.dispatched.length, 1);
    assert.equal(await pendingSnapshotRequest(pool, org, FIXTURE_REPOSITORY_ID), null);
    // Without a starter the queue is left alone.
    await requestSnapshotBuild(pool, request);
    await sweepEnvironmentSnapshots({ pool, providers: {} });
    assert.ok(await pendingSnapshotRequest(pool, org, FIXTURE_REPOSITORY_ID));
  });
});
