import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import {
  getEngineeringRun,
  insertEngineeringRun,
  insertEngineeringTask,
  insertRepairAttempt,
  insertVerificationRun,
  listVerificationRuns,
  listWorkspaces,
} from "../dist/factory/repositories.js";
import { enforceSpendAndTimeRails } from "../dist/factory/rails-gate.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import {
  WorkerSessionRegistry,
  resolveRepairSession,
} from "../dist/factory/workflow/session-registry.js";
import { loadSessionBinding } from "../dist/factory/workflow/session-binding.js";
import { recordSessionBinding } from "../dist/factory/workflow/handlers/session-turn.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { createImplementingHandler } from "../dist/factory/workflow/handlers/implementing.js";
import { createVerifyingHandler } from "../dist/factory/workflow/handlers/verifying.js";
import { bareFixtureRepo, repoRoot, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * ADR-0017: **the maker survives a verification exactly when the repair loop still has budget,
 * and is destroyed on every other exit.**
 *
 * The teardown assertions here are deliberately made against the *sandbox timeline* — was
 * `destroy()` actually called on the handle, and is the handle still held — rather than against
 * a `workspace.status` column alone. A status column is what the code being tested writes; if a
 * teardown path were skipped entirely, the column would simply keep its old value and an
 * assertion on it could still be made to pass by writing the column in the wrong place.
 *
 * Postgres-gated, like every other suite that reads rows.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let counter = 0;

function scripted(name, value) {
  const path = join(tempDir(name), `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

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

function mappingFor(criteria, status = "satisfied") {
  return {
    mappings: criteria.map((c) => ({
      criterion: c.id,
      status,
      evidence: ["ev-01"],
      reason: "the repo's own checks pass on the candidate",
    })),
  };
}

const STREAM = [
  { type: "started", sessionId: "sess-1" },
  { type: "file_changed", path: "index.js", kind: "update" },
  { type: "test_finished", command: "npm test", exitCode: 0, passed: true },
  { type: "completed", usage: { inputTokens: 100, outputTokens: 20 } },
];

/**
 * Writes a real file into the maker sandbox so there is a genuine diff to capture, and reports
 * `resumableSessions: true` — this suite is about session *continuity*, and a fake that refuses
 * to be resumable cannot exercise the decision at all. What it still cannot do is take a second
 * turn; that is M5.6's scripted multi-turn fake.
 */
class MutatingWorkerAdapter {
  constructor(inner) {
    this.inner = inner;
    this.capabilities = { resumableSessions: true };
    this.onResult = null;
  }
  get name() {
    return this.inner.name;
  }
  get calls() {
    return this.inner.calls;
  }
  async start(input) {
    await input.sandbox.writeFile("index.js", "console.log('hello');\n");
    return this.inner.start(input);
  }
  send(s, m) {
    return this.inner.send(s, m);
  }
  cancel(s) {
    return this.inner.cancel(s);
  }
  events(s) {
    return this.inner.events(s);
  }
  async result(s) {
    if (this.onResult) await this.onResult();
    const result = await this.inner.result(s);
    if (result.outcome !== "completed") return result;
    return {
      ...result,
      diff: { patch: "+console.log('hello');\n", filesChanged: ["index.js"], truncated: false },
    };
  }
}

/**
 * Records every `destroy()` the run performs, in order, so "the maker was torn down" is a fact
 * about the sandbox rather than about a column.
 */
function watchDestroys(sandboxes) {
  const destroyed = [];
  const create = sandboxes.create.bind(sandboxes);
  sandboxes.create = async (options) => {
    const handle = await create(options);
    const destroy = handle.destroy.bind(handle);
    handle.destroy = async () => {
      destroyed.push({ id: handle.id, role: handle.role });
      return destroy();
    };
    return handle;
  };
  return destroyed;
}

async function withRun(fn, options = {}) {
  const schema = `windkeel_cont_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "true" });
  const sandboxes = new FakeSandboxProvider();
  const destroyed = watchDestroys(sandboxes);
  const registry = new SandboxRegistry();
  const sessions = new WorkerSessionRegistry();
  const worker = new MutatingWorkerAdapter(new FakeWorkerAdapter(STREAM));

  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "local",
      sourceReference: "m5.1",
      title: "Add a greeting",
      description: "Make index.js print hello.",
      acceptanceCriteria: CRITERIA,
      riskLevel: options.riskLevel ?? "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: options.spendCapUsd ?? 25,
      wallClockCapSeconds: options.wallClockCapSeconds ?? 7200,
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
      config: {
        repository: { url: remote.bare, baseRevision: "HEAD" },
        makerModel: "gpt-5-codex",
        makerVendor: "openai",
        modelApiDomain: "api.openai.com",
        modelKeyEnvVar: "OPENAI_API_KEY",
        modelPricing: { usdPerInputToken: 0, usdPerOutputToken: 0 },
        usdPerCpuMs: options.usdPerCpuMs ?? 0,
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
          fakes: {
            review: scripted("review", options.review ?? CLEAN_REVIEW),
            mapping: scripted("mapping", options.mapping ?? mappingFor(CRITERIA)),
          },
        },
      },
    };

    const provider = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool) });
    provider.register(createProvisioningHandler(deps));
    provider.register(createImplementingHandler(deps));
    provider.register(createVerifyingHandler(deps));
    await provider.start();

    if (options.before) await options.before({ pool, runId: run.id, deps, sandboxes, worker });

    await fn({ pool, provider, deps, runId: run.id, sandboxes, registry, sessions, destroyed, worker });
  } finally {
    for (const [, handle] of registry.entries()) await handle.destroy().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

const roleOf = async (pool, runId, role) =>
  (await listWorkspaces(pool, runId)).find((w) => w.role === role);

test(
  "a fail verdict with budget leaves the maker alive and destroys only the verifier",
  { skip },
  async () => {
    await withRun(
      async ({ pool, provider, runId, registry, destroyed }) => {
        await provider.startRun(runId);
        await provider.drain();

        const maker = await roleOf(pool, runId, "maker");
        const verifier = await roleOf(pool, runId, "verifier");

        assert.deepEqual(
          destroyed.map((d) => d.role),
          ["verifier"],
          "exactly one destroy(), and it was the verifier's",
        );
        assert.equal(maker.status, "ready");
        assert.ok(registry.get(maker.id), "the maker handle is still held for the repair turn");
        assert.equal(verifier.status, "destroyed");
        assert.equal(registry.get(verifier.id), undefined);

        const [verification] = await listVerificationRuns(pool, runId);
        assert.equal(verification.verdict, "fail");
      },
      { review: DIRTY_REVIEW },
    );
  },
);

test(
  "the verifier is a distinct sandbox from the maker, including on the kept-alive path",
  { skip },
  async () => {
    for (const review of [CLEAN_REVIEW, DIRTY_REVIEW]) {
      await withRun(
        async ({ pool, provider, runId }) => {
          await provider.startRun(runId);
          await provider.drain();
          const maker = await roleOf(pool, runId, "maker");
          const verifier = await roleOf(pool, runId, "verifier");
          assert.ok(verifier, "ADR-0004: a verification always provisions its own sandbox");
          assert.notEqual(verifier.providerHandle, maker.providerHandle);
        },
        { review },
      );
    }
  },
);

/**
 * The exhaustiveness table. The point is not any single row — it is that there is no way out of
 * a run that leaves a sandbox running, and that adding a new way out means adding a row here.
 *
 * Some rows stop the run before VERIFYING is reached (a spend cap of $0 refuses the very first
 * spawn, by design — ADR-0011 §4). That is not a weaker assertion: the claim under test is "no
 * sandbox outlives its run on any path", and where the path ends is exactly what varies.
 */
const TEARDOWN_CASES = [
  {
    name: "pass",
    options: { review: CLEAN_REVIEW },
  },
  {
    name: "warn",
    // A non-blocking finding with every criterion satisfied is what the engine calls a warn.
    options: {
      review: {
        summary: "a note, not a defect",
        findings: [
          {
            id: "REV-2",
            severity: "advisory",
            category: "style",
            claim: "the greeting could be clearer",
            location: "index.js",
            failure_scenario: "a reader is mildly confused",
          },
        ],
      },
    },
  },
  {
    name: "repair cap reached",
    options: {
      review: DIRTY_REVIEW,
      riskLevel: "high",
      // ADR-0011 §1: high risk allows 1 attempt, so one packet already on the record plus the
      // one this verification produces is over the cap.
      seedPackets: 1,
    },
  },
  {
    name: "stuck",
    options: {
      review: DIRTY_REVIEW,
      // The seeded packet has the same fingerprint as the one this run will produce, so two
      // consecutive identical packets stop the loop early (ADR-0011 §3).
      seedPackets: 1,
      seedFingerprintMatches: true,
    },
  },
  {
    name: "spend cap",
    options: { review: CLEAN_REVIEW, spendCapUsd: 0 },
  },
  {
    name: "wall-clock cap",
    options: { review: CLEAN_REVIEW, wallClockCapSeconds: 0 },
  },
  {
    name: "cancellation",
    options: { review: CLEAN_REVIEW, cancelMidSession: true },
  },
  {
    name: "exception",
    options: { review: CLEAN_REVIEW, verifierProvisionThrows: true },
  },
];

for (const testCase of TEARDOWN_CASES) {
  test(`no sandbox outlives the run: ${testCase.name}`, { skip }, async () => {
    const { seedPackets, seedFingerprintMatches, cancelMidSession, verifierProvisionThrows, ...rest } =
      testCase.options;

    await withRun(
      async ({ pool, provider, runId, registry, destroyed, worker }) => {
        if (cancelMidSession) {
          worker.onResult = async () => {
            await provider.cancel(runId, "operator asked");
          };
        }
        await provider.startRun(runId);
        await provider.drain();

        const workspaces = await listWorkspaces(pool, runId);
        for (const workspace of workspaces) {
          assert.ok(
            ["destroyed", "teardown_failed", "failed", "orphaned"].includes(workspace.status),
            `${workspace.role} left as ${workspace.status}`,
          );
          assert.equal(
            registry.get(workspace.id),
            undefined,
            `${workspace.role}'s handle is still held`,
          );
        }
        // And the sandboxes that really existed really had destroy() called.
        const created = workspaces.filter((w) => w.providerHandle !== null);
        assert.equal(
          destroyed.length,
          created.length,
          `${created.length} sandbox(es) created, ${destroyed.length} destroyed`,
        );
      },
      {
        ...rest,
        before: async ({ pool, runId, sandboxes }) => {
          if (verifierProvisionThrows) {
            const create = sandboxes.create.bind(sandboxes);
            sandboxes.create = async (options) => {
              if (options.role === "verifier") throw new Error("simulated provider failure");
              return create(options);
            };
          }
          for (let i = 0; i < (seedPackets ?? 0); i++) {
            const seeded = await insertVerificationRun(pool, {
              engineeringRunId: runId,
              candidateSha: `${"0".repeat(39)}${i + 1}`,
              policyVersion: "windkeel-engine@test",
            });
            await insertRepairAttempt(pool, {
              engineeringRunId: runId,
              verificationRunId: seeded.id,
              attemptNumber: i + 1,
              repairPacket: {
                failed_acceptance_criteria: [],
                failed_checks: [],
                security_findings: [],
                review_findings: seedFingerprintMatches
                  ? [{ id: "REV-1", severity: "blocking", category: "correctness", claim: "x" }]
                  : [{ id: `SEED-${i}`, severity: "blocking", category: "correctness", claim: "x" }],
                browser_findings: [],
                evidence_links: [],
                recommended_focus: [],
                repair_constraints: [],
              },
            });
          }
        },
      },
    );
  });
}

test(
  "the worker session survives the delivery boundary, and is released when the loop ends",
  { skip },
  async () => {
    await withRun(
      async ({ pool, provider, runId, sessions, worker }) => {
        await provider.startRun(runId);
        await provider.drain();

        const held = sessions.get(runId);
        assert.ok(held, "IMPLEMENTING's session is still addressable after VERIFYING");
        assert.equal(held.workerType, worker.name);
        assert.equal(held.resumable, true);

        const resolved = await resolveRepairSession({ pool, worker, sessions }, runId, undefined);
        assert.equal(resolved.reason, undefined);
        assert.equal(resolved.held.session.id, held.session.id);

        // #210: the durable half. `FakeWorkerAdapter` reports reattachableSessions: false, so
        // there is honestly nothing to persist — a binding here would be a promise the adapter
        // cannot keep. The reattachable case is covered below.
        assert.equal(await loadSessionBinding(pool, runId), null);
      },
      { review: DIRTY_REVIEW },
    );

    await withRun(async ({ provider, runId, sessions }) => {
      await provider.startRun(runId);
      await provider.drain();
      assert.equal(sessions.get(runId), undefined, "a passing run releases its session");
    });
  },
);

/**
 * #210 changed what a restart means, and this pair of tests is where that shows.
 *
 * It used to be one test: a fresh registry always produced `session_unreachable`, because
 * `WorkerAdapter` had no `attach()` and a session was only ever an object in one process. That
 * was honest then. Under ADR-0020's topology a REPAIRING delivery *routinely* lands in a process
 * that never held the session, so "always refuse" would mean "the repair loop never runs".
 *
 * So the refusal is now conditional on the adapter telling the truth about itself, and both
 * halves are asserted: an adapter that cannot reattach is still refused by name, and one that
 * can is resumed rather than cold-started. What neither case does is start a fresh session and
 * call it a resume — that remains the thing ADR-0017 §3 forbids.
 */
test("a restart still refuses by name when the adapter cannot reattach", { skip }, async () => {
  await withRun(
    async ({ pool, provider, runId, worker }) => {
      await provider.startRun(runId);
      await provider.drain();

      // A fresh registry is exactly what a restarted process has: the row is still in Postgres,
      // the session handle is not here.
      const afterRestart = new WorkerSessionRegistry();
      const maker = await roleOf(pool, runId, "maker");
      const resolved = await resolveRepairSession(
        { pool, worker, sessions: afterRestart },
        runId,
        { id: maker.providerHandle, role: "maker" },
      );

      assert.equal(resolved.reason, "session_unreachable");
      assert.equal(resolved.held, undefined);
      assert.equal(resolved.outcome.to, "FAILED");
      assert.equal(resolved.outcome.stopReason, "error");
      assert.match(resolved.outcome.reason, /cannot be resumed/);
      assert.match(resolved.outcome.reason, /no durable session reference/);
    },
    { review: DIRTY_REVIEW },
  );
});

test("a restart re-acquires the session when the adapter can reattach", { skip }, async () => {
  await withRun(
    async ({ pool, provider, runId, deps, sessions }) => {
      await provider.startRun(runId);
      await provider.drain();

      const held = sessions.get(runId);
      assert.ok(held, "the maker's session is held before the restart");

      /**
       * The same adapter, told the truth about itself: its session state is a serialisable id,
       * so it genuinely *can* be handed to another process. `FakeWorkerAdapter` declares
       * `reattachableSessions: false` because its sessions are objects in one process, and that
       * declaration is correct — so this test brings its own rather than making the fake lie.
       */
      const reattachable = {
        ...deps.worker,
        name: deps.worker.name,
        capabilities: {
          resumableSessions: true,
          reattachableSessions: true,
          reattachedSessionsAcceptNewTurns: true,
        },
        reference: (session) => ({
          id: session.id,
          workerType: deps.worker.name,
          adapterState: {},
        }),
        attach: async (ref) => ({ id: ref.id }),
      };

      // What #197's poll does on every pass, and what IMPLEMENTING does at start().
      await recordSessionBinding(
        { ...deps, worker: reattachable },
        runId,
        held.session,
      );
      const binding = await loadSessionBinding(pool, runId);
      assert.ok(binding, "the reference outlives the turn (#210)");
      assert.equal(binding.workerType, deps.worker.name);

      const afterRestart = new WorkerSessionRegistry();
      const maker = await roleOf(pool, runId, "maker");
      const resolved = await resolveRepairSession(
        { pool, worker: reattachable, sessions: afterRestart },
        runId,
        { id: maker.providerHandle, role: "maker" },
      );

      assert.equal(resolved.reason, undefined, "the session is resumed, not refused");
      assert.equal(resolved.held.session.id, held.session.id, "the *same* session (ADR-0011 §2)");
      assert.equal(
        afterRestart.get(runId)?.session.id,
        held.session.id,
        "and it is cached for the rest of this process",
      );
    },
    { review: DIRTY_REVIEW },
  );
});

test("a released session releases its durable reference too", { skip }, async () => {
  await withRun(async ({ pool, provider, runId, deps, sessions }) => {
    await provider.startRun(runId);
    await provider.drain();
    assert.equal(sessions.get(runId), undefined, "a passing run releases its session");
    assert.equal(
      await loadSessionBinding(pool, runId),
      null,
      "a binding left behind would let a later process attach to a destroyed sandbox",
    );
  });
});

test("a non-resumable adapter is refused by name", { skip }, async () => {
  await withRun(
    async ({ pool, provider, runId, sessions, worker }) => {
      await provider.startRun(runId);
      await provider.drain();

      const replayOnly = {
        ...worker,
        name: worker.name,
        capabilities: { resumableSessions: false, reattachableSessions: false },
      };
      const resolved = await resolveRepairSession(
        { pool, worker: replayOnly, sessions },
        runId,
        undefined,
      );
      assert.equal(resolved.reason, "worker_not_resumable");
      assert.equal(resolved.outcome.stopReason, "error");
    },
    { review: DIRTY_REVIEW },
  );
});

test(
  "idle maker time reaches the cost ledger and is visible to the spend rail",
  { skip },
  async () => {
    await withRun(
      async ({ pool, provider, runId, registry }) => {
        await provider.startRun(runId);
        await provider.drain();

        const maker = await roleOf(pool, runId, "maker");
        assert.equal(maker.status, "ready", "held alive, and therefore accruing");

        const { rows } = await pool.query(
          `select * from cost_event
           where engineering_run_id = $1 and stage_type = 'workspace' and stage_id = $2`,
          [runId, maker.id],
        );
        /**
         * One charge per cycle the maker is held through — IMPLEMENTING's tail and VERIFYING's
         * — and each is the *delta* since the last one, never the lifetime total. A run that
         * re-charged the total every cycle would show a sum growing quadratically in the number
         * of cycles, which is why the sum is asserted against the run's cost rather than only
         * the row count.
         */
        assert.ok(rows.length >= 1, "the kept-alive maker is charged while it is held");
        for (const row of rows) assert.ok(Number(row.usd) > 0, "every charge is a real delta");

        const run = await getEngineeringRun(pool, runId);
        assert.ok(run.cost > 0, "the denormalized sum the spend rail reads moved too");

        // The invariant that makes repeated charging safe: what the ledger holds for this
        // workspace is never more than what the sandbox has actually accrued. A cycle that
        // recorded the lifetime total instead of the delta would break this on cycle two.
        const charged = rows.reduce((sum, row) => sum + Number(row.usd), 0);
        const accrued = (await registry.get(maker.id).usage()).activeCpuMs * 0.001;
        assert.ok(
          charged <= accrued + 1e-9,
          `charged $${charged} against $${accrued} accrued — repeated totals, not deltas`,
        );

        /**
         * The rail can see it: a cap below what the idle sandbox has already cost stops the
         * run. The run is walked back to VERIFYING first, which is where the next cycle would
         * consult the rail (and is legal — ADR-0003 gives BLOCKED a return to the state it
         * left); a rail stop from BLOCKED would be an illegal transition, not a passing test.
         */
        await pool.query("update engineering_run set spend_cap_usd = $1 where id = $2", [
          run.cost / 2,
          runId,
        ]);
        await advanceRun(pool, runId, "VERIFYING", "next repair cycle");
        const rails = await enforceSpendAndTimeRails(pool, runId);
        assert.equal(rails.stopped, true);
        assert.equal(rails.reason, "spend_cap");
      },
      // A rate high enough that a sub-second sandbox lifetime is a nonzero number of dollars.
      { review: DIRTY_REVIEW, usdPerCpuMs: 0.001 },
    );
  },
);
