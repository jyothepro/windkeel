

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  finishExhaustedStaleBinding,
  reclaimStaleBinding,
  releaseStaleBinding,
  setReclaimedBindingHandle,
} from "./stores/workflow-run-binding-store.js";
import {
  countUnconsumedSignals,
  insertCancellation,
  insertRunSignal,
  selectCancellation,
} from "./stores/run-signal-store.js";
import { terminalStateFor } from "../rails.js";
import type { Log } from "../stage-wiring.js";
import { getEngineeringRun } from "../repositories.js";
import { IllegalTransitionError, TERMINAL_STATES, type RunState } from "../run-state-machine.js";
import type { PostgresRunStateStore } from "./run-state-store.js";
import type { StalledRunReclaim } from "../sweeps/stalled-runs.js";
import type { TickResult } from "./vercel-flow.js";
import type { VercelWorkflowProviderConfig } from "./vercel.js";
import {
  UnknownRunError,
  type CancellationResult,
  type DeliveredSignal,
  type RunSignal,
  type RunStateStore,
  type RunStatus,
  type SignalReceipt,
  type StageHandler,
  type StartRunResult,
  type WorkflowProviderCapabilities,
} from "./provider.js";
import {
  MAX_ATTEMPTS,
  RETRY_SLEEP_MS,
  VERCEL_WORKFLOW_CAPABILITIES,
  VERCEL_WORKFLOW_PROVIDER_NAME,
  WAIT_SLEEP_MS,
  WAKE_WINDOW_MS,
} from "./vercel-provider-policy.js";
import * as bindings from "./vercel-bindings.js";
import { runTick, type TickHost } from "./vercel-tick.js";

export { VERCEL_WORKFLOW_PROVIDER_NAME } from "./vercel-provider-policy.js";

export abstract class VercelWorkflowProviderCore {
  readonly name = VERCEL_WORKFLOW_PROVIDER_NAME;

  readonly capabilities: WorkflowProviderCapabilities = { ...VERCEL_WORKFLOW_CAPABILITIES };

  protected readonly handlers = new Map<RunState, StageHandler>();
  protected readonly maxTicks: number | undefined;

  protected readonly log: Log;
  protected readonly waitSleepMs: number;
  protected readonly retrySleepMs: number;
  protected readonly maxAttempts: number;
  protected readonly wakeWindowMs: number;

  protected pool: Pool | null = null;
  protected store: PostgresRunStateStore | null = null;
  protected started = false;

  constructor(protected readonly config: VercelWorkflowProviderConfig) {
    this.maxTicks = config.maxTicks;
    this.log = config.log ?? (() => {});
    this.waitSleepMs = config.waitSleepMs ?? WAIT_SLEEP_MS;
    this.retrySleepMs = config.retrySleepMs ?? RETRY_SLEEP_MS;
    this.maxAttempts = config.maxAttempts ?? MAX_ATTEMPTS;
    this.wakeWindowMs = config.wakeWindowMs ?? WAKE_WINDOW_MS;
  }

  register(handler: StageHandler): void {
    if (this.handlers.has(handler.state)) {
      throw new Error(
        `VercelWorkflowProvider: a handler is already registered for ${handler.state} ` +
          `(${this.handlers.get(handler.state)?.name}); one stage owns one state.`,
      );
    }
    this.handlers.set(handler.state, handler);
  }

  async reclaimStalled(
    engineeringRunId: string,
    options: { stalledForMs: number; maxReclaims: number },
  ): Promise<StalledRunReclaim> {
    const pool = this.requirePool();
    const run = await getEngineeringRun(pool, engineeringRunId);
    if (!run) return { kind: "skipped", why: "no such run" };
    const stale = `engineering_run_id = $1 and provider = $2
         and phase in ('queued', 'running', 'retrying', 'waiting')
         and updated_at < now() - ($3::bigint * interval '1 millisecond')`;
    const staleArgs = [engineeringRunId, this.name, String(options.stalledForMs)];

    if (TERMINAL_STATES.has(run.status)) {
      const rowCount = await releaseStaleBinding(pool, stale, staleArgs);
      return rowCount ? { kind: "released", state: run.status } : { kind: "skipped", why: "not stalled" };
    }

    const executionToken = randomUUID();
    const rows = await reclaimStaleBinding(pool, stale, staleArgs, executionToken, options.maxReclaims);
    if (rows.length === 0) {
      return await this.failStalledRun(engineeringRunId, run.status, stale, staleArgs, options.maxReclaims);
    }

    const execution = await this.startExecution(engineeringRunId, executionToken);
    await setReclaimedBindingHandle(pool, engineeringRunId, execution.runId, executionToken);
    this.log("re-dispatched a run whose step stopped making progress", {
      engineeringRunId,
      state: run.status,
      reclaims: rows[0]!.reclaim_count,
    });
    return { kind: "redispatched", state: run.status, reclaims: rows[0]!.reclaim_count };
  }

  protected async failStalledRun(
    engineeringRunId: string,
    state: RunState,
    stale: string,
    staleArgs: string[],
    maxReclaims: number,
  ): Promise<StalledRunReclaim> {
    const pool = this.requirePool();
    const rows = await finishExhaustedStaleBinding(pool, stale, staleArgs, randomUUID(), maxReclaims);
    if (rows.length === 0) return { kind: "skipped", why: "not stalled" };
    const reason =
      `the run's driving step stopped making progress at ${state} and was re-dispatched ` +
      `${rows[0]!.reclaim_count} time(s) without recovering; it is failed rather than re-dispatched ` +
      "again. Its sandbox is released by the sandbox reaper now that the run is terminal.";
    try {
      await this.requireStore().commit(engineeringRunId, terminalStateFor("error"), reason, "error");
    } catch (err) {

      if (!(err instanceof IllegalTransitionError)) throw err;
      return { kind: "skipped", why: "the run moved" };
    }
    this.log("failed a run whose step kept stalling", { engineeringRunId, state, reason });
    return { kind: "failed", state, reason };
  }

  async signal(engineeringRunId: string, signal: RunSignal): Promise<SignalReceipt> {
    const pool = this.requirePool();
    await this.requireRun(engineeringRunId);
    const { type, ...payload } = signal;
    const inserted = (await insertRunSignal(pool, engineeringRunId, type, JSON.stringify(payload)))!;
    const delivered =
      (await this.wake(engineeringRunId)) || (await this.adopt(engineeringRunId));
    if (!delivered) {

      this.log("signal written but nothing is carrying the run", {
        engineeringRunId,
        signal: signal.type,
        signalId: inserted.id,
        hint: "no execution to wake and no finished binding to adopt; the row waits at consumed_at is null",
      });
    }
    return { id: inserted.id, handledInline: false, delivered };
  }

  async recoverStranded(engineeringRunId: string): Promise<boolean> {
    return await this.adopt(engineeringRunId);
  }

  protected async adopt(engineeringRunId: string): Promise<boolean> {
    const binding = await this.binding(engineeringRunId);
    if (!binding) return false;
    if (binding.phase === "finished") {
      const { enqueued } = await this.startRun(engineeringRunId);
      return enqueued;
    }

    if (binding.phase !== "waiting") return false;
    if (!(await this.executionHasEnded(binding.executionHandle))) return false;

    await this.setPhase(engineeringRunId, "finished", 1);
    const { enqueued } = await this.startRun(engineeringRunId);
    return enqueued;
  }

  protected async hasPendingSignal(engineeringRunId: string): Promise<boolean> {
    return bindings.hasPendingSignal(this.requirePool(), engineeringRunId);
  }

  async cancel(
    engineeringRunId: string,
    reason = "cancelled by operator",
  ): Promise<CancellationResult> {
    const pool = this.requirePool();
    const run = await this.requireRun(engineeringRunId);

    await insertCancellation(pool, engineeringRunId, reason);

    const binding = await this.binding(engineeringRunId);
    await this.wake(engineeringRunId);

    if (TERMINAL_STATES.has(run.status)) {
      return { settled: true, state: run.status, cancelledJobs: 0 };
    }
    if (binding && binding.phase === "running") {

      return { settled: false, state: run.status, cancelledJobs: 0 };
    }
    if (binding && binding.phase !== "finished") {

      return { settled: false, state: run.status, cancelledJobs: 0 };
    }
    const committed = await this.requireStore().commit(engineeringRunId, "CANCELLED", reason, null);
    return { settled: true, state: committed.state, cancelledJobs: 0 };
  }

  async status(engineeringRunId: string): Promise<RunStatus> {
    const pool = this.requirePool();
    const snapshot = await this.requireStore().read(engineeringRunId);
    if (!snapshot) throw new UnknownRunError(engineeringRunId);

    const binding = await this.binding(engineeringRunId);
    const active = binding?.phase === "running" ? 1 : 0;
    const queued = binding && binding.phase !== "finished" && active === 0 ? 1 : 0;

    const cancelRows = await selectCancellation(pool, engineeringRunId);
    const signalRows = await countUnconsumedSignals(pool, engineeringRunId);

    return {
      engineeringRunId,
      state: snapshot.state,
      blockedFrom: snapshot.blockedFrom,
      stopReason: snapshot.stopReason,
      terminal: TERMINAL_STATES.has(snapshot.state),
      cancellationRequested: cancelRows.length > 0,
      inFlight: { queued, active },
      pendingSignals: signalRows[0]!.n,
    };
  }

  protected async runTick(
    engineeringRunId: string,
    attempt: number,
    executionToken?: string,
  ): Promise<TickResult> {
    const host: TickHost = {
      store: this.requireStore(),
      pool: this.requirePool(),
      handlers: this.handlers,
      log: this.log,
      maxAttempts: this.maxAttempts,
      claimTick: (id, token) => this.claimTick(id, token),
      stillOwns: (id, token) => this.stillOwns(id, token),
      setPhase: (id, phase, attempt, ...fence) => this.setPhase(id, phase, attempt, ...fence),
      isCancellationRequested: (id) => this.isCancellationRequested(id),
      takeSignals: (id) => this.takeSignals(id),
      arrivedSince: (id, since) => this.arrivedSince(id, since),
    };
    return runTick(host, engineeringRunId, attempt, executionToken);
  }

  protected async recordTickBudgetExhausted(engineeringRunId: string, executionToken?: string): Promise<void> {
    await bindings.recordTickBudgetExhausted(this.requirePool(), engineeringRunId, executionToken);
  }

  protected async setPhase(
    engineeringRunId: string,
    phase: bindings.BindingPhase,
    attempt: number,
    ...fence: [executionToken?: string]
  ): Promise<Date | null> {
    return bindings.setPhase(this.requirePool(), engineeringRunId, phase, attempt, ...fence);
  }

  protected async binding(engineeringRunId: string): Promise<bindings.Binding | null> {
    return bindings.readBinding(this.requirePool(), engineeringRunId);
  }

  protected async claimTick(engineeringRunId: string, executionToken?: string): Promise<boolean> {
    return bindings.claimTick(this.requirePool(), engineeringRunId, executionToken);
  }

  protected async stillOwns(engineeringRunId: string, executionToken?: string): Promise<boolean> {
    return bindings.stillOwns(this.requirePool(), engineeringRunId, executionToken);
  }

  protected async isCancellationRequested(engineeringRunId: string): Promise<boolean> {
    return bindings.isCancellationRequested(this.requirePool(), engineeringRunId);
  }

  protected async takeSignals(engineeringRunId: string): Promise<DeliveredSignal[]> {
    return bindings.takeSignals(this.requirePool(), engineeringRunId);
  }

  protected async arrivedSince(engineeringRunId: string, since: Date): Promise<boolean> {
    return bindings.arrivedSince(this.requirePool(), engineeringRunId, since);
  }

  protected async requireRun(engineeringRunId: string) {
    const run = await getEngineeringRun(this.requirePool(), engineeringRunId);
    if (!run) throw new UnknownRunError(engineeringRunId);
    return run;
  }

  protected requirePool(): Pool {
    if (!this.pool) {
      throw new Error("VercelWorkflowProvider: call start() before using the provider");
    }
    return this.pool;
  }

  protected requireStore(): RunStateStore {
    if (!this.store) {
      throw new Error("VercelWorkflowProvider: call start() before using the provider");
    }
    return this.store;
  }

  abstract startRun(engineeringRunId: string): Promise<StartRunResult>;
  protected abstract startExecution(engineeringRunId: string, executionToken: string): Promise<{ runId: string }>;
  protected abstract executionHasEnded(executionHandle: string): Promise<boolean>;
  protected abstract wake(engineeringRunId: string): Promise<boolean>;
}
