import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import {
  getEngineeringRun,
  listWorkspaces,
  listAgentRuns,
  listRepairAttempts,
  listVerificationRuns,
  insertEngineeringRun,
  insertEngineeringTask,
} from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { createImplementingHandler } from "../dist/factory/workflow/handlers/implementing.js";
import { createVerifyingHandler } from "../dist/factory/workflow/handlers/verifying.js";
import { createRepairingHandler } from "../dist/factory/workflow/handlers/repairing.js";
import { loadSessionBinding } from "../dist/factory/workflow/session-binding.js";
import { bareFixtureRepo, repoRoot, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * The REPAIRING stage, driven to its entry point by the real PROVISIONING → IMPLEMENTING →
 * VERIFYING chain and then **delivered directly**, one job at a time.
 *
 * Driving the whole thing through `provider.drain()` is what the earlier stage suites do, and it
 * is the wrong tool here: until M5.3 (#143) captures the repairer's work as a *new* candidate,
 * the second VERIFYING finds a completed verification for the implementer's SHA and returns its
 * verdict, so an unbounded drain would cycle REPAIRING → VERIFYING → REPAIRING until the fake
 * provider's step guard fired. That cycle is real, it is #143's to close, and this suite is
 * about what one repair delivery does — so it delivers one.
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

const TURN_ONE = [
  { type: "started", sessionId: "sess-1" },
  { type: "file_changed", path: "index.js", kind: "update" },
  { type: "completed", usage: { inputTokens: 100, outputTokens: 20 } },
];

const TURN_TWO = [
  { type: "file_changed", path: "index.js", kind: "update" },
  { type: "test_finished", command: "npm test", exitCode: 0, passed: true },
  { type: "completed", usage: { inputTokens: 10, outputTokens: 5 } },
];

/**
 * A worker that can take a second turn. Deliberately minimal: it exists to exercise *this*
 * stage's contract with the adapter — that `send()` is called once, with the packet, and that a
 * second `events()`/`result()` pair follows it. The scripted multi-turn fake that replays a
 * defect-then-fix story into a real workspace is M5.6's (#146).
 */
class ResumableWorker {
  constructor(options = {}) {
    this.name = "fake-resumable";
    /**
     * Reattachable as well as resumable (#210), and honestly so: this adapter's per-session state
     * is an id, so handing it to another process loses nothing. `FakeWorkerAdapter` declares
     * `reattachableSessions: false` because its sessions really are objects in one process — the
     * two declarations differ because the two adapters differ, which is the point of the flag.
     */
    this.capabilities = {
      resumableSessions: true,
      reattachableSessions: true,
      reattachedSessionsAcceptNewTurns: true,
    };
    this.attaches = 0;
    this.sends = [];
    this.cancels = 0;
    this.turn = 1;
    this.sendThrows = options.sendThrows ?? null;
    this.onTurnTwoEvent = options.onTurnTwoEvent ?? null;
    this.cancelled = false;
  }
  async start(input) {
    await input.sandbox.writeFile("index.js", "console.log('hello');\n");
    return { id: "session-1", workerSessionId: "sess-1" };
  }
  reference(session) {
    return { id: session.id, workerType: this.name, adapterState: { turn: this.turn } };
  }
  async attach(ref) {
    this.attaches += 1;
    return { id: ref.id };
  }
  async send(_session, message) {
    if (this.sendThrows) throw new Error(this.sendThrows);
    this.sends.push(message);
    this.turn = 2;
    this.cancelled = false;
  }
  async cancel() {
    this.cancels++;
    this.cancelled = true;
  }
  async *events() {
    const stream = this.turn === 1 ? TURN_ONE : TURN_TWO;
    for (const event of stream) {
      if (this.cancelled) return;
      if (this.turn === 2 && this.onTurnTwoEvent) await this.onTurnTwoEvent();
      yield event;
    }
  }
  async result() {
    if (this.turn === 1) {
      return {
        outcome: "completed",
        diff: { patch: "+console.log('hello');\n", filesChanged: ["index.js"], truncated: false },
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    }
    if (this.cancelled) {
      return {
        outcome: "cancelled",
        error: "cancelled mid-turn",
        diff: { patch: "", filesChanged: [], truncated: false },
        usage: { inputTokens: 10, outputTokens: 5 },
        cumulativeUsage: { inputTokens: 110, outputTokens: 25 },
      };
    }
    return {
      outcome: "completed",
      diff: { patch: "+console.log('fixed');\n", filesChanged: ["index.js"], truncated: false },
      // Per-turn usage, and a cumulative that is deliberately much larger: a handler that
      // charged the wrong one would be off by exactly turn one.
      usage: { inputTokens: 10, outputTokens: 5 },
      cumulativeUsage: { inputTokens: 110, outputTokens: 25 },
    };
  }
}

async function withRepair(fn, options = {}) {
  const schema = `windkeel_repair_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "true" });
  const sandboxes = new FakeSandboxProvider();
  const registry = new SandboxRegistry();
  const sessions = new WorkerSessionRegistry();
  const worker = options.worker ?? new ResumableWorker();

  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "local",
      sourceReference: "m5.2",
      title: "Add a greeting",
      description: "Make index.js print hello.",
      acceptanceCriteria: CRITERIA,
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: options.spendCapUsd ?? 10_000,
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
      config: {
        repository: { url: remote.bare, baseRevision: "HEAD" },
        makerModel: "gpt-5-codex",
        makerVendor: "openai",
        modelApiDomain: "api.openai.com",
        modelKeyEnvVar: "OPENAI_API_KEY",
        // $1 per token, so a per-turn vs cumulative mix-up is a visible number.
        modelPricing: { usdPerInputToken: 1, usdPerOutputToken: 1 },
        usdPerCpuMs: 0,
        usdPerEgressByte: 0,
        railsCheckIntervalMs: options.railsCheckIntervalMs ?? 60_000,
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
            review: scripted("review", DIRTY_REVIEW),
            mapping: scripted("mapping", mappingFor(CRITERIA)),
          },
        },
      },
    };

    const store = new PostgresRunStateStore(pool);
    const provider = new FakeWorkflowProvider({ store });
    provider.register(createProvisioningHandler(deps));
    provider.register(createImplementingHandler(deps));
    provider.register(createVerifyingHandler(deps));
    await provider.start();

    // Drive the run to the repair loop's entry point using the real chain.
    await provider.startRun(run.id);
    await provider.drain();
    assert.equal(
      (await getEngineeringRun(pool, run.id)).status,
      "REPAIRING",
      "the fail verdict entered the repair loop",
    );

    const handler = createRepairingHandler(deps);
    let cancellationRequested = false;
    const deliver = async () => {
      const outcome = await handler.handle({
        engineeringRunId: run.id,
        state: "REPAIRING",
        attempt: 1,
        isCancellationRequested: async () => cancellationRequested,
        takeSignals: async () => [],
        runs: store,
      });
      // The provider commits what a handler asks for; this does the same, so a second delivery
      // sees the state the first one produced.
      if (outcome.kind === "transition") {
        await store.commit(run.id, outcome.to, outcome.reason ?? null, outcome.stopReason ?? null);
      }
      return outcome;
    };

    await fn({
      pool,
      runId: run.id,
      deps,
      worker,
      registry,
      sessions,
      deliver,
      requestCancellation: () => {
        cancellationRequested = true;
      },
    });
  } finally {
    for (const [, handle] of registry.entries()) await handle.destroy().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

test("the repair turn receives the stored packet, verbatim", { skip }, async () => {
  await withRepair(async ({ pool, runId, worker, deliver }) => {
    const [stored] = await listRepairAttempts(pool, runId);
    await deliver();

    assert.equal(worker.sends.length, 1, "one resumed turn, not a second session");
    const [message] = worker.sends;
    assert.deepEqual(message.repairPacket, stored.repairPacket, "the packet, unreshaped");
    assert.equal(message.text, undefined, "and nothing this handler invented alongside it");

    // The engine's three static constraints are what stop a repairer editing the verifier.
    assert.equal(message.repairPacket.repair_constraints.length, 3);
    assert.ok(message.repairPacket.repair_constraints[0].includes("repair the implementation"));
    assert.ok(message.repairPacket.review_findings.some((f) => f.id === "REV-1"));
  });
});

test(
  "a completed repair turn returns to VERIFYING and records the attempt, the session, and its cost",
  { skip },
  async () => {
    await withRepair(async ({ pool, runId, deliver }) => {
      const outcome = await deliver();
      assert.equal(outcome.kind, "transition");
      assert.equal(outcome.to, "VERIFYING");

      const attempts = await listRepairAttempts(pool, runId);
      assert.equal(attempts.length, 1, "one attempt per fail verdict");
      const [attempt] = attempts;
      assert.ok(attempt.agentRunId, "ADR-0011 §7: the attempt names the session that ran it");
      assert.equal(attempt.result.outcome, "completed");
      assert.deepEqual(attempt.result.filesChanged, ["index.js"]);

      const agentRuns = await listAgentRuns(pool, runId);
      const repairer = agentRuns.find((r) => r.role === "repairer");
      const implementer = agentRuns.find((r) => r.role === "implementer");
      assert.ok(repairer, "a repairer AgentRun exists");
      assert.equal(repairer.id, attempt.agentRunId);
      // ADR-0011 §2: nothing escalates.
      assert.equal(repairer.workerType, implementer.workerType);
      assert.equal(repairer.model, implementer.model);
      assert.ok(repairer.completedAt);

      const { rows } = await pool.query(
        "select * from cost_event where stage_type = 'agent_run' and stage_id = $1",
        [repairer.id],
      );
      assert.equal(rows.length, 1);
      // 10 in + 5 out at $1/token. The cumulative total is 135; charging it would double-bill
      // the implementer's turn and drag the spend cap forward by that much.
      assert.equal(Number(rows[0].usd), 15);
      assert.equal(Number(rows[0].tokens_in), 10);
      assert.equal(Number(rows[0].tokens_out), 5);
    });
  },
);

test("a redelivered REPAIRING job produces one attempt and one repairer", { skip }, async () => {
  await withRepair(async ({ pool, runId, worker, deliver }) => {
    await deliver();
    // At-least-once delivery: the same job arrives again after the transition was committed.
    await pool.query("update engineering_run set status = 'REPAIRING' where id = $1", [runId]);
    const second = await deliver();

    assert.equal(second.kind, "transition");
    assert.equal(second.to, "VERIFYING");
    assert.equal(worker.sends.length, 1, "the second delivery did not take a second turn");

    const attempts = await listRepairAttempts(pool, runId);
    assert.equal(attempts.length, 1);
    const repairers = (await listAgentRuns(pool, runId)).filter((r) => r.role === "repairer");
    assert.equal(repairers.length, 1);
  });
});

test("a non-resumable adapter is refused by name, not silently cold-started", { skip }, async () => {
  const worker = new ResumableWorker();
  worker.capabilities = { resumableSessions: false };
  await withRepair(
    async ({ pool, runId, deliver }) => {
      const outcome = await deliver();
      assert.equal(outcome.kind, "transition");
      assert.equal(outcome.to, "FAILED");
      assert.equal(outcome.stopReason, "error");
      assert.match(outcome.reason, /resumableSessions: false/);
      assert.match(outcome.reason, /worker_not_resumable/);

      assert.equal(
        (await listAgentRuns(pool, runId)).filter((r) => r.role === "repairer").length,
        0,
        "and no repairer session was spawned to pretend otherwise",
      );
    },
    { worker },
  );
});

test("the stock replay-only fake is refused the same way", { skip }, async () => {
  /**
   * `FakeWorkerAdapter` reports `resumableSessions: false` and throws from `send()`. Every stage
   * unit suite before this one used it, so "what does the repair stage do with the adapter the
   * rest of the tests use" is a question this ticket had to answer rather than discover later.
   * The answer is the refusal above — the throw is never reached.
   */
  const inner = new FakeWorkerAdapter(TURN_ONE);
  const worker = {
    name: "fake",
    capabilities: inner.capabilities,
    start: async (input) => {
      await input.sandbox.writeFile("index.js", "console.log('hello');\n");
      return inner.start(input);
    },
    send: (s, m) => inner.send(s, m),
    cancel: (s) => inner.cancel(s),
    events: (s) => inner.events(s),
    result: async (s) => ({
      ...(await inner.result(s)),
      diff: { patch: "+x\n", filesChanged: ["index.js"], truncated: false },
    }),
  };
  await withRepair(
    async ({ deliver }) => {
      const outcome = await deliver();
      assert.equal(outcome.to, "FAILED");
      assert.equal(outcome.stopReason, "error");
      assert.match(outcome.reason, /worker_not_resumable/);
    },
    { worker },
  );
});

test("a send() that throws becomes a run outcome, not a propagated crash", { skip }, async () => {
  const worker = new ResumableWorker({ sendThrows: "turn 1 of session-1 is still running" });
  await withRepair(
    async ({ pool, runId, deliver }) => {
      const outcome = await deliver();
      assert.equal(outcome.kind, "transition");
      assert.equal(outcome.to, "FAILED");
      assert.equal(outcome.stopReason, "error");
      assert.match(outcome.reason, /still running/);

      // The failure is on the record, not just in the transition reason.
      const [attempt] = await listRepairAttempts(pool, runId);
      assert.equal(attempt.result.outcome, "failed");
      const repairer = (await listAgentRuns(pool, runId)).find((r) => r.role === "repairer");
      assert.ok(repairer.completedAt, "the session row is closed rather than left dangling");
    },
    { worker },
  );
});

test("cancellation mid-repair settles the run and still records the cost", { skip }, async () => {
  let requestCancel;
  const worker = new ResumableWorker({
    onTurnTwoEvent: async () => {
      requestCancel();
    },
  });
  await withRepair(
    async ({ pool, runId, deliver, requestCancellation }) => {
      requestCancel = requestCancellation;
      const outcome = await deliver();

      assert.equal(outcome.kind, "settled");
      assert.ok(worker.cancels >= 1, "the turn was actually cancelled, not just abandoned");

      const repairer = (await listAgentRuns(pool, runId)).find((r) => r.role === "repairer");
      assert.ok(repairer.completedAt);
      const { rows } = await pool.query(
        "select * from cost_event where stage_type = 'agent_run' and stage_id = $1",
        [repairer.id],
      );
      assert.equal(rows.length, 1, "a cancelled turn burned tokens and is billed for them");
    },
    // Check the rails and the cancellation latch on every event rather than once a minute.
    { worker, railsCheckIntervalMs: 0 },
  );
});

test("a spend cap tripped mid-repair stops the turn and settles the run", { skip }, async () => {
  let tripCap;
  const worker = new ResumableWorker({
    // The cap moves *while the turn is streaming*, which is the case that matters: a repair turn
    // can run for an hour, and checking only at its end is accounting, not enforcement.
    onTurnTwoEvent: async () => {
      await tripCap();
    },
  });
  await withRepair(
    async ({ pool, runId, deliver }) => {
      tripCap = async () => {
        await pool.query("update engineering_run set spend_cap_usd = 1 where id = $1", [runId]);
      };
      const outcome = await deliver();

      assert.equal(outcome.kind, "settled");
      assert.ok(worker.cancels >= 1, "the running turn was cancelled, not left to finish");
      const run = await getEngineeringRun(pool, runId);
      assert.equal(run.status, "FAILED");
      assert.equal(run.stopReason, "spend_cap");
    },
    { worker, railsCheckIntervalMs: 0 },
  );
});

test("the maker is destroyed when a repair delivery ends the run", { skip }, async () => {
  const worker = new ResumableWorker();
  worker.capabilities = { resumableSessions: false };
  await withRepair(
    async ({ pool, runId, registry, deliver }) => {
      await deliver();
      const { rows } = await pool.query(
        "select role, status from workspace where engineering_run_id = $1",
        [runId],
      );
      for (const row of rows) {
        assert.ok(
          ["destroyed", "teardown_failed", "orphaned"].includes(row.status),
          `${row.role} left as ${row.status}`,
        );
      }
      assert.equal(registry.size, 0, "and no handle is still held");
    },
    { worker },
  );
});

test("the run's verification history is untouched by a repair turn", { skip }, async () => {
  await withRepair(async ({ pool, runId, deliver }) => {
    const before = await listVerificationRuns(pool, runId);
    await deliver();
    const after = await listVerificationRuns(pool, runId);
    assert.equal(after.length, before.length, "REPAIRING verifies nothing; #143 does that");
  });
});

test(
  "a repair delivery in a process that never held the session resumes it rather than failing",
  { skip },
  async () => {
    await withRepair(async ({ pool, runId, worker, registry, sessions, deliver }) => {
      /**
       * #210, and the reason this test exists at the handler level rather than only at
       * `resolveRepairSession`: under ADR-0020 a REPAIRING delivery is a separate invocation, so
       * *both* in-process caches are empty — the session **and** the sandbox it lives inside.
       * Emptying them here is the closest a single-process test gets to that, and it is the exact
       * condition that used to end the run at FAILED/`session_unreachable`.
       */
      const workspaces = await listWorkspaces(pool, runId);
      for (const workspace of workspaces) registry.forget(workspace.id);
      sessions.forget(runId);

      assert.equal(sessions.get(runId), undefined, "nothing held: a fresh process");

      const binding = await loadSessionBinding(pool, runId);
      assert.ok(binding, "IMPLEMENTING left a durable reference behind");
      assert.equal(binding.workerType, worker.name);

      const outcome = await deliver();

      assert.equal(worker.attaches, 1, "the session was re-acquired, not re-created");
      assert.equal(worker.sends.length, 1, "and the packet went over on the resumed session");
      assert.notEqual(outcome.to, "FAILED");
      assert.equal(
        (await getEngineeringRun(pool, runId)).status,
        "VERIFYING",
        "the repair turn completed and handed back to verification",
      );

      // The thing that must never happen instead: a fresh session wearing the same name.
      assert.equal(sessions.get(runId)?.session.id, "session-1", "the *same* session (ADR-0011 §2)");
    });
  },
);
