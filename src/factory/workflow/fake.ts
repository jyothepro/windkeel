import {
  IllegalTransitionError,
  TERMINAL_STATES,
  transition,
  type RunState,
} from "../run-state-machine.js";
import type { StopReason } from "../rails.js";
import {
  UnknownRunError,
  type CancellationResult,
  type DeliveredSignal,
  type RunSignal,
  type RunStateSnapshot,
  type RunStateStore,
  type RunStatus,
  type SignalReceipt,
  type StageContext,
  type StageHandler,
  type StageOutcome,
  type StartRunResult,
  type WorkflowProvider,
  type WorkflowProviderCapabilities,
} from "./provider.js";

export type WorkflowCallRecord =
  | { type: "startRun"; engineeringRunId: string; enqueued: boolean }
  | { type: "handler_started"; state: RunState; handler: string; attempt: number }
  | { type: "handler_outcome"; state: RunState; handler: string; outcome: StageOutcome }
  | { type: "polled"; state: RunState; reason: string; afterMs: number }
  | { type: "handler_threw"; state: RunState; handler: string; attempt: number; error: string }
  | { type: "transition"; from: RunState; to: RunState; reason: string | null }
  | { type: "signal"; engineeringRunId: string; signal: RunSignal }
  | { type: "signals_taken"; engineeringRunId: string; count: number }
  | { type: "cancel"; engineeringRunId: string; settled: boolean }
  | { type: "status"; engineeringRunId: string; state: RunState }
  | { type: "parked"; state: RunState; reason: string };

interface InMemoryRun {
  state: RunState;
  blockedFrom: RunState | null;
  stopReason: StopReason | null;
  lastReasonInto: Map<RunState, string | null>;
}

export class InMemoryRunStateStore implements RunStateStore {
  private readonly runs = new Map<string, InMemoryRun>();

  seed(engineeringRunId: string, state: RunState = "CREATED"): void {
    this.runs.set(engineeringRunId, { state, blockedFrom: null, stopReason: null, lastReasonInto: new Map() });
  }

  async read(engineeringRunId: string): Promise<RunStateSnapshot | null> {
    const run = this.runs.get(engineeringRunId);
    if (!run) return null;
    return { state: run.state, blockedFrom: run.blockedFrom, stopReason: run.stopReason };
  }

  async commit(
    engineeringRunId: string,
    to: RunState,
    reason: string | null,
    stopReason?: StopReason | null,
  ): Promise<RunStateSnapshot> {
    const run = this.runs.get(engineeringRunId);
    if (!run) throw new UnknownRunError(engineeringRunId);
    if (run.state === to && run.lastReasonInto.has(to) && run.lastReasonInto.get(to) === reason) {
      return { state: run.state, blockedFrom: run.blockedFrom, stopReason: run.stopReason };
    }
    const { next } = transition({ state: run.state, blockedFrom: run.blockedFrom }, to, reason);
    run.state = next.state;
    run.blockedFrom = next.blockedFrom;
    run.lastReasonInto.set(to, reason);
    if (stopReason !== undefined) run.stopReason = stopReason;
    return { state: run.state, blockedFrom: run.blockedFrom, stopReason: run.stopReason };
  }
}

export interface FakeWorkflowProviderOptions {
  store?: RunStateStore;
  maxAttempts?: number;
  maxSteps?: number;
}

interface QueuedJob {
  engineeringRunId: string;
  attempt: number;
}

export class FakeWorkflowProvider implements WorkflowProvider {
  readonly name = "fake";
  readonly capabilities: WorkflowProviderCapabilities = {
    durableAcrossRestart: false,
    retriesFailedStages: true,
    reclaimsExpiredJobs: false,
  };

  readonly calls: WorkflowCallRecord[] = [];

  private readonly handlers = new Map<RunState, StageHandler>();
  private readonly signals = new Map<string, DeliveredSignal[]>();
  private readonly cancellations = new Set<string>();
  private readonly queue: QueuedJob[] = [];
  private readonly memory: InMemoryRunStateStore | null;
  private readonly store: RunStateStore;
  private readonly maxAttempts: number;
  private readonly maxSteps: number;
  private running = false;
  private inHandler = false;
  private nextSignalId = 1;

  constructor(options: FakeWorkflowProviderOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.maxSteps = options.maxSteps ?? 100;
    this.memory = options.store ? null : new InMemoryRunStateStore();
    const backing = options.store ?? (this.memory as RunStateStore);
    const calls = this.calls;
    this.store = {
      read: (id) => backing.read(id),
      async commit(id, to, reason, stopReason) {
        const before = await backing.read(id);
        const after = await backing.commit(id, to, reason, stopReason);
        calls.push({ type: "transition", from: before?.state ?? to, to: after.state, reason });
        return after;
      },
    };
  }

  seed(engineeringRunId: string, state: RunState = "CREATED"): void {
    if (!this.memory) {
      throw new Error(
        "FakeWorkflowProvider.seed: this provider was constructed with an external " +
          "RunStateStore, so runs come from there. Create the row through the store's own " +
          "persistence instead.",
      );
    }
    this.memory.seed(engineeringRunId, state);
  }

  async snapshot(engineeringRunId: string): Promise<RunStateSnapshot | null> {
    return this.store.read(engineeringRunId);
  }

  register(handler: StageHandler): void {
    if (this.handlers.has(handler.state)) {
      throw new Error(
        `FakeWorkflowProvider: a handler is already registered for ${handler.state} ` +
          `(${this.handlers.get(handler.state)?.name}); one stage owns one state.`,
      );
    }
    this.handlers.set(handler.state, handler);
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async startRun(engineeringRunId: string): Promise<StartRunResult> {
    const snapshot = await this.requireRun(engineeringRunId);
    const inFlight =
      this.queue.some((j) => j.engineeringRunId === engineeringRunId) || this.inHandler;
    const enqueued = !inFlight && !TERMINAL_STATES.has(snapshot.state);
    if (enqueued) this.queue.push({ engineeringRunId, attempt: 1 });
    this.calls.push({ type: "startRun", engineeringRunId, enqueued });
    return { engineeringRunId, state: snapshot.state, enqueued };
  }

  async signal(engineeringRunId: string, signal: RunSignal): Promise<SignalReceipt> {
    const snapshot = await this.requireRun(engineeringRunId);
    const id = `sig-${this.nextSignalId++}`;
    const pending = this.signals.get(engineeringRunId) ?? [];
    pending.push({ id, engineeringRunId, signal, receivedAt: new Date(0) });
    this.signals.set(engineeringRunId, pending);
    this.calls.push({ type: "signal", engineeringRunId, signal });
    const live = !TERMINAL_STATES.has(snapshot.state);
    if (live && this.queue.length === 0) this.queue.push({ engineeringRunId, attempt: 1 });
    return { id, handledInline: false, delivered: live };
  }

  async cancel(engineeringRunId: string, reason = "cancelled by operator"): Promise<CancellationResult> {
    const snapshot = await this.requireRun(engineeringRunId);
    this.cancellations.add(engineeringRunId);

    let cancelledJobs = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]?.engineeringRunId === engineeringRunId) {
        this.queue.splice(i, 1);
        cancelledJobs++;
      }
    }

    let settled = TERMINAL_STATES.has(snapshot.state);
    let state = snapshot.state;
    if (!settled && !this.inHandler) {
      state = (await this.store.commit(engineeringRunId, "CANCELLED", reason, null)).state;
      settled = true;
    }
    this.calls.push({ type: "cancel", engineeringRunId, settled });
    return { settled, state, cancelledJobs };
  }

  async status(engineeringRunId: string): Promise<RunStatus> {
    const snapshot = await this.requireRun(engineeringRunId);
    const queued = this.queue.filter((j) => j.engineeringRunId === engineeringRunId).length;
    this.calls.push({ type: "status", engineeringRunId, state: snapshot.state });
    return {
      engineeringRunId,
      state: snapshot.state,
      blockedFrom: snapshot.blockedFrom,
      stopReason: snapshot.stopReason,
      terminal: TERMINAL_STATES.has(snapshot.state),
      cancellationRequested: this.cancellations.has(engineeringRunId),
      inFlight: { queued, active: this.inHandler ? 1 : 0 },
      pendingSignals: (this.signals.get(engineeringRunId) ?? []).length,
    };
  }

  async drain(): Promise<void> {
    if (!this.running) {
      throw new Error("FakeWorkflowProvider.drain: call start() first");
    }
    let steps = 0;
    while (this.queue.length > 0) {
      if (++steps > this.maxSteps) {
        throw new Error(
          `FakeWorkflowProvider.drain: ${this.maxSteps} steps without quiescence — ` +
            "the registered handlers are cycling.",
        );
      }
      const job = this.queue.shift();
      if (!job) break;
      await this.runOne(job);
    }
  }

  private async runOne(job: QueuedJob): Promise<void> {
    const snapshot = await this.requireRun(job.engineeringRunId);
    if (TERMINAL_STATES.has(snapshot.state)) return;

    if (this.cancellations.has(job.engineeringRunId)) {
      await this.store.commit(job.engineeringRunId, "CANCELLED", "cancelled by operator", null);
      return;
    }

    const handler = this.handlers.get(snapshot.state);
    if (!handler) {
      this.calls.push({
        type: "parked",
        state: snapshot.state,
        reason: "no handler registered for this state",
      });
      return;
    }

    const context: StageContext = {
      engineeringRunId: job.engineeringRunId,
      state: snapshot.state,
      attempt: job.attempt,
      isCancellationRequested: async () => this.cancellations.has(job.engineeringRunId),
      takeSignals: async () => {
        const pending = this.signals.get(job.engineeringRunId) ?? [];
        this.signals.set(job.engineeringRunId, []);
        this.calls.push({
          type: "signals_taken",
          engineeringRunId: job.engineeringRunId,
          count: pending.length,
        });
        return pending;
      },
      runs: this.store,
    };

    this.calls.push({
      type: "handler_started",
      state: snapshot.state,
      handler: handler.name,
      attempt: job.attempt,
    });

    let outcome: StageOutcome;
    this.inHandler = true;
    try {
      outcome = await handler.handle(context);
    } catch (err) {
      if (err instanceof IllegalTransitionError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.calls.push({
        type: "handler_threw",
        state: snapshot.state,
        handler: handler.name,
        attempt: job.attempt,
        error: message,
      });
      if (job.attempt < this.maxAttempts) {
        this.queue.push({ engineeringRunId: job.engineeringRunId, attempt: job.attempt + 1 });
      } else {
        await this.store.commit(job.engineeringRunId, "FAILED", message, "error");
      }
      return;
    } finally {
      this.inHandler = false;
    }

    this.calls.push({
      type: "handler_outcome",
      state: snapshot.state,
      handler: handler.name,
      outcome,
    });

    if (
      this.cancellations.has(job.engineeringRunId) &&
      outcome.kind !== "wait" &&
      outcome.kind !== "poll"
    ) {
      await this.store.commit(job.engineeringRunId, "CANCELLED", "cancelled by operator", null);
      return;
    }

    if (outcome.kind === "wait") {
      this.calls.push({ type: "parked", state: snapshot.state, reason: outcome.reason });
      return;
    }
    if (outcome.kind === "poll") {
      this.calls.push({
        type: "polled",
        state: snapshot.state,
        reason: outcome.reason,
        afterMs: outcome.afterMs,
      });
      this.queue.push({ engineeringRunId: job.engineeringRunId, attempt: 1 });
      return;
    }
    if (outcome.kind === "settled") {
      const current = await this.store.read(job.engineeringRunId);
      if (current && !TERMINAL_STATES.has(current.state) && current.state !== snapshot.state) {
        this.queue.push({ engineeringRunId: job.engineeringRunId, attempt: 1 });
      }
      return;
    }

    const committed = await this.store.commit(
      job.engineeringRunId,
      outcome.to,
      outcome.reason ?? null,
      outcome.stopReason ?? null,
    );
    if (!TERMINAL_STATES.has(committed.state)) {
      this.queue.push({ engineeringRunId: job.engineeringRunId, attempt: 1 });
    }
  }

  private async requireRun(engineeringRunId: string): Promise<RunStateSnapshot> {
    const snapshot = await this.store.read(engineeringRunId);
    if (!snapshot) throw new UnknownRunError(engineeringRunId);
    return snapshot;
  }
}
