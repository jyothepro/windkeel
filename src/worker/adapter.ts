import type { RepairPacket } from "@windkeel/verification/engine/repair.js";
import type { CredentialBrokerRule, SandboxHandle } from "../sandbox/provider.js";

export type WorkerEvent =
  | {
      type: "started";
      sessionId?: string;
    }
  | { type: "thinking"; text: string }
  | { type: "command_started"; command: string }
  | {
      type: "command_finished";
      command: string;
      exitCode: number | null;
      output?: string;
    }
  | { type: "test_started"; command: string }
  | {
      type: "test_finished";
      command: string;
      exitCode: number | null;
      output?: string;
      passed: boolean;
    }
  | { type: "file_changed"; path: string; kind?: FileChangeKind }
  | { type: "message"; text: string }
  | { type: "completed"; usage?: WorkerUsage }
  | { type: "failed"; error: string };

export type FileChangeKind = "add" | "update" | "delete";

export interface WorkerUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface WorkerModelRoute {
  model: string;
  provider: string;
  baseUrl?: string;
  modelApiDomain: string;
  credentialRules: CredentialBrokerRule[];
}

export interface WorkerStartInput {
  prompt: string;
  sandbox: SandboxHandle;
  workdir?: string;
  route?: WorkerModelRoute;
  harnessVersion?: string;
}

export interface WorkerSession {
  readonly id: string;
  workerSessionId?: string | undefined;
}

export interface WorkerMessage {
  text?: string;
  repairPacket?: RepairPacket;
}

export type WorkerOutcome = "completed" | "failed" | "cancelled";

export interface WorkerDiff {
  patch: string;
  filesChanged: string[];
  truncated: boolean;
  error?: string;
}

export interface WorkerResult {
  outcome: WorkerOutcome;
  error?: string;
  diff: WorkerDiff;
  usage?: WorkerUsage;
  cumulativeUsage?: WorkerUsage;
  finalMessage?: string;
  selfReportDivergence?: { onlyReportedByAgent: string[]; onlyInWorkspace: string[] };
  harnessReportedCostUsd?: number;
}

export interface WorkerPoll {
  readonly events: WorkerEvent[];
  readonly turnEnded: boolean;
}

export interface WorkerAdapterCapabilities {
  resumableSessions: boolean;
  reattachableSessions: boolean;
  reattachedSessionsAcceptNewTurns: boolean;
  pollable: boolean;
  reportsUsage: boolean;
  reportsFileChanges: boolean;
  providers: readonly string[];
}

export interface WorkerSessionRef {
  readonly id: string;
  readonly workerType: string;
  readonly workerSessionId?: string | undefined;
  readonly adapterState: Record<string, unknown>;
}

export class WorkerNotReattachableError extends Error {
  constructor(adapterName: string) {
    super(
      `worker: the "${adapterName}" adapter cannot reattach a session ` +
        "(capabilities.reattachableSessions is false)",
    );
    this.name = "WorkerNotReattachableError";
  }
}

export class WorkerSessionGoneError extends Error {
  constructor(id: string, detail: string) {
    super(`worker: session ${id} cannot be re-acquired — ${detail}`);
    this.name = "WorkerSessionGoneError";
  }
}

export class WorkerRouteChangedError extends Error {
  constructor(id: string, startedOn: string, resolved: string) {
    super(
      `worker: session ${id} started on ${startedOn} and this delivery resolved ${resolved}. A ` +
        "resumed turn keeps its model and provider; changing either between attempts is the " +
        "escalation ADR-0011 §2 forbids.",
    );
    this.name = "WorkerRouteChangedError";
  }
}

export interface WorkerAdapter {
  readonly name: string;
  readonly capabilities: WorkerAdapterCapabilities;
  readonly version?: string;
  start(input: WorkerStartInput): Promise<WorkerSession>;
  useRoute?(session: WorkerSession, route: WorkerModelRoute): void;
  reference(session: WorkerSession): WorkerSessionRef;
  attach(ref: WorkerSessionRef, sandbox: SandboxHandle): Promise<WorkerSession>;
  send(session: WorkerSession, message: WorkerMessage): Promise<void>;
  events(session: WorkerSession): AsyncIterable<WorkerEvent>;
  poll?(session: WorkerSession): Promise<WorkerPoll>;
  cancel(session: WorkerSession): Promise<void>;
  result(session: WorkerSession): Promise<WorkerResult>;
}
