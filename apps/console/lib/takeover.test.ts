import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionFor, inboxGroup, nextAction, nextActionTone, type DecisionFacts, type TakeoverFacts } from "./decision.ts";
import { RUN_STATES, TERMINAL_STATES, dotForRun, guidanceClosedReason, railFor, stateLabel } from "./run-states.ts";
import { PERMISSIONS, ADMIN_PERMISSIONS, defaultTokenScopes } from "./permissions.ts";
import { tabsFor, workspaceTab } from "./session.ts";
import { canStartSession, editorName, latestProvenance, missedTakeoverNotice, provenanceLabel, takeoverOf, workspaceStatus } from "./takeover.ts";
import type { CandidateProvenance, HumanSession, TakeoverInfo } from "./types.ts";

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

const on = (over: Partial<TakeoverFacts> = {}): TakeoverFacts => ({ enabled: true, permitted: true, canStart: true, session: null, ...over });

const session = (over: Partial<HumanSession> = {}): HumanSession => ({
  id: "hs-1",
  state: "ready",
  origin: "takeover",
  editor: { principalId: "p-1", login: "octocat", displayName: "The Octocat" },
  yours: true,
  awake: true,
  requestedAt: "2026-10-17T10:00:00Z",
  startedAt: "2026-10-17T10:02:00Z",
  lastActiveAt: "2026-10-17T10:05:00Z",
  expiresAt: "2026-10-18T10:02:00Z",
  seedSha: "a".repeat(40),
  intent: null,
  error: null,
  canHandBack: true,
  ...over,
});

const actions = (d: ReturnType<typeof decisionFor>) => [d.primary, d.secondary, ...(d.also ?? [])].filter(Boolean);

test("HUMAN_EDITING is non-terminal, needs you, and sits in Needs your decision", () => {
  assert.ok(RUN_STATES.includes("HUMAN_EDITING"));
  assert.ok(!TERMINAL_STATES.has("HUMAN_EDITING"));
  assert.equal(dotForRun("HUMAN_EDITING", null), "waiting", "the needs-you mark, not the agent's cyan");
  assert.equal(inboxGroup("HUMAN_EDITING"), "decide");
  assert.equal(nextAction(facts({ state: "HUMAN_EDITING" })), "You're editing — submit or hand back");
  assert.equal(nextActionTone("HUMAN_EDITING"), "yours");
  assert.equal(stateLabel("HUMAN_EDITING"), "You're editing");
  assert.notEqual(guidanceClosedReason("HUMAN_EDITING"), null, "no maker session listens while a person edits");
  const rail = Object.fromEntries(railFor("HUMAN_EDITING", ["IMPLEMENTING", "HUMAN_EDITING"]).map((r) => [r.step, r.status]));
  assert.equal(rail["Implement"], "current");
});

test("with take over off, or absent, nothing of it is offered in any state", () => {
  for (const state of RUN_STATES) {
    for (const t of [undefined, on({ enabled: false })]) {
      const d = decisionFor(facts({ state, hasPullRequest: true }), t);
      for (const a of ["take_over", "make_changes", "submit", "hand_back"] as const) assert.ok(!actions(d).includes(a), `${state}: ${a}`);
    }
  }
  const editing = decisionFor(facts({ state: "HUMAN_EDITING" }));
  assert.equal(editing.primary, null);
  assert.equal(editing.secondary, "cancel");
});

test("Take over is offered on IMPLEMENTING and REPAIRING, never while VERIFYING", () => {
  assert.ok(actions(decisionFor(facts({ state: "IMPLEMENTING" }), on())).includes("take_over"));
  assert.ok(actions(decisionFor(facts({ state: "REPAIRING" }), on())).includes("take_over"));
  assert.ok(!actions(decisionFor(facts({ state: "VERIFYING" }), on())).includes("take_over"));
  assert.equal(decisionFor(facts({ state: "IMPLEMENTING" }), on()).primary, "guide");
});

test("Make changes is offered on a verified pull request", () => {
  for (const state of ["PR_READY", "WAITING_FOR_HUMAN"] as const) {
    const d = decisionFor(facts({ state, finalVerdict: "pass", hasPullRequest: true }), on());
    assert.equal(d.primary, "open_pull_request");
    assert.ok(actions(d).includes("make_changes"));
  }
});

test("merge eligible and take over on: Merge pull request first, then Open pull request, Make changes and Cancel", () => {
  for (const state of ["PR_READY", "WAITING_FOR_HUMAN"] as const) {
    const d = decisionFor(facts({ state, finalVerdict: "pass", hasPullRequest: true, merge: { eligible: true, blockedBy: null, isDraft: false } }), on());
    assert.equal(d.primary, "merge");
    for (const a of ["open_pull_request", "make_changes", "cancel"] as const) assert.ok(actions(d).includes(a), `${state}: ${a}`);
  }
});

test("nothing is offered that the API would refuse: no permission, a live session, or the cycle cap", () => {
  assert.ok(!actions(decisionFor(facts({ state: "IMPLEMENTING" }), on({ permitted: false }))).includes("take_over"));
  assert.ok(!actions(decisionFor(facts({ state: "IMPLEMENTING" }), on({ canStart: false }))).includes("take_over"));
  const capped: TakeoverInfo = { enabled: true, session: null, cycles: { used: 10, cap: 10 } };
  assert.equal(canStartSession(capped), false);
  assert.equal(canStartSession({ ...capped, cycles: { used: 2, cap: 10 } }), true);
  assert.equal(canStartSession({ ...capped, cycles: { used: 0, cap: 10 }, session: session() }), false);
  assert.equal(canStartSession({ ...capped, cycles: { used: 0, cap: 10 }, session: session({ state: "ended" }) }), true);
});

test("HUMAN_EDITING: Submit for verification is primary; Hand back and Cancel follow", () => {
  const d = decisionFor(facts({ state: "HUMAN_EDITING" }), on({ session: { yours: true, canHandBack: true, editor: "You" } }));
  assert.equal(d.needs, "You're editing — submit or hand back");
  assert.equal(d.primary, "submit");
  assert.equal(d.secondary, "hand_back");
  assert.deepEqual(d.also, ["cancel"]);
  const noMaker = decisionFor(facts({ state: "HUMAN_EDITING" }), on({ session: { yours: true, canHandBack: false, editor: "You" } }));
  assert.equal(noMaker.primary, "submit");
  assert.equal(noMaker.secondary, "cancel");
  const theirs = decisionFor(facts({ state: "HUMAN_EDITING" }), on({ session: { yours: false, canHandBack: true, editor: "The Octocat" } }));
  assert.equal(theirs.primary, null);
  assert.equal(theirs.secondary, "cancel");
  assert.match(theirs.why, /The Octocat/);
});

test("the Workspace tab exists only while HUMAN_EDITING with take over on, and leads", () => {
  assert.equal(tabsFor(false).some(([k]) => k === "workspace"), false);
  assert.equal(tabsFor(true)[0]![0], "workspace");
  assert.equal(workspaceTab({}, "HUMAN_EDITING", true).tab, "workspace");
  assert.equal(workspaceTab({ tab: "workspace" }, "HUMAN_EDITING", false).tab, "changes", "off: no Workspace tab, even by URL");
  assert.equal(workspaceTab({ tab: "workspace" }, "IMPLEMENTING", true).tab, "changes");
  assert.equal(workspaceTab({ tab: "files" }, "HUMAN_EDITING", true).tab, "files");
});

test("takeoverOf reads only an enabled block", () => {
  assert.equal(takeoverOf({}), null);
  assert.equal(takeoverOf({ takeover: { enabled: false, session: null, cycles: { used: 0, cap: 10 } } }), null);
  assert.ok(takeoverOf({ takeover: { enabled: true, session: null, cycles: { used: 0, cap: 10 } } }));
});

test("a sleeping workspace says so and is never drawn as failed; provisioning says what happens first", () => {
  assert.deepEqual(workspaceStatus(session({ awake: false })), { tone: "sleeping", line: "Sleeping — opens again when you type.", openable: true });
  assert.equal(workspaceStatus(session({ state: "sleeping" })).tone, "sleeping");
  assert.match(workspaceStatus(session({ state: "provisioning" })).line, /install runs without repository secrets before you get it/);
  assert.equal(workspaceStatus(session({ state: "provisioning" })).openable, false);
  assert.equal(workspaceStatus(session()).openable, true);
  assert.equal(workspaceStatus(session({ state: "submitting" })).openable, false);
  assert.equal(workspaceStatus(session({ state: "failed", error: "install failed" })).line, "install failed");
  assert.equal(editorName(session()), "You");
  assert.equal(editorName(session({ yours: false })), "The Octocat");
});

test("provenance names Windkeel with its harness and model, you, or mixed", () => {
  const maker: CandidateProvenance = { sha: "a".repeat(40), parentSha: null, at: null, commitAuthor: "maker", provenance: "maker", maker: { harness: "codex", model: "gpt-5" }, person: null };
  const person: CandidateProvenance = { sha: "b".repeat(40), parentSha: maker.sha, at: null, commitAuthor: "person", provenance: "mixed", maker: { harness: "codex", model: "gpt-5" }, person: { login: "octocat", principalId: "p-1" } };
  assert.equal(provenanceLabel(maker, null), "Windkeel (codex · gpt-5)");
  assert.equal(provenanceLabel(person, "octocat"), "mixed — Windkeel (codex · gpt-5) and you");
  assert.equal(provenanceLabel(person, "someone"), "mixed — Windkeel (codex · gpt-5) and octocat");
  assert.equal(provenanceLabel({ ...person, provenance: "person", maker: null }, "octocat"), "you");
  assert.equal(latestProvenance([maker, person]), person);
  assert.equal(latestProvenance([]), null);
});

test("runs.takeover is a permission Members hold and tokens get by default", () => {
  assert.ok(PERMISSIONS.includes("runs.takeover"));
  assert.ok(!ADMIN_PERMISSIONS.has("runs.takeover"));
  assert.ok(defaultTokenScopes(["runs.read", "runs.takeover"]).includes("runs.takeover"));
});

test("a takeover that missed its turn boundary says so and can be asked for again", () => {
  const missed = session({ state: "ended", outcome: "expired", error: "The turn ended before Windkeel could stop — take over again." });
  assert.deepEqual(workspaceStatus(missed), { tone: "ended", line: "The turn ended before Windkeel could stop — take over again.", openable: false });
  assert.equal(workspaceStatus(session({ state: "ended", outcome: "submitted", error: "the push token could not be revoked" })).line, "This workspace has ended.");
});

test("the run page says when a takeover missed its boundary, outside HUMAN_EDITING only", () => {
  const info = (over: Partial<HumanSession>): TakeoverInfo => ({ enabled: true, cycles: { used: 0, cap: 10 }, session: session(over) });
  const missed = { state: "ended" as const, outcome: "expired" as const, error: "The turn ended before Windkeel could stop — take over again." };
  assert.equal(missedTakeoverNotice(info(missed), "VERIFYING"), missed.error);
  assert.equal(missedTakeoverNotice(info(missed), "HUMAN_EDITING"), null);
  assert.equal(missedTakeoverNotice(info({ ...missed, origin: "make_changes" }), "VERIFYING"), null);
  assert.equal(missedTakeoverNotice(info({ state: "ended", outcome: "submitted" }), "VERIFYING"), null);
  assert.equal(canStartSession(info(missed)), true, "and Take over is offered again");
});
