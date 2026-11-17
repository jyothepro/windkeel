const WORKFLOWS_PREFIX = ".github/workflows/";

export const BYPASS_REASON =
  "The repository lets you bypass its protection, so Windkeel can't guarantee it applies. Turn on \u201cDo not allow bypassing the above settings\u201d (or empty the ruleset's bypass list) to merge from Windkeel.";

const MERGEABLE_WITHOUT_BYPASS = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

export type RuleId =
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
  id: RuleId;
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

export interface VerdictOfRecordFacts {
  candidateSha: string;
  verdict: string | null;
  needsALook?: NeedsALookItem[];
}

export interface PullRequestFacts {
  state?: "OPEN" | "CLOSED" | "MERGED";
  headSha?: string;
  isDraft?: boolean;
  changedPaths?: string[];
  changedPathsComplete?: boolean;
  mergeStateStatus?: string;
  viewerCanMergeAsAdmin?: boolean;
  viewerCanBypassRulesets?: boolean;
  bypassRulesets?: string[];
}

export interface EligibilityInput {
  verdictOfRecord: VerdictOfRecordFacts | null;
  acknowledgements?: string[];
  pr?: PullRequestFacts;
  principal?: { permissions: readonly string[] };
  org?: { allowMergingFromWindkeel?: boolean };
  app?: { workflowsPermission?: "read" | "write" | null };
  markReady?: boolean;
  seenBy?: "app" | "person";
  bypassSeenAtLastMerge?: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  flags: string[];
  rules: MergeRule[];
}

function workflowPaths(paths: readonly unknown[] | undefined | null): string[] {
  return (paths ?? []).filter((p): p is string => typeof p === "string" && p.startsWith(WORKFLOWS_PREFIX));
}

function rule(
  id: RuleId,
  ok: boolean,
  reason: string,
  { blocking = true, checked = true }: { blocking?: boolean; checked?: boolean } = {},
): MergeRule {
  return { id, ok, blocking, checked, reason };
}

function evaluateMergeEligibility(input: EligibilityInput): EligibilityResult {
  const { verdictOfRecord: v, pr = {}, principal = { permissions: [] }, org = {}, app = {} } = input;
  const acks = new Set(input.acknowledgements ?? []);
  const rules: MergeRule[] = [];

  if (pr.state === undefined) {
    rules.push(rule("pr-open", false, "PR state not known yet", { checked: false }));
  } else {
    rules.push(
      rule("pr-open", pr.state === "OPEN", pr.state === "OPEN" ? "PR is open" : `PR is ${pr.state.toLowerCase()}`),
    );
  }

  if (!v) {
    rules.push(rule("head-verified", false, "No verdict of record, so no verified candidate to compare against"));
  } else if (!pr.headSha) {
    rules.push(rule("head-verified", false, "PR head SHA not known yet", { checked: false }));
  } else if (pr.headSha.toLowerCase() !== String(v.candidateSha).toLowerCase()) {
    rules.push(
      rule(
        "head-verified",
        false,
        `PR head ${pr.headSha.slice(0, 7)} is not the verified candidate ${String(v.candidateSha).slice(0, 7)}; the verdict is stale`,
      ),
    );
  } else {
    rules.push(rule("head-verified", true, `PR head is the verified candidate ${pr.headSha.slice(0, 7)}`));
  }

  if (!v) {
    rules.push(rule("verdict", false, "No verdict of record"));
  } else if (v.verdict === "pass" || v.verdict === "warn") {
    rules.push(rule("verdict", true, `Verdict of record is ${v.verdict}`));
  } else {
    rules.push(rule("verdict", false, `Verdict of record is ${v.verdict}`));
  }

  if (v?.verdict === "warn") {
    const items = v.needsALook ?? [];
    const missing = items.filter((i) => !acks.has(i.id));
    rules.push(
      missing.length === 0
        ? rule("warn-acknowledged", true, `All ${items.length} Needs-a-look item(s) acknowledged`)
        : rule(
            "warn-acknowledged",
            false,
            `${missing.length} of ${items.length} Needs-a-look item(s) not acknowledged: ${missing.map((i) => i.id).join(", ")}`,
          ),
    );
  } else {
    rules.push(rule("warn-acknowledged", true, "Not a warn; nothing to acknowledge"));
  }

  const hasPerm = (principal.permissions ?? []).includes("runs.merge");
  rules.push(rule("permission", hasPerm, hasPerm ? "Holds runs.merge" : "Does not hold runs.merge"));

  const allowed = org.allowMergingFromWindkeel === true;
  rules.push(
    rule("org-allows", allowed, allowed ? "Allow merging from Windkeel is on" : "Allow merging from Windkeel is off for this organization"),
  );

  if (pr.isDraft === undefined) {
    rules.push(rule("draft", false, "Draft state not known yet", { checked: false }));
  } else if (!pr.isDraft) {
    rules.push(rule("draft", true, "Not a draft"));
  } else if (input.markReady) {
    rules.push(rule("draft", true, "Draft; will be marked ready with the person's token before merging"));
  } else {
    rules.push(rule("draft", false, "Draft; only Mark ready and merge may merge it"));
  }

  const flags: string[] = [];
  if (pr.changedPaths === undefined) {
    rules.push(rule("workflows", false, "Changed files not known yet", { checked: false }));
  } else {
    const wf = workflowPaths(pr.changedPaths);
    const complete = pr.changedPathsComplete !== false;
    const appHasWorkflows = app.workflowsPermission === "write";
    if (wf.length > 0 || !complete) {
      flags.push("touches-workflows");
      const what = wf.length > 0 ? `touches ${wf.join(", ")}` : "file list is truncated, so it may touch .github/workflows/";
      rules.push(
        appHasWorkflows
          ? rule("workflows", true, `PR ${what}; the App holds Workflows: write, so the person's token can carry it`)
          : rule(
              "workflows",
              false,
              `PR ${what}; GitHub refuses a GitHub App token (installation or user) without the App's Workflows permission — merge it on GitHub`,
            ),
      );
    } else {
      rules.push(rule("workflows", true, "PR does not touch .github/workflows/"));
    }
  }

  if (pr.mergeStateStatus === undefined) {
    rules.push(rule("protection", false, "GitHub merge state not known yet", { checked: false }));
  } else if (MERGEABLE_WITHOUT_BYPASS.has(pr.mergeStateStatus)) {
    rules.push(rule("protection", true, `GitHub reports ${pr.mergeStateStatus}: mergeable without bypassing protection`));
  } else if (pr.mergeStateStatus === "DRAFT" && pr.isDraft && input.markReady) {
    rules.push(rule("protection", true, "Draft; protection re-checked after marking ready", { checked: false, blocking: false }));
  } else if (pr.mergeStateStatus === "BLOCKED" && pr.viewerCanMergeAsAdmin) {
    rules.push(
      rule("protection", false, "GitHub reports BLOCKED; only an admin bypass would merge it, and Windkeel never bypasses"),
    );
  } else {
    rules.push(rule("protection", false, `GitHub reports ${pr.mergeStateStatus}; not mergeable as-is`));
  }

  rules.push(bypassRule(input));

  const eligible = rules.every((r) => !r.blocking || (r.ok && r.checked));
  return { eligible, flags, rules };
}

function bypassRule(input: EligibilityInput): MergeRule {
  const pr = input.pr ?? {};
  if (pr.viewerCanMergeAsAdmin === true || pr.viewerCanBypassRulesets === true) {
    const which =
      pr.viewerCanMergeAsAdmin === true
        ? "GitHub reports you can merge as an admin past branch protection"
        : `GitHub reports you can bypass the ruleset${(pr.bypassRulesets ?? []).length === 1 ? "" : "s"} ${(pr.bypassRulesets ?? []).map((n) => `\u201c${n}\u201d`).join(", ")}`.trim();
    return { ...rule("bypass", false, BYPASS_REASON), detail: which };
  }
  if (pr.viewerCanMergeAsAdmin === false && pr.viewerCanBypassRulesets === false) {
    return rule("bypass", true, "GitHub reports you can't bypass the repository's protection");
  }
  if (input.seenBy === "app") {
    if (input.bypassSeenAtLastMerge) {
      return rule("bypass", false, BYPASS_REASON, { blocking: false });
    }
    return rule(
      "bypass",
      false,
      "Checked with your GitHub token when you merge: Windkeel won't merge as someone the repository lets bypass its protection",
      { blocking: false, checked: false },
    );
  }
  return rule("bypass", false, "GitHub didn't say whether you can bypass the repository's protection, so Windkeel can't guarantee it applies", {
    checked: false,
  });
}

export interface AuthorizationFacts {
  status: "valid" | "needs_reauth";
  githubUserId: number;
  githubLogin: string;
}

export interface MergeInput extends EligibilityInput {
  deploymentEnabled: boolean;
  authorization: AuthorizationFacts | null;
  linkedGithubUserId: number | null;
}

export function evaluateMerge(input: MergeInput): EligibilityResult {
  const base = evaluateMergeEligibility(input);
  const enabled = input.deploymentEnabled
    ? rule("enabled", true, "Merging from Windkeel is on for this deployment")
    : rule("enabled", false, "Merging from Windkeel is off for this deployment (WINDKEEL_MERGE)");
  const rules = [enabled, ...base.rules, authorizationRule(input)];
  return { eligible: rules.every((r) => !r.blocking || (r.ok && r.checked)), flags: base.flags, rules };
}

function authorizationRule(input: MergeInput): MergeRule {
  const a = input.authorization;
  if (!a) return rule("authorization", false, "You haven't connected GitHub to merge from Windkeel");
  if (a.status !== "valid") return rule("authorization", false, "Your GitHub authorization needs renewing — connect GitHub again");
  if (input.linkedGithubUserId === null) {
    return rule("authorization", false, "Your Windkeel account is not linked to a GitHub account");
  }
  if (a.githubUserId !== input.linkedGithubUserId) {
    return rule(
      "authorization",
      false,
      `Your GitHub authorization is for @${a.githubLogin}, not the GitHub account you sign in with — connect GitHub again as yourself`,
    );
  }
  return rule("authorization", true, `Merges as @${a.githubLogin}`);
}

export function firstFailing(result: EligibilityResult): MergeRule | null {
  return result.rules.find((r) => r.blocking && !(r.ok && r.checked)) ?? null;
}

export function mergeStateFromRest(state: string | null | undefined): string {
  return typeof state === "string" && state !== "" ? state.toUpperCase() : "UNKNOWN";
}
