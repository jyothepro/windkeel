export type RunState =
  | "CREATED"
  | "CLASSIFYING"
  | "PLANNING"
  | "WAITING_FOR_APPROVAL"
  | "PROVISIONING"
  | "IMPLEMENTING"
  | "VERIFYING"
  | "REPAIRING"
  | "PR_CREATING"
  | "PR_READY"
  | "WAITING_FOR_HUMAN"
  | "HUMAN_EDITING"
  | "COMPLETED"
  | "CANCELLED"
  | "BLOCKED"
  | "FAILED"
  | "MAX_REPAIR_ATTEMPTS_REACHED";

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "MAX_REPAIR_ATTEMPTS_REACHED",
]);

const ALL_STATES: RunState[] = [
  "CREATED",
  "CLASSIFYING",
  "PLANNING",
  "WAITING_FOR_APPROVAL",
  "PROVISIONING",
  "IMPLEMENTING",
  "VERIFYING",
  "REPAIRING",
  "PR_CREATING",
  "PR_READY",
  "WAITING_FOR_HUMAN",
  "HUMAN_EDITING",
  "COMPLETED",
  "CANCELLED",
  "BLOCKED",
  "FAILED",
  "MAX_REPAIR_ATTEMPTS_REACHED",
];

const NON_TERMINAL_EXCLUDING_BLOCKED = ALL_STATES.filter(
  (s) => !TERMINAL_STATES.has(s) && s !== "BLOCKED",
);

const FAILED_ELIGIBLE: RunState[] = [
  "CLASSIFYING",
  "PLANNING",
  "WAITING_FOR_APPROVAL",
  "PROVISIONING",
  "IMPLEMENTING",
  "VERIFYING",
  "REPAIRING",
  "PR_CREATING",
];

const NAMED_PAIRS: Array<[RunState, RunState]> = [
  ["CREATED", "CLASSIFYING"],
  ["CLASSIFYING", "PLANNING"],
  ["PLANNING", "PROVISIONING"],
  ["PLANNING", "WAITING_FOR_APPROVAL"],
  ["WAITING_FOR_APPROVAL", "PROVISIONING"],
  ["PROVISIONING", "IMPLEMENTING"],
  ["IMPLEMENTING", "VERIFYING"],
  ["VERIFYING", "PR_CREATING"],
  ["VERIFYING", "REPAIRING"],
  ["VERIFYING", "MAX_REPAIR_ATTEMPTS_REACHED"],
  ["REPAIRING", "VERIFYING"],
  ["PR_CREATING", "PR_READY"],
  ["PR_READY", "WAITING_FOR_HUMAN"],
  ["WAITING_FOR_HUMAN", "COMPLETED"],
  ["WAITING_FOR_HUMAN", "CANCELLED"],
  ["BLOCKED", "CANCELLED"],
  ["IMPLEMENTING", "HUMAN_EDITING"],
  ["REPAIRING", "HUMAN_EDITING"],
  ["WAITING_FOR_HUMAN", "HUMAN_EDITING"],
  ["HUMAN_EDITING", "VERIFYING"],
  ["HUMAN_EDITING", "IMPLEMENTING"],
];

function pairKey(from: RunState, to: RunState): string {
  return `${from}->${to}`;
}

const LEGAL_PAIRS: ReadonlySet<string> = new Set([
  ...NAMED_PAIRS.map(([from, to]) => pairKey(from, to)),
  ...NON_TERMINAL_EXCLUDING_BLOCKED.map((from) => pairKey(from, "BLOCKED")),
  ...NON_TERMINAL_EXCLUDING_BLOCKED.map((from) => pairKey(from, "CANCELLED")),
  ...FAILED_ELIGIBLE.map((from) => pairKey(from, "FAILED")),
]);

export function isLegalTransition(
  from: RunState,
  to: RunState,
  blockedFrom: RunState | null = null,
): boolean {
  if (LEGAL_PAIRS.has(pairKey(from, to))) return true;
  return from === "BLOCKED" && to === blockedFrom;
}

export class IllegalTransitionError extends Error {
  constructor(from: RunState, to: RunState) {
    super(`illegal transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export interface RunStateValue {
  state: RunState;
  blockedFrom: RunState | null;
}

export function initialRunState(): RunStateValue {
  return { state: "CREATED", blockedFrom: null };
}

export interface TransitionRecord {
  from: RunState;
  to: RunState;
  reason: string | null;
}

export function transition(
  run: RunStateValue,
  to: RunState,
  reason: string | null = null,
): { next: RunStateValue; record: TransitionRecord } {
  if (!isLegalTransition(run.state, to, run.blockedFrom)) {
    throw new IllegalTransitionError(run.state, to);
  }
  return {
    next: { state: to, blockedFrom: to === "BLOCKED" ? run.state : null },
    record: { from: run.state, to, reason },
  };
}
