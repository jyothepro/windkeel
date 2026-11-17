import type { SandboxHandle } from "../sandbox/provider.js";
import { WorkerNotReattachableError, type WorkerPoll, type WorkerSessionRef } from "./adapter.js";
import type {
  WorkerAdapter,
  WorkerAdapterCapabilities,
  WorkerDiff,
  WorkerEvent,
  WorkerMessage,
  WorkerOutcome,
  WorkerResult,
  WorkerSession,
  WorkerStartInput,
  WorkerUsage,
} from "./adapter.js";

export interface ScriptedTurn {
  events: WorkerEvent[];
  apply?: (sandbox: SandboxHandle) => Promise<void>;
  diff: WorkerDiff;
  usage?: WorkerUsage;
  outcome?: WorkerOutcome;
  error?: string;
}

export class ScriptedWorkerAdapter implements WorkerAdapter {
  readonly name: string;
  readonly capabilities: WorkerAdapterCapabilities = {
    resumableSessions: true,
    reattachableSessions: false,
    reattachedSessionsAcceptNewTurns: false,
    pollable: true,
    reportsUsage: false,
    reportsFileChanges: true,
    providers: [],
  };

  async poll(session: WorkerSession): Promise<WorkerPoll> {
    const events = [];
    for await (const event of this.events(session)) events.push(event);
    return { events, turnEnded: true };
  }

  reference(): WorkerSessionRef {
    throw new WorkerNotReattachableError(this.name);
  }

  async attach(): Promise<WorkerSession> {
    throw new WorkerNotReattachableError(this.name);
  }

  readonly received: WorkerMessage[] = [];

  private readonly turns: ScriptedTurn[];
  private index = 0;
  private sandbox: SandboxHandle | null = null;
  private cancelled = false;
  private applied = false;

  constructor(turns: ScriptedTurn[], options: { name?: string } = {}) {
    if (turns.length === 0) throw new Error("ScriptedWorkerAdapter: needs at least one turn");
    this.turns = turns;
    this.name = options.name ?? "scripted";
  }

  get turnsTaken(): number {
    return this.index + 1;
  }

  async start(input: WorkerStartInput): Promise<WorkerSession> {
    this.sandbox = input.sandbox;
    this.index = 0;
    this.applied = false;
    return { id: `scripted-session-1`, workerSessionId: "scripted-thread-1" };
  }

  async send(_session: WorkerSession, message: WorkerMessage): Promise<void> {
    this.received.push(message);
    if (!message.repairPacket) {
      throw new Error(
        "ScriptedWorkerAdapter.send: a repair turn arrived with no RepairPacket. ADR-0011 §2 " +
          "says the packet is what a repair turn is driven by; a turn without one is a cold " +
          "retry wearing the name of a repair.",
      );
    }
    if (this.index + 1 >= this.turns.length) {
      throw new Error(
        `ScriptedWorkerAdapter.send: the script has ${this.turns.length} turn(s) and turn ` +
          `${this.index + 2} was requested. A loop asking for more turns than the story has is a ` +
          "test finding, not a fake's problem to paper over.",
      );
    }
    this.index += 1;
    this.applied = false;
    this.cancelled = false;
  }

  async *events(_session: WorkerSession): AsyncIterable<WorkerEvent> {
    const turn = this.turns[this.index]!;
    if (!this.applied) {
      this.applied = true;
      if (turn.apply) {
        if (!this.sandbox) throw new Error("ScriptedWorkerAdapter: events() before start()");
        await turn.apply(this.sandbox);
      }
    }
    for (const event of turn.events) {
      if (this.cancelled) return;
      yield event;
    }
  }

  async cancel(_session: WorkerSession): Promise<void> {
    this.cancelled = true;
  }

  async result(_session: WorkerSession): Promise<WorkerResult> {
    const turn = this.turns[this.index]!;
    if (this.cancelled) {
      return {
        outcome: "cancelled",
        error: "ScriptedWorkerAdapter: the turn was cancelled",
        diff: turn.diff,
        ...(turn.usage ? { usage: turn.usage } : {}),
      };
    }
    const cumulative = this.turns
      .slice(0, this.index + 1)
      .reduce<WorkerUsage>(
        (total, t) => ({
          inputTokens: (total.inputTokens ?? 0) + (t.usage?.inputTokens ?? 0),
          outputTokens: (total.outputTokens ?? 0) + (t.usage?.outputTokens ?? 0),
        }),
        {},
      );
    return {
      outcome: turn.outcome ?? "completed",
      diff: turn.diff,
      ...(turn.error ? { error: turn.error } : {}),
      ...(turn.usage ? { usage: turn.usage } : {}),
      ...(this.index > 0 ? { cumulativeUsage: cumulative } : {}),
    };
  }
}
