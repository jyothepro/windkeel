import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { recordCost } from "../dist/factory/cost-ledger.js";
import { runMigrations } from "../dist/factory/migrate.js";
import {
  insertAgentRun,
  insertEngineeringRun,
  insertEngineeringTask,
  insertWorkspace,
  getWorkspace,
  listWorkspaces,
} from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import {
  loadSessionProgress,
} from "../dist/factory/workflow/handlers/session-progress.js";
import {
  DEFAULT_SESSION_POLL_INTERVAL_MS,
  pollSession,
} from "../dist/factory/workflow/handlers/session-turn.js";
import { preservedNote } from "../dist/factory/workflow/handlers/candidate-capture.js";
import { CodexWorkerAdapter } from "../dist/worker/codex/adapter.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";

/**
 * #197's new model, and only the parts that did not exist before it.
 *
 * The rails and e2e suites the issue lists are the safety net for everything that must *not*
 * change, and they pass unmodified — no file under `test/` was touched by this change. What is
 * here is the behaviour the restructure introduced: a cap that trips between two polls, a
 * summary that survives a process boundary, and the arithmetic that keeps a unit of work clear
 * of the 800 s step ceiling.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let counter = 0;

async function makeSchema() {
  const schema = `windkeel_poll_${Date.now()}_${process.pid}_${counter++}`;
  const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await setup.query(`create schema ${schema}`);
  await setup.end();
  const pool = new Pool({
    connectionString: dbUrl,
    ...TEST_POOL,
    options: `-c search_path=${schema}`,
  });
  await runMigrations(pool, join(repoRoot, "migrations"));
  await seedFixtureRepository(pool);
  return { schema, pool };
}

async function dropSchema(schema) {
  const teardown = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await teardown.query(`drop schema if exists ${schema} cascade`);
  await teardown.end();
}

/**
 * A worker whose turn spans several polls, which is the shape the old blocking consumer could
 * not express: `poll()` hands back one batch and says the turn is still running, until the
 * script is exhausted.
 *
 * It also models the **lossy tail** Spike A measured: a batch scheduled for poll N can be
 * withheld and re-offered at poll N+1. What it must never do is lose one, and that is what the
 * event-loss test asserts.
 */
class SteppedWorkerAdapter {
  constructor(batches, { withholdAt = [] } = {}) {
    this.name = "stepped";
    this.capabilities = {
      resumableSessions: true,
      reattachableSessions: true,
      reattachedSessionsAcceptNewTurns: true,
    };
    this.batches = batches;
    this.withholdAt = new Set(withholdAt);
    this.index = 0;
    this.polls = 0;
    this.cancelled = false;
    this.withheld = [];
  }
  async start() {
    return { id: "stepped-1" };
  }
  reference() {
    return { id: "stepped-1", workerType: this.name, adapterState: { index: this.index } };
  }
  async attach(ref) {
    this.index = ref.adapterState.index ?? 0;
    return { id: ref.id };
  }
  async poll() {
    this.polls += 1;
    if (this.cancelled) return { events: [], turnEnded: true };
    if (this.index >= this.batches.length) return { events: [], turnEnded: true };

    const batch = this.batches[this.index++];
    // The live tail: this batch is not handed over yet, but it is not dropped either.
    if (this.withholdAt.has(this.polls)) {
      this.withheld.push(...batch);
      return { events: [], turnEnded: false };
    }
    const events = [...this.withheld, ...batch];
    this.withheld = [];
    const turnEnded = this.index >= this.batches.length && this.withheld.length === 0;
    return { events, turnEnded };
  }
  async *events() {
    for (;;) {
      const { events, turnEnded } = await this.poll();
      for (const event of events) yield event;
      if (turnEnded) return;
    }
  }
  async send() {}
  async cancel() {
    this.cancelled = true;
  }
  async result() {
    return { outcome: this.cancelled ? "cancelled" : "completed", diff: { patch: "", filesChanged: [], truncated: false } };
  }
}

/** A sandbox handle that records whether it was destroyed. The assertion this issue is about. */
function recordingHandle(id) {
  return {
    id,
    role: "maker",
    checkoutPath: "/tmp/nowhere",
    destroyed: false,
    async exec() {
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
    async readFile() {
      return Buffer.alloc(0);
    },
    async writeFile() {},
    async exists() {
      return true;
    },
    async listFiles() {
      return [];
    },
    async mkdtemp() {
      return "/tmp/x";
    },
    async updateNetworkPolicy() {},
    async applyCredentialBrokerRules() {},
    async usage() {
      return { activeCpuMs: 1, wallClockMs: 1, networkEgressBytes: 1 };
    },
    async destroy() {
      this.destroyed = true;
    },
  };
}

async function seedRun(pool, { spendCapUsd = 25, wallClockCapSeconds = 7200 } = {}) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "local",
    sourceReference: "session-poll",
    title: "t",
    description: "d",
    acceptanceCriteria: [],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd, wallClockCapSeconds });
  for (const next of ["CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING"]) {
    await advanceRun(pool, run.id, next, "seed");
  }
  return run.id;
}

function makeDeps(pool, worker, handle, workspaceId) {
  const registry = new SandboxRegistry();
  if (handle && workspaceId) registry.put(workspaceId, handle);
  return {
    pool,
    worker,
    registry,
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
      railsCheckIntervalMs: DEFAULT_SESSION_POLL_INTERVAL_MS,
      usdPerCpuMs: 0,
      usdPerEgressByte: 0,
      makerModel: "m",
      modelPricing: { usdPerInputToken: 0, usdPerOutputToken: 0 },
    },
  };
}

function makeContext(engineeringRunId, { cancelled = false } = {}) {
  return {
    engineeringRunId,
    state: "IMPLEMENTING",
    attempt: 1,
    isCancellationRequested: async () => cancelled,
    takeSignals: async () => [],
    runs: null,
  };
}

const event = (type, extra = {}) => ({ type, ...extra });

// --- the arithmetic, asserted rather than believed -----------------------------------------

test("the poll interval and the enforcement lag it implies are stated, not assumed", () => {
  assert.equal(DEFAULT_SESSION_POLL_INTERVAL_MS, 60_000);

  // The bound: a run may exceed a rail by at most one poll interval of agent activity.
  const wallClockCapSeconds = 7200; // ADR-0011's DEFAULT_WALL_CLOCK_CAP_SECONDS
  const lagFraction = DEFAULT_SESSION_POLL_INTERVAL_MS / 1000 / wallClockCapSeconds;
  assert.ok(lagFraction < 0.01, `enforcement lag is ${(lagFraction * 100).toFixed(2)}% of the cap`);

  // And the property that actually matters against a Workflow step: a *unit of work* is one
  // poll, and the interval is spent by the provider between steps rather than inside one.
  const STEP_CEILING_MS = 800_000;
  assert.ok(
    DEFAULT_SESSION_POLL_INTERVAL_MS < STEP_CEILING_MS / 10,
    "even if an entire poll interval were spent inside a step, it would not approach the ceiling",
  );
});

test("a real streaming adapter implements poll() — the fallback is for replays only", () => {
  assert.equal(
    typeof CodexWorkerAdapter.prototype.poll,
    "function",
    "an adapter driving a live agent must not fall back to draining events(), which blocks " +
      "for the whole session and brings the 800s step ceiling straight back",
  );
});

/**
 * "Exactly one rails enforcement point remains — demonstrate it, do not assert it."
 *
 * Two different claims, checked separately because they are different:
 *
 * 1. **While a session is running**, rails are enforced in exactly one file. That is the one
 *    #197 is about: two copies of a spend cap drift into a system where the first turn is
 *    capped and the second is not.
 * 2. **At stage entry**, several handlers gate on the rails before starting work. Those are
 *    pre-flight checks, not in-session enforcement, and they predate this change. They are
 *    enumerated rather than counted, so adding a sixth is a visible diff rather than a silent
 *    drift.
 *
 * What this cannot see: a call made through a function passed in as a parameter. Nothing in
 * `src/factory/workflow/handlers/` does that today; if one ever does, this check will still
 * pass and will be wrong.
 */
test("rails are enforced from exactly one place while a session is running", () => {
  const handlersDir = join(repoRoot, "src", "factory", "workflow", "handlers");
  const files = readdirSync(handlersDir).filter((f) => f.endsWith(".ts"));

  const callers = [];
  for (const file of files) {
    const source = readFileSync(join(handlersDir, file), "utf8");
    // Calls, not imports and not prose: `await enforceSpendAndTimeRails(`.
    const calls = source.match(/enforceSpendAndTimeRails\s*\(/g) ?? [];
    if (calls.length > 0) callers.push([file, calls.length]);
  }

  const byFile = Object.fromEntries(callers);
  assert.equal(
    byFile["session-turn.ts"],
    1,
    "session-turn.ts is the single in-session enforcement point, and calls it once per poll",
  );

  assert.deepEqual(
    callers.map(([file]) => file).sort(),
    // The stage-entry gates, enumerated. session-turn.ts is the in-session one.
    // human-editing.ts: the turn after a hand back (ADR-0029 §3.7) gates its entry like a repair turn.
    ["human-editing.ts", "implementing.ts", "intake.ts", "provisioning.ts", "repairing.ts", "session-turn.ts", "verifying.ts"],
    "a new file enforcing the rails is a deliberate change, not an accident",
  );
});

test("both callers reach the rails only through the shared poll", () => {
  const handlersDir = join(repoRoot, "src", "factory", "workflow", "handlers");
  for (const file of ["implementing.ts", "repairing.ts"]) {
    const source = readFileSync(join(handlersDir, file), "utf8");
    assert.match(
      source,
      /pollSession\(/,
      `${file} drives its session through the shared pollSession`,
    );
    assert.doesNotMatch(
      source,
      /worker\.poll\(|\.events\(/,
      `${file} must not read the event stream itself — that is how two copies of the rails start`,
    );
  }
});

// --- behaviour that only exists in the new model ---------------------------------------------

test("a summary accumulates across polls and survives a process boundary", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRun(pool);
    const agentRun = await insertAgentRun(pool, {
      engineeringRunId: runId,
      workerType: "stepped",
      model: "m",
      role: "implementer",
      tokenUsage: null,
    });

    const batches = [
      [event("started"), event("test_started", { command: "npm test" })],
      [event("test_finished", { command: "npm test", exitCode: 0, passed: true })],
      [event("file_changed", { path: "src/a.ts" }), event("file_changed", { path: "src/b.ts" })],
      [event("message", { text: "done" }), event("completed")],
    ];

    /**
     * Each poll uses a **brand new `deps`** — a new registry, a new session registry, a fresh
     * adapter object rebuilt from its reference. Nothing in memory carries over, which is the
     * whole point: under #197 each poll may be a different process, and a summary that only
     * accumulated in a local variable would come back empty every time.
     */
    let ref = null;
    let last;
    let polls = 0;
    for (;;) {
      const worker = new SteppedWorkerAdapter(batches);
      const session = ref ? await worker.attach(ref) : await worker.start();
      const deps = makeDeps(pool, worker, null, null);
      last = await pollSession(deps, makeContext(runId), session, agentRun.id);
      polls += 1;
      if (last.finished) break;
      const progress = await loadSessionProgress(pool, agentRun.id);
      assert.ok(progress, "an unfinished turn leaves its accumulator in Postgres");
      ref = progress.sessionRef;
      assert.ok(ref, "and the reference that re-acquires the session");
      if (polls > 20) throw new Error("the poll loop did not converge");
    }

    assert.ok(polls > 1, `the turn genuinely spanned several polls (${polls})`);
    assert.deepEqual(
      last.summary.tests,
      [{ command: "npm test", exitCode: 0, passed: true }],
      "a test result observed on poll 2 is still in the summary at the end",
    );
    assert.deepEqual(last.summary.filesChanged, ["src/a.ts", "src/b.ts"]);
    assert.equal(last.summary.finalMessage, "done");
    assert.equal(last.summary.eventCounts.started, 1);
    assert.equal(last.summary.eventCounts.file_changed, 2);

    /**
     * #340: the scaffolding is *kept*, marked ended, until the stage records completion on the
     * `AgentRun` (it is the stage, not the poll, that deletes it). Deleting it here left a window
     * in which a crash made the redelivery launch a second agent. A later poll still cannot think
     * the turn is live: it returns the finished summary without reading again.
     */
    const ended = await loadSessionProgress(pool, agentRun.id);
    assert.ok(ended?.turnEndedAt, "the turn is recorded as ended, not as in flight");
    const worker = new SteppedWorkerAdapter(batches);
    const again = await pollSession(makeDeps(pool, worker, null, null), makeContext(runId), await worker.attach(ended.sessionRef), agentRun.id);
    assert.equal(again.finished, true);
    assert.deepEqual(again.summary, last.summary, "a redelivered poll of an ended turn changes nothing");
    assert.equal(worker.polls, 0, "and does not read the agent again");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("the multi-poll summary equals the single-process result", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const batches = [
      [event("started"), event("file_changed", { path: "a" })],
      [event("test_finished", { command: "t", exitCode: 1, passed: false })],
      [event("file_changed", { path: "b" }), event("completed")],
    ];

    const drive = async (withholdAt) => {
      const runId = await seedRun(pool);
      const agentRun = await insertAgentRun(pool, {
        engineeringRunId: runId,
        workerType: "stepped",
        model: "m",
        role: "implementer",
        tokenUsage: null,
      });
      let ref = null;
      let last;
      for (let i = 0; i < 20; i++) {
        const worker = new SteppedWorkerAdapter(batches, { withholdAt });
        const session = ref ? await worker.attach(ref) : await worker.start();
        last = await pollSession(pool && makeDeps(pool, worker, null, null), makeContext(runId), session, agentRun.id);
        if (last.finished) break;
        ref = (await loadSessionProgress(pool, agentRun.id))?.sessionRef ?? null;
      }
      return last.summary;
    };

    const straight = await drive([]);
    // The same session, with a lossy tail: poll 2 hands back nothing and re-offers it later.
    const lossy = await drive([2]);

    assert.deepEqual(
      { ...lossy, filesChanged: [...lossy.filesChanged].sort() },
      { ...straight, filesChanged: [...straight.filesChanged].sort() },
      "no event is lost or duplicated when a poll's output arrives late",
    );
    assert.deepEqual(straight.tests, [{ command: "t", exitCode: 1, passed: false }]);
    assert.deepEqual(straight.filesChanged, ["a", "b"]);
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

// --- the caps, and the sandbox they must destroy ---------------------------------------------

/**
 * The assertion this issue names as the leak: a cap that stops the agent and leaves a billing
 * microVM behind **has not capped spend**. So each case below asserts the destruction, not just
 * the `stoppedBy`.
 */
async function capTripCase(pool, { overspend = false, overtime = false, cancelled = false }) {
  const runId = await seedRun(
    pool,
    overtime ? { wallClockCapSeconds: 0 } : { spendCapUsd: overspend ? 1 : 25 },
  );
  const agentRun = await insertAgentRun(pool, {
    engineeringRunId: runId,
    workerType: "stepped",
    model: "m",
    role: "implementer",
    tokenUsage: null,
  });
  const workspace = await insertWorkspace(pool, {
    engineeringRunId: runId,
    role: "maker",
    sandboxProvider: "fake",
    providerHandle: "sbx-197",
    repository: "r",
    baseSha: "a".repeat(40),
    workingBranch: null,
    status: "ready",
  });
  if (overspend) {
    await recordCost(pool, {
      engineeringRunId: runId,
      stageType: "agent_run",
      stageId: agentRun.id,
      kind: "model",
      usd: 5,
    });
  }

  // Two batches, so the breach lands *between* polls rather than before the first one.
  const worker = new SteppedWorkerAdapter([
    [event("started")],
    [event("thinking", { text: "..." })],
    [event("completed")],
  ]);
  const handle = recordingHandle("sbx-197");
  const deps = makeDeps(pool, worker, handle, workspace.id);
  const session = await worker.start();
  const context = makeContext(runId, { cancelled });

  const first = await pollSession(deps, context, session, agentRun.id);
  assert.equal(first.finished, cancelled || overspend || overtime, "the breach is seen on a poll");

  return { runId, workspaceId: workspace.id, handle, worker, summary: first.summary };
}

test("a spend cap trip stops the agent and destroys the sandbox", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const { workspaceId, handle, worker, summary } = await capTripCase(pool, { overspend: true });
    assert.equal(summary.stoppedBy, "spend_cap");
    assert.equal(worker.cancelled, true, "the agent was cancelled");
    assert.equal(handle.destroyed, true, "**and the sandbox was destroyed** — this is the leak");
    assert.equal((await getWorkspace(pool, workspaceId)).status, "destroyed");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("a wall-clock cap trip stops the agent and destroys the sandbox", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const { workspaceId, handle, worker, summary } = await capTripCase(pool, { overtime: true });
    assert.equal(summary.stoppedBy, "wall_clock_cap");
    assert.equal(worker.cancelled, true);
    assert.equal(handle.destroyed, true);
    assert.equal((await getWorkspace(pool, workspaceId)).status, "destroyed");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("a cancellation stops the agent and destroys the sandbox", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const { workspaceId, handle, worker, summary } = await capTripCase(pool, { cancelled: true });
    assert.equal(summary.stoppedBy, "cancellation");
    assert.equal(worker.cancelled, true);
    assert.equal(handle.destroyed, true);
    assert.equal((await getWorkspace(pool, workspaceId)).status, "destroyed");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("a run with no breach keeps its sandbox across polls", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const { workspaceId, handle, worker, summary } = await capTripCase(pool, {});
    assert.equal(summary.stoppedBy, undefined);
    assert.equal(worker.cancelled, false, "an untripped rail cancels nothing");
    assert.equal(handle.destroyed, false, "and destroys nothing — the maker is still needed");
    assert.equal((await getWorkspace(pool, workspaceId)).status, "ready");
    assert.equal((await listWorkspaces(pool, (await getWorkspace(pool, workspaceId)).engineeringRunId)).length, 1);
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

// --- the step ceiling ------------------------------------------------------------------------

test("a session longer than one step is many short units of work", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRun(pool);
    const agentRun = await insertAgentRun(pool, {
      engineeringRunId: runId,
      workerType: "stepped",
      model: "m",
      role: "implementer",
      tokenUsage: null,
    });

    // 40 polls at the 60 s interval is a 40-minute session — longer than 800 s by a factor of
    // three, and impossible for the blocking consumer this replaced.
    const batches = Array.from({ length: 40 }, (_, i) => [event("thinking", { text: `${i}` })]);
    batches.push([event("completed")]);

    let ref = null;
    let polls = 0;
    let slowest = 0;
    for (;;) {
      const worker = new SteppedWorkerAdapter(batches);
      const session = ref ? await worker.attach(ref) : await worker.start();
      const started = Date.now();
      const poll = await pollSession(pool && makeDeps(pool, worker, null, null), makeContext(runId), session, agentRun.id);
      slowest = Math.max(slowest, Date.now() - started);
      polls += 1;
      if (poll.finished) break;
      ref = (await loadSessionProgress(pool, agentRun.id))?.sessionRef ?? null;
      if (polls > 60) throw new Error("the poll loop did not converge");
    }

    const STEP_CEILING_MS = 800_000;
    const simulatedSessionMs = polls * DEFAULT_SESSION_POLL_INTERVAL_MS;
    assert.ok(
      simulatedSessionMs > STEP_CEILING_MS,
      `the session spans ${simulatedSessionMs} ms, past the ${STEP_CEILING_MS} ms step ceiling`,
    );
    assert.ok(
      slowest < STEP_CEILING_MS / 100,
      `the slowest single unit of work was ${slowest} ms — nowhere near the ceiling`,
    );
    assert.equal(polls, 41, "one poll per batch, and the numbers are asserted rather than assumed");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

// --- the contract ----------------------------------------------------------------------------

test("AgentSessionSummary keeps every field its consumers read", () => {
  const source = readFileSync(
    join(repoRoot, "src", "factory", "workflow", "handlers", "session-turn.ts"),
    "utf8",
  );
  // These are written to `AgentRun.result` and read downstream; #197 changed where the summary
  // is accumulated, not what it contains.
  for (const field of [
    "eventCounts",
    "tests",
    "filesChanged",
    "outcome",
    "error",
    "finalMessage",
    "truncatedDiff",
    "candidate",
    "selfReportDivergence",
    "stoppedBy",
  ]) {
    assert.match(source, new RegExp(`\\n  ${field}\\??:`), `AgentSessionSummary.${field} survives`);
  }
});

test("the durable accumulator holds no run state — Postgres stays the single authority", () => {
  const migration = readFileSync(
    join(repoRoot, "migrations", "0012_agent_session_progress.sql"),
    "utf8",
  );
  // ADR-0007 §1: a second store for *run state* is what this must never become. The table holds
  // one turn's in-flight bookkeeping and is deleted when the turn ends.
  for (const forbidden of ["status", "stop_reason", "verdict", "state"]) {
    assert.doesNotMatch(
      migration.replace(/--[^\n]*/g, ""),
      new RegExp(`^\\s+${forbidden}\\s`, "m"),
      `agent_session_progress must not carry a \`${forbidden}\` column`,
    );
  }
});

const rel = (p) => relative(repoRoot, p).split(sep).join("/");

test("no handler blocks on the full event stream any more", () => {
  const handlersDir = join(repoRoot, "src", "factory", "workflow", "handlers");
  const offenders = [];
  for (const name of readdirSync(handlersDir)) {
    const file = join(handlersDir, name);
    if (!statSync(file).isFile() || !name.endsWith(".ts")) continue;
    const source = readFileSync(file, "utf8");
    // `for await (const … of worker.events(` is the exact shape #197 removed. The fallback in
    // session-turn.ts is the one sanctioned use, and it is documented there as replay-only.
    const matches = source.match(/for await \([^)]*of [\w.]*\.events\(/g) ?? [];
    if (matches.length > 0 && name !== "session-turn.ts") offenders.push(rel(file));
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

// --- a stop preserves the work before the sandbox goes (2026-09-24) ---------

/**
 * What a stop used to throw away, and the invariant that must survive fixing it.
 *
 * Candidate capture runs at the end of a turn. A cancellation or a cap means that end never comes, so
 * `stopSession` destroyed the sandbox with every uncommitted edit still inside it — a run cancelled
 * twenty minutes in left no branch and nothing to look at.
 *
 * The fix is a hook called between `worker.cancel()` and the teardown. The thing these tests exist to
 * protect is that the hook cannot *prevent* the teardown: "a cap that stops the agent and leaves a
 * billing microVM behind has not capped spend" is the whole reason this code path exists, and a
 * best-effort convenience must not be able to break it.
 */

/** A workspace row plus a handle the registry will hand back, so teardown has something to destroy. */
async function seedWorkspace(pool, runId, handle) {
  const workspace = await insertWorkspace(pool, {
    engineeringRunId: runId,
    role: "maker",
    repository: "https://example.test/r.git",
    baseSha: "0".repeat(40),
    sandboxProvider: "fake",
    status: "ready",
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return workspace;
}

test("a cancelled session preserves its work before the sandbox is destroyed", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRun(pool);
    const agentRun = await insertAgentRun(pool, {
      engineeringRunId: runId,
      workerType: "stepped",
      model: "m",
      role: "implementer",
      tokenUsage: null,
    });
    const handle = recordingHandle("ws-preserve");
    const workspace = await seedWorkspace(pool, runId, handle);

    const worker = new SteppedWorkerAdapter([[event("started")]]);
    const deps = makeDeps(pool, worker, handle, workspace.id);

    const order = [];
    const originalDestroy = handle.destroy.bind(handle);
    handle.destroy = async () => {
      order.push("destroy");
      await originalDestroy();
    };

    const poll = await pollSession(
      deps,
      makeContext(runId, { cancelled: true }),
      await worker.start(),
      agentRun.id,
      {
        beforeTeardown: async () => {
          order.push("preserve");
        },
      },
    );

    assert.equal(poll.summary.stoppedBy, "cancellation");
    assert.deepEqual(
      order,
      ["preserve", "destroy"],
      "the work has to be taken out of the sandbox before the sandbox is destroyed",
    );
    assert.equal(worker.cancelled, true, "the agent is stopped first — that is what stops the burn");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("a hook that throws does not save the sandbox from teardown", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRun(pool, { spendCapUsd: 1 });
    const agentRun = await insertAgentRun(pool, {
      engineeringRunId: runId,
      workerType: "stepped",
      model: "m",
      role: "implementer",
      tokenUsage: null,
    });
    await recordCost(pool, {
      engineeringRunId: runId,
      stageType: "agent_run",
      stageId: agentRun.id,
      kind: "model",
      tokensIn: null,
      tokensOut: null,
      usd: 5,
    });
    const handle = recordingHandle("ws-throwing-hook");
    const workspace = await seedWorkspace(pool, runId, handle);

    const worker = new SteppedWorkerAdapter([[event("started")]]);
    const deps = makeDeps(pool, worker, handle, workspace.id);

    /*
     * A push that fails is an ordinary outcome on this path — the credential expired, the remote
     * refused, the sandbox is already unreachable. If any of those could skip the teardown below, a
     * spend cap would stop the agent and leave the meter running: the exact failure the cap exists to
     * prevent, reintroduced by the feature that preserves work.
     */
    const poll = await pollSession(deps, makeContext(runId), await worker.start(), agentRun.id, {
      beforeTeardown: async () => {
        throw new Error("push refused: credential expired");
      },
    });

    assert.equal(poll.summary.stoppedBy, "spend_cap");
    assert.equal(handle.destroyed, true, "the sandbox must be destroyed even when preserving failed");
    const [row] = await listWorkspaces(pool, runId);
    assert.notEqual(row.status, "ready", "the workspace row must not still claim to be live");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("no hook is the old behaviour exactly — stop, then tear down", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRun(pool);
    const agentRun = await insertAgentRun(pool, {
      engineeringRunId: runId,
      workerType: "stepped",
      model: "m",
      role: "implementer",
      tokenUsage: null,
    });
    const handle = recordingHandle("ws-no-hook");
    const workspace = await seedWorkspace(pool, runId, handle);
    const worker = new SteppedWorkerAdapter([[event("started")]]);
    const deps = makeDeps(pool, worker, handle, workspace.id);

    const poll = await pollSession(
      deps,
      makeContext(runId, { cancelled: true }),
      await worker.start(),
      agentRun.id,
    );
    assert.equal(poll.summary.stoppedBy, "cancellation");
    assert.equal(handle.destroyed, true);
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("the note a run carries distinguishes preserved, nothing-to-preserve, and failed", () => {
  /*
   * Three sentences for three outcomes, and the third is why this function exists: silence would make
   * "the agent had not changed anything yet" and "we threw your work away" look identical from
   * outside the run.
   */
  assert.match(
    preservedNote({ candidateSha: "abc1234", workingBranch: "windkeel/task-1", empty: false }),
    /work preserved on windkeel\/task-1 at abc1234/,
  );
  assert.match(
    preservedNote({ candidateSha: null, workingBranch: null, empty: true }),
    /changed nothing, so there was nothing to preserve/,
  );
  assert.match(preservedNote(null), /nothing could be preserved/);
});
