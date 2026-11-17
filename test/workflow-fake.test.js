import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { UnknownRunError } from "../dist/factory/workflow/provider.js";
import { IllegalTransitionError } from "../dist/factory/run-state-machine.js";
import { runConformanceSuite } from "./workflow-conformance.js";

/**
 * The shared behaviour suite first (test/workflow-conformance.js) — the same cases
 * `PgBossWorkflowProvider` runs, so a semantic that drifts between the two fails here rather
 * than surfacing in M4.4. The fake-specific tests below cover what only a test double can or
 * should do.
 */
let fakeRunCounter = 0;
runConformanceSuite("fake", async (handlers) => {
  const provider = new FakeWorkflowProvider();
  for (const handler of handlers) provider.register(handler);
  await provider.start();
  let currentId = null;
  return {
    provider,
    async seed(state) {
      currentId = `fake-run-${++fakeRunCounter}`;
      provider.seed(currentId, state);
      return currentId;
    },
    startRun: (runId) => provider.startRun(runId),
    status: (runId) => provider.status(runId),
    settle: () => provider.drain(),
    async transitions() {
      return provider.calls.filter((c) => c.type === "transition").map((c) => `${c.from}->${c.to}`);
    },
    async snapshot(runId) {
      return provider.snapshot(runId);
    },
    async deliverAgain(runId) {
      await provider.startRun(runId);
    },
    async cleanup() {
      await provider.stop();
    },
  };
});

/**
 * No database, no network, no pg-boss — the same posture as test/sandbox-fake.test.js and
 * test/worker-fake.test.js. Every assertion about sequencing reads off the ordered timeline
 * rather than counting calls, because ordering is what this seam is for.
 */

/** A handler that always advances to `to`. */
function stage(state, to, options = {}) {
  return {
    state,
    name: options.name ?? `${state}->${to}`,
    async handle(context) {
      if (options.onHandle) {
        const early = await options.onHandle(context);
        if (early) return early;
      }
      return { kind: "transition", to, ...(options.reason ? { reason: options.reason } : {}) };
    },
  };
}

/** The M4 spine, minus the stages M6 owns: CREATED -> ... -> PROVISIONING. */
function spine(provider, extra = []) {
  provider.register(stage("CREATED", "CLASSIFYING"));
  provider.register(stage("CLASSIFYING", "PLANNING"));
  provider.register(stage("PLANNING", "PROVISIONING"));
  for (const handler of extra) provider.register(handler);
}

function transitions(provider) {
  return provider.calls
    .filter((c) => c.type === "transition")
    .map((c) => `${c.from}->${c.to}`);
}

async function started(provider, runId = "run-1", state = "CREATED") {
  provider.seed(runId, state);
  await provider.start();
  return runId;
}

test("startRun drives the registered handlers through a legal state sequence, in order", async () => {
  const provider = new FakeWorkflowProvider();
  spine(provider, [
    stage("PROVISIONING", "IMPLEMENTING"),
    stage("IMPLEMENTING", "VERIFYING"),
    stage("VERIFYING", "PR_CREATING"),
    stage("PR_CREATING", "PR_READY"),
    stage("PR_READY", "WAITING_FOR_HUMAN"),
  ]);
  const runId = await started(provider);

  const result = await provider.startRun(runId);
  assert.deepEqual(
    { enqueued: result.enqueued, state: result.state },
    { enqueued: true, state: "CREATED" },
  );

  await provider.drain();

  assert.deepEqual(transitions(provider), [
    "CREATED->CLASSIFYING",
    "CLASSIFYING->PLANNING",
    "PLANNING->PROVISIONING",
    "PROVISIONING->IMPLEMENTING",
    "IMPLEMENTING->VERIFYING",
    "VERIFYING->PR_CREATING",
    "PR_CREATING->PR_READY",
    "PR_READY->WAITING_FOR_HUMAN",
  ]);
  assert.equal((await provider.snapshot(runId)).state, "WAITING_FOR_HUMAN");
});

test("a handler requesting an illegal transition surfaces IllegalTransitionError, not a no-op", async () => {
  const provider = new FakeWorkflowProvider();
  provider.register(stage("CREATED", "PR_READY"));
  const runId = await started(provider);
  await provider.startRun(runId);

  await assert.rejects(() => provider.drain(), IllegalTransitionError);
  // The run did not move, and no transition was recorded.
  assert.equal((await provider.snapshot(runId)).state, "CREATED");
  assert.deepEqual(transitions(provider), []);
});

test("startRun is idempotent: a second call does not enqueue a second job", async () => {
  const provider = new FakeWorkflowProvider();
  spine(provider);
  const runId = await started(provider);

  assert.equal((await provider.startRun(runId)).enqueued, true);
  assert.equal((await provider.startRun(runId)).enqueued, false);
  await provider.drain();
  assert.deepEqual(transitions(provider), [
    "CREATED->CLASSIFYING",
    "CLASSIFYING->PLANNING",
    "PLANNING->PROVISIONING",
  ]);
});

test("startRun on an unknown run throws UnknownRunError", async () => {
  const provider = new FakeWorkflowProvider();
  await provider.start();
  await assert.rejects(() => provider.startRun("nope"), UnknownRunError);
});

test("a signal is data: it is persisted, returns without invoking a handler, and the waiting handler observes it", async () => {
  const provider = new FakeWorkflowProvider();
  let seenByHandler = null;
  provider.register({
    state: "WAITING_FOR_APPROVAL",
    name: "approval-gate",
    async handle(context) {
      const signals = await context.takeSignals();
      const approval = signals.find((s) => s.signal.type === "approval_granted");
      if (!approval) return { kind: "wait", reason: "no approval yet" };
      seenByHandler = approval.signal;
      return { kind: "transition", to: "PROVISIONING", reason: "approved" };
    },
  });
  const runId = await started(provider, "run-approval", "WAITING_FOR_APPROVAL");

  await provider.startRun(runId);
  await provider.drain();
  // Parked: no approval was waiting.
  assert.equal((await provider.snapshot(runId)).state, "WAITING_FOR_APPROVAL");
  assert.ok(provider.calls.some((c) => c.type === "parked" && c.reason === "no approval yet"));

  const receipt = await provider.signal(runId, { type: "approval_granted", actor: "operator" });
  assert.equal(receipt.handledInline, false, "signal never invokes a handler inline");
  assert.equal(seenByHandler, null, "and nothing ran as a side effect of signalling");

  await provider.drain();
  assert.deepEqual(seenByHandler, { type: "approval_granted", actor: "operator" });
  assert.equal((await provider.snapshot(runId)).state, "PROVISIONING");
});

test("a signal consumed by one delivery is not re-delivered to the next", async () => {
  const provider = new FakeWorkflowProvider();
  const counts = [];
  provider.register({
    state: "PROVISIONING",
    name: "counts-signals",
    async handle(context) {
      counts.push((await context.takeSignals()).length);
      return { kind: "transition", to: "IMPLEMENTING" };
    },
  });
  provider.register({
    state: "IMPLEMENTING",
    name: "counts-signals-again",
    async handle(context) {
      counts.push((await context.takeSignals()).length);
      return { kind: "transition", to: "VERIFYING" };
    },
  });
  const runId = await started(provider, "run-sig", "PROVISIONING");
  await provider.signal(runId, { type: "human_response", actor: "operator", text: "go" });
  await provider.startRun(runId);
  await provider.drain();

  assert.deepEqual(counts, [1, 0]);
});

test("cancel mid-run stops subsequent handlers and is visible on the timeline", async () => {
  const provider = new FakeWorkflowProvider();
  const ran = [];
  provider.register({
    state: "PROVISIONING",
    name: "provision",
    async handle(context) {
      ran.push("provision");
      // An operator cancels while this stage is running.
      await provider.cancel(context.engineeringRunId, "operator changed their mind");
      return { kind: "transition", to: "IMPLEMENTING" };
    },
  });
  provider.register({
    state: "IMPLEMENTING",
    name: "implement",
    async handle() {
      ran.push("implement");
      return { kind: "transition", to: "VERIFYING" };
    },
  });
  const runId = await started(provider, "run-cancel", "PROVISIONING");
  await provider.startRun(runId);
  await provider.drain();

  assert.deepEqual(ran, ["provision"], "no handler runs after the cancellation is honoured");
  assert.equal((await provider.snapshot(runId)).state, "CANCELLED");
  // Deterministic and stated: a cancellation observed before the commit beats the transition.
  assert.deepEqual(transitions(provider), ["PROVISIONING->CANCELLED"]);
  assert.ok(
    provider.calls.some((c) => c.type === "cancel" && c.settled === false),
    "cancel does not pretend to be instantaneous while a handler is mid-stage",
  );
});

test("a handler that observes cancellation cooperatively settles, and the provider then commits CANCELLED", async () => {
  const provider = new FakeWorkflowProvider();
  let observed = false;
  provider.register({
    state: "IMPLEMENTING",
    name: "long-stage",
    async handle(context) {
      await provider.cancel(context.engineeringRunId);
      // The cooperative observation point a streaming session polls.
      if (await context.isCancellationRequested()) {
        observed = true;
        return { kind: "settled", observed: "IMPLEMENTING", note: "cancellation observed" };
      }
      return { kind: "transition", to: "VERIFYING" };
    },
  });
  const runId = await started(provider, "run-coop", "IMPLEMENTING");
  await provider.startRun(runId);
  await provider.drain();

  assert.equal(observed, true);
  // The handler made no transition of its own — but the run does not strand at IMPLEMENTING
  // with a latch nobody acts on. The provider commits CANCELLED once the handler releases it.
  assert.equal((await provider.snapshot(runId)).state, "CANCELLED");
  assert.deepEqual(transitions(provider), ["IMPLEMENTING->CANCELLED"]);
});

test("a handler that throws is retried to the attempt limit, then the run FAILS with stop_reason error", async () => {
  const provider = new FakeWorkflowProvider({ maxAttempts: 3 });
  const attempts = [];
  provider.register({
    state: "PROVISIONING",
    name: "always-throws",
    async handle(context) {
      attempts.push(context.attempt);
      throw new Error("sandbox provider unavailable");
    },
  });
  const runId = await started(provider, "run-throw", "PROVISIONING");
  await provider.startRun(runId);
  await provider.drain();

  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(transitions(provider), ["PROVISIONING->FAILED"]);
  assert.equal((await provider.snapshot(runId)).stopReason, "error");
  assert.equal(
    provider.calls.filter((c) => c.type === "handler_threw").length,
    3,
    "every failed attempt is on the timeline, not just the last",
  );
});

test("a handler that throws once and then succeeds is retried and the run completes", async () => {
  const provider = new FakeWorkflowProvider({ maxAttempts: 3 });
  provider.register({
    state: "PROVISIONING",
    name: "flaky",
    async handle(context) {
      if (context.attempt === 1) throw new Error("transient");
      return { kind: "transition", to: "IMPLEMENTING" };
    },
  });
  const runId = await started(provider, "run-flaky", "PROVISIONING");
  await provider.startRun(runId);
  await provider.drain();

  assert.deepEqual(transitions(provider), ["PROVISIONING->IMPLEMENTING"]);
});

test("a settled outcome re-reads the run rather than transitioning — the retry-after-commit case", async () => {
  const provider = new FakeWorkflowProvider();
  let provisionCalls = 0;
  provider.register({
    state: "PROVISIONING",
    name: "guarded-provision",
    async handle(context) {
      // The exactly-once state check: has someone already moved this run past PROVISIONING?
      const snapshot = await context.runs.read(context.engineeringRunId);
      if (snapshot.state !== "PROVISIONING") {
        return { kind: "settled", observed: snapshot.state, note: "already provisioned" };
      }
      provisionCalls++;
      return { kind: "transition", to: "IMPLEMENTING" };
    },
  });
  provider.register(stage("IMPLEMENTING", "VERIFYING"));
  const runId = await started(provider, "run-guard", "PROVISIONING");
  await provider.startRun(runId);
  await provider.startRun(runId);
  await provider.drain();

  assert.equal(provisionCalls, 1, "the guarded side effect happens exactly once");
  assert.deepEqual(transitions(provider), ["PROVISIONING->IMPLEMENTING", "IMPLEMENTING->VERIFYING"]);
});

test("status on an unknown run id fails clearly rather than fabricating a state", async () => {
  const provider = new FakeWorkflowProvider();
  await provider.start();
  await assert.rejects(() => provider.status("no-such-run"), UnknownRunError);
  await assert.rejects(() => provider.cancel("no-such-run"), UnknownRunError);
  await assert.rejects(
    () => provider.signal("no-such-run", { type: "approval_granted", actor: "x" }),
    UnknownRunError,
  );
});

test("status reports the run row plus in-flight liveness, and nothing invented", async () => {
  const provider = new FakeWorkflowProvider();
  spine(provider);
  const runId = await started(provider);
  await provider.startRun(runId);

  const queuedStatus = await provider.status(runId);
  assert.deepEqual(
    {
      state: queuedStatus.state,
      terminal: queuedStatus.terminal,
      queued: queuedStatus.inFlight.queued,
      active: queuedStatus.inFlight.active,
      cancellationRequested: queuedStatus.cancellationRequested,
      pendingSignals: queuedStatus.pendingSignals,
    },
    {
      state: "CREATED",
      terminal: false,
      queued: 1,
      active: 0,
      cancellationRequested: false,
      pendingSignals: 0,
    },
  );

  await provider.drain();
  const drained = await provider.status(runId);
  assert.equal(drained.inFlight.queued, 0);
  assert.equal(drained.state, "PROVISIONING");
});

test("capabilities are honest: the in-memory fake does not claim durability", () => {
  const provider = new FakeWorkflowProvider();
  assert.deepEqual(provider.capabilities, {
    durableAcrossRestart: false,
    retriesFailedStages: true,
    reclaimsExpiredJobs: false,
  });
});

test("registering two handlers for one state is refused", async () => {
  const provider = new FakeWorkflowProvider();
  provider.register(stage("PROVISIONING", "IMPLEMENTING"));
  assert.throws(
    () => provider.register(stage("PROVISIONING", "BLOCKED")),
    /already registered for PROVISIONING/,
  );
});

test("a state with no registered handler parks the run instead of erroring", async () => {
  const provider = new FakeWorkflowProvider();
  provider.register(stage("CREATED", "CLASSIFYING"));
  const runId = await started(provider);
  await provider.startRun(runId);
  await provider.drain();

  assert.equal((await provider.snapshot(runId)).state, "CLASSIFYING");
  assert.ok(
    provider.calls.some((c) => c.type === "parked" && c.state === "CLASSIFYING"),
    "the parking is visible rather than silent",
  );
});

test("drain before start() refuses rather than silently doing nothing", async () => {
  const provider = new FakeWorkflowProvider();
  await assert.rejects(() => provider.drain(), /call start\(\) first/);
});
