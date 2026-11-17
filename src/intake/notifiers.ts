import type { Pool } from "pg";
import type { EngineeringRun, EngineeringTask } from "../factory/repositories.js";
import { getEngineeringTask } from "../factory/repositories.js";
import { defaultLog, describeError, type IntakeLog } from "../factory/log.js";
import type { RunState } from "../factory/run-state-machine.js";
import { TERMINAL_STATES } from "../factory/run-state-machine.js";
import { verdictForRun, type RunVerdict } from "./verdict.js";
import { setRunOutcomeListener } from "../factory/run-service.js";

export type NotifiedTask = EngineeringTask;

const NOTIFIER_TIMEOUT_MS = 10_000;

export type RunOutcomeKind = "started" | "state" | "progress";

export interface RunOutcome {
  kind: RunOutcomeKind;
  transitionId: string;
  state: RunState;
  reason: string | null;
  terminal: boolean;
  verdict?: RunVerdict | null;
}

export interface SourceNotifier {
  sourceType: string;
  timeoutMs?: number;
  notify(
    task: NotifiedTask,
    run: EngineeringRun,
    outcome: RunOutcome,
    signal?: AbortSignal,
  ): Promise<void>;
}

const notifiers = new Map<string, SourceNotifier>();

export function registerSourceNotifier(notifier: SourceNotifier): void {
  notifiers.set(notifier.sourceType, notifier);
}

export function unregisterSourceNotifier(sourceType: string): boolean {
  return notifiers.delete(sourceType);
}

export function getSourceNotifier(sourceType: string): SourceNotifier | undefined {
  return notifiers.get(sourceType);
}

export const RELAYED_REASON_MAX_CHARS = 300;

const WITHHELD_NOTE = "details are in the run's record";

export function relayableReason(reason: string | null): string | null {
  if (reason === null) return null;
  let text = reason.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  const detail = text.indexOf(": ");
  if (detail !== -1) text = `${text.slice(0, detail)} (${WITHHELD_NOTE})`;
  if (text.length > RELAYED_REASON_MAX_CHARS) text = `${text.slice(0, RELAYED_REASON_MAX_CHARS - 1)}…`;
  return text;
}

function isNotifiableState(state: RunState): boolean {
  return TERMINAL_STATES.has(state) || state === "WAITING_FOR_HUMAN" || state === "WAITING_FOR_APPROVAL";
}

export function notifiableOutcomeKind(transition: {
  fromState?: RunState | null;
  toState: RunState;
}): RunOutcomeKind | null {
  if (isNotifiableState(transition.toState)) return "state";
  if (transition.fromState === "CREATED") return "started";
  if (transition.toState === "VERIFYING") return "progress";
  return null;
}

export async function notifyRunOutcome(
  pool: Pool,
  run: EngineeringRun,
  transition: { id: string; fromState?: RunState | null; toState: RunState; reason: string | null },
  log: IntakeLog = defaultLog,
): Promise<void> {
  const state = transition.toState;
  if (notifiers.size === 0) return;
  const kind = notifiableOutcomeKind(transition);
  if (!kind) return;
  try {
    const task = await getEngineeringTask(pool, run.taskId);
    if (!task) return;
    const notifier = notifiers.get(task.sourceType);
    if (!notifier) return;
    const terminal = TERMINAL_STATES.has(state);
    const outcome: RunOutcome = { kind, transitionId: transition.id, state, reason: relayableReason(transition.reason), terminal };
    if (kind === "state" && (terminal || state === "WAITING_FOR_HUMAN")) outcome.verdict = await verdictForRun(pool, run.id);
    await withTimeout(notifier.timeoutMs ?? NOTIFIER_TIMEOUT_MS, (signal) => notifier.notify(task, run, outcome, signal));
  } catch (error) {
    log("source notification failed", {
      engineeringRunId: run.id,
      state,
      kind,
      transitionId: transition.id,
      ...describeError(error),
    });
  }
}

class NotifierTimeoutError extends Error {
  constructor(ms: number) {
    super(`notifier did not finish within ${ms} ms`);
    this.name = "NotifierTimeoutError";
  }
}

async function withTimeout(ms: number, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new NotifierTimeoutError(ms);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

setRunOutcomeListener((pool, run, transition) => notifyRunOutcome(pool, run, transition));
