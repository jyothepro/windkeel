import type { RunState } from "./run-states.ts";
import type { CandidateProvenance, HumanSession, RunDetail, TakeoverInfo } from "./types.ts";

export function takeoverOf(detail: Pick<RunDetail, "takeover">): TakeoverInfo | null {
  return detail.takeover?.enabled === true ? detail.takeover : null;
}

export const TAKE_OVER_STATES: ReadonlySet<RunState> = new Set(["IMPLEMENTING", "REPAIRING"]);
export const MAKE_CHANGES_STATES: ReadonlySet<RunState> = new Set(["PR_READY", "WAITING_FOR_HUMAN"]);

export function canStartSession(takeover: TakeoverInfo): boolean {
  const live = takeover.session !== null && takeover.session.state !== "ended" && takeover.session.state !== "failed";
  return !live && takeover.cycles.used < takeover.cycles.cap;
}

export type WorkspaceTone = "setting_up" | "awake" | "sleeping" | "busy" | "failed" | "ended";

export function workspaceStatus(session: HumanSession): { tone: WorkspaceTone; line: string; openable: boolean } {
  switch (session.state) {
    case "requested":
      return {
        tone: "setting_up",
        line:
          session.origin === "make_changes"
            ? "Opening a workspace on the pull request's head."
            : "Windkeel will stop after this turn and commit its work, then your workspace is set up.",
        openable: false,
      };
    case "provisioning":
      return { tone: "setting_up", line: "Setting up your workspace — install runs without repository secrets before you get it.", openable: false };
    case "ready":
      return session.awake
        ? { tone: "awake", line: "Awake — your terminal, editor and preview open in a new tab.", openable: true }
        : { tone: "sleeping", line: "Sleeping — opens again when you type.", openable: true };
    case "sleeping":
      return { tone: "sleeping", line: "Sleeping — opens again when you type.", openable: true };
    case "submitting":
      return { tone: "busy", line: "Committing your changes as you and sending them for verification.", openable: false };
    case "handing_back":
      return { tone: "busy", line: "Committing your changes as you and handing back to Windkeel.", openable: false };
    case "failed":
      return { tone: "failed", line: session.error ?? "The workspace could not be set up.", openable: false };
    case "ended":
      return {
        tone: "ended",
        line: session.outcome === "expired" && session.error ? session.error : "This workspace has ended.",
        openable: false,
      };
  }
}

export function missedTakeoverNotice(takeover: TakeoverInfo | null, state: RunState): string | null {
  const session = takeover?.session;
  if (!session || state === "HUMAN_EDITING") return null;
  if (session.origin !== "takeover" || session.state !== "ended" || session.outcome !== "expired" || !session.error) return null;
  return session.error;
}

export function editorName(session: HumanSession): string {
  if (session.yours) return "You";
  return session.editor.displayName || session.editor.login || "Someone";
}

export function provenanceLabel(candidate: CandidateProvenance, viewerLogin: string | null): string {
  const person = candidate.person?.login
    ? viewerLogin && candidate.person.login === viewerLogin
      ? "you"
      : candidate.person.login
    : "a person";
  const maker = candidate.maker ? `Windkeel (${candidate.maker.harness} · ${candidate.maker.model})` : "Windkeel";
  switch (candidate.provenance) {
    case "maker":
      return maker;
    case "person":
      return person;
    case "mixed":
      return `mixed — ${maker} and ${person}`;
  }
}

export function latestProvenance(candidates: readonly CandidateProvenance[] | undefined): CandidateProvenance | null {
  return candidates && candidates.length > 0 ? candidates[candidates.length - 1]! : null;
}
