/**
 * #340 issue B: the maker-session recovery windows, reproduced with fault injection and then
 * fixed. Each test kills a "process" between two specific calls and redelivers the stage in a
 * fresh one, exactly as a Workflow step re-run on a different instance would.
 *
 * ## How a crash is simulated
 *
 * A real crash runs no `catch` and no `finally`: the function is simply gone. So a fault here is
 * a call that **never returns** — the delivery that reached it is abandoned, its promise left
 * pending, and nothing it would have done afterwards happens. A *throw* is a different fault and
 * is tested separately, because the handler's `catch` does run for it.
 *
 * Every redelivery gets a brand-new `StageDeps`: a new sandbox registry, a new session registry
 * and a new adapter object. What survives is what survives a real process boundary — Postgres,
 * the sandbox (`FakeSandboxProvider` is reattachable for real) and the agent processes running
 * inside it, which `SimulatedCodex` below models as a shared "world".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { WorkerSessionGoneError } from "../dist/worker/adapter.js";
import {
  getEngineeringRun,
  insertEngineeringRun,
  insertEngineeringTask,
  listAgentRuns,
  listWorkspaces,
} from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { createImplementingHandler } from "../dist/factory/workflow/handlers/implementing.js";
import { bareFixtureRepo, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const STAGE_CONFIG = {
  makerModel: "gpt-5-codex",
  modelApiDomain: "api.openai.com",
  modelKeyEnvVar: "OPENAI_API_KEY",
  modelPricing: { usdPerInputToken: 0.000_001, usdPerOutputToken: 0.000_01 },
  usdPerCpuMs: 0,
  usdPerEgressByte: 0,
  railsCheckIntervalMs: 0,
  workspaceTtlMs: 60_000,
  gitHost: "github.com",
  gitAuthorName: "Windkeel Factory",
  gitAuthorEmail: "factory@windkeel.invalid",
};

/** A turn of two polls: the first leaves it running, the second ends it. */
const BATCHES = [
  [
    { type: "started", sessionId: "codex-thread-1" },
    { type: "file_changed", path: "index.js", kind: "update" },
  ],
  [
    { type: "test_finished", command: "npm test", exitCode: 0, passed: true },
    { type: "message", text: "done" },
    { type: "completed", usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } },
  ],
];

/** A promise that never settles: the process that awaits it is, for every purpose, dead. */
const never = () => new Promise(() => {});

/**
 * What lives inside the sandbox and outlives any one orchestrating process: the agent processes
 * that have been launched, and the output each has written. `launches` is the number the issue
 * is about — two means two agents were let loose on one checkout.
 */
class CodexWorld {
  constructor() {
    this.launches = 0;
    this.sessions = new Map();
  }
}

/**
 * A reattachable, resumable adapter shaped like `CodexWorkerAdapter`: `start()` launches a
 * detached process, `reference()` carries an output watermark, `attach()` rebuilds from a
 * reference and fails with `WorkerSessionGoneError` when the session's output is gone.
 *
 * `faults` are one-shot injection points, each naming the call at which this process dies.
 */
class SimulatedCodex {
  constructor(world, faults = {}) {
    this.world = world;
    this.faults = { ...faults };
    this.name = "sim-codex";
    this.capabilities = {
      resumableSessions: true,
      reattachableSessions: true,
      reattachedSessionsAcceptNewTurns: true,
    };
    this.local = new Map();
    this.crashed = null;
    this.crash = new Promise((resolve) => {
      this.crashed = resolve;
    });
  }
  die(point) {
    this.crashed(point);
    return never();
  }
  async start(input) {
    this.world.launches += 1;
    const id = `sim-${this.world.launches}`;
    // The agent edits the checkout as soon as it is running — which is what makes a second
    // launch into the same checkout dangerous rather than merely wasteful.
    await input.sandbox.writeFile("index.js", `console.log('hello from ${id}');\n`);
    this.world.sessions.set(id, { alive: true });
    this.local.set(id, { index: 0 });
    if (this.faults.afterLaunch) return this.die("afterLaunch");
    return { id, workerSessionId: "codex-thread-1" };
  }
  reference(session) {
    return {
      id: session.id,
      workerType: this.name,
      workerSessionId: "codex-thread-1",
      adapterState: { index: this.local.get(session.id).index },
    };
  }
  async attach(ref) {
    if (!this.world.sessions.has(ref.id)) {
      throw new WorkerSessionGoneError(ref.id, "the scratch directory is gone from the sandbox");
    }
    this.local.set(ref.id, { index: ref.adapterState.index ?? 0 });
    return { id: ref.id, workerSessionId: ref.workerSessionId };
  }
  useRoute() {}
  async poll(session) {
    if (this.faults.onPoll) return this.die("onPoll");
    const state = this.local.get(session.id);
    if (state.index >= BATCHES.length) return { events: [], turnEnded: true };
    const events = BATCHES[state.index++];
    return { events, turnEnded: state.index >= BATCHES.length };
  }
  async *events(session) {
    for (;;) {
      const { events, turnEnded } = await this.poll(session);
      yield* events;
      if (turnEnded) return;
    }
  }
  async send() {}
  async cancel(session) {
    const s = this.world.sessions.get(session.id);
    if (s) s.alive = false;
  }
  async result() {
    if (this.faults.onResult) return this.die("onResult");
    if (this.faults.throwOnResult) {
      delete this.faults.throwOnResult;
      throw new Error("result exploded: the sandbox read timed out");
    }
    return {
      outcome: "completed",
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
      diff: {
        patch: "--- a/index.js\n+++ b/index.js\n+console.log('hello');\n",
        filesChanged: ["index.js"],
        truncated: false,
      },
    };
  }
}

let counter = 0;

async function withRun(fn) {
  const schema = `windkeel_makerrec_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "node --test" });
  const sandboxes = new FakeSandboxProvider();
  const world = new CodexWorld();
  const config = { ...STAGE_CONFIG, repository: { url: remote.bare, baseRevision: "HEAD" } };
  const leaked = [];
  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "local",
      sourceReference: "maker-recovery",
      title: "Add a greeting",
      description: "Make index.js print hello.",
      acceptanceCriteria: [{ id: "ac-1", text: "index.js prints hello" }],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    for (const to of ["CLASSIFYING", "PLANNING", "PROVISIONING"]) await advanceRun(pool, run.id, to, "test seed");

    // PROVISIONING runs for real, in a process of its own that is then thrown away.
    const provisioningRegistry = new SandboxRegistry();
    const provisioner = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool) });
    provisioner.register(
      createProvisioningHandler({
        pool,
        sandboxes,
        worker: new SimulatedCodex(world),
        registry: provisioningRegistry,
        sessions: new WorkerSessionRegistry(),
        config,
      }),
    );
    await provisioner.start();
    await provisioner.startRun(run.id);
    await provisioner.drain();
    assert.equal((await getEngineeringRun(pool, run.id)).status, "IMPLEMENTING");
    leaked.push(...provisioningRegistry.entries());

    const store = new PostgresRunStateStore(pool);
    const context = {
      engineeringRunId: run.id,
      state: "IMPLEMENTING",
      attempt: 1,
      isCancellationRequested: async () => false,
      takeSignals: async () => [],
      runs: store,
    };

    /** A fresh process: nothing in memory survives from any earlier one. */
    const processWith = (faults = {}) => {
      const worker = new SimulatedCodex(world, faults);
      const registry = new SandboxRegistry();
      const deps = { pool, sandboxes, worker, registry, sessions: new WorkerSessionRegistry(), config };
      return { worker, registry, handler: createImplementingHandler(deps) };
    };

    /**
     * One delivery. Resolves `{ crashed: point }` if the process died at an injected fault,
     * `{ threw: error }` if the handler threw, or `{ outcome }` — committing a transition the way
     * the provider would.
     */
    const deliver = async (proc) => {
      const handled = proc.handler.handle(context).then(
        (outcome) => ({ outcome }),
        (threw) => ({ threw }),
      );
      const result = await Promise.race([handled, proc.worker.crash.then((point) => ({ crashed: point }))]);
      for (const entry of proc.registry.entries()) leaked.push(entry);
      if (result.outcome?.kind === "transition") {
        await store.commit(run.id, result.outcome.to, result.outcome.reason ?? null, result.outcome.stopReason ?? null);
      }
      return result;
    };

    /** Deliver, in a fresh process each time, until the stage stops polling. */
    const driveToEnd = async (limit = 10) => {
      for (let i = 0; i < limit; i++) {
        const result = await deliver(processWith());
        if (result.outcome?.kind !== "poll") return result;
      }
      throw new Error("the stage never stopped polling");
    };

    await fn({ pool, runId: run.id, world, sandboxes, processWith, deliver, driveToEnd });
  } finally {
    for (const [, handle] of leaked) await handle.destroy().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

async function runRow(pool, runId) {
  const { rows } = await pool.query("select status, stop_reason from engineering_run where id = $1", [runId]);
  const { rows: last } = await pool.query(
    "select to_state, reason from run_state_transition where engineering_run_id = $1 order by at desc, id desc limit 1",
    [runId],
  );
  return { status: rows[0].status, stopReason: rows[0].stop_reason, reason: last[0]?.reason ?? null };
}

// --- window 2: a crash after worker.start() and before the first progress save --------------

test(
  "#340 window 2: a crash during the first poll does not launch a second agent — the redelivery reattaches",
  { skip },
  async () => {
    await withRun(async ({ pool, runId, world, processWith, deliver, driveToEnd }) => {
      // Process A launches the agent and dies inside its first poll, before anything about the
      // turn's progress is written.
      const a = await deliver(processWith({ onPoll: true }));
      assert.equal(a.crashed, "onPoll");
      assert.equal(world.launches, 1);

      const end = await driveToEnd();
      assert.equal(end.outcome?.kind, "transition", JSON.stringify(end));
      assert.equal(
        world.launches,
        1,
        "the redelivery re-acquired the agent already running in the checkout instead of starting another",
      );
      assert.equal((await runRow(pool, runId)).status, "VERIFYING");
      const [implementer] = (await listAgentRuns(pool, runId)).filter((r) => r.role === "implementer");
      assert.ok(implementer.completedAt);
    });
  },
);

test(
  "#340 window 2, narrowest: a crash between the launch and its reference being recorded fails cleanly, never a second agent",
  { skip },
  async () => {
    await withRun(async ({ pool, runId, world, processWith, deliver, driveToEnd }) => {
      const a = await deliver(processWith({ afterLaunch: true }));
      assert.equal(a.crashed, "afterLaunch");
      assert.equal(world.launches, 1);

      const end = await driveToEnd();
      assert.equal(world.launches, 1, "no second agent was launched into a checkout one may already be editing");
      const row = await runRow(pool, runId);
      assert.equal(row.status, "FAILED");
      assert.equal(row.stopReason, "error");
      assert.match(row.reason, /launch.*no session reference was recorded/i);
      assert.equal(end.outcome?.kind, "transition");
      // The clean fail releases the sandbox — which also stops any agent that did start.
      const [maker] = await listWorkspaces(pool, runId);
      assert.equal(maker.status, "destroyed");
    });
  },
);

// --- window 3: the turn ended, but completion was never recorded ---------------------------

test(
  "#340 window 3: a crash after the turn ends and before completedAt reuses the finished turn instead of re-running it",
  { skip },
  async () => {
    await withRun(async ({ pool, runId, world, processWith, deliver, driveToEnd }) => {
      // Poll 1 in its own process; poll 2 ends the turn and the process dies in worker.result().
      assert.equal((await deliver(processWith())).outcome?.kind, "poll");
      const b = await deliver(processWith({ onResult: true }));
      assert.equal(b.crashed, "onResult");

      const end = await driveToEnd();
      assert.equal(end.outcome?.kind, "transition", JSON.stringify(end));
      assert.equal(world.launches, 1, "the whole Codex turn was not re-paid on a dirty tree");
      assert.equal((await runRow(pool, runId)).status, "VERIFYING");
      const [implementer] = (await listAgentRuns(pool, runId)).filter((r) => r.role === "implementer");
      assert.ok(implementer.completedAt);
      assert.deepEqual(implementer.result.tests, [{ command: "npm test", exitCode: 0, passed: true }]);
      assert.equal(implementer.result.eventCounts.started, 1, "events were counted once, not replayed");
      const { rows } = await pool.query("select 1 from agent_session_progress where agent_run_id = $1", [implementer.id]);
      assert.equal(rows.length, 0, "the scaffolding is cleared once completion is recorded");
    });
  },
);

// --- item 3: a thrown error, and a session that is gone ------------------------------------

/**
 * The provider's own retry, as `runTick` does it: up to three deliveries, each in a fresh
 * process, then FAILED with the last error. Returns the last delivery's result.
 */
async function deliverWithRetries(ctx, firstFaults) {
  let faults = firstFaults;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await ctx.deliver(ctx.processWith(faults));
    faults = {};
    if (!result.threw) return result;
    lastError = result.threw;
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  await new PostgresRunStateStore(ctx.pool).commit(ctx.runId, "FAILED", message, "error");
  return { threw: lastError };
}

test(
  "#340 item 3: a thrown worker.result() ends the run with the error that happened, not a misleading one",
  { skip },
  async () => {
    await withRun(async (ctx) => {
      assert.equal((await ctx.deliver(ctx.processWith())).outcome?.kind, "poll");
      await deliverWithRetries(ctx, { throwOnResult: true });

      const row = await runRow(ctx.pool, ctx.runId);
      assert.equal(row.status, "FAILED");
      assert.equal(row.stopReason, "error");
      assert.match(row.reason, /result exploded/, `the terminal reason names the real failure: ${row.reason}`);
      assert.equal(ctx.world.launches, 1);
      const [maker] = await listWorkspaces(ctx.pool, ctx.runId);
      assert.equal(maker.status, "destroyed", "the sandbox is released, not left billing");
    });
  },
);

test(
  "#340 item 3: a session that is gone on redelivery fails cleanly by name, and starts no second agent",
  { skip },
  async () => {
    await withRun(async (ctx) => {
      assert.equal((await ctx.deliver(ctx.processWith())).outcome?.kind, "poll");
      // The agent's output vanished from the sandbox (reset, replaced): the session cannot be
      // re-acquired, although the checkout may well hold its edits.
      ctx.world.sessions.clear();
      await deliverWithRetries(ctx, {});

      const row = await runRow(ctx.pool, ctx.runId);
      assert.equal(row.status, "FAILED");
      assert.equal(row.stopReason, "error");
      assert.match(row.reason, /cannot be re-acquired/);
      assert.equal(ctx.world.launches, 1, "no fresh agent on a dirty checkout");
      const [maker] = await listWorkspaces(ctx.pool, ctx.runId);
      assert.equal(maker.status, "destroyed");
    });
  },
);

test(
  "#340 item 3 (regression guard): a sandbox that dies between polls ends the run FAILED with a reason, not a hang",
  { skip },
  async () => {
    await withRun(async (ctx) => {
      assert.equal((await ctx.deliver(ctx.processWith())).outcome?.kind, "poll");
      const [maker] = await listWorkspaces(ctx.pool, ctx.runId);
      const handle = await ctx.sandboxes.attach({ role: "maker", handleId: maker.providerHandle });
      await handle.destroy();

      const end = await deliverWithRetries(ctx, {});
      assert.equal(end.outcome?.kind, "transition");
      const row = await runRow(ctx.pool, ctx.runId);
      assert.equal(row.status, "FAILED");
      assert.equal(row.stopReason, "error");
      assert.match(row.reason, /could not be re-attached/);
      assert.equal(ctx.world.launches, 1);
    });
  },
);
