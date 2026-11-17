/**
 * `windkeel say`, end to end across the seam it crosses.
 *
 * The feature's whole difficulty is that the process which accepts a message cannot deliver it: the
 * API writes a row (ADR-0023 §2) and the worker sends it as a new turn at the next turn boundary,
 * because `WorkerAdapter.send()` starts a turn and cannot start one while a turn is running. So the
 * assertions here are about the boundary, not about the round trip:
 *
 * - a claim under the run's row lock, bounded so a crash neither loses a message nor repeats it;
 * - delivery **only** at a turn boundary, and only when the turn ended cleanly;
 * - never after a rail stopped the run, which would be spending past a cap through a new door;
 * - the summary surviving the extra turn, rather than restarting at zero;
 * - an adapter that cannot resume saying so in a row a person can read, rather than throwing.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { recordCost } from "../dist/factory/cost-ledger.js";
import { runMigrations } from "../dist/factory/migrate.js";
import {
  getEngineeringRun,
  insertAgentRun,
  insertEngineeringRun,
  insertEngineeringTask,
} from "../dist/factory/repositories.js";
import { TERMINAL_STATES } from "../dist/factory/run-state-machine.js";
import { advanceRun } from "../dist/factory/run-service.js";
import {
  GUIDANCE_PREAMBLE,
  MAX_DELIVERY_ATTEMPTS,
  claimPendingGuidance,
  listGuidance,
  recordGuidance,
  renderGuidance,
} from "../dist/factory/run-guidance.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { pollSession } from "../dist/factory/workflow/handlers/session-turn.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let counter = 0;

async function withSchema(fn) {
  const schema = `windkeel_guidance_${Date.now()}_${process.pid}_${counter++}`;
  const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await setup.query(`create schema ${schema}`);
  await setup.end();
  const pool = new Pool({
    connectionString: dbUrl,
    ...TEST_POOL,
    options: `-c search_path=${schema}`,
  });
  try {
    await runMigrations(pool, join(repoRoot, "migrations"));
    await seedFixtureRepository(pool);
    await fn(pool);
  } finally {
    await pool.end();
    const teardown = new Pool({ connectionString: dbUrl, ...TEST_POOL });
    await teardown.query(`drop schema if exists ${schema} cascade`);
    await teardown.end();
  }
}

async function seedRun(pool, { spendCapUsd = 25 } = {}) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "local",
    sourceReference: "run-guidance",
    title: "t",
    description: "d",
    acceptanceCriteria: [],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  const run = await insertEngineeringRun(pool, {
    taskId: task.id,
    spendCapUsd,
    wallClockCapSeconds: 7200,
  });
  for (const next of ["CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING"]) {
    await advanceRun(pool, run.id, next, "seed");
  }
  const agentRun = await insertAgentRun(pool, {
    engineeringRunId: run.id,
    workerType: "turns",
    model: "m",
    role: "implementer",
    tokenUsage: null,
  });
  return { runId: run.id, agentRunId: agentRun.id };
}

/**
 * A worker whose turn ends on demand and which records every `send`.
 *
 * `endsAfter` polls, then the turn is over — which is exactly the moment guidance may be delivered.
 * After a `send`, the turn is running again for another `endsAfter` polls, so a test can watch the
 * extra turn happen rather than only watch the row change.
 */
class TurnWorker {
  constructor({ resumable = true, sendThrows = null, endsAfter = 1 } = {}) {
    this.name = "turns";
    this.capabilities = {
      resumableSessions: resumable,
      reattachableSessions: true,
      reattachedSessionsAcceptNewTurns: true,
    };
    this.sent = [];
    this.sendThrows = sendThrows;
    this.endsAfter = endsAfter;
    this.pollsThisTurn = 0;
    this.pending = [{ type: "message", text: "turn one" }];
  }
  async start() {
    return { id: "turns-1" };
  }
  reference() {
    return { id: "turns-1", workerType: this.name, adapterState: {} };
  }
  async attach(ref) {
    return { id: ref.id };
  }
  async poll() {
    this.pollsThisTurn += 1;
    const events = this.pending;
    this.pending = [];
    return { events, turnEnded: this.pollsThisTurn >= this.endsAfter };
  }
  async send(_session, message) {
    if (this.sendThrows) throw new Error(this.sendThrows);
    this.sent.push(message);
    this.pollsThisTurn = 0;
    this.pending = [{ type: "file_changed", path: "src/steered.ts" }];
  }
  async cancel() {}
  async result() {
    return { outcome: "completed", diff: { patch: "", filesChanged: [], truncated: false } };
  }
}

function makeDeps(pool, worker) {
  return {
    pool,
    worker,
    registry: new SandboxRegistry(),
    sessions: new WorkerSessionRegistry(),
    sandboxes: {
      name: "fake",
      capabilities: { credentialBrokering: false, phasedEgress: false, reattachable: false },
      async create() {
        throw new Error("unused");
      },
      async attach() {
        throw new Error("unused");
      },
    },
    config: {
      railsCheckIntervalMs: 60_000,
      usdPerCpuMs: 0,
      usdPerEgressByte: 0,
      makerModel: "m",
      modelPricing: { usdPerInputToken: 0, usdPerOutputToken: 0 },
    },
  };
}

function makeContext(runId, { cancelled = false } = {}) {
  return {
    engineeringRunId: runId,
    state: "IMPLEMENTING",
    attempt: 1,
    isCancellationRequested: async () => cancelled,
    takeSignals: async () => [],
    runs: null,
  };
}

// --- the store -------------------------------------------------------------

test("a claim hands guidance over in the order it was said", { skip }, async () => {
  await withSchema(async (pool) => {
    const { runId } = await seedRun(pool);
    await recordGuidance(pool, { engineeringRunId: runId, actor: "operator", message: "first" });
    await recordGuidance(pool, { engineeringRunId: runId, actor: "operator", message: "second" });

    const claimed = await claimPendingGuidance(pool, runId);
    assert.deepEqual(
      claimed.map((item) => item.message),
      ["first", "second"],
      "order is meaning: `update ... returning` has none, so it is sorted by seq",
    );
    assert.deepEqual(
      (await listGuidance(pool, runId, "IMPLEMENTING")).map((row) => row.deliveryAttempts),
      [1, 1],
      "the claim leaves an attempt behind, so a crash before the mark is visible",
    );
  });
});

test("a message reclaimed without ever being delivered is given up on, not re-sent forever", { skip }, async () => {
  await withSchema(async (pool) => {
    const { runId } = await seedRun(pool);
    await recordGuidance(pool, { engineeringRunId: runId, actor: "operator", message: "steer" });

    /*
     * Each iteration is a worker that claimed the row and then died before marking it — the one
     * failure that must neither lose the message nor repeat it without end. It has to come back at
     * least once: a restart that silently dropped an operator's words is the worse failure of the
     * two. And it has to stop: a delivery path that crashes every time would otherwise start a new
     * turn every minute for the length of the run.
     */
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      const claimed = await claimPendingGuidance(pool, runId);
      assert.equal(claimed.length, 1, `attempt ${attempt} should still be re-claimable`);
    }

    const exhausted = await claimPendingGuidance(pool, runId);
    assert.deepEqual(exhausted, [], "the bound has to hold, or steering is an unbounded turn loop");
    const [row] = await listGuidance(pool, runId, "IMPLEMENTING");
    assert.equal(row.state, "undeliverable");
    assert.match(row.undeliverableReason, /without a confirmed delivery/);
  });
});

test("guidance still pending on a finished run reads superseded, not queued", { skip }, async () => {
  await withSchema(async (pool) => {
    const { runId } = await seedRun(pool);
    await recordGuidance(pool, { engineeringRunId: runId, actor: "operator", message: "hello" });

    const live = await listGuidance(pool, runId, "IMPLEMENTING");
    assert.equal(live[0].state, "queued");

    await advanceRun(pool, runId, "CANCELLED", "done");
    const dead = await listGuidance(pool, runId, "CANCELLED");
    assert.equal(dead[0].state, "superseded");
    assert.equal(dead[0].deliveredAt, null);
  });
});

test("the rendered turn carries the constraint and attributes every message", { skip }, async () => {
  const text = renderGuidance([
    { id: "1", actor: "operator", message: "use the existing helper" },
    { id: "2", actor: "operator", message: "and keep the public signature" },
  ]);
  assert.ok(text.startsWith(GUIDANCE_PREAMBLE), "the how-not-what rule leads, or it is buried");
  assert.match(text, /criteria you were\s+given are unchanged/);
  assert.match(text, /operator said:\nuse the existing helper/);
  assert.match(text, /operator said:\nand keep the public signature/);
  assert.ok(
    text.indexOf("use the existing helper") < text.indexOf("and keep the public signature"),
    "order is meaning: a later message may correct an earlier one",
  );
});

// --- delivery at a turn boundary -------------------------------------------

test("nothing is delivered while the turn is still running", { skip }, async () => {
  await withSchema(async (pool) => {
    const { runId, agentRunId } = await seedRun(pool);
    await recordGuidance(pool, { engineeringRunId: runId, actor: "operator", message: "steer" });

    // `endsAfter: 2` — this poll leaves the turn running, which is the state in which `send` would
    // throw and a workspace would end up with two codex processes in it.
    const worker = new TurnWorker({ endsAfter: 2 });
    const deps = makeDeps(pool, worker);
    const poll = await pollSession(deps, makeContext(runId), { id: "turns-1" }, agentRunId);

    assert.equal(poll.finished, false);
    assert.equal(worker.sent.length, 0, "a mid-turn send is what the adapter refuses outright");
    assert.equal((await listGuidance(pool, runId, "IMPLEMENTING"))[0].state, "queued");
  });
});

test("the turn boundary delivers it as one new turn, and the run keeps polling", { skip }, async () => {
  await withSchema(async (pool) => {
    const { runId, agentRunId } = await seedRun(pool);
    await recordGuidance(pool, { engineeringRunId: runId, actor: "operator", message: "steer one" });
    await recordGuidance(pool, { engineeringRunId: runId, actor: "operator", message: "steer two" });

    const worker = new TurnWorker({ endsAfter: 1 });
    const deps = makeDeps(pool, worker);
    const poll = await pollSession(deps, makeContext(runId), { id: "turns-1" }, agentRunId);

    assert.equal(worker.sent.length, 1, "two messages are one turn, not two");
    assert.match(worker.sent[0].text, /steer one[\s\S]*steer two/);
    assert.equal(
      poll.finished,
      false,
      "a turn is running again, so the caller must come back rather than move to VERIFYING",
    );

    const rows = await listGuidance(pool, runId, "IMPLEMENTING");
    assert.deepEqual(
      rows.map((row) => row.state),
      ["delivered", "delivered"],
    );
    assert.ok(rows[0].deliveredAt instanceof Date);
    assert.equal(rows[0].deliveryAttempts, 1);
  });
});

test("the summary survives the extra turn instead of restarting at zero", { skip }, async () => {
  await withSchema(async (pool) => {
    const { runId, agentRunId } = await seedRun(pool);
    await recordGuidance(pool, { engineeringRunId: runId, actor: "operator", message: "steer" });

    const worker = new TurnWorker({ endsAfter: 1 });
    const deps = makeDeps(pool, worker);

    // Poll 1 reads turn one's `message` event and then delivers guidance, starting turn two.
    const first = await pollSession(deps, makeContext(runId), { id: "turns-1" }, agentRunId);
    assert.equal(first.finished, false);

    // Poll 2 reads turn two's `file_changed`. Both turns' events must be in one summary — a run
    // whose evidence lost turn one's tests because a person spoke would be a worse artifact than
    // one nobody steered.
    const second = await pollSession(deps, makeContext(runId), { id: "turns-1" }, agentRunId);
    assert.equal(second.finished, true, "no guidance left, so this boundary is the real end");
    assert.equal(second.summary.eventCounts.message, 1);
    assert.equal(second.summary.eventCounts.file_changed, 1);
    assert.deepEqual(second.summary.filesChanged, ["src/steered.ts"]);
  });
});

test("a rail that stopped the run is not reopened by guidance", { skip }, async () => {
  await withSchema(async (pool) => {
    const { runId, agentRunId } = await seedRun(pool, { spendCapUsd: 1 });
    await recordCost(pool, {
      engineeringRunId: runId,
      stageType: "agent_run",
      stageId: agentRunId,
      kind: "model",
      tokensIn: null,
      tokensOut: null,
      usd: 5,
    });
    await recordGuidance(pool, { engineeringRunId: runId, actor: "operator", message: "keep going" });

    const worker = new TurnWorker({ endsAfter: 1 });
    const deps = makeDeps(pool, worker);
    const poll = await pollSession(deps, makeContext(runId), { id: "turns-1" }, agentRunId);

    assert.equal(poll.summary.stoppedBy, "spend_cap");
    assert.equal(
      worker.sent.length,
      0,
      "a new turn here would spend past the cap through the door steering opened",
    );
    assert.equal(poll.finished, true);
    /*
     * The row is left pending, and the run's own terminal state is what reports it honestly. Read
     * back rather than asserted as a literal: the rail chooses which terminal state a cap trip lands
     * in (ADR-0011), and hardcoding one here would be this test asserting the rail's decision as a
     * side effect of asserting something else.
     */
    const run = await getEngineeringRun(pool, runId);
    assert.ok(TERMINAL_STATES.has(run.status), `a tripped rail must end the run, got ${run.status}`);
    assert.equal((await listGuidance(pool, runId, run.status))[0].state, "superseded");
  });
});

test("a cancelled run is stopped rather than steered", { skip }, async () => {
  await withSchema(async (pool) => {
    const { runId, agentRunId } = await seedRun(pool);
    await recordGuidance(pool, { engineeringRunId: runId, actor: "operator", message: "steer" });

    const worker = new TurnWorker({ endsAfter: 1 });
    const deps = makeDeps(pool, worker);
    const poll = await pollSession(
      deps,
      makeContext(runId, { cancelled: true }),
      { id: "turns-1" },
      agentRunId,
    );

    assert.equal(poll.summary.stoppedBy, "cancellation");
    assert.equal(worker.sent.length, 0);
  });
});

// --- honest refusals -------------------------------------------------------

test("an adapter that cannot resume says so in a row, not in a stack trace", { skip }, async () => {
  await withSchema(async (pool) => {
    const { runId, agentRunId } = await seedRun(pool);
    await recordGuidance(pool, { engineeringRunId: runId, actor: "operator", message: "steer" });

    const worker = new TurnWorker({ resumable: false, endsAfter: 1 });
    const deps = makeDeps(pool, worker);
    const poll = await pollSession(deps, makeContext(runId), { id: "turns-1" }, agentRunId);

    assert.equal(poll.finished, true, "no turn was started, so the boundary is still the boundary");
    const [row] = await listGuidance(pool, runId, "IMPLEMENTING");
    assert.equal(row.state, "undeliverable");
    assert.match(row.undeliverableReason, /cannot resume a session/);
    assert.match(row.undeliverableReason, /submit a new task/, "a refusal names the way forward");
  });
});

test("a send that throws records the adapter's own reason verbatim", { skip }, async () => {
  await withSchema(async (pool) => {
    const { runId, agentRunId } = await seedRun(pool);
    await recordGuidance(pool, { engineeringRunId: runId, actor: "operator", message: "steer" });

    const worker = new TurnWorker({
      endsAfter: 1,
      sendThrows: "CodexWorkerAdapter.send: session turns-1 has no codex session id",
    });
    const deps = makeDeps(pool, worker);
    await pollSession(deps, makeContext(runId), { id: "turns-1" }, agentRunId);

    const [row] = await listGuidance(pool, runId, "IMPLEMENTING");
    assert.equal(row.state, "undeliverable");
    assert.equal(
      row.undeliverableReason,
      "CodexWorkerAdapter.send: session turns-1 has no codex session id",
      "the specific sentence is the only one that says what to do; a paraphrase loses it",
    );
  });
});

test("an undeliverable row is not retried on the next boundary", { skip }, async () => {
  await withSchema(async (pool) => {
    const { runId, agentRunId } = await seedRun(pool);
    await recordGuidance(pool, { engineeringRunId: runId, actor: "operator", message: "steer" });

    const worker = new TurnWorker({ resumable: false, endsAfter: 1 });
    const deps = makeDeps(pool, worker);
    await pollSession(deps, makeContext(runId), { id: "turns-1" }, agentRunId);
    await pollSession(deps, makeContext(runId), { id: "turns-1" }, agentRunId);

    const [row] = await listGuidance(pool, runId, "IMPLEMENTING");
    assert.equal(
      row.deliveryAttempts,
      1,
      "retrying a deployment-shaped failure every minute is a row of noise a minute",
    );
  });
});
