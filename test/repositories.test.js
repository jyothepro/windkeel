import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import {
  getEngineeringRun,
  getEngineeringRunForUpdate,
  getEngineeringTask,
  getLastTransitionInto,
  getVerificationRun,
  getWorkspace,
  insertAgentRun,
  insertEngineeringRun,
  insertEngineeringTask,
  insertRepairAttempt,
  insertRunStateTransition,
  insertVerificationRun,
  insertWorkspace,
  listRepairPackets,
  listVerificationRuns,
  updateEngineeringRun,
  updateVerificationRun,
} from "../dist/factory/repositories.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

/** One schema per test file run, migrated once, torn down at the end. */
async function withSchema(fn) {
  const schema = `windkeel_repositories_test_${Date.now()}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    await fn(pool);
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

function newTask(overrides = {}) {
  return {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "github_issue",
    sourceReference: "42",
    title: "Fix the widget",
    description: "The widget is broken.",
    acceptanceCriteria: [{ id: "c1", text: "widget works", source: { kind: "explicit", ref: "" } }],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
    ...overrides,
  };
}

test(
  "engineering_task round-trips through insert and get",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const inserted = await insertEngineeringTask(pool, newTask());
      const fetched = await getEngineeringTask(pool, inserted.id);
      assert.deepEqual(fetched, inserted);
      assert.equal(fetched.acceptanceCriteria[0].id, "c1");
    });
  },
);

test(
  "engineering_run starts CREATED, uncosted, and updateEngineeringRun patches only given fields",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const task = await insertEngineeringTask(pool, newTask());
      const run = await insertEngineeringRun(pool, {
        taskId: task.id,
        spendCapUsd: 25,
        wallClockCapSeconds: 7200,
      });
      assert.equal(run.status, "CREATED");
      assert.equal(run.cost, 0);
      assert.equal(run.stopReason, null);

      const patched = await updateEngineeringRun(pool, run.id, { status: "CLASSIFYING" });
      assert.equal(patched.status, "CLASSIFYING");
      assert.equal(patched.spendCapUsd, 25, "unrelated fields are untouched by a partial patch");

      const refetched = await getEngineeringRun(pool, run.id);
      assert.equal(refetched.status, "CLASSIFYING");
    });
  },
);

test(
  "getEngineeringRunForUpdate reads the row inside a transaction (row-lock read path)",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const task = await insertEngineeringTask(pool, newTask());
      const run = await insertEngineeringRun(pool, {
        taskId: task.id,
        spendCapUsd: null,
        wallClockCapSeconds: 7200,
      });
      const client = await pool.connect();
      try {
        await client.query("begin");
        const locked = await getEngineeringRunForUpdate(client, run.id);
        assert.equal(locked.id, run.id);
        assert.equal(locked.spendCapUsd, null, "an uncapped run round-trips null, not 0");
        await client.query("commit");
      } finally {
        client.release();
      }
    });
  },
);

test(
  "agent_run, verification_run, repair_attempt, and workspace round-trip and relate to their run",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const task = await insertEngineeringTask(pool, newTask());
      const run = await insertEngineeringRun(pool, {
        taskId: task.id,
        spendCapUsd: 25,
        wallClockCapSeconds: 7200,
      });

      const agentRun = await insertAgentRun(pool, {
        engineeringRunId: run.id,
        workerType: "codex",
        model: "gpt-5-codex",
        role: "implementer",
      });
      assert.equal(agentRun.engineeringRunId, run.id);

      const verificationRun = await insertVerificationRun(pool, {
        engineeringRunId: run.id,
        candidateSha: "deadbeef",
        policyVersion: "v1",
      });
      assert.equal(verificationRun.verdict, null);

      const packet = {
        failed_acceptance_criteria: [],
        failed_checks: [],
        security_findings: [],
        review_findings: [],
        browser_findings: [],
        evidence_links: [],
        recommended_focus: [],
        repair_constraints: [],
      };
      const repairAttempt = await insertRepairAttempt(pool, {
        engineeringRunId: run.id,
        verificationRunId: verificationRun.id,
        attemptNumber: 1,
        repairPacket: packet,
      });
      assert.equal(repairAttempt.agentRunId, null);
      assert.deepEqual(repairAttempt.repairPacket, packet);

      const workspace = await insertWorkspace(pool, {
        engineeringRunId: run.id,
        role: "maker",
        sandboxProvider: "vercel",
        repository: "acme/widgets",
        baseSha: "deadbeef",
        status: "provisioning",
      });
      assert.equal((await getWorkspace(pool, workspace.id)).role, "maker");

      assert.equal((await getVerificationRun(pool, verificationRun.id)).candidateSha, "deadbeef");
      assert.deepEqual(
        (await listVerificationRuns(pool, run.id)).map((v) => v.id),
        [verificationRun.id],
      );
      assert.deepEqual(await listRepairPackets(pool, run.id), [packet]);
    });
  },
);

test(
  "getLastTransitionInto recovers BLOCKED's return address from the append-only log",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const task = await insertEngineeringTask(pool, newTask());
      const run = await insertEngineeringRun(pool, {
        taskId: task.id,
        spendCapUsd: 25,
        wallClockCapSeconds: 7200,
      });

      await insertRunStateTransition(pool, {
        engineeringRunId: run.id,
        fromState: "CREATED",
        toState: "CLASSIFYING",
        reason: null,
      });
      await insertRunStateTransition(pool, {
        engineeringRunId: run.id,
        fromState: "CLASSIFYING",
        toState: "BLOCKED",
        reason: "external dependency",
      });

      const last = await getLastTransitionInto(pool, run.id, "BLOCKED");
      assert.equal(last.fromState, "CLASSIFYING");

      const none = await getLastTransitionInto(pool, run.id, "PR_READY");
      assert.equal(none, null);
    });
  },
);

test(
  "updateVerificationRun patches only given fields, including nulling evidence_package_ref",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const task = await insertEngineeringTask(pool, newTask());
      const run = await insertEngineeringRun(pool, {
        taskId: task.id,
        spendCapUsd: 25,
        wallClockCapSeconds: 7200,
      });
      const verificationRun = await insertVerificationRun(pool, {
        engineeringRunId: run.id,
        candidateSha: "deadbeef",
        policyVersion: "v1",
      });

      const sealed = await updateVerificationRun(pool, verificationRun.id, {
        evidencePackageRef: "bucket/key",
        evidenceManifestDigest: "sha256:abc",
        verdict: "pass",
      });
      assert.equal(sealed.evidencePackageRef, "bucket/key");
      assert.equal(sealed.verdict, "pass");

      // Pruning: null the ref, keep the digest, stamp evidence_pruned_at.
      const pruned = await updateVerificationRun(pool, verificationRun.id, {
        evidencePackageRef: null,
        evidencePrunedAt: new Date(),
      });
      assert.equal(pruned.evidencePackageRef, null);
      assert.equal(pruned.evidenceManifestDigest, "sha256:abc", "unrelated fields survive a partial patch");
      assert.ok(pruned.evidencePrunedAt);
    });
  },
);
