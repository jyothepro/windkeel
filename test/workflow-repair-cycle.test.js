import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import {
  getEngineeringRun,
  listAgentRuns,
  listRepairAttempts,
  listVerificationRuns,
  listWorkspaces,
  insertEngineeringRun,
  insertEngineeringTask,
} from "../dist/factory/repositories.js";
import { runRetentionSweep } from "../dist/factory/evidence-retention.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { createImplementingHandler } from "../dist/factory/workflow/handlers/implementing.js";
import { createVerifyingHandler } from "../dist/factory/workflow/handlers/verifying.js";
import { createRepairingHandler } from "../dist/factory/workflow/handlers/repairing.js";
import { bareFixtureRepo, repoRoot, runCli, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * The full `VERIFYING → REPAIRING → VERIFYING` cycle: two candidates, two verifications, two
 * evidence packages, one repair attempt.
 *
 * **What is real here and what is scripted, stated up front.** The candidates are real commits
 * pushed to a real bare repository, the verifier sandboxes are real clones at those SHAs, and
 * both evidence packages are sealed by the real engine and re-verified offline through the real
 * CLI. What is scripted is the *reviewer*: the verdict flips from fail to pass because the
 * review script the engine reads is rewritten between cycles. A defect caught by the repository's
 * own tests, with no scripted verdict anywhere, is M5.6's (#146) — and it is a different claim, so
 * this suite does not make it.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let counter = 0;

const CRITERIA = [{ id: "ac-1", text: "the module keeps passing its own tests" }];
const CLEAN_REVIEW = { summary: "no defects found", findings: [] };
const DIRTY_REVIEW = {
  summary: "a blocking defect",
  findings: [
    {
      id: "REV-1",
      severity: "blocking",
      category: "correctness",
      claim: "the greeting is never printed",
      location: "index.js",
      failure_scenario: "a user runs the module and sees nothing",
    },
  ],
};

const mappingFor = (criteria) => ({
  mappings: criteria.map((c) => ({
    criterion: c.id,
    status: "satisfied",
    evidence: ["ev-01"],
    reason: "the repo's own checks pass on the candidate",
  })),
});

const TURN = (usage) => [
  { type: "started", sessionId: "sess-1" },
  { type: "file_changed", path: "index.js", kind: "update" },
  { type: "completed", usage },
];

/**
 * Writes real content into the maker sandbox on each turn, so the run branch really advances and
 * the second verification really has a different SHA to clone.
 */
class TwoTurnWorker {
  constructor(options = {}) {
    this.name = "fake-resumable";
    this.capabilities = { resumableSessions: true };
    this.turn = 1;
    this.sends = [];
    this.sandbox = null;
    this.repairWritesNothing = options.repairWritesNothing ?? false;
    this.onSend = options.onSend ?? null;
  }
  async start(input) {
    this.sandbox = input.sandbox;
    await input.sandbox.writeFile("index.js", "// broken\n");
    return { id: "session-1", workerSessionId: "sess-1" };
  }
  async send(_session, message) {
    this.sends.push(message);
    this.turn = 2;
    if (!this.repairWritesNothing) {
      await this.sandbox.writeFile("index.js", "console.log('hello');\n");
    }
    if (this.onSend) await this.onSend();
  }
  async cancel() {}
  async *events() {
    for (const event of TURN(
      this.turn === 1 ? { inputTokens: 100, outputTokens: 20 } : { inputTokens: 10, outputTokens: 5 },
    )) {
      yield event;
    }
  }
  async result() {
    return {
      outcome: "completed",
      diff: {
        patch: this.turn === 1 ? "+// broken\n" : "+console.log('hello');\n",
        filesChanged: ["index.js"],
        truncated: false,
      },
      usage: this.turn === 1 ? { inputTokens: 100, outputTokens: 20 } : { inputTokens: 10, outputTokens: 5 },
    };
  }
}

class MemoryEvidenceStorage {
  constructor() {
    this.packages = new Map();
  }
  async putPackage(localDir, bucket, key) {
    const dest = tempDir("stored");
    cpSync(localDir, dest, { recursive: true });
    const ref = `${bucket}/${key}`;
    this.packages.set(ref, dest);
    return ref;
  }
  async deletePackage(bucket, key) {
    this.packages.delete(`${bucket}/${key}`);
  }
}

async function withCycle(fn, options = {}) {
  const schema = `windkeel_cycle_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "true" });
  const sandboxes = new FakeSandboxProvider();
  const registry = new SandboxRegistry();
  const sessions = new WorkerSessionRegistry();
  const storage = new MemoryEvidenceStorage();

  // The review script is rewritten between cycles — see the file header.
  const reviewPath = join(tempDir("review"), "review.json");
  writeFileSync(reviewPath, JSON.stringify(DIRTY_REVIEW));
  const mappingPath = join(tempDir("mapping"), "mapping.json");
  writeFileSync(mappingPath, JSON.stringify(mappingFor(CRITERIA)));

  const worker =
    options.worker ??
    new TwoTurnWorker({
      ...(options.repairWritesNothing ? { repairWritesNothing: true } : {}),
      onSend: async () => {
        if (!options.stayDirty) writeFileSync(reviewPath, JSON.stringify(CLEAN_REVIEW));
      },
    });

  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "local",
      sourceReference: "m5.3",
      title: "Add a greeting",
      description: "Make index.js print hello.",
      acceptanceCriteria: CRITERIA,
      riskLevel: options.riskLevel ?? "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: 10_000,
      wallClockCapSeconds: 7200,
    });
    for (const to of ["CLASSIFYING", "PLANNING", "PROVISIONING"]) {
      await advanceRun(pool, run.id, to, "test seed");
    }

    const deps = {
      pool,
      sandboxes,
      worker,
      registry,
      sessions,
      evidence: { storage, bucket: "evidence" },
      config: {
        repository: { url: remote.bare, baseRevision: "HEAD" },
        makerModel: "gpt-5-codex",
        makerVendor: "openai",
        modelApiDomain: "api.openai.com",
        modelKeyEnvVar: "OPENAI_API_KEY",
        modelPricing: { usdPerInputToken: 0, usdPerOutputToken: 0 },
        usdPerCpuMs: 0,
        usdPerEgressByte: 0,
        railsCheckIntervalMs: 60_000,
        workspaceTtlMs: 60_000,
        gitHost: "github.com",
        gitAuthorName: "Windkeel Factory",
        gitAuthorEmail: "factory@windkeel.invalid",
        policyVersion: "test",
        fakeSecurity: join(repoRoot, "test", "fixtures", "no-scanners.json"),
        checkerModels: {
          endpoints: [],
          maker: { vendor: "openai", model: "gpt-5-codex" },
          fakes: { review: reviewPath, mapping: mappingPath },
        },
      },
    };

    const provider = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool) });
    provider.register(createProvisioningHandler(deps));
    provider.register(createImplementingHandler(deps));
    provider.register(createVerifyingHandler(deps));
    provider.register(createRepairingHandler(deps));
    await provider.start();

    await fn({ pool, provider, deps, runId: run.id, registry, storage, remote, worker });
  } finally {
    for (const [, handle] of registry.entries()) await handle.destroy().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

const transitionsOf = async (pool, runId) => {
  const { rows } = await pool.query(
    "select from_state, to_state from run_state_transition where engineering_run_id = $1 order by at, id",
    [runId],
  );
  return rows.map((r) => `${r.from_state}->${r.to_state}`);
};

test("a two-cycle run: fail, repair, pass", { skip }, async () => {
  await withCycle(async ({ pool, provider, runId, storage, worker }) => {
    await provider.startRun(runId);
    await provider.drain();

    const seen = await transitionsOf(pool, runId);
    assert.ok(seen.includes("VERIFYING->REPAIRING"), seen.join(", "));
    assert.ok(seen.includes("REPAIRING->VERIFYING"), seen.join(", "));
    assert.equal(seen.at(-1), "VERIFYING->PR_CREATING");

    const verifications = await listVerificationRuns(pool, runId);
    assert.equal(verifications.length, 2, "one verification per cycle");
    assert.equal(verifications[0].verdict, "fail");
    assert.equal(verifications[1].verdict, "pass");
    assert.notEqual(
      verifications[0].candidateSha,
      verifications[1].candidateSha,
      "the second cycle verified the repairer's work, not the implementer's",
    );

    const attempts = await listRepairAttempts(pool, runId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].attemptNumber, 1);
    assert.equal(attempts[0].verificationRunId, verifications[0].id, "triggered by the failure");
    assert.equal(attempts[0].result.candidateSha, verifications[1].candidateSha);
    assert.equal(attempts[0].result.emptyChange, false);

    const run = await getEngineeringRun(pool, runId);
    assert.equal(run.finalVerdict, "pass", "the last cycle's verdict is the run's");
    assert.equal(run.stopReason, null);

    assert.equal(worker.sends.length, 1, "one repair turn, on the resumed session");
    // Two sealed evidence packages, plus one stored candidate patch per turn.
    assert.equal(storage.packages.size, 4);
  });
});

test("each cycle's candidate is a fast-forward of the last, on the run's own branch", { skip }, async () => {
  await withCycle(async ({ pool, provider, runId, remote }) => {
    await provider.startRun(runId);
    await provider.drain();

    const [first, second] = await listVerificationRuns(pool, runId);
    const branch = `windkeel/run/${runId}`;

    const head = spawnSync("git", ["-C", remote.bare, "rev-parse", branch], { encoding: "utf8" });
    assert.equal(head.stdout.trim(), second.candidateSha, "the branch is at the latest candidate");

    const ancestor = spawnSync(
      "git",
      ["-C", remote.bare, "merge-base", "--is-ancestor", first.candidateSha, second.candidateSha],
      { encoding: "utf8" },
    );
    assert.equal(ancestor.status, 0, "the repair commit is a fast-forward, never a force-push");
  });
});

test("the second verifier is a distinct sandbox from the first and from the maker", { skip }, async () => {
  await withCycle(async ({ pool, provider, runId }) => {
    await provider.startRun(runId);
    await provider.drain();

    const workspaces = await listWorkspaces(pool, runId);
    const verifiers = workspaces.filter((w) => w.role === "verifier");
    const makers = workspaces.filter((w) => w.role === "maker");
    assert.equal(verifiers.length, 2, "ADR-0004: a fresh sandbox per verification, not per run");
    assert.equal(makers.length, 1, "and one maker, held across the loop (ADR-0017)");

    const handles = new Set(workspaces.map((w) => w.providerHandle));
    assert.equal(handles.size, 3, "three distinct sandboxes");

    // Matched by SHA rather than by position: `listWorkspaces` orders by uuid, so which
    // verifier row comes first is arbitrary. Asserting `verifiers[1]` passed or failed
    // depending on how the ids sorted.
    const verified = new Set(verifiers.map((w) => w.baseSha));
    const candidates = new Set(
      (await listVerificationRuns(pool, runId)).map((v) => v.candidateSha),
    );
    assert.deepEqual(verified, candidates, "one verifier per candidate, each cloned at its own");
    for (const workspace of workspaces) {
      assert.equal(workspace.status, "destroyed", `${workspace.role} torn down at the end`);
    }
  });
});

test("both packages verify offline; the final one is the verdict of record", { skip }, async () => {
  await withCycle(async ({ pool, provider, runId, storage }) => {
    await provider.startRun(runId);
    await provider.drain();

    const verifications = await listVerificationRuns(pool, runId);
    for (const verification of verifications) {
      const dir = storage.packages.get(verification.evidencePackageRef);
      assert.ok(dir, `verification ${verification.id} has a stored package`);
      const result = runCli(["verify-package", dir]);
      assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
      assert.match(result.stdout, new RegExp(`verdict: ${verification.verdict}`, "i"));
      assert.match(verification.evidenceManifestDigest, /^[0-9a-f]{64}$/);
    }
  });
});

test("the earlier package is superseded and prunable; the final one never is", { skip }, async () => {
  await withCycle(async ({ pool, provider, runId, storage }) => {
    await provider.startRun(runId);
    await provider.drain();

    const [first, second] = await listVerificationRuns(pool, runId);

    // ADR-0015's 90-day tier had never been exercised against real data, because no run had ever
    // produced a superseded package. This one has.
    const sweep = await runRetentionSweep(pool, storage, new Date(Date.now() + 100 * 86_400_000));
    assert.deepEqual(sweep.prunedIds, [first.id], "only the superseded cycle is pruned");

    const after = await listVerificationRuns(pool, runId);
    const prunedRow = after.find((v) => v.id === first.id);
    assert.equal(prunedRow.evidencePackageRef, null);
    assert.ok(prunedRow.evidencePrunedAt, "a tombstone, not a silent 404");
    assert.equal(
      prunedRow.evidenceManifestDigest,
      first.evidenceManifestDigest,
      "the seal-time digest outlives the bytes",
    );

    const finalRow = after.find((v) => v.id === second.id);
    assert.equal(finalRow.evidencePackageRef, second.evidencePackageRef);
    assert.ok(storage.packages.has(finalRow.evidencePackageRef), "the verdict of record is kept");
  });
});

test("a repair turn that changes nothing terminates the run instead of looping", { skip }, async () => {
  await withCycle(
    async ({ pool, provider, runId, storage }) => {
      const before = storage.packages.size;
      await provider.startRun(runId);
      await provider.drain();

      const run = await getEngineeringRun(pool, runId);
      assert.equal(run.status, "MAX_REPAIR_ATTEMPTS_REACHED");
      assert.equal(run.stopReason, "stuck");

      const verifications = await listVerificationRuns(pool, runId);
      assert.equal(verifications.length, 1, "no second verification for an unchanged SHA");
      assert.equal(verifications[0].verdict, "fail");

      const [attempt] = await listRepairAttempts(pool, runId);
      assert.equal(attempt.result.emptyChange, true);
      assert.equal(attempt.result.candidateSha, verifications[0].candidateSha);

      assert.ok(
        storage.packages.size <= before + 2,
        "one evidence package and one candidate patch, not a package per spin",
      );

      const workspaces = await listWorkspaces(pool, runId);
      for (const workspace of workspaces) assert.equal(workspace.status, "destroyed");
    },
    { repairWritesNothing: true, stayDirty: true },
  );
});

test("a redelivered VERIFYING in cycle two adds no package, row, or charge", { skip }, async () => {
  await withCycle(async ({ pool, provider, runId, storage }) => {
    await provider.startRun(runId);
    await provider.drain();

    const packagesBefore = storage.packages.size;
    const costBefore = (await getEngineeringRun(pool, runId)).cost;

    // At-least-once delivery of the cycle-two VERIFYING job: the run is walked back and
    // re-delivered, exactly as pg-boss would after a lost ack.
    await pool.query("update engineering_run set status = 'VERIFYING' where id = $1", [runId]);
    await provider.startRun(runId);
    await provider.drain();

    assert.equal((await listVerificationRuns(pool, runId)).length, 2);
    assert.equal(storage.packages.size, packagesBefore);
    assert.equal((await getEngineeringRun(pool, runId)).cost, costBefore);
    assert.equal((await listRepairAttempts(pool, runId)).length, 1);
    assert.equal(
      (await listAgentRuns(pool, runId)).filter((r) => r.role === "repairer").length,
      1,
    );
  });
});

test("attempt numbering and candidate SHAs line up across the two tables", { skip }, async () => {
  await withCycle(async ({ pool, provider, runId }) => {
    await provider.startRun(runId);
    await provider.drain();

    const verifications = await listVerificationRuns(pool, runId);
    const attempts = await listRepairAttempts(pool, runId);
    const agentRuns = await listAgentRuns(pool, runId);

    // Attempt n was triggered by verification n and produced the candidate verification n+1
    // judged. That chain is the whole history a reviewer needs, and it has to hold by row.
    for (const attempt of attempts) {
      const trigger = verifications[attempt.attemptNumber - 1];
      assert.equal(attempt.verificationRunId, trigger.id);
      const next = verifications[attempt.attemptNumber];
      if (next) assert.equal(attempt.result.candidateSha, next.candidateSha);
      const repairer = agentRuns.find((r) => r.id === attempt.agentRunId);
      assert.equal(repairer.role, "repairer");
    }
  });
});
