import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
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
import { REPAIR_ATTEMPT_CAPS, isStuck, packetFingerprint } from "../dist/factory/rails.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { createImplementingHandler } from "../dist/factory/workflow/handlers/implementing.js";
import { createVerifyingHandler } from "../dist/factory/workflow/handlers/verifying.js";
import { createRepairingHandler } from "../dist/factory/workflow/handlers/repairing.js";
import { bareFixtureRepo, repoRoot, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * ADR-0011's rails against a loop that actually loops.
 *
 * `rails.ts` and `rails-gate.ts` were written in M1, before there was a repair cycle to bound,
 * and every one of their behaviours was asserted against synthetic inputs — packets handed
 * straight to `checkRepairLoop`. That proves the function agrees with itself. What it cannot
 * prove is the claim ADR-0011 actually makes: that a low-risk run performs three repair attempts
 * and then stops. So the tier tests here count the repair turns a *real* loop took, driven
 * through the real handlers, and never call `checkRepairLoop` directly.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let counter = 0;

const CRITERIA = [{ id: "ac-1", text: "the module keeps passing its own tests" }];

const findingReview = (id) => ({
  summary: `blocking defect ${id}`,
  findings: [
    {
      id,
      severity: "blocking",
      category: "correctness",
      claim: `the greeting is wrong (${id})`,
      location: "index.js",
      failure_scenario: "a user runs the module and sees the wrong thing",
    },
  ],
});

const mappingFor = (criteria) => ({
  mappings: criteria.map((c) => ({
    criterion: c.id,
    status: "satisfied",
    evidence: ["ev-01"],
    reason: "the repo's own checks pass on the candidate",
  })),
});

const TURN = [
  { type: "started", sessionId: "sess-1" },
  { type: "file_changed", path: "index.js", kind: "update" },
  { type: "completed", usage: { inputTokens: 1, outputTokens: 1 } },
];

/**
 * A worker that keeps producing new candidates forever. Every turn writes different content, so
 * the branch really advances and every cycle has a genuinely new SHA to verify — which is what
 * makes "the loop stopped" a statement about the cap rather than about running out of work.
 */
class EndlessWorker {
  constructor(options = {}) {
    this.name = "fake-resumable";
    this.capabilities = { resumableSessions: true };
    this.turn = 0;
    this.sends = [];
    this.sandbox = null;
    this.onTurn = options.onTurn ?? null;
  }
  async start(input) {
    this.sandbox = input.sandbox;
    this.turn = 1;
    await input.sandbox.writeFile("index.js", `// attempt ${this.turn}\n`);
    if (this.onTurn) await this.onTurn(this.turn);
    return { id: "session-1", workerSessionId: "sess-1" };
  }
  async send(_session, message) {
    this.sends.push(message);
    this.turn += 1;
    await this.sandbox.writeFile("index.js", `// attempt ${this.turn}\n`);
    if (this.onTurn) await this.onTurn(this.turn);
  }
  async cancel() {}
  async *events() {
    for (const event of TURN) yield event;
  }
  async result() {
    return {
      outcome: "completed",
      diff: {
        patch: `+// attempt ${this.turn}\n`,
        filesChanged: ["index.js"],
        truncated: false,
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

async function withLoop(fn, options = {}) {
  const schema = `windkeel_rails_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "true" });
  const sandboxes = new FakeSandboxProvider();
  const registry = new SandboxRegistry();
  const sessions = new WorkerSessionRegistry();

  const reviewPath = join(tempDir("review"), "review.json");
  const mappingPath = join(tempDir("mapping"), "mapping.json");
  writeFileSync(mappingPath, JSON.stringify(mappingFor(CRITERIA)));

  /**
   * The failure set moves with each turn unless a test asks otherwise: distinct finding ids give
   * distinct fingerprints, so the stuck detector stays quiet and the *cap* is what stops the run.
   * A test that wants the stuck detector holds the id still instead.
   */
  const writeReview = (turn) =>
    writeFileSync(
      reviewPath,
      JSON.stringify(findingReview(options.stuck ? "REV-SAME" : `REV-${turn}`)),
    );
  writeReview(1);

  const worker = new EndlessWorker({ onTurn: async (turn) => writeReview(turn) });

  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "local",
      sourceReference: "m5.4",
      title: "Add a greeting",
      description: "Make index.js print hello.",
      acceptanceCriteria: CRITERIA,
      riskLevel: options.riskLevel ?? "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: options.spendCapUsd ?? 10_000,
      wallClockCapSeconds: options.wallClockCapSeconds ?? 7200,
    });
    for (const to of ["CLASSIFYING", "PLANNING", "PROVISIONING"]) {
      await advanceRun(pool, run.id, to, "test seed");
    }
    if (options.backdateStart) {
      await pool.query("update engineering_run set started_at = now() - interval '3 hours' where id = $1", [
        run.id,
      ]);
    }

    const deps = {
      pool,
      sandboxes,
      worker,
      registry,
      sessions,
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

    await fn({ pool, provider, runId: run.id, deps, worker, registry });
  } finally {
    for (const [, handle] of registry.entries()) await handle.destroy().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

/** Attempts that actually ran: a packet is stored for every failure, including the last one. */
const attemptsTaken = async (pool, runId) =>
  (await listRepairAttempts(pool, runId)).filter((a) => a.agentRunId !== null);

for (const riskLevel of ["low", "medium", "high"]) {
  const cap = REPAIR_ATTEMPT_CAPS[riskLevel];
  test(`${riskLevel} risk performs exactly ${cap} repair attempt${cap === 1 ? "" : "s"}, then stops`, { skip }, async () => {
    await withLoop(
      async ({ pool, provider, runId, worker }) => {
        await provider.startRun(runId);
        await provider.drain();

        const run = await getEngineeringRun(pool, runId);
        assert.equal(run.status, "MAX_REPAIR_ATTEMPTS_REACHED");
        assert.equal(run.stopReason, "repair_cap");
        assert.equal(run.finalVerdict, "fail");

        assert.equal(worker.sends.length, cap, `${cap} repair turns were taken`);
        assert.equal((await attemptsTaken(pool, runId)).length, cap);
        // One verification per candidate: the implementer's, plus one per repair attempt.
        assert.equal((await listVerificationRuns(pool, runId)).length, cap + 1);

        const repairers = (await listAgentRuns(pool, runId)).filter((r) => r.role === "repairer");
        assert.equal(repairers.length, cap);
      },
      { riskLevel },
    );
  });
}

test("a repairer that does not move the failure set is stopped early, as stuck", { skip }, async () => {
  await withLoop(
    async ({ pool, provider, runId, worker }) => {
      await provider.startRun(runId);
      await provider.drain();

      const run = await getEngineeringRun(pool, runId);
      assert.equal(run.status, "MAX_REPAIR_ATTEMPTS_REACHED");
      assert.equal(run.stopReason, "stuck");

      // ADR-0011 §3: two consecutive identical fingerprints. The low-risk cap is 3, so this
      // stopped strictly earlier than the numeric cap would have.
      assert.equal(worker.sends.length, 1, "one attempt, then the second identical packet stopped it");
      assert.ok(worker.sends.length < REPAIR_ATTEMPT_CAPS.low);
    },
    { riskLevel: "low", stuck: true },
  );
});

// Pure policy: no Postgres, so this one is not gated.
test("fingerprints ignore ordering and prose, and track the failure set", () => {
  const finding = (id) => ({ id, severity: "blocking", category: "correctness", claim: "x" });
  const base = {
    failed_acceptance_criteria: [{ id: "ac-1", text: "t", reason: "r" }],
    failed_checks: [{ check: "tests", command: "npm test", exit_code: 1, transcript: "run A" }],
    security_findings: [],
    review_findings: [finding("REV-1"), finding("REV-2")],
    browser_findings: [],
    evidence_links: [],
    recommended_focus: [],
    repair_constraints: [],
  };
  const shuffled = {
    ...base,
    // Same set, different order, and a transcript from a different run.
    review_findings: [finding("REV-2"), finding("REV-1")],
    failed_checks: [{ check: "tests", command: "npm test", exit_code: 1, transcript: "run B" }],
    recommended_focus: ["completely different prose"],
  };
  assert.equal(packetFingerprint(base), packetFingerprint(shuffled), "same work demanded");

  const moved = { ...base, failed_acceptance_criteria: [{ id: "ac-2", text: "t", reason: "r" }] };
  assert.notEqual(packetFingerprint(base), packetFingerprint(moved), "a different failure set");

  assert.equal(isStuck([base, shuffled]), true);
  assert.equal(isStuck([base, moved]), false);
});

test("a spend cap of $0 spawns nothing at all", { skip }, async () => {
  await withLoop(
    async ({ pool, provider, runId, worker }) => {
      await provider.startRun(runId);
      await provider.drain();

      const run = await getEngineeringRun(pool, runId);
      assert.equal(run.status, "FAILED");
      assert.equal(run.stopReason, "spend_cap");

      assert.equal((await listWorkspaces(pool, runId)).length, 0, "no sandbox was ever created");
      assert.equal((await listAgentRuns(pool, runId)).length, 0, "and no agent session");
      assert.equal(worker.sends.length, 0);
    },
    { spendCapUsd: 0 },
  );
});

test("an already-elapsed wall clock spawns nothing at all", { skip }, async () => {
  await withLoop(
    async ({ pool, provider, runId }) => {
      await provider.startRun(runId);
      await provider.drain();

      const run = await getEngineeringRun(pool, runId);
      assert.equal(run.status, "FAILED");
      assert.equal(run.stopReason, "wall_clock_cap");
      assert.equal((await listWorkspaces(pool, runId)).length, 0);
    },
    // Started three hours ago against a one-hour cap.
    { wallClockCapSeconds: 3600, backdateStart: true },
  );
});

test("a terminal state is sticky under redelivery", { skip }, async () => {
  await withLoop(
    async ({ pool, provider, runId, worker }) => {
      await provider.startRun(runId);
      await provider.drain();

      const stopped = await getEngineeringRun(pool, runId);
      assert.equal(stopped.status, "MAX_REPAIR_ATTEMPTS_REACHED");
      const before = {
        verifications: (await listVerificationRuns(pool, runId)).length,
        attempts: (await listRepairAttempts(pool, runId)).length,
        cost: stopped.cost,
        sends: worker.sends.length,
      };

      // At-least-once delivery against a run that is finished. Terminal means terminal: no
      // handler runs, nothing is spawned, and the stop reason does not change.
      await provider.startRun(runId);
      await provider.drain();

      const after = await getEngineeringRun(pool, runId);
      assert.equal(after.status, stopped.status);
      assert.equal(after.stopReason, stopped.stopReason);
      assert.equal((await listVerificationRuns(pool, runId)).length, before.verifications);
      assert.equal((await listRepairAttempts(pool, runId)).length, before.attempts);
      assert.equal(after.cost, before.cost);
      assert.equal(worker.sends.length, before.sends);
    },
    { riskLevel: "high" },
  );
});

test("every sandbox is destroyed when a rail stops the loop", { skip }, async () => {
  await withLoop(
    async ({ pool, provider, runId, registry }) => {
      await provider.startRun(runId);
      await provider.drain();

      const workspaces = await listWorkspaces(pool, runId);
      assert.ok(workspaces.length >= 2);
      for (const workspace of workspaces) {
        assert.equal(workspace.status, "destroyed", `${workspace.role}`);
      }
      assert.equal(registry.size, 0);
    },
    { riskLevel: "medium" },
  );
});
