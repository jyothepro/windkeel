import { test } from "node:test";
import assert from "node:assert/strict";
import { attemptLine, mergeButtonLabel, mergeFacts, ruleInWords, type MergeEligibility, type MergeRule } from "./merge.ts";

const rule = (id: MergeRule["id"], over: Partial<MergeRule> = {}): MergeRule => ({ id, ok: false, blocking: true, checked: true, reason: "", ...over });

const eligibility = (over: Partial<MergeEligibility> = {}): MergeEligibility => ({
  eligible: true,
  rules: [],
  flags: [],
  failing: null,
  needsAcknowledgement: [],
  verifiedSha: "c".repeat(40),
  verdict: "pass",
  prNumber: 7,
  prUrl: null,
  isDraft: false,
  authorization: { githubLogin: "alice", status: "valid" },
  merge: null,
  githubError: null,
  ...over,
});

test("the card names the failing rule in console-ux.md's words", () => {
  assert.equal(ruleInWords(rule("org-allows")), "Merging is off for this organization");
  assert.equal(ruleInWords(rule("head-verified")), "A commit landed after verification — verify again");
  assert.equal(ruleInWords(rule("permission")), "You need the Merge permission");
  assert.match(ruleInWords(rule("workflows")), /merge this one on GitHub/);
  assert.match(ruleInWords(rule("protection", { reason: "GitHub reports BLOCKED; only an admin bypass would merge it, and Windkeel never bypasses" })), /never bypasses/);
  assert.match(ruleInWords(rule("protection", { reason: "GitHub reports BEHIND; not mergeable as-is" })), /\(BEHIND\)/);
  assert.match(ruleInWords(rule("protection", { checked: false })), /couldn't be read/);
  assert.equal(ruleInWords(rule("authorization", { reason: "You haven't connected GitHub to merge from Windkeel" })), "You haven't connected GitHub to merge from Windkeel");
});

test("merge facts: eligible, blocked with a reason, or null when merging is off", () => {
  assert.equal(mergeFacts(null), null);
  assert.deepEqual(mergeFacts(eligibility()), { eligible: true, blockedBy: null, isDraft: false, caution: null });
  const blocked = mergeFacts(eligibility({ eligible: false, failing: rule("org-allows") }));
  assert.equal(blocked?.blockedBy, "Merging is off for this organization");
  const unread = mergeFacts(eligibility({ eligible: false, githubError: "GitHub couldn't be read just now; try again in a moment" }));
  assert.match(unread?.blockedBy ?? "", /couldn't be read/);
});

test("a draft's button says Mark ready and merge; nothing says merge-ready", () => {
  assert.equal(mergeButtonLabel(true), "Mark ready and merge");
  assert.equal(mergeButtonLabel(false), "Merge pull request");
  for (const label of [mergeButtonLabel(true), mergeButtonLabel(false)]) assert.doesNotMatch(label, /merge-ready|ready to merge/i);
});

test("the newest attempt is said plainly", () => {
  const at = { id: "m", verifiedSha: "c", mergedSha: null, createdAt: "", completedAt: null, githubLogin: "alice" };
  assert.equal(attemptLine(null), null);
  assert.match(attemptLine({ ...at, status: "pending", reason: null }) ?? "", /Merging as you/);
  assert.match(attemptLine({ ...at, status: "merged", reason: null }) ?? "", /Merged as @alice/);
  assert.match(attemptLine({ ...at, status: "refused", reason: "a commit landed after verification" }) ?? "", /refused: a commit landed/);
});

const BYPASS =
  "The repository lets you bypass its protection, so Windkeel can't guarantee it applies. Turn on \u201cDo not allow bypassing the above settings\u201d (or empty the ruleset's bypass list) to merge from Windkeel.";

test("bypass (ADR-0029 §5.1, amended): the card names it — blocking at merge time, a caution in the preview", () => {
  assert.equal(ruleInWords(rule("bypass", { reason: BYPASS })), BYPASS);
  const blocked = mergeFacts(eligibility({ eligible: false, failing: rule("bypass", { reason: BYPASS }) }));
  assert.equal(blocked?.blockedBy, BYPASS);
  const unknown = mergeFacts(eligibility({ rules: [rule("bypass", { checked: false, blocking: false, reason: "Checked with your GitHub token when you merge" })] }));
  assert.equal(unknown?.caution, null);
  const seen = mergeFacts(eligibility({ rules: [rule("bypass", { blocking: false, reason: BYPASS })] }));
  assert.equal(seen?.eligible, true);
  assert.equal(seen?.caution, BYPASS);
});
