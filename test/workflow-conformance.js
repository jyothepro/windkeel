import assert from "node:assert/strict";
import { test } from "node:test";
import { UnknownRunError } from "../dist/factory/workflow/provider.js";

/**
 * One behaviour suite, two backings. #127 asked for "a shared conformance suite rather than
 * two divergent test files", and this is it: `FakeWorkflowProvider` and
 * `PgBossWorkflowProvider` run these same cases, so a semantic the fake has and the real
 * provider lacks (or vice versa) fails a test rather than being discovered by M4.4.
 *
 * A harness is `{ seed, startRun, settle, transitions, snapshot, status, provider, cleanup }`.
 * `settle()` means "run everything that is runnable and come back when nothing is in flight":
 * an explicit `drain()` for the fake, a poll-to-quiescence for pg-boss. Everything else is
 * provider-agnostic by construction.
 *
 * Two behaviours are deliberately *not* here, because the two providers honestly differ and
 * pretending otherwise would weaken both:
 *
 * - **An `IllegalTransitionError` out of a handler.** The fake rethrows it out of `drain()`,
 *   because a test author *is* the caller and surfacing it to them is the whole value of a
 *   double. The real provider has no caller — it is inside a job — so it fails the run
 *   instead. Each is tested in its own file.
 * - **Durability across restart.** Only one of them claims it (`capabilities`), and it is
 *   tested where it is true.
 */

/** A handler that always advances to `to`. */
export function stage(state, to, options = {}) {
  return {
    state,
    name: options.name ?? `${state}->${to}`,
    async handle(context) {
      if (options.onHandle) {
        const early = await options.onHandle(context);
        if (early) return early;
      }
      return { kind: "transition", to };
    },
  };
}

/** The M4 spine below PROVISIONING — the stages M6 will fill in. */
export const SPINE = [
  stage("CREATED", "CLASSIFYING"),
  stage("CLASSIFYING", "PLANNING"),
  stage("PLANNING", "PROVISIONING"),
];

const CASES = [
  {
    name: "startRun drives the registered handlers through a legal state sequence, in order",
    handlers: () => [
      ...SPINE,
      stage("PROVISIONING", "IMPLEMENTING"),
      stage("IMPLEMENTING", "VERIFYING"),
      stage("VERIFYING", "PR_CREATING"),
      stage("PR_CREATING", "PR_READY"),
    ],
    async run(h) {
      const runId = await h.seed("CREATED");
      const result = await h.startRun(runId);
      assert.equal(result.enqueued, true);
      await h.settle(runId);

      assert.deepEqual(await h.transitions(runId), [
        "CREATED->CLASSIFYING",
        "CLASSIFYING->PLANNING",
        "PLANNING->PROVISIONING",
        "PROVISIONING->IMPLEMENTING",
        "IMPLEMENTING->VERIFYING",
        "VERIFYING->PR_CREATING",
        "PR_CREATING->PR_READY",
      ]);
      assert.equal((await h.snapshot(runId)).state, "PR_READY");
    },
  },

  {
    name: "startRun on a run already under way does not enqueue a second job",
    handlers: () => SPINE,
    async run(h) {
      const runId = await h.seed("CREATED");
      assert.equal((await h.startRun(runId)).enqueued, true);
      assert.equal((await h.startRun(runId)).enqueued, false);
      await h.settle(runId);
      assert.deepEqual(await h.transitions(runId), [
        "CREATED->CLASSIFYING",
        "CLASSIFYING->PLANNING",
        "PLANNING->PROVISIONING",
      ]);
    },
  },

  {
    name: "an unknown run id fails clearly on startRun, status, cancel, and signal",
    handlers: () => [],
    async run(h) {
      const missing = "00000000-0000-0000-0000-0000000000ff";
      await assert.rejects(() => h.provider.startRun(missing), UnknownRunError);
      await assert.rejects(() => h.provider.status(missing), UnknownRunError);
      await assert.rejects(() => h.provider.cancel(missing), UnknownRunError);
      await assert.rejects(
        () => h.provider.signal(missing, { type: "approval_granted", actor: "x" }),
        UnknownRunError,
      );
    },
  },

  {
    name: "a signal persisted while nothing is running is picked up by the next delivery",
    handlers: () => [
      {
        state: "WAITING_FOR_APPROVAL",
        name: "approval-gate",
        async handle(context) {
          const signals = await context.takeSignals();
          const approval = signals.find((s) => s.signal.type === "approval_granted");
          if (!approval) return { kind: "wait", reason: "no approval yet" };
          return { kind: "transition", to: "PROVISIONING", reason: "approved" };
        },
      },
    ],
    async run(h) {
      const runId = await h.seed("WAITING_FOR_APPROVAL");
      await h.startRun(runId);
      await h.settle(runId);
      assert.equal((await h.snapshot(runId)).state, "WAITING_FOR_APPROVAL", "parked, not moved");

      const receipt = await h.provider.signal(runId, {
        type: "approval_granted",
        actor: "operator",
      });
      assert.equal(receipt.handledInline, false, "a signal never invokes a handler inline");

      await h.settle(runId);
      assert.equal((await h.snapshot(runId)).state, "PROVISIONING");
    },
  },

  {
    name: "a signal consumed by one delivery is not re-delivered to the next",
    handlers: () => {
      const seen = [];
      return {
        handlers: [
          {
            state: "PROVISIONING",
            name: "counts-signals",
            async handle(context) {
              seen.push((await context.takeSignals()).length);
              return { kind: "transition", to: "IMPLEMENTING" };
            },
          },
          {
            state: "IMPLEMENTING",
            name: "counts-signals-again",
            async handle(context) {
              seen.push((await context.takeSignals()).length);
              return { kind: "transition", to: "VERIFYING" };
            },
          },
        ],
        seen,
      };
    },
    async run(h, extra) {
      const runId = await h.seed("PROVISIONING");
      await h.provider.signal(runId, { type: "human_response", actor: "op", text: "go" });
      await h.startRun(runId);
      await h.settle(runId);
      assert.deepEqual(extra.seen, [1, 0]);
    },
  },

  {
    name: "cancel mid-stage lands the run in CANCELLED and no further handler runs",
    handlers: () => {
      const ran = [];
      let providerRef = null;
      return {
        handlers: [
          {
            state: "PROVISIONING",
            name: "provision",
            async handle(context) {
              ran.push("provision");
              await providerRef.cancel(context.engineeringRunId, "operator changed their mind");
              return { kind: "transition", to: "IMPLEMENTING" };
            },
          },
          {
            state: "IMPLEMENTING",
            name: "implement",
            async handle() {
              ran.push("implement");
              return { kind: "transition", to: "VERIFYING" };
            },
          },
        ],
        ran,
        bind: (provider) => {
          providerRef = provider;
        },
      };
    },
    async run(h, extra) {
      const runId = await h.seed("PROVISIONING");
      await h.startRun(runId);
      await h.settle(runId);

      assert.deepEqual(extra.ran, ["provision"], "no handler runs after the cancel is honoured");
      assert.equal((await h.snapshot(runId)).state, "CANCELLED");
      assert.deepEqual(await h.transitions(runId), ["PROVISIONING->CANCELLED"]);
    },
  },

  {
    name: "cancel is not instantaneous: settled is false while a handler holds the run",
    handlers: () => {
      let providerRef = null;
      const results = [];
      return {
        handlers: [
          {
            state: "IMPLEMENTING",
            name: "long-stage",
            async handle(context) {
              results.push(await providerRef.cancel(context.engineeringRunId));
              if (await context.isCancellationRequested()) {
                return { kind: "settled", observed: "IMPLEMENTING", note: "cancellation observed" };
              }
              return { kind: "transition", to: "VERIFYING" };
            },
          },
        ],
        results,
        bind: (provider) => {
          providerRef = provider;
        },
      };
    },
    async run(h, extra) {
      const runId = await h.seed("IMPLEMENTING");
      await h.startRun(runId);
      await h.settle(runId);

      assert.equal(extra.results[0].settled, false, "a held run is not settled by cancel alone");
      // The handler observed the latch cooperatively and made no transition of its own — but
      // the run does not strand at IMPLEMENTING: the provider commits CANCELLED once the
      // handler has released it. `settled: false` means "not yet", never "not going to".
      assert.deepEqual(await h.transitions(runId), ["IMPLEMENTING->CANCELLED"]);
      assert.equal((await h.snapshot(runId)).state, "CANCELLED");
      assert.equal((await h.status(runId)).cancellationRequested, true);
    },
  },

  {
    name: "a handler that throws is retried to the limit, then the run FAILS with stop_reason error",
    handlers: () => {
      const attempts = [];
      return {
        handlers: [
          {
            state: "PROVISIONING",
            name: "always-throws",
            async handle(context) {
              attempts.push(context.attempt);
              throw new Error("sandbox provider unavailable");
            },
          },
        ],
        attempts,
      };
    },
    async run(h, extra) {
      const runId = await h.seed("PROVISIONING");
      await h.startRun(runId);
      await h.settle(runId);

      assert.deepEqual(extra.attempts, [1, 2, 3], "three deliveries, 1-based, in order");
      assert.deepEqual(await h.transitions(runId), ["PROVISIONING->FAILED"]);
      assert.equal((await h.snapshot(runId)).stopReason, "error");
    },
  },

  {
    name: "a handler that throws once and then succeeds is retried and the run continues",
    handlers: () => [
      {
        state: "PROVISIONING",
        name: "flaky",
        async handle(context) {
          if (context.attempt === 1) throw new Error("transient");
          return { kind: "transition", to: "IMPLEMENTING" };
        },
      },
    ],
    async run(h) {
      const runId = await h.seed("PROVISIONING");
      await h.startRun(runId);
      await h.settle(runId);
      assert.deepEqual(await h.transitions(runId), ["PROVISIONING->IMPLEMENTING"]);
    },
  },

  {
    name: "a job delivered twice produces exactly one transition and one side effect",
    handlers: () => {
      const sideEffects = [];
      return {
        handlers: [
          {
            state: "PROVISIONING",
            name: "guarded-provision",
            async handle(context) {
              // ADR-0007 §4: the guard is a state check, not a lock.
              const snapshot = await context.runs.read(context.engineeringRunId);
              if (snapshot.state !== "PROVISIONING") {
                return { kind: "settled", observed: snapshot.state, note: "already provisioned" };
              }
              sideEffects.push(context.attempt);
              return { kind: "transition", to: "IMPLEMENTING" };
            },
          },
          stage("IMPLEMENTING", "VERIFYING"),
        ],
        sideEffects,
      };
    },
    async run(h, extra) {
      const runId = await h.seed("PROVISIONING");
      await h.startRun(runId);
      await h.deliverAgain(runId);
      await h.settle(runId);

      assert.equal(extra.sideEffects.length, 1, "the guarded side effect happens exactly once");
      assert.deepEqual(await h.transitions(runId), [
        "PROVISIONING->IMPLEMENTING",
        "IMPLEMENTING->VERIFYING",
      ]);
    },
  },

  {
    /**
     * #197's `poll`: a stage making progress it cannot finish in one delivery. Added here
     * rather than tested per-provider because the point of the outcome is that *every* backing
     * redelivers rather than parking — a provider that treated it like `wait` would strand a
     * run with a live agent and a live sandbox, and that failure is invisible until a bill
     * arrives.
     *
     * The case does not assert the *delay*: `FakeWorkflowProvider` has no clock by design (see
     * its handling of this outcome), so a timing assertion would be meaningless there and
     * flaky elsewhere. The delay's arithmetic is asserted in `test/session-poll.test.js`.
     */
    name: "a stage that polls is redelivered until it finishes, without parking",
    handlers: () => {
      const seen = [];
      return {
        handlers: [
          {
            state: "IMPLEMENTING",
            name: "polls-twice",
            async handle(context) {
              seen.push(context.attempt);
              if (seen.length < 3) {
                return { kind: "poll", afterMs: 10, reason: "still working" };
              }
              return { kind: "transition", to: "VERIFYING" };
            },
          },
        ],
        seen,
      };
    },
    async run(h, extra) {
      const runId = await h.seed("IMPLEMENTING");
      await h.startRun(runId);
      await h.settle(runId);

      assert.equal(extra.seen.length, 3, "two polls and then the transition");
      assert.deepEqual(
        extra.seen,
        [1, 1, 1],
        "a poll is not a retry: `attempt` resets, because nothing failed",
      );
      assert.deepEqual(await h.transitions(runId), ["IMPLEMENTING->VERIFYING"]);
      assert.equal((await h.snapshot(runId)).state, "VERIFYING");
    },
  },

  {
    name: "a state with no registered handler parks the run instead of erroring",
    handlers: () => [stage("CREATED", "CLASSIFYING")],
    async run(h) {
      const runId = await h.seed("CREATED");
      await h.startRun(runId);
      await h.settle(runId);
      assert.equal((await h.snapshot(runId)).state, "CLASSIFYING");
    },
  },

  {
    name: "status reports the run row plus in-flight liveness once quiescent",
    handlers: () => SPINE,
    async run(h) {
      const runId = await h.seed("CREATED");
      await h.startRun(runId);
      await h.settle(runId);

      const status = await h.status(runId);
      assert.deepEqual(
        {
          state: status.state,
          terminal: status.terminal,
          queued: status.inFlight.queued,
          active: status.inFlight.active,
          cancellationRequested: status.cancellationRequested,
          pendingSignals: status.pendingSignals,
        },
        {
          state: "PROVISIONING",
          terminal: false,
          queued: 0,
          active: 0,
          cancellationRequested: false,
          pendingSignals: 0,
        },
      );
    },
  },

  {
    name: "registering two handlers for one state is refused",
    handlers: () => [],
    async run(h) {
      h.provider.register(stage("PROVISIONING", "IMPLEMENTING"));
      assert.throws(
        () => h.provider.register(stage("PROVISIONING", "BLOCKED")),
        /already registered for PROVISIONING/,
      );
    },
  },
];

/**
 * Runs every conformance case against one backing. `makeHarness(handlers)` must construct a
 * provider, register `handlers`, `start()` it, and return the harness.
 */
export function runConformanceSuite(label, makeHarness, options = {}) {
  for (const testCase of CASES) {
    test(`${label}: ${testCase.name}`, { skip: options.skip ?? false }, async () => {
      const built = testCase.handlers();
      const handlers = Array.isArray(built) ? built : built.handlers;
      const extra = Array.isArray(built) ? {} : built;
      const harness = await makeHarness(handlers);
      if (extra.bind) extra.bind(harness.provider);
      try {
        await testCase.run(harness, extra);
      } finally {
        await harness.cleanup();
      }
    });
  }
}
