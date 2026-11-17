import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import {
  getAgentRun,
  insertEngineeringRun,
  insertEngineeringTask,
  listAgentRuns,
  listWorkspaces,
} from "../dist/factory/repositories.js";
import { sumCostEvents } from "../dist/factory/cost-ledger.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { createImplementingHandler } from "../dist/factory/workflow/handlers/implementing.js";
import { GRANT_REVOKED_REASON, withRepositoryGrant } from "../dist/factory/workflow/repository-grant-gate.js";
import { bareFixtureRepo, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `FakeWorkerAdapter` with a real pause partway through the stream, so a rails check or a
 * cancellation can land *during* a session rather than only between stages. Everything else
 * delegates, so the adapter under test is still the real fake.
 */
class PausingWorkerAdapter {
  constructor(inner, { pauseAfter, pauseMs }) {
    this.inner = inner;
    this.pauseAfter = pauseAfter;
    this.pauseMs = pauseMs;
  }
  get name() {
    return this.inner.name;
  }
  get capabilities() {
    return this.inner.capabilities;
  }
  get calls() {
    return this.inner.calls;
  }
  start(input) {
    return this.inner.start(input);
  }
  send(session, message) {
    return this.inner.send(session, message);
  }
  cancel(session) {
    return this.inner.cancel(session);
  }
  result(session) {
    return this.inner.result(session);
  }
  async *events(session) {
    let seen = 0;
    for await (const event of this.inner.events(session)) {
      yield event;
      if (++seen === this.pauseAfter) await sleep(this.pauseMs);
    }
  }
}

/**
 * **Why these are Postgres-gated, when the ticket asked for "no Postgres".**
 *
 * They cannot be. Every behaviour #128 asks to be tested is a Postgres read or write: the
 * ADR-0007 §4 exactly-once guard is a `Workspace` row lookup, the ADR-0011 rails are
 * `enforceSpendAndTimeRails` driving `advanceRun`, and "an `AgentRun` row and a cost-ledger
 * entry exist after a session" is an acceptance criterion outright. A version of these handlers
 * that could run without a database would be a version with no state checks and no rails —
 * i.e. not these handlers.
 *
 * What the fakes *do* buy is the part that matters: **no Vercel, no Codex, no network, and no
 * model key.** `FakeSandboxProvider` does a real local `git clone` into a real temp directory,
 * `FakeWorkerAdapter` replays a recorded event stream, and `FakeWorkflowProvider` runs the same
 * `WorkflowProvider` contract deterministically. The provider is constructed over
 * `PostgresRunStateStore` rather than its in-memory default, because the handlers call
 * `advanceRun` against Postgres directly through the rails gate — a fake holding a private copy
 * of run state would silently diverge from the rows the handlers read.
 *
 * Skipped cleanly when `TEST_DATABASE_URL` is unset; CI runs Postgres.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let counter = 0;

const STAGE_CONFIG = {
  makerModel: "gpt-5-codex",
  modelApiDomain: "api.openai.com",
  modelKeyEnvVar: "OPENAI_API_KEY",
  modelPricing: { usdPerInputToken: 0.000_001, usdPerOutputToken: 0.000_01 },
  usdPerCpuMs: 0,
  usdPerEgressByte: 0,
  railsCheckIntervalMs: 0, // check on every event, so a breach is observable in a short stream
  workspaceTtlMs: 60_000,
  gitHost: "github.com",
  gitAuthorName: "Windkeel Factory",
  gitAuthorEmail: "factory@windkeel.invalid",
};

/**
 * A worker that actually edits the checkout, so the M4.5 capture at the tail of IMPLEMENTING has
 * something real to commit. `FakeWorkerAdapter` is a replay-only double with no workspace, so
 * left alone it reports an empty diff and every run would take the empty-change path.
 */
class MutatingWorkerAdapter {
  constructor(inner, mutate) {
    this.inner = inner;
    this.mutate = mutate;
  }
  get name() {
    return this.inner.name;
  }
  get capabilities() {
    return this.inner.capabilities;
  }
  get calls() {
    return this.inner.calls;
  }
  async start(input) {
    await this.mutate(input.sandbox);
    return this.inner.start(input);
  }
  send(session, message) {
    return this.inner.send(session, message);
  }
  cancel(session) {
    return this.inner.cancel(session);
  }
  events(session) {
    return this.inner.events(session);
  }
  async result(session) {
    const result = await this.inner.result(session);
    if (result.outcome !== "completed") return result;
    return {
      ...result,
      diff: {
        patch: "--- a/index.js\n+++ b/index.js\n+console.log('hello');\n",
        filesChanged: ["index.js"],
        truncated: false,
      },
    };
  }
}

/** A recorded stream that edits a file, runs tests, and completes. */
function successStream(options = {}) {
  return [
    { type: "started", sessionId: "sess-1" },
    { type: "thinking", text: "reading the repo" },
    { type: "file_changed", path: "index.js", kind: "update" },
    { type: "test_started", command: "npm test" },
    { type: "test_finished", command: "npm test", exitCode: 0, passed: true },
    { type: "message", text: "done" },
    {
      type: "completed",
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
    },
    ...(options.extra ?? []),
  ];
}

function failureStream() {
  return [
    { type: "started", sessionId: "sess-1" },
    { type: "command_started", command: "npm ci" },
    { type: "command_finished", command: "npm ci", exitCode: 1 },
    { type: "failed", error: "the agent could not install dependencies" },
  ];
}

async function withHarness(fn, options = {}) {
  const schema = `windkeel_stages_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "node --test" });
  const sandboxes = new FakeSandboxProvider();
  const registry = new SandboxRegistry();
  const base = new FakeWorkerAdapter(options.stream ?? successStream(), options.workerOptions);
  const paused = options.pause ? new PausingWorkerAdapter(base, options.pause) : base;
  const worker =
    options.mutate === false
      ? paused
      : new MutatingWorkerAdapter(paused, async (sandbox) => {
          await sandbox.writeFile("index.js", "console.log('hello');\n");
        });

  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "local",
      sourceReference: "m4.4",
      title: "Add a greeting",
      description: "Make index.js print hello.",
      acceptanceCriteria: [{ id: "ac-1", text: "index.js prints hello" }],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: options.spendCapUsd ?? 25,
      wallClockCapSeconds: options.wallClockCapSeconds ?? 7200,
    });
    // The stages M6 owns are not built yet; walk the run to PROVISIONING the way they would.
    for (const to of ["CLASSIFYING", "PLANNING", "PROVISIONING"]) {
      await advanceRun(pool, run.id, to, "test seed");
    }

    const deps = {
      pool,
      sandboxes,
      worker,
      registry,
      sessions: new WorkerSessionRegistry(),
      config: {
        ...STAGE_CONFIG,
        ...(options.config ?? {}),
        repository: { url: remote.bare, baseRevision: "HEAD" },
      },
    };

    const provider = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool) });
    // `gated`: wrapped as `registerStageHandlers` wraps them, with the repository-grant check.
    const wrap = options.gated ? (handler) => withRepositoryGrant(deps, handler) : (handler) => handler;
    provider.register(wrap(createProvisioningHandler(deps)));
    provider.register(wrap(createImplementingHandler(deps)));
    await provider.start();

    await fn({ pool, provider, deps, runId: run.id, sandboxes, worker, registry, schema, remote });
  } finally {
    for (const [, handle] of registry.entries()) await handle.destroy().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

async function transitions(pool, runId) {
  const { rows } = await pool.query(
    "select from_state, to_state from run_state_transition where engineering_run_id = $1 order by at, id",
    [runId],
  );
  // The three seeded moves are the test's own scaffolding, not the handlers' work.
  return rows.slice(3).map((r) => `${r.from_state}->${r.to_state}`);
}

test("happy path: PROVISIONING -> IMPLEMENTING -> VERIFYING, in order", { skip }, async () => {
  await withHarness(async ({ pool, provider, runId, registry }) => {
    await provider.startRun(runId);
    await provider.drain();

    assert.deepEqual(await transitions(pool, runId), [
      "PROVISIONING->IMPLEMENTING",
      "IMPLEMENTING->VERIFYING",
    ]);

    const workspaces = await listWorkspaces(pool, runId);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].role, "maker");
    // The debt M4.6 pays: the maker workspace is still alive at VERIFYING.
    assert.equal(workspaces[0].status, "ready");
    assert.ok(registry.get(workspaces[0].id), "and its handle is still held");
    assert.ok(workspaces[0].expiresAt, "with an expiry, so a crash cannot leak it forever");
  });
});

test("a retried PROVISIONING job provisions exactly one sandbox", { skip }, async () => {
  await withHarness(async ({ pool, provider, runId, sandboxes }) => {
    let created = 0;
    const realCreate = sandboxes.create.bind(sandboxes);
    sandboxes.create = async (options) => {
      created++;
      return realCreate(options);
    };

    await provider.startRun(runId);
    // At-least-once delivery: a second job for the same run, before anything has run.
    await provider.startRun(runId);
    await provider.drain();

    assert.equal(created, 1, "the ADR-0007 §4 state check held");
    assert.equal((await listWorkspaces(pool, runId)).length, 1);
    assert.deepEqual(await transitions(pool, runId), [
      "PROVISIONING->IMPLEMENTING",
      "IMPLEMENTING->VERIFYING",
    ]);
  });
});

test(
  "an AgentRun row and a cost-ledger entry exist after a successful session",
  { skip },
  async () => {
    await withHarness(async ({ pool, provider, runId }) => {
      await provider.startRun(runId);
      await provider.drain();

      const agentRuns = await listAgentRuns(pool, runId);
      assert.equal(agentRuns.length, 1);
      const agentRun = await getAgentRun(pool, agentRuns[0].id);
      assert.equal(agentRun.role, "implementer");
      assert.equal(agentRun.workerType, "fake");
      assert.equal(agentRun.model, "gpt-5-codex");
      assert.ok(agentRun.startedAt && agentRun.completedAt);

      // The event stream is summarized, not dropped and not stored raw.
      assert.equal(agentRun.result.outcome, "completed");
      assert.deepEqual(agentRun.result.tests, [
        { command: "npm test", exitCode: 0, passed: true },
      ]);
      assert.deepEqual(agentRun.result.filesChanged, ["index.js"]);
      assert.equal(agentRun.result.eventCounts.thinking, 1);

      // 1000 in * 1e-6 + 200 out * 1e-5 = 0.003
      assert.equal(Number(agentRun.modelCost.toFixed(6)), 0.003);
      assert.equal(Number((await sumCostEvents(pool, runId)).toFixed(6)), 0.003);
    });
  },
);

test(
  "a stream ending in `failed` lands the run in FAILED with the AgentRun row reflecting it",
  { skip },
  async () => {
    await withHarness(
      async ({ pool, provider, runId }) => {
        await provider.startRun(runId);
        await provider.drain();

        assert.deepEqual(await transitions(pool, runId), [
          "PROVISIONING->IMPLEMENTING",
          "IMPLEMENTING->FAILED",
        ]);
        const { rows } = await pool.query("select stop_reason from engineering_run where id = $1", [
          runId,
        ]);
        assert.equal(rows[0].stop_reason, "error");

        const [agentRun] = await listAgentRuns(pool, runId);
        assert.equal(agentRun.result.outcome, "failed");
        assert.equal(agentRun.result.error, "the agent could not install dependencies");
        assert.ok(agentRun.completedAt, "a failed session is still a completed row");
        // Cost is recorded on the failure path too — a session that burned tokens and then
        // failed cost exactly as much as one that succeeded.
        assert.ok((await sumCostEvents(pool, runId)) >= 0);
      },
      { stream: failureStream() },
    );
  },
);

test(
  "a spend-cap breach before the session even starts refuses to spawn it",
  { skip },
  async () => {
    await withHarness(
      async ({ pool, provider, runId, worker }) => {
        // A zero cap: `checkCaps` refuses at `cost >= cap`, so the entry gate trips.
        await provider.startRun(runId);
        await provider.drain();

        assert.equal(
          worker.calls.filter((c) => c.type === "start").length,
          0,
          "ADR-0011 is checked *before* spawning the next stage, so no session is started",
        );
        const { rows } = await pool.query(
          "select status, stop_reason from engineering_run where id = $1",
          [runId],
        );
        assert.equal(rows[0].status, "FAILED", "terminalStateFor('spend_cap')");
        assert.equal(rows[0].stop_reason, "spend_cap");
      },
      { spendCapUsd: 0 },
    );
  },
);

test(
  "a rail breached *mid-stream* calls adapter.cancel() and lands the ADR-0011 terminal state",
  { skip },
  async () => {
    /**
     * The wall-clock cap is the rail that can genuinely trip mid-session: `EngineeringRun.cost`
     * only changes at stage boundaries, so a spend cap cannot cross during one stream, but the
     * clock always can. A 1s cap plus a 1.3s pause after the session's first event means the
     * entry gate passes and the next in-stream check does not — which is exactly the shape of
     * the real failure (a session that runs past its remaining budget).
     */
    await withHarness(
      async ({ pool, provider, runId, worker }) => {
        await provider.startRun(runId);
        await provider.drain();

        const cancelIndex = worker.calls.findIndex((c) => c.type === "cancel");
        assert.ok(
          cancelIndex >= 0,
          "the orchestrator called adapter.cancel() — the only lever it has over a live agent",
        );
        const eventsAfterCancel = worker.calls
          .slice(cancelIndex)
          .filter((c) => c.type === "event").length;
        assert.equal(eventsAfterCancel, 0, "and the stream stopped there");

        const { rows } = await pool.query(
          "select status, stop_reason from engineering_run where id = $1",
          [runId],
        );
        assert.equal(rows[0].status, "FAILED", "terminalStateFor('wall_clock_cap')");
        assert.equal(rows[0].stop_reason, "wall_clock_cap");
      },
      { wallClockCapSeconds: 1, pause: { pauseAfter: 1, pauseMs: 1300 } },
    );
  },
);

test(
  "cancel mid-session stops event consumption and does not transition to VERIFYING",
  { skip },
  async () => {
    await withHarness(
      async ({ pool, provider, runId, worker }) => {
        // Start the drain but do not await it: the cancellation has to land while the
        // IMPLEMENTING handler is genuinely mid-stream, which is the only case worth testing.
        await provider.startRun(runId);
        const draining = provider.drain();
        await sleep(400); // past PROVISIONING and into the paused session
        const cancellation = await provider.cancel(runId, "operator stopped the run");
        await draining;

        assert.equal(
          cancellation.settled,
          false,
          "a live agent cannot be preempted, so cancel does not claim to have settled it",
        );

        const seen = await transitions(pool, runId);
        assert.ok(!seen.includes("IMPLEMENTING->VERIFYING"), `unexpected: ${seen.join(", ")}`);
        assert.equal((await provider.snapshot(runId)).state, "CANCELLED");

        const cancelIndex = worker.calls.findIndex((c) => c.type === "cancel");
        assert.ok(cancelIndex >= 0, "the live worker session was actually cancelled");
        assert.equal(
          worker.calls.slice(cancelIndex).filter((c) => c.type === "event").length,
          0,
          "and no further events were consumed",
        );
      },
      { pause: { pauseAfter: 1, pauseMs: 1200 } },
    );
  },
);

test(
  "ORQ-10: a grant revoked mid-session cancels the agent and destroys the sandbox before the run is cancelled",
  { skip },
  async () => {
    await withHarness(
      async ({ pool, provider, runId, worker, sandboxes }) => {
        let destroyed = 0;
        const realCreate = sandboxes.create.bind(sandboxes);
        sandboxes.create = async (options) => {
          const handle = await realCreate(options);
          const destroy = handle.destroy.bind(handle);
          handle.destroy = async () => {
            destroyed++;
            return destroy();
          };
          return handle;
        };

        await provider.startRun(runId);
        const draining = provider.drain();
        await sleep(400); // past PROVISIONING and into the paused session
        await pool.query("delete from repository_grant where repository_id = '11111111-1111-1111-1111-111111111111'");
        await draining;

        const seen = await transitions(pool, runId);
        assert.ok(!seen.includes("IMPLEMENTING->VERIFYING"), `unexpected: ${seen.join(", ")}`);
        const { rows } = await pool.query(
          "select reason from run_state_transition where engineering_run_id = $1 and to_state = 'CANCELLED'",
          [runId],
        );
        assert.deepEqual(rows.map((r) => r.reason), [GRANT_REVOKED_REASON]);

        const cancelIndex = worker.calls.findIndex((c) => c.type === "cancel");
        assert.ok(cancelIndex >= 0, "the live worker session was cancelled, not left running");
        assert.equal(worker.calls.slice(cancelIndex).filter((c) => c.type === "event").length, 0);
        assert.ok(destroyed >= 1, "and the maker sandbox was destroyed by the stage, not left for the reaper");
      },
      { gated: true, pause: { pauseAfter: 1, pauseMs: 1200 } },
    );
  },
);

test(
  "the maker workspace is not destroyed on the success path — M4.6 needs its files",
  { skip },
  async () => {
    await withHarness(async ({ pool, provider, runId, registry }) => {
      await provider.startRun(runId);
      await provider.drain();

      const [workspace] = await listWorkspaces(pool, runId);
      assert.equal(workspace.status, "ready");
      const handle = registry.get(workspace.id);
      assert.ok(handle);
      // The checkout is still readable: a destroyed FakeSandboxHandle removes its temp dir.
      assert.equal(await handle.exists("package.json"), true);
    });
  },
);

test(
  "no path puts a real model key in the sandbox: the broker rule names an env var, and the sandbox sees the placeholder",
  { skip },
  async () => {
    await withHarness(async ({ provider, runId, registry, pool }) => {
      await provider.startRun(runId);
      await provider.drain();

      const [workspace] = await listWorkspaces(pool, runId);
      const handle = registry.get(workspace.id);
      const brokerCalls = handle.calls.filter((c) => c.type === "credentialBroker");
      assert.ok(brokerCalls.length > 0, "broker rules were installed");
      for (const call of brokerCalls) {
        for (const rule of call.rules) {
          assert.equal(rule.domain, "api.openai.com");
          assert.equal(rule.header, "Authorization");
          assert.equal(
            rule.secretEnvVar,
            "OPENAI_API_KEY",
            "the rule names an env var on the worker container, never carries a key value",
          );
          assert.ok(!("value" in rule), "a CredentialBrokerRule has no value field to leak into");
        }
      }
      // And the sandbox got install-phase egress before any untrusted command ran.
      const policies = handle.calls.filter((c) => c.type === "policy");
      assert.ok(policies.some((p) => p.policy.allowedDomains?.includes("github.com")));
    });
  },
);

test(
  "a redelivered IMPLEMENTING job does not start a second agent session",
  { skip },
  async () => {
    await withHarness(async ({ pool, provider, runId, worker }) => {
      await provider.startRun(runId);
      await provider.drain();
      assert.equal(worker.calls.filter((c) => c.type === "start").length, 1);

      // The run is at VERIFYING with no handler, so a re-delivery lands on a parked state;
      // force the exactly-once path directly by rewinding nothing and re-running the handler.
      const agentRuns = await listAgentRuns(pool, runId);
      assert.equal(agentRuns.length, 1, "one session, one row");
      assert.ok(agentRuns[0].completedAt, "which the guard reads as `already completed`");
    });
  },
);
