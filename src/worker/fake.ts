import { WorkerNotReattachableError, type WorkerPoll, type WorkerSessionRef } from "./adapter.js";
import type {
  WorkerAdapter,
  WorkerAdapterCapabilities,
  WorkerDiff,
  WorkerEvent,
  WorkerMessage,
  WorkerResult,
  WorkerSession,
  WorkerStartInput,
} from "./adapter.js";

export type WorkerCallRecord =
  | { type: "start"; prompt: string; workdir?: string | undefined }
  | { type: "event"; event: WorkerEvent }
  | { type: "send"; message: WorkerMessage }
  | { type: "cancel" }
  | { type: "result" };

const EMPTY_DIFF: WorkerDiff = { patch: "", filesChanged: [], truncated: false };

function lastOfType<T extends WorkerEvent["type"]>(
  events: WorkerEvent[],
  type: T,
): Extract<WorkerEvent, { type: T }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === type) return event as Extract<WorkerEvent, { type: T }>;
  }
  return undefined;
}

export interface FakeWorkerAdapterOptions {
  result?: Partial<WorkerResult>;
}

function parseEventJsonl(text: string): WorkerEvent[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line) as WorkerEvent;
      } catch (cause) {
        throw new Error(
          `FakeWorkerAdapter: recorded stream line ${index + 1} is not valid JSON: ${line}`,
          { cause },
        );
      }
    });
}

export class FakeWorkerAdapter implements WorkerAdapter {
  readonly name = "fake";
  readonly capabilities: WorkerAdapterCapabilities = {
    resumableSessions: false,
    reattachableSessions: false,
    reattachedSessionsAcceptNewTurns: false,
    pollable: false,
    reportsUsage: false,
    reportsFileChanges: true,
    providers: [],
  };

  readonly calls: WorkerCallRecord[] = [];
  private readonly recorded: WorkerEvent[];
  private readonly resultOverride: Partial<WorkerResult>;
  private cancelled = false;
  private started = false;

  constructor(recorded: WorkerEvent[] | string, options: FakeWorkerAdapterOptions = {}) {
    this.recorded = typeof recorded === "string" ? parseEventJsonl(recorded) : [...recorded];
    this.resultOverride = options.result ?? {};
  }

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

  async start(input: WorkerStartInput): Promise<WorkerSession> {
    this.started = true;
    this.calls.push({ type: "start", prompt: input.prompt, workdir: input.workdir });
    const announced = this.recorded.find((e) => e.type === "started");
    return {
      id: `fake-session-${this.calls.length}`,
      ...(announced?.type === "started" && announced.sessionId
        ? { workerSessionId: announced.sessionId }
        : {}),
    };
  }

  async send(_session: WorkerSession, message: WorkerMessage): Promise<void> {
    this.calls.push({ type: "send", message });
    throw new Error(
      "FakeWorkerAdapter.send: this adapter replays a recording and cannot resume a session " +
        "(capabilities.resumableSessions is false). Use a real adapter, or construct the fake " +
        "with a recording that already contains the follow-up turn's events.",
    );
  }

  async *events(_session: WorkerSession): AsyncIterable<WorkerEvent> {
    for (const event of this.recorded) {
      if (this.cancelled) return;
      this.calls.push({ type: "event", event });
      yield event;
    }
  }

  async cancel(_session: WorkerSession): Promise<void> {
    this.cancelled = true;
    this.calls.push({ type: "cancel" });
  }

  async result(_session: WorkerSession): Promise<WorkerResult> {
    this.calls.push({ type: "result" });
    const completed = lastOfType(this.recorded, "completed");
    const failed = lastOfType(this.recorded, "failed");
    const finalMessage = lastOfType(this.recorded, "message");

    const base: WorkerResult = this.cancelled
      ? {
          outcome: "cancelled",
          error: "FakeWorkerAdapter: session cancelled before the recording was exhausted",
          diff: EMPTY_DIFF,
        }
      : failed
        ? { outcome: "failed", error: failed.error, diff: EMPTY_DIFF }
        : {
            outcome: this.started && completed ? "completed" : "failed",
            diff: EMPTY_DIFF,
            ...(completed?.usage ? { usage: completed.usage } : {}),
            ...(this.started && completed
              ? {}
              : { error: "FakeWorkerAdapter: recording ended without a `completed` event" }),
          };

    return {
      ...base,
      ...(finalMessage ? { finalMessage: finalMessage.text } : {}),
      ...this.resultOverride,
    };
  }
}
