import { TERMINAL_STATES, guidanceClosedReason, type RunState, type Verdict } from "./run-states.ts";
import type { MergeFacts } from "./merge.ts";

export type InboxGroup = "decide" | "review" | "in_progress" | "failed" | "done";

export const INBOX_GROUPS: Array<[InboxGroup, string]> = [
  ["decide", "Needs your decision"],
  ["review", "Ready to review"],
  ["in_progress", "In progress"],
  ["failed", "Failed"],
  ["done", "Done"],
];

export function inboxGroup(state: RunState): InboxGroup {
  if (state === "WAITING_FOR_APPROVAL" || state === "BLOCKED" || state === "HUMAN_EDITING") return "decide";
  if (state === "PR_READY" || state === "WAITING_FOR_HUMAN") return "review";
  if (state === "FAILED" || state === "MAX_REPAIR_ATTEMPTS_REACHED") return "failed";
  if (TERMINAL_STATES.has(state)) return "done";
  return "in_progress";
}

export function nextActionTone(state: RunState): "yours" | "failed" | null {
  const group = inboxGroup(state);
  return group === "decide" || group === "review" ? "yours" : group === "failed" ? "failed" : null;
}

export interface RunFacts {
  state: RunState;
  finalVerdict: Verdict | null;
  prNumber: number | null;
  prMergedAt: string | null;
  stopReason: string | null;
}

export function nextAction(run: RunFacts): string {
  const pr = run.prNumber ? ` #${run.prNumber}` : "";
  switch (run.state) {
    case "WAITING_FOR_APPROVAL":
      return "Approve the criteria before work starts";
    case "BLOCKED":
      return "Stopped — read why, then unblock or cancel";
    case "HUMAN_EDITING":
      return "You're editing — submit or hand back";
    case "PR_READY":
    case "WAITING_FOR_HUMAN":
      return run.finalVerdict === "warn"
        ? `Verified with warnings — review pull request${pr}`
        : `Verified — review pull request${pr}`;
    case "CREATED":
      return "Queued — starts when a worker is free";
    case "CLASSIFYING":
    case "PLANNING":
      return "Windkeel is reading the task";
    case "PROVISIONING":
      return "Windkeel is preparing a sandbox";
    case "IMPLEMENTING":
      return "Windkeel is making the change";
    case "VERIFYING":
      return "Checking the change independently";
    case "REPAIRING":
      return "Fixing what verification found";
    case "PR_CREATING":
      return "Opening the pull request";
    case "COMPLETED":
      if (run.prMergedAt) return `Done — pull request${pr} merged`;
      return run.finalVerdict === "warn" ? "Done — verified with warnings" : "Done";
    case "CANCELLED":
      return "Cancelled";
    case "FAILED":
      return "Failed — see what went wrong";
    case "MAX_REPAIR_ATTEMPTS_REACHED":
      return "Stopped after the repair limit — see what still fails";
  }
}

export type DecisionAction =
  | "approve"
  | "open_pull_request"
  | "run_again"
  | "cancel"
  | "guide"
  | "merge"
  | "take_over"
  | "make_changes"
  | "submit"
  | "hand_back";

export interface Decision {
  needed: boolean;
  needs: string;
  why: string;
  recommended: string | null;
  consequence: string | null;
  primary: DecisionAction | null;
  secondary: DecisionAction | null;
  also?: DecisionAction[];
}

export interface TakeoverFacts {
  enabled: boolean;
  permitted: boolean;
  canStart: boolean;
  session: { yours: boolean; canHandBack: boolean; editor: string } | null;
}

export interface DecisionFacts extends RunFacts {
  criteriaCount: number;
  criteriaGeneratedBy: string | null;
  criteriaSatisfied: number | null;
  stopReasonText: string | null;
  hasPullRequest: boolean;
  merge?: MergeFacts | null;
}

export function decisionFor(run: DecisionFacts, takeover?: TakeoverFacts): Decision {
  const base = baseDecision(run);
  if (!takeover?.enabled) return base;
  return withTakeover(run, base, takeover);
}

function withTakeover(run: DecisionFacts, base: Decision, t: TakeoverFacts): Decision {
  const offer = t.permitted && t.canStart;
  switch (run.state) {
    case "IMPLEMENTING":
    case "REPAIRING":
      return offer ? { ...base, also: [...(base.also ?? []), "take_over"] } : base;
    case "PR_READY":
    case "WAITING_FOR_HUMAN":
      return offer ? { ...base, also: [...(base.also ?? []), "make_changes"] } : base;
    case "HUMAN_EDITING": {
      const yours = t.permitted && t.session?.yours === true;
      return {
        needed: true,
        needs: "You're editing — submit or hand back",
        why: t.session
          ? `${t.session.yours ? "You have" : `${t.session.editor} has`} a workspace of their own, cloned from Windkeel's last commit. Windkeel is paused until it comes back.`
          : "A person has a workspace of their own. Windkeel is paused until it comes back.",
        recommended: yours
          ? "Open the workspace from the Workspace tab. Submit when it's ready to check; hand back if you want Windkeel to carry on from your commit."
          : "Only the person editing can submit or hand back.",
        consequence: "Submitting commits your changes as you and verifies them in a fresh sandbox, as any candidate is. Uncommitted editor state isn't kept.",
        primary: yours ? "submit" : null,
        secondary: yours && t.session?.canHandBack ? "hand_back" : "cancel",
        also: yours && t.session?.canHandBack ? ["cancel"] : [],
      };
    }
    default:
      return base;
  }
}

function baseDecision(run: DecisionFacts): Decision {
  const criteria = `${run.criteriaCount} ${run.criteriaCount === 1 ? "criterion" : "criteria"}`;
  switch (run.state) {
    case "WAITING_FOR_APPROVAL":
      return {
        needed: true,
        needs: `Approve the ${criteria} this run will be judged against`,
        why: `${run.criteriaGeneratedBy ?? "A model"} wrote them, not the issue's author, so a person signs off before any code is written.`,
        recommended: "Read them under Criteria. Approve if they describe the change you want; cancel if they don't.",
        consequence: "Approving starts the work. To change what the run is aiming for afterwards, it comes back to you.",
        primary: "approve",
        secondary: "cancel",
      };
    case "PR_READY":
    case "WAITING_FOR_HUMAN": {
      const met = run.criteriaSatisfied === null ? "" : ` ${run.criteriaSatisfied} of ${run.criteriaCount} criteria met.`;
      const warn = run.finalVerdict === "warn";
      const merge = run.merge ?? null;
      if (merge?.eligible) {
        return {
          needed: true,
          needs: warn ? "Verified with warnings — review and merge" : "Verified — review and merge",
          why: `An independent verifier checked the change.${met}${warn ? " Some things could not be settled; they are listed under Evidence." : ""}`,
          recommended: `${
            warn
              ? "Read the warnings and the diff. Merging asks you to acknowledge each warning, then merges as you."
              : "Read the diff, then merge. Windkeel merges as you, so GitHub's branch protection and reviews still apply."
          }${merge.caution ? ` Your last merge was refused: ${merge.caution}` : ""}`,
          consequence: "The merge lands on GitHub under your name; the run completes when GitHub confirms it.",
          primary: "merge",
          secondary: run.hasPullRequest ? "open_pull_request" : "cancel",
          ...(run.hasPullRequest ? { also: ["cancel" as const] } : {}),
        };
      }
      if (merge) {
        return {
          needed: true,
          needs: warn ? "Review the pull request — verified with warnings" : "Review the pull request",
          why: `An independent verifier checked the change.${met}${warn ? " Some things could not be settled; they are listed under Evidence." : ""}`,
          recommended: `${warn ? "Read the warnings and the diff, then review on GitHub." : "Read the diff, then review on GitHub."} Merging from Windkeel isn't possible yet: ${merge.blockedBy ?? "it can't be merged from here"}.`,
          consequence: "Nothing more happens until the pull request is merged or closed.",
          primary: run.hasPullRequest ? "open_pull_request" : null,
          secondary: "cancel",
        };
      }
      return {
        needed: true,
        needs: run.finalVerdict === "warn" ? "Review the pull request — verified with warnings" : "Review the pull request",
        why: `An independent verifier checked the change.${met}${run.finalVerdict === "warn" ? " Some things could not be settled; they are listed under Evidence." : ""}`,
        recommended:
          run.finalVerdict === "warn"
            ? "Read the warnings and the diff, then review on GitHub. Windkeel doesn't merge."
            : "Read the diff, then review on GitHub. Windkeel doesn't merge.",
        consequence: "Nothing more happens until the pull request is merged or closed.",
        primary: run.hasPullRequest ? "open_pull_request" : null,
        secondary: "cancel",
      };
    }
    case "HUMAN_EDITING":
      return {
        needed: true,
        needs: "A person is editing this run",
        why: "Windkeel is paused while a person works in a workspace of their own.",
        recommended: null,
        consequence: null,
        primary: null,
        secondary: "cancel",
      };
    case "BLOCKED":
      return {
        needed: true,
        needs: "Unblock this run",
        why: run.stopReasonText ?? "It stopped and can't continue on its own.",
        recommended: "Read what stopped it in the activity. If it can't be fixed from here, cancel and file it again.",
        consequence: null,
        primary: null,
        secondary: "cancel",
      };
    case "FAILED":
    case "MAX_REPAIR_ATTEMPTS_REACHED":
      return {
        needed: true,
        needs: "Decide what's next",
        why:
          run.stopReasonText ??
          (run.state === "FAILED" ? "The run failed before it could finish." : "Verification still failed after the last repair Windkeel was allowed."),
        recommended:
          run.state === "FAILED"
            ? "Read the activity to see where it stopped. Run again if it looks fixable; otherwise change the task."
            : "Read what still fails under Evidence. Run again if it looks fixable; otherwise change the task.",
        consequence: "Running again starts a fresh attempt with the same criteria.",
        primary: "run_again",
        secondary: run.hasPullRequest ? "open_pull_request" : null,
      };
    case "COMPLETED":
      return {
        needed: false,
        needs: "Nothing needed",
        why: run.prMergedAt ? "The pull request was merged." : "This run is finished.",
        recommended: null,
        consequence: null,
        primary: run.hasPullRequest ? "open_pull_request" : null,
        secondary: null,
      };
    case "CANCELLED":
      return {
        needed: false,
        needs: "Nothing needed",
        why: "This run was cancelled.",
        recommended: null,
        consequence: null,
        primary: "run_again",
        secondary: null,
      };
    default: {
      const guidable = guidanceClosedReason(run.state) === null;
      return {
        needed: false,
        needs: "Nothing needed from you",
        why: `${nextAction(run)}.`,
        recommended: guidable ? "You can steer how it goes about the work from the chat below." : null,
        consequence: null,
        primary: guidable ? "guide" : null,
        secondary: "cancel",
      };
    }
  }
}

export type Outcome =
  | "passed"
  | "passed_with_warnings"
  | "found_issues"
  | "failed"
  | "not_tested"
  | "unavailable"
  | "running"
  | "not_run_yet"
  | "not_reported";

export const OUTCOME_LABEL: Record<Outcome, string> = {
  passed: "Passed",
  passed_with_warnings: "Passed with warnings",
  found_issues: "Found issues",
  failed: "Failed",
  not_tested: "Not tested",
  unavailable: "Test unavailable",
  running: "Still running",
  not_run_yet: "Not run yet",
  not_reported: "Not reported",
};

export type VerificationPhase = "before" | "verifying" | "after";

export function verificationPhase(state: RunState, hasVerdictOfRecord: boolean): VerificationPhase {
  if (state === "VERIFYING") return "verifying";
  return hasVerdictOfRecord ? "after" : "before";
}

export function stageOutcome(
  status: "passed" | "warning" | "failed" | "completed_with_findings" | "skipped" | null,
  didNotFinish: boolean,
  phase: VerificationPhase,
): Outcome {
  if (didNotFinish) return "unavailable";
  switch (status) {
    case "passed":
      return "passed";
    case "warning":
      return "passed_with_warnings";
    case "completed_with_findings":
      return "found_issues";
    case "failed":
      return "failed";
    case "skipped":
      return "not_tested";
    default:
      return phase === "verifying" ? "running" : phase === "before" ? "not_run_yet" : "not_reported";
  }
}

export function verdictHeadline(verdict: Verdict | null, live: boolean): string {
  if (verdict === "pass") return "Verified";
  if (verdict === "warn") return "Verified with warnings";
  if (verdict === "fail") return "Failed verification";
  return live ? "Not verified yet" : "Never verified";
}
