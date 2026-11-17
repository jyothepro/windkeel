import type { Author, Criterion } from "@windkeel/verification/evidence/format.js";
import { NoIndependentProviderError, parseJsonResponse, selectGateway } from "@windkeel/verification/providers/index.js";
import { CRITERIA_SYSTEM_PROMPT, criteriaUserPrompt } from "@windkeel/verification/providers/prompt.js";
import type { ModelGateway, ModelPolicy, ModelUsage } from "@windkeel/verification/providers/types.js";
import { extractCriteria } from "@windkeel/verification/stages/intent.js";
import { approvalDeadlineAt, DEFAULT_APPROVAL_DEADLINE_SECONDS } from "./rails.js";

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
  | "BLOCKED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "MAX_REPAIR_ATTEMPTS_REACHED";

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "MAX_REPAIR_ATTEMPTS_REACHED",
]);

export type CriteriaProvenance = "extracted" | "generated";

export interface SourceIssue {
  number: number;
  url: string;
  title: string;
  body: string;
}

export const MAX_GENERATED_CRITERIA = 10;

export type GateDecision =
  | {
      kind: "proceed";
      provenance: "extracted";
      criteria: Criterion[];
      nextState: "PROVISIONING";
    }
  | {
      kind: "await_approval";
      provenance: "generated";
      criteria: Criterion[];
      generatedBy: { vendor: string; model: string };
      nextState: "WAITING_FOR_APPROVAL";
      comment: string;
      usage?: ModelUsage;
    }
  | {
      kind: "cancel";
      reason: string;
      nextState: "CANCELLED";
      comment: string;
      usage?: ModelUsage;
    };

export function extractIssueCriteria(issue: SourceIssue): Criterion[] {
  return extractCriteria(issue.body, { kind: "linked_issue", ref: issue.url });
}

export function needsGeneration(criteria: Criterion[]): boolean {
  return criteria.length === 0;
}

export function criteriaGateway(policy: ModelPolicy): ModelGateway {
  if (!policy.maker?.vendor && !policy.maker?.model) {
    throw new MakerIdentityRequiredError(
      "criteria generation needs ModelPolicy.maker set explicitly; the factory knows the maker (ADR-0010 §3)",
    );
  }
  const author: Author = { login: "windkeel-factory", kind: "unknown" };
  const gateway = selectGateway(policy, author, "criteria");
  if (!gateway) {
    throw new NoIndependentProviderError(
      "no model endpoint is configured to generate acceptance criteria",
    );
  }
  return gateway;
}

export class MakerIdentityRequiredError extends Error {}

export function normalizeGeneratedCriteria(texts: string[], issue: SourceIssue): Criterion[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of texts) {
    const text = String(raw ?? "")
      .replace(/^\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
    if (kept.length === MAX_GENERATED_CRITERIA) break;
  }
  return kept.map((text, i) => ({
    id: `AC${i + 1}`,
    text,
    source: { kind: "linked_issue" as const, ref: issue.url },
  }));
}

export async function decideCriteria(
  issue: SourceIssue,
  policy: ModelPolicy,
  approval: { deadlineSeconds: number; now?: Date } = {
    deadlineSeconds: DEFAULT_APPROVAL_DEADLINE_SECONDS,
  },
): Promise<GateDecision> {
  const extracted = extractIssueCriteria(issue);
  if (!needsGeneration(extracted)) {
    return {
      kind: "proceed",
      provenance: "extracted",
      criteria: extracted,
      nextState: "PROVISIONING",
    };
  }

  const gateway = criteriaGateway(policy);
  const response = await gateway.generate({
    system: CRITERIA_SYSTEM_PROMPT,
    user: criteriaUserPrompt({ number: issue.number, title: issue.title, body: issue.body }),
  });

  let criteria: Criterion[] = [];
  try {
    const parsed = parseJsonResponse<{ criteria?: Array<{ text?: string }> }>(response.text);
    criteria = normalizeGeneratedCriteria(
      (parsed.criteria ?? []).map((c) => c?.text ?? ""),
      issue,
    );
  } catch {
    criteria = [];
  }

  if (!criteria.length) {
    const reason = "no verifiable acceptance criteria could be derived from this issue";
    return {
      kind: "cancel",
      reason,
      nextState: "CANCELLED",
      comment: noCriteriaComment(reason),
      ...(response.usage ? { usage: response.usage } : {}),
    };
  }

  return {
    kind: "await_approval",
    provenance: "generated",
    criteria,
    generatedBy: { vendor: gateway.vendor, model: gateway.model },
    nextState: "WAITING_FOR_APPROVAL",
    ...(response.usage ? { usage: response.usage } : {}),
    comment: criteriaApprovalComment(
      criteria,
      { vendor: gateway.vendor, model: gateway.model },
      {
        at: approvalDeadlineAt(approval.now ?? new Date(), approval.deadlineSeconds),
        seconds: approval.deadlineSeconds,
      },
    ),
  };
}

export type WindkeelCommand = "approve" | "cancel";

const COMMAND = /^\s*\/windkeel\s+(approve|cancel)\s*$/i;

export function parseCommand(commentBody: string): WindkeelCommand | null {
  for (const line of commentBody.split("\n")) {
    if (line.trimStart().startsWith(">")) continue;
    const match = COMMAND.exec(line);
    if (match?.[1]) return match[1].toLowerCase() as WindkeelCommand;
  }
  return null;
}

export class IllegalTransitionError extends Error {}

export interface GatedRun {
  status: RunState;
  acceptance_criteria: Criterion[];
  criteria_provenance: CriteriaProvenance;
  criteria_approved_at: Date | null;
}

export function applyCommand(run: GatedRun, command: WindkeelCommand): "PROVISIONING" | "CANCELLED" {
  if (TERMINAL_STATES.has(run.status)) {
    throw new IllegalTransitionError(`run is already ${run.status}; nothing leaves a terminal state`);
  }
  if (command === "cancel") return "CANCELLED";
  if (run.status !== "WAITING_FOR_APPROVAL") {
    throw new IllegalTransitionError(
      `/windkeel approve applies to a run at WAITING_FOR_APPROVAL, not ${run.status}`,
    );
  }
  return "PROVISIONING";
}

export class UnapprovedCriteriaError extends Error {}

export function assertProvisionable(run: GatedRun): void {
  if (!run.acceptance_criteria.length) {
    throw new UnapprovedCriteriaError(
      "no acceptance criteria: a run with nothing to verify against never provisions (ADR-0012 §5)",
    );
  }
  if (run.criteria_provenance === "generated" && run.criteria_approved_at === null) {
    throw new UnapprovedCriteriaError(
      "generated acceptance criteria are unapproved: /windkeel approve on the issue before provisioning",
    );
  }
}

export function approveCriteria(run: GatedRun, approvedAt: Date): GatedRun {
  return { ...run, status: "PROVISIONING", criteria_approved_at: approvedAt };
}

export function criteriaApprovalComment(
  criteria: Criterion[],
  generatedBy: { vendor: string; model: string },
  deadline?: { at: Date; seconds: number },
): string {
  return [
    "**Acceptance criteria — approval needed before anything runs.**",
    "",
    `This issue states no acceptance criteria, so these were generated (${generatedBy.vendor}/${generatedBy.model}) from what it asks for. Nothing is provisioned until you approve them.`,
    "",
    ...criteria.map((c) => `- [ ] **${c.id}** — ${c.text}`),
    "",
    "- `/windkeel approve` — verify the change against exactly these.",
    "- `/windkeel cancel` — stop here.",
    "",
    ...(deadline
      ? [
          `**Approve by ${formatDeadline(deadline.at)}** — ${hours(deadline.seconds)} from now. ` +
            "After that the run is cancelled unapproved and the label has to be re-added. " +
            "Nothing is spent while it waits.",
          "",
        ]
      : []),
    "To change them: cancel, edit the issue to state the criteria you want, and re-add the `windkeel` label. The fresh run reads your words instead of generating.",
  ].join("\n");
}

export function approvalExpiredComment(deadlineSeconds: number): string {
  return [
    `**Run cancelled — the acceptance criteria above went unapproved for ${hours(deadlineSeconds)}.**`,
    "",
    "Nothing was provisioned, nothing was verified, and nothing was spent waiting.",
    "",
    "Re-add the `windkeel` label to start a fresh run. To skip the wait next time, state the acceptance criteria in the issue as a `- [ ]` checklist: criteria Windkeel can read are never sent for approval.",
  ].join("\n");
}

function hours(seconds: number): string {
  const total = Math.round(seconds / 3600);
  if (total % 24 === 0 && total >= 24) {
    const days = total / 24;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return `${total} hour${total === 1 ? "" : "s"}`;
}

function formatDeadline(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function noCriteriaComment(reason: string): string {
  return [
    `**Run cancelled** — ${reason}.`,
    "",
    "Nothing was provisioned and nothing was verified: a change checked against no stated outcome proves nothing.",
    "",
    "Add an acceptance-criteria checklist to the issue and re-add the `windkeel` label to try again.",
  ].join("\n");
}
