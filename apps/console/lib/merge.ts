export type MergeRuleId =
  | "enabled"
  | "pr-open"
  | "head-verified"
  | "verdict"
  | "warn-acknowledged"
  | "permission"
  | "org-allows"
  | "draft"
  | "workflows"
  | "protection"
  | "bypass"
  | "authorization";

export interface MergeRule {
  id: MergeRuleId;
  ok: boolean;
  blocking: boolean;
  checked: boolean;
  reason: string;
  detail?: string;
}

export interface NeedsALookItem {
  id: string;
  title?: string;
}

export interface MergeAttempt {
  id: string;
  status: "pending" | "merged" | "refused" | "failed";
  reason: string | null;
  githubLogin: string | null;
  verifiedSha: string;
  mergedSha: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface MergeEligibility {
  eligible: boolean;
  rules: MergeRule[];
  flags: string[];
  failing: MergeRule | null;
  needsAcknowledgement: NeedsALookItem[];
  verifiedSha: string | null;
  verdict: "pass" | "warn" | "fail" | null;
  prNumber: number | null;
  prUrl: string | null;
  isDraft: boolean | null;
  authorization: { githubLogin: string; status: "valid" | "needs_reauth" } | null;
  merge: MergeAttempt | null;
  githubError: string | null;
}

export interface MergingSettings {
  allowMerge: boolean;
  canManage: boolean;
  canMerge: boolean;
  githubConnect: { configured: boolean };
  authorization: { githubLogin: string; status: "valid" | "needs_reauth"; statusReason: string | null; connectedAt: string } | null;
}

export interface MergeFacts {
  eligible: boolean;
  blockedBy: string | null;
  isDraft: boolean;
  caution?: string | null;
}

export function ruleInWords(rule: MergeRule): string {
  if (rule.id === "bypass") return rule.checked ? rule.reason : "Windkeel couldn't tell whether the repository lets you bypass its protection, so it won't merge as you — try again in a moment";
  if (!rule.checked) return "GitHub couldn't be read just now, so Windkeel can't tell whether it can merge — try again in a moment";
  switch (rule.id) {
    case "enabled":
      return "Merging from Windkeel isn't on for this deployment";
    case "org-allows":
      return "Merging is off for this organization";
    case "permission":
      return "You need the Merge permission";
    case "head-verified":
      return "A commit landed after verification — verify again";
    case "verdict":
      return /no verdict/i.test(rule.reason) ? "Nothing has been verified yet" : "Only a change that passed verification (or passed with warnings) can be merged from here";
    case "workflows":
      return "It changes .github/workflows — merge this one on GitHub";
    case "protection":
      return /bypass/i.test(rule.reason)
        ? "GitHub would only merge it with an admin bypass, and Windkeel never bypasses — merge it on GitHub if you mean to"
        : `GitHub won't merge it as it stands (${rule.reason.replace(/^GitHub reports /, "").replace(/;.*$/, "")})`;
    case "pr-open":
      return /no pull request/i.test(rule.reason) ? "There's no pull request yet" : "The pull request isn't open";
    case "draft":
      return "It's a draft — mark it ready to merge it";
    case "warn-acknowledged":
      return "Each warning has to be acknowledged";
    case "authorization":
      return rule.reason;
  }
}

export function mergeFacts(e: MergeEligibility | null): MergeFacts | null {
  if (!e) return null;
  const failing = e.failing ?? e.rules.find((r) => r.blocking && !(r.ok && r.checked)) ?? null;
  const bypass = e.rules.find((r) => r.id === "bypass" && r.checked && !r.ok) ?? null;
  return {
    eligible: e.eligible,
    blockedBy: e.eligible ? null : e.githubError ?? (failing ? ruleInWords(failing) : "It can't be merged from here"),
    isDraft: e.isDraft === true,
    caution: e.eligible && bypass ? ruleInWords(bypass) : null,
  };
}

export function mergeButtonLabel(isDraft: boolean): string {
  return isDraft ? "Mark ready and merge" : "Merge pull request";
}

export function attemptLine(attempt: MergeAttempt | null): string | null {
  if (!attempt) return null;
  switch (attempt.status) {
    case "pending":
      return "Merging as you… GitHub decides; this page updates when it has.";
    case "merged":
      return `Merged${attempt.githubLogin ? ` as @${attempt.githubLogin}` : ""} — the run completes when GitHub confirms.`;
    case "refused":
      return `The last merge was refused: ${attempt.reason ?? "no reason given"}.`;
    case "failed":
      return `The last merge didn't go through: ${attempt.reason ?? "no reason given"}.`;
  }
}

export const MERGE_METHODS: Array<[string, string]> = [
  ["squash", "Squash and merge"],
  ["merge", "Create a merge commit"],
  ["rebase", "Rebase and merge"],
];
