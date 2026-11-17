import type { StopReason } from "../rails.js";
import type { RunState } from "../run-state-machine.js";

export type RunSignal =
  | { type: "approval_granted"; actor: string }
  | { type: "approval_denied"; actor: string; reason: string }
  | { type: "human_response"; actor: string; text: string }
  | { type: "human_intent"; intent: "takeover" | "submit" | "handback"; actor: string }
  | { type: "external_event"; source: string; name: string; payload: unknown };

export interface DeliveredSignal {
  readonly id: string;
  readonly engineeringRunId: string;
  readonly signal: RunSignal;
  readonly receivedAt: Date;
}

export interface RunStateStore {
  read(engineeringRunId: string): Promise<RunStateSnapshot | null>;
  commit(
    engineeringRunId: string,
    to: RunState,
    reason: string | null,
    stopReason?: StopReason | null,
  ): Promise<RunStateSnapshot>;
}

export interface RunStateSnapshot {
  readonly state: RunState;
  readonly blockedFrom: RunState | null;
  readonly stopReason: StopReason | null;
}

export interface StageContext {
  readonly engineeringRunId: string;
  readonly state: RunState;
  readonly attempt: number;
  isCancellationRequested(): Promise<boolean>;
  takeSignals(): Promise<DeliveredSignal[]>;
  readonly runs: RunStateStore;
}

export type StageOutcome =
  | {
      kind: "transition";
      to: RunState;
      reason?: string | null;
      stopReason?: StopReason | null;
    }
  | { kind: "settled"; observed: RunState; note?: string }
  | { kind: "wait"; reason: string }
  | {
      kind: "poll";
      afterMs: number;
      reason: string;
    };

export interface StageHandler {
  readonly state: RunState;
  readonly name: string;
  handle(context: StageContext): Promise<StageOutcome>;
}

export interface WorkflowProviderCapabilities {
  durableAcrossRestart: boolean;
  retriesFailedStages: boolean;
  reclaimsExpiredJobs: boolean;
}

export interface StartRunResult {
  readonly engineeringRunId: string;
  readonly state: RunState;
  readonly enqueued: boolean;
}

export interface SignalReceipt {
  readonly id: string;
  readonly handledInline: false;
  readonly delivered: boolean;
}

export interface CancellationResult {
  readonly settled: boolean;
  readonly state: RunState;
  readonly cancelledJobs: number;
}

export interface RunStatus {
  readonly engineeringRunId: string;
  readonly state: RunState;
  readonly blockedFrom: RunState | null;
  readonly stopReason: StopReason | null;
  readonly terminal: boolean;
  readonly cancellationRequested: boolean;
  readonly inFlight: { readonly queued: number; readonly active: number };
  readonly pendingSignals: number;
}

export class UnknownRunError extends Error {
  constructor(engineeringRunId: string) {
    super(`workflow: no engineering_run ${engineeringRunId}`);
    this.name = "UnknownRunError";
  }
}

export interface WorkflowProvider {
  readonly name: string;
  readonly capabilities: WorkflowProviderCapabilities;

  register(handler: StageHandler): void;

  start(): Promise<void>;
  stop(): Promise<void>;

  startRun(engineeringRunId: string): Promise<StartRunResult>;

  signal(engineeringRunId: string, signal: RunSignal): Promise<SignalReceipt>;

  cancel(engineeringRunId: string, reason?: string): Promise<CancellationResult>;

  status(engineeringRunId: string): Promise<RunStatus>;
}
