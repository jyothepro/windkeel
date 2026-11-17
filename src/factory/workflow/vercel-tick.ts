

import type { Pool } from "pg";
import { terminalStateFor } from "../rails.js";
import type { Log } from "../stage-wiring.js";
import { describeError, redactSecrets } from "../log.js";
import { IllegalTransitionError, TERMINAL_STATES, type RunState } from "../run-state-machine.js";
import type { TickResult } from "./vercel-flow.js";
import { resetReclaimCount } from "./stores/workflow-run-binding-store.js";
import {
  UnknownRunError,
  type DeliveredSignal,
  type RunStateStore,
  type StageContext,
  type StageHandler,
  type StageOutcome,
} from "./provider.js";
import { LOGGED_END_STATES, LOGGED_TEXT_MAX_CHARS } from "./vercel-provider-policy.js";
import type { BindingPhase } from "./vercel-bindings.js";

export interface TickHost {
  readonly pool: Pool;
  readonly store: RunStateStore;
  readonly handlers: ReadonlyMap<RunState, StageHandler>;
  readonly log: Log;
  readonly maxAttempts: number;
  claimTick(engineeringRunId: string, executionToken?: string): Promise<boolean>;
  stillOwns(engineeringRunId: string, executionToken?: string): Promise<boolean>;
  setPhase(
    engineeringRunId: string,
    phase: BindingPhase,
    attempt: number,
    ...fence: [executionToken?: string]
  ): Promise<Date | null>;
  isCancellationRequested(engineeringRunId: string): Promise<boolean>;
  takeSignals(engineeringRunId: string): Promise<DeliveredSignal[]>;
  arrivedSince(engineeringRunId: string, since: Date): Promise<boolean>;
}

export async function runTick(
  host: TickHost,
  engineeringRunId: string,
  attempt: number,
  executionToken?: string,
): Promise<TickResult> {
  const store = host.store;

  if (!(await host.claimTick(engineeringRunId, executionToken))) {
    return superseded(host, engineeringRunId);
  }

  const snapshot = await store.read(engineeringRunId);
  if (!snapshot) throw new UnknownRunError(engineeringRunId);
  if (TERMINAL_STATES.has(snapshot.state)) {
    return finish(host, engineeringRunId, snapshot.state, executionToken);
  }

  if (await host.isCancellationRequested(engineeringRunId)) {
    await store.commit(engineeringRunId, "CANCELLED", "cancelled by operator", null);
    return finish(host, engineeringRunId, "CANCELLED", executionToken);
  }

  const handler = host.handlers.get(snapshot.state);

  if (!handler) return finish(host, engineeringRunId, snapshot.state, executionToken);

  const handlerStartedAt = await host.setPhase(engineeringRunId, "running", attempt, executionToken);

  const context: StageContext = {
    engineeringRunId,
    state: snapshot.state,
    attempt,
    isCancellationRequested: () => host.isCancellationRequested(engineeringRunId),
    takeSignals: () => host.takeSignals(engineeringRunId),
    runs: store,
  };

  try {
    return await runHandler(host, handler, context, snapshot.state, store, executionToken, handlerStartedAt);
  } catch (err) {

    if (!(await host.stillOwns(engineeringRunId, executionToken))) {
      return superseded(host, engineeringRunId);
    }

    const message = err instanceof Error ? err.message : String(err);
    const lastAttempt = err instanceof IllegalTransitionError || attempt >= host.maxAttempts;

    host.log("stage threw", {
      engineeringRunId,
      stage: handler.name,
      state: snapshot.state,
      attempt,
      final: lastAttempt,
      ...describeError(err),
      ...(err instanceof Error && err.stack ? { stack: redactSecrets(err.stack).slice(0, LOGGED_TEXT_MAX_CHARS) } : {}),
    });
    if (!lastAttempt) {
      await host.setPhase(engineeringRunId, "retrying", attempt, executionToken);
      return { kind: "retry" };
    }

    await store.commit(engineeringRunId, terminalStateFor("error"), message, "error");
    return finish(host, engineeringRunId, terminalStateFor("error"), executionToken);
  }
}

async function runHandler(
  host: TickHost,
  handler: StageHandler,
  context: StageContext,
  entryState: RunState,
  store: RunStateStore,
  executionToken: string | undefined,
  handlerStartedAt: Date | null,
): Promise<TickResult> {
  const engineeringRunId = context.engineeringRunId;
  const outcome: StageOutcome = await handler.handle(context);

  if (!(await host.stillOwns(engineeringRunId, executionToken))) {
    return superseded(host, engineeringRunId);
  }

  if (outcome.kind === "wait") return park(host, engineeringRunId, handlerStartedAt, executionToken);

  if (outcome.kind === "poll") {
    await host.setPhase(engineeringRunId, "running", 1, executionToken);
    return { kind: "poll", afterMs: outcome.afterMs };
  }

  if (await host.isCancellationRequested(engineeringRunId)) {
    await store.commit(engineeringRunId, "CANCELLED", "cancelled by operator", null);
    return finish(host, engineeringRunId, "CANCELLED", executionToken);
  }

  if (outcome.kind === "settled") {
    const current = await store.read(engineeringRunId);
    if (!current || TERMINAL_STATES.has(current.state)) {
      return finish(host, engineeringRunId, current?.state ?? entryState, executionToken);
    }

    if (current.state !== entryState) {
      await host.setPhase(engineeringRunId, "queued", 1, executionToken);
      return { kind: "continue" };
    }
    return park(host, engineeringRunId, handlerStartedAt, executionToken);
  }

  const committed = await store.commit(
    engineeringRunId,
    outcome.to,
    outcome.reason ?? null,
    outcome.stopReason ?? null,
  );

  if (LOGGED_END_STATES.has(committed.state)) {
    host.log("stage ended the run", {
      engineeringRunId,
      stage: handler.name,
      from: entryState,
      to: committed.state,
      stopReason: outcome.stopReason ?? null,
      reason: outcome.reason ? redactSecrets(outcome.reason).slice(0, LOGGED_TEXT_MAX_CHARS) : null,
    });
  }

  await resetReclaimCount(host.pool, engineeringRunId, executionToken ?? null);
  if (TERMINAL_STATES.has(committed.state)) {
    return finish(host, engineeringRunId, committed.state, executionToken);
  }
  await host.setPhase(engineeringRunId, "queued", 1, executionToken);
  return { kind: "continue" };
}

async function park(
  host: TickHost,
  engineeringRunId: string,
  handlerStartedAt: Date | null,
  executionToken: string | undefined,
): Promise<TickResult> {
  await host.setPhase(engineeringRunId, "waiting", 1, executionToken);
  if (handlerStartedAt && (await host.arrivedSince(engineeringRunId, handlerStartedAt))) {
    await host.setPhase(engineeringRunId, "queued", 1, executionToken);
    return { kind: "continue" };
  }
  return { kind: "wait" };
}

async function finish(
  host: TickHost,
  engineeringRunId: string,
  state: RunState,
  executionToken?: string,
): Promise<TickResult> {
  await host.setPhase(engineeringRunId, "finished", 1, executionToken);
  return { kind: "finished", state };
}

export function superseded(host: TickHost, engineeringRunId: string): TickResult {
  host.log("an execution the stalled-run sweep replaced woke and stood down", { engineeringRunId });
  return { kind: "finished", state: "superseded" };
}
