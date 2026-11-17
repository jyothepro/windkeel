export const RUN_STATES = [
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
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "MAX_REPAIR_ATTEMPTS_REACHED",
]);

export type Verdict = "pass" | "warn" | "fail";

export type EvidenceStatus = "passed" | "warning" | "failed" | "completed_with_findings" | "skipped";

export type VerdictMark = "pass" | "warn" | "fail" | "skipped" | "running";
export type RunMark = "queued" | "waiting";
export type Dot = VerdictMark | RunMark;

const NEEDS_YOU: ReadonlySet<RunState> = new Set(["WAITING_FOR_APPROVAL", "PR_READY", "WAITING_FOR_HUMAN", "BLOCKED", "HUMAN_EDITING"]);

export const parkedOnPerson = (state: RunState): boolean => NEEDS_YOU.has(state);

export function dotForRun(state: RunState, finalVerdict: Verdict | null): Dot {
  if (state === "CREATED") return "queued";
  if (!TERMINAL_STATES.has(state)) return NEEDS_YOU.has(state) ? "waiting" : "running";
  switch (finalVerdict) {
    case "pass":
      return "pass";
    case "fail":
      return "fail";
    case "warn":
      return "warn";
    default:
      return "skipped";
  }
}

export function dotForStage(status: EvidenceStatus | null): Dot {
  switch (status) {
    case "passed":
      return "pass";
    case "failed":
      return "fail";
    case "warning":
    case "completed_with_findings":
      return "warn";
    case "skipped":
      return "skipped";
    default:
      return "running";
  }
}

export function stateLabel(state: RunState): string {
  const words: Record<RunState, string> = {
    CREATED: "Created",
    CLASSIFYING: "Classifying",
    PLANNING: "Planning",
    WAITING_FOR_APPROVAL: "Waiting for approval",
    PROVISIONING: "Provisioning",
    IMPLEMENTING: "Implementing",
    VERIFYING: "Verifying",
    REPAIRING: "Repairing",
    PR_CREATING: "Opening pull request",
    PR_READY: "Pull request ready",
    WAITING_FOR_HUMAN: "Waiting for review",
    HUMAN_EDITING: "You're editing",
    COMPLETED: "Completed",
    CANCELLED: "Cancelled",
    BLOCKED: "Blocked",
    FAILED: "Failed",
    MAX_REPAIR_ATTEMPTS_REACHED: "Repair cap reached",
  };
  return words[state];
}

const GUIDABLE: ReadonlySet<RunState> = new Set(["IMPLEMENTING", "REPAIRING", "VERIFYING"]);

export function guidanceClosedReason(state: RunState): string | null {
  if (GUIDABLE.has(state)) return null;
  if (TERMINAL_STATES.has(state)) return "This run has ended. Start a new run to try again.";
  if (state === "WAITING_FOR_APPROVAL") return "No session is listening yet — the run is waiting for its criteria to be approved.";
  if (state === "HUMAN_EDITING") return "You have the workspace. Windkeel reads nothing until you submit or hand back.";
  return "No session is listening right now. Guidance opens while the run is implementing, verifying or repairing.";
}

export const RAIL = ["Classify", "Plan", "Approval", "Provision", "Implement", "Verify", "Repair", "Pull request"] as const;
export type RailStep = (typeof RAIL)[number];
export type RailStatus = "done" | "current" | "upcoming" | "not_taken";

const STEP_OF: Partial<Record<RunState, RailStep>> = {
  CLASSIFYING: "Classify",
  PLANNING: "Plan",
  WAITING_FOR_APPROVAL: "Approval",
  PROVISIONING: "Provision",
  IMPLEMENTING: "Implement",
  VERIFYING: "Verify",
  REPAIRING: "Repair",
  PR_CREATING: "Pull request",
  PR_READY: "Pull request",
  WAITING_FOR_HUMAN: "Pull request",
  HUMAN_EDITING: "Implement",
};

export function railFor(current: RunState, visited: readonly RunState[]): Array<{ step: RailStep; status: RailStatus }> {
  const seen = new Set<RailStep>();
  for (const s of visited) {
    const step = STEP_OF[s];
    if (step) seen.add(step);
  }
  const terminal = TERMINAL_STATES.has(current);
  const here = STEP_OF[current] ?? null;
  const hereIndex = here ? RAIL.indexOf(here) : -1;
  const furthest = Math.max(hereIndex, ...[...seen].map((s) => RAIL.indexOf(s)));

  return RAIL.map((step, i) => {
    if (step === here && !terminal) return { step, status: "current" };
    if (seen.has(step)) return { step, status: "done" };
    if (i < furthest || terminal) return { step, status: "not_taken" };
    return { step, status: "upcoming" };
  });
}
