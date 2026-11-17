import type { Workspace } from "../../repositories.js";

const LIVE_STATUSES = new Set(["provisioning", "ready"]);

export function makerWorkspaceOf(workspaces: Workspace[]): Workspace | undefined {
  return workspaces.find((w) => w.role === "maker" && LIVE_STATUSES.has(w.status));
}

export function missingMakerReason(workspaces: Workspace[], consequence: string): string {
  const maker = workspaces.find((w) => w.role === "maker");
  if (!maker) return `this run has no maker workspace row, so ${consequence}.`;
  return (
    `the maker workspace ${maker.id} is ${maker.status}, not live, so ${consequence}. An earlier ` +
    "attempt of this stage most likely failed and released it; its error is in the flow " +
    "function's log under \"stage threw\"."
  );
}
