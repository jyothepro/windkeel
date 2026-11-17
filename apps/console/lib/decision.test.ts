import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionFor, inboxGroup, nextAction, nextActionTone, stageOutcome, verdictHeadline, verificationPhase, type DecisionFacts } from "./decision.ts";
import { RUN_STATES, dotForRun } from "./run-states.ts";

const facts = (over: Partial<DecisionFacts>): DecisionFacts => ({
  state: "IMPLEMENTING",
  finalVerdict: null,
  prNumber: null,
  prMergedAt: null,
  stopReason: null,
  criteriaCount: 3,
  criteriaGeneratedBy: null,
  criteriaSatisfied: null,
  stopReasonText: null,
  hasPullRequest: false,
  ...over,
});

test("every state has an inbox group, a next action and a decision", () => {
  for (const state of RUN_STATES) {
    assert.ok(inboxGroup(state));
    assert.ok(nextAction(facts({ state })).length > 0, state);
    assert.ok(decisionFor(facts({ state })).needs.length > 0, state);
  }
});

test("a pull request waiting on review is ready to review, not a decision", () => {
  assert.equal(inboxGroup("WAITING_FOR_HUMAN"), "review");
  assert.equal(inboxGroup("WAITING_FOR_APPROVAL"), "decide");
  assert.equal(inboxGroup("BLOCKED"), "decide");
});

test("Windkeel never calls a change merge-ready — with merging off, eligible or blocked", () => {
  const merges = [
    null,
    { eligible: true, blockedBy: null, isDraft: false },
    { eligible: true, blockedBy: null, isDraft: true },
    { eligible: false, blockedBy: "Merging is off for this organization", isDraft: false },
  ];
  for (const state of RUN_STATES) {
    for (const verdict of ["pass", "warn", "fail", null] as const) {
      for (const merge of merges) {
        const d = decisionFor(facts({ state, finalVerdict: verdict, hasPullRequest: true, prNumber: 7, merge }));
        const text = [nextAction(facts({ state, finalVerdict: verdict, prNumber: 7 })), d.needs, d.why, d.recommended ?? "", d.consequence ?? ""].join(" ");
        assert.doesNotMatch(text, /merge-ready|ready to merge|safe to merge/i, `${state}/${verdict}/${JSON.stringify(merge)}`);
      }
    }
  }
});

test("with merging off, the card never offers a merge", () => {
  for (const state of RUN_STATES) {
    const d = decisionFor(facts({ state, finalVerdict: "pass", hasPullRequest: true }));
    assert.notEqual(d.primary, "merge", state);
    assert.notEqual(d.secondary, "merge", state);
  }
});

test("eligible: Verified — review and merge, with Merge pull request as the primary action", () => {
  const d = decisionFor(facts({ state: "PR_READY", finalVerdict: "pass", hasPullRequest: true, merge: { eligible: true, blockedBy: null, isDraft: false } }));
  assert.equal(d.needs, "Verified — review and merge");
  assert.equal(d.primary, "merge");
  assert.equal(d.secondary, "open_pull_request");
  assert.match(d.recommended ?? "", /merges as you/);
  const warn = decisionFor(facts({ state: "WAITING_FOR_HUMAN", finalVerdict: "warn", hasPullRequest: true, merge: { eligible: true, blockedBy: null, isDraft: false } }));
  assert.equal(warn.needs, "Verified with warnings — review and merge");
  assert.match(warn.recommended ?? "", /acknowledge each warning/);
});

test("a caution from the last attempt (you can bypass protection) is named on the card beside the merge button", () => {
  const caution = "The repository lets you bypass its protection, so Windkeel can't guarantee it applies.";
  const d = decisionFor(facts({ state: "PR_READY", finalVerdict: "pass", hasPullRequest: true, merge: { eligible: true, blockedBy: null, isDraft: false, caution } }));
  assert.equal(d.primary, "merge");
  assert.match(d.recommended ?? "", /last merge was refused: The repository lets you bypass its protection/);
  const blocked = decisionFor(facts({ state: "PR_READY", finalVerdict: "pass", hasPullRequest: true, merge: { eligible: false, blockedBy: caution, isDraft: false } }));
  assert.match(blocked.recommended ?? "", /lets you bypass its protection/);
});

test("not eligible: no merge button, and the card names the rule that doesn't hold", () => {
  const d = decisionFor(facts({ state: "PR_READY", finalVerdict: "pass", hasPullRequest: true, merge: { eligible: false, blockedBy: "A commit landed after verification — verify again", isDraft: false } }));
  assert.equal(d.primary, "open_pull_request");
  assert.notEqual(d.secondary, "merge");
  assert.match(d.recommended ?? "", /A commit landed after verification — verify again/);
  assert.doesNotMatch(d.needs, /merge/i);
});

test("merging is only ever offered on a pull request waiting for review", () => {
  for (const state of RUN_STATES) {
    if (state === "PR_READY" || state === "WAITING_FOR_HUMAN") continue;
    const d = decisionFor(facts({ state, finalVerdict: "pass", hasPullRequest: true, merge: { eligible: true, blockedBy: null, isDraft: false } }));
    assert.notEqual(d.primary, "merge", state);
  }
});

test("a warn verdict is named in the review decision, not hidden", () => {
  const d = decisionFor(facts({ state: "WAITING_FOR_HUMAN", finalVerdict: "warn", hasPullRequest: true }));
  assert.match(d.needs, /warnings/);
  assert.equal(d.primary, "open_pull_request");
});

test("a working run asks nothing of you", () => {
  assert.equal(decisionFor(facts({ state: "VERIFYING" })).needed, false);
  assert.equal(decisionFor(facts({ state: "VERIFYING" })).primary, "guide");
  assert.equal(decisionFor(facts({ state: "PROVISIONING" })).primary, null);
});

test("a tool that did not finish is unavailable, whatever the stage recorded", () => {
  assert.equal(stageOutcome("passed", true, "after"), "unavailable");
  assert.equal(stageOutcome("skipped", false, "after"), "not_tested");
  assert.equal(stageOutcome("warning", false, "after"), "passed_with_warnings");
  assert.equal(stageOutcome("completed_with_findings", false, "after"), "found_issues", "a stage with findings didn't pass");
});

test("an unreported stage is never drawn as passed, nor as running when nothing runs", () => {
  assert.equal(stageOutcome(null, false, "after"), "not_reported");
  assert.equal(stageOutcome(null, false, "verifying"), "running");
  assert.equal(stageOutcome(null, false, "before"), "not_run_yet");
  assert.equal(verificationPhase("WAITING_FOR_APPROVAL", false), "before", "a run waiting on approval is verifying nothing");
  assert.equal(verificationPhase("REPAIRING", true), "after");
});

test("a review with no warnings doesn't ask you to read warnings", () => {
  const d = decisionFor(facts({ state: "WAITING_FOR_HUMAN", finalVerdict: "pass", hasPullRequest: true }));
  assert.doesNotMatch(`${d.needs} ${d.why} ${d.recommended}`, /warning/i);
});

test("the headline repeats the verdict in words", () => {
  assert.equal(verdictHeadline("warn", false), "Verified with warnings");
  assert.equal(verdictHeadline(null, true), "Not verified yet");
});

test("a failed run is never listed under Done, and its line is drawn as failed", () => {
  for (const state of ["FAILED", "MAX_REPAIR_ATTEMPTS_REACHED"] as const) {
    assert.equal(inboxGroup(state), "failed", state);
    assert.equal(nextActionTone(state), "failed", state);
  }
  assert.equal(inboxGroup("CANCELLED"), "done");
  assert.equal(inboxGroup("COMPLETED"), "done");
  assert.equal(nextActionTone("WAITING_FOR_APPROVAL"), "yours");
  assert.equal(nextActionTone("IMPLEMENTING"), null);
});

test("the Failed group doesn't change the mark: no verdict is still skipped", () => {
  assert.equal(dotForRun("FAILED", null), "skipped");
  assert.equal(dotForRun("MAX_REPAIR_ATTEMPTS_REACHED", "fail"), "fail");
});
