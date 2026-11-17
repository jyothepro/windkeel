import type { RunState } from "./run-states.ts";

export const WORKSPACE_TABS = [
  ["changes", "Changes"],
  ["terminal", "Terminal"],
  ["files", "Files"],
  ["browser", "Browser"],
  ["criteria", "Criteria"],
  ["evidence", "Evidence"],
  ["progress", "Progress"],
] as const;
export const HUMAN_TAB = ["workspace", "Workspace"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number][0] | (typeof HUMAN_TAB)[0];

export function tabsFor(humanWorkspace: boolean): ReadonlyArray<readonly [WorkspaceTab, string]> {
  return humanWorkspace ? [HUMAN_TAB, ...WORKSPACE_TABS] : WORKSPACE_TABS;
}

export const EVIDENCE_VIEWS = [
  ["verifications", "Verifications"],
  ["attempts", "Repairs"],
  ["cost", "Cost"],
  ["provenance", "Provenance"],
] as const;
export type EvidenceView = (typeof EVIDENCE_VIEWS)[number][0];

const isTab = (t: string | undefined): t is (typeof WORKSPACE_TABS)[number][0] => WORKSPACE_TABS.some(([k]) => k === t);
const isView = (v: string | undefined): v is EvidenceView => EVIDENCE_VIEWS.some(([k]) => k === v);

export function workspaceTab(
  search: { tab?: string; view?: string },
  state: RunState,
  humanWorkspace = false,
): { tab: WorkspaceTab; view: EvidenceView } {
  if (isView(search.tab)) return { tab: "evidence", view: search.tab };
  const human = humanWorkspace && state === "HUMAN_EDITING";
  if (human && (search.tab === "workspace" || search.tab === undefined)) return { tab: "workspace", view: "verifications" };
  const tab = isTab(search.tab) ? search.tab : state === "WAITING_FOR_APPROVAL" ? "criteria" : "changes";
  return { tab, view: isView(search.view) ? search.view : "verifications" };
}

export function workspaceTarget(search: { path?: string | string[]; turn?: string | string[] }): { path: string; turn: string | null } {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const turn = one(search.turn)?.trim();
  return { path: one(search.path) ?? "", turn: turn ? turn : null };
}

export function workspaceHref(runId: string, tab: WorkspaceTab, view?: EvidenceView, target: { path?: string; turn?: string } = {}): string {
  const q = new URLSearchParams({ tab });
  if (tab === "evidence" && view && view !== "verifications") q.set("view", view);
  if (tab === "files" && target.path) q.set("path", target.path);
  if (tab === "changes" && target.turn) q.set("turn", target.turn);
  return `/runs/${encodeURIComponent(runId)}?${q}`;
}
