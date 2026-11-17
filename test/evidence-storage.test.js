import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { evidenceManifestDigest, evidenceObjectKey, sealEvidenceReference } from "../dist/factory/evidence-storage.js";
import { getVerificationRun, insertEngineeringRun, insertEngineeringTask, insertVerificationRun } from "../dist/factory/repositories.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

test("evidenceManifestDigest is sha256 of hashes.json, matching the DSSE statement's binding", () => {
  const dir = mkdtempSync(join(tmpdir(), "windkeel-evidence-"));
  const hashesContent = JSON.stringify({ algorithm: "sha256", files: { "manifest.json": "abc123" } }, null, 2) + "\n";
  writeFileSync(join(dir, "hashes.json"), hashesContent);

  const expected = createHash("sha256").update(hashesContent).digest("hex");
  assert.equal(evidenceManifestDigest(dir), expected);
});

test("evidenceObjectKey is a stable, unique-per-verification prefix", () => {
  const key = evidenceObjectKey("run-1", "verification-1");
  assert.equal(key, "run-1/verification-1");
  assert.notEqual(evidenceObjectKey("run-1", "verification-2"), key);
});

class FakeEvidenceStorage {
  constructor() {
    this.puts = [];
  }
  async putPackage(localDir, bucket, key) {
    this.puts.push({ localDir, bucket, key });
  }
  async deletePackage(bucket, key) {
    this.puts = this.puts.filter((p) => !(p.bucket === bucket && p.key === key));
  }
}

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

async function withVerificationRun(fn) {
  const schema = `windkeel_evidence_storage_test_${Date.now()}`;
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
    const verificationRun = await insertVerificationRun(pool, {
      engineeringRunId: run.id,
      candidateSha: "deadbeef",
      policyVersion: "v1",
    });
    await fn(pool, run, verificationRun);
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

test(
  "sealEvidenceReference uploads the package and records bucket+key and digest on the VerificationRun",
  { skip },
  async () => {
    await withVerificationRun(async (pool, run, verificationRun) => {
      const dir = mkdtempSync(join(tmpdir(), "windkeel-evidence-"));
      const hashesContent = JSON.stringify({ algorithm: "sha256", files: {} }, null, 2) + "\n";
      writeFileSync(join(dir, "hashes.json"), hashesContent);
      writeFileSync(join(dir, "manifest.json"), "{}\n");

      const storage = new FakeEvidenceStorage();
      const updated = await sealEvidenceReference(pool, storage, verificationRun.id, run.id, dir, "evidence-bucket");

      assert.equal(updated.evidencePackageRef, `evidence-bucket/${run.id}/${verificationRun.id}`);
      assert.equal(updated.evidenceManifestDigest, createHash("sha256").update(hashesContent).digest("hex"));

      assert.deepEqual(storage.puts, [{ localDir: dir, bucket: "evidence-bucket", key: `${run.id}/${verificationRun.id}` }]);

      const refetched = await getVerificationRun(pool, verificationRun.id);
      assert.equal(refetched.evidencePackageRef, updated.evidencePackageRef);
      assert.equal(refetched.evidenceManifestDigest, updated.evidenceManifestDigest);
    });
  },
);
