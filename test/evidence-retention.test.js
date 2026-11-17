import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { pruneVerificationRun, runRetentionSweep } from "../dist/factory/evidence-retention.js";
import {
  getVerificationRun,
  insertEngineeringRun,
  insertEngineeringTask,
  insertVerificationRun,
  updateVerificationRun,
} from "../dist/factory/repositories.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

class FakeEvidenceStorage {
  constructor() {
    this.deletes = [];
  }
  async putPackage() {}
  async deletePackage(bucket, key) {
    this.deletes.push({ bucket, key });
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-26T00:00:00Z");

async function withRun(fn) {
  const schema = `windkeel_evidence_retention_test_${Date.now()}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "github_issue",
      sourceReference: "1",
      title: "t",
      description: "d",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    await fn(pool, run);
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

/** A "sealed" verification: completed at `completedAt`, holding a package + digest. */
async function sealedVerification(pool, engineeringRunId, completedAt) {
  const vr = await insertVerificationRun(pool, {
    engineeringRunId,
    candidateSha: "sha",
    policyVersion: "v1",
  });
  return updateVerificationRun(pool, vr.id, {
    completedAt,
    evidencePackageRef: `bucket/${engineeringRunId}/${vr.id}`,
    evidenceManifestDigest: `sha256:${vr.id}`,
  });
}

test(
  "the ADR-0015 required fixture: a single verification run is never pruned, however old",
  { skip },
  async () => {
    await withRun(async (pool, run) => {
      const only = await sealedVerification(pool, run.id, new Date(NOW.getTime() - 400 * DAY_MS));

      const storage = new FakeEvidenceStorage();
      const result = await runRetentionSweep(pool, storage, NOW);

      assert.deepEqual(result.prunedIds, []);
      assert.deepEqual(storage.deletes, []);
      const refetched = await getVerificationRun(pool, only.id);
      assert.equal(refetched.evidencePackageRef, only.evidencePackageRef, "the verdict of record survives untouched");
      assert.equal(refetched.evidencePrunedAt, null);
    });
  },
);

test(
  "a superseded verification past the retention window is pruned; the current one is not",
  { skip },
  async () => {
    await withRun(async (pool, run) => {
      const superseded = await sealedVerification(pool, run.id, new Date(NOW.getTime() - 100 * DAY_MS));
      const current = await sealedVerification(pool, run.id, new Date(NOW.getTime() - 1 * DAY_MS));

      const storage = new FakeEvidenceStorage();
      const result = await runRetentionSweep(pool, storage, NOW);

      assert.deepEqual(result.prunedIds, [superseded.id]);
      assert.deepEqual(storage.deletes, [{ bucket: "bucket", key: `${run.id}/${superseded.id}` }]);

      const prunedRow = await getVerificationRun(pool, superseded.id);
      assert.equal(prunedRow.evidencePackageRef, null);
      assert.ok(prunedRow.evidencePrunedAt);
      assert.equal(prunedRow.evidenceManifestDigest, superseded.evidenceManifestDigest, "the digest is kept forever");

      const currentRow = await getVerificationRun(pool, current.id);
      assert.equal(currentRow.evidencePackageRef, current.evidencePackageRef, "the newest verification is untouched");
    });
  },
);

test(
  "a superseded verification still inside the retention window is not pruned yet",
  { skip },
  async () => {
    await withRun(async (pool, run) => {
      const recent = await sealedVerification(pool, run.id, new Date(NOW.getTime() - 10 * DAY_MS));
      await sealedVerification(pool, run.id, new Date(NOW.getTime() - 1 * DAY_MS));

      const storage = new FakeEvidenceStorage();
      const result = await runRetentionSweep(pool, storage, NOW);

      assert.deepEqual(result.prunedIds, []);
      const refetched = await getVerificationRun(pool, recent.id);
      assert.equal(refetched.evidencePackageRef, recent.evidencePackageRef);
    });
  },
);

test("a sweep is idempotent: a second pass over already-pruned rows prunes nothing new", { skip }, async () => {
  await withRun(async (pool, run) => {
    const superseded = await sealedVerification(pool, run.id, new Date(NOW.getTime() - 100 * DAY_MS));
    await sealedVerification(pool, run.id, new Date(NOW.getTime() - 1 * DAY_MS));

    const storage = new FakeEvidenceStorage();
    await runRetentionSweep(pool, storage, NOW);
    const second = await runRetentionSweep(pool, storage, NOW);

    assert.deepEqual(second.prunedIds, []);
    assert.equal(storage.deletes.length, 1, "the object delete only happened once");
  });
});

test("pruneVerificationRun is a no-op for a run with no package", { skip }, async () => {
  await withRun(async (pool, run) => {
    const vr = await insertVerificationRun(pool, { engineeringRunId: run.id, candidateSha: "sha", policyVersion: "v1" });
    const storage = new FakeEvidenceStorage();
    const result = await pruneVerificationRun(pool, storage, vr, NOW);
    assert.deepEqual(result, vr);
    assert.deepEqual(storage.deletes, []);
  });
});
