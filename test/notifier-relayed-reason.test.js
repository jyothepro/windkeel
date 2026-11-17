/**
 * ORQ-12: a transition's reason is relayed to a Slack thread, a Linear issue or a Jira issue —
 * read by whoever can file a task there, who need not be able to read the repository. A FAILED
 * reason quoted the maker's own failure text (or its stderr tail), which task text can steer: an
 * agent told to put a file's contents in its failure text and stop would have it posted back,
 * through a channel no sandbox egress policy governs. The full reason stays on the transition
 * row; the source hears only the orchestrator's own words.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  notifyRunOutcome,
  registerSourceNotifier,
  relayableReason,
  RELAYED_REASON_MAX_CHARS,
  unregisterSourceNotifier,
} from "../dist/intake/notifiers.js";

const SECRET = "QUJDRA==c2VjcmV0LWZyb20tdGhlLXJlcG8=";

test("a reason's detail is withheld whatever the prefix; only the orchestrator's head is relayed", () => {
  for (const prefix of [
    "worker session failed:",
    "repair turn failed:",
    "the repair turn could not be started:",
    "candidate capture failed:",
    "verification failed:",
    // `thrownStageReason`'s shape: an exception's message, which can quote launcher stderr.
    "implementing failed:",
    "repairing failed:",
    // A stage nobody has written yet: default-deny, not a list of known prefixes.
    "some future stage failed:",
  ]) {
    const relayed = relayableReason(`${prefix} ${SECRET}`);
    assert.ok(!relayed.includes(SECRET), `${prefix} must not relay the sandbox's text`);
    assert.ok(relayed.startsWith(prefix.slice(0, -1)), "the reason still says what failed");
    assert.match(relayed, /run's record/);
  }
  // A detail smuggled onto a second line is still a detail.
  assert.ok(!relayableReason(`implementing failed\n: ${SECRET}`).includes(SECRET));
  // A reason with no detail is the orchestrator's sentence and is relayed whole.
  const keyRefused =
    'the maker\'s model credential "team-router" was refused by openrouter.ai (401 Unauthorized) and is now marked invalid';
  assert.equal(relayableReason(keyRefused), keyRefused);
});

test("every relayed reason is one bounded line of printable text", () => {
  assert.equal(relayableReason(null), null);
  assert.equal(relayableReason("criteria declined by alice"), "criteria declined by alice");
  assert.equal(relayableReason("line one\n\n```\nline\u0007two "), "line one ``` line two");
  const long = relayableReason("x".repeat(5000));
  assert.equal(long.length, RELAYED_REASON_MAX_CHARS);
  assert.ok(long.endsWith("…"));
});

test("notifyRunOutcome hands the notifier the relayable reason, not the recorded one", async () => {
  const task = {
    id: "t1",
    repository_id: "r1",
    source_type: "orq12_test",
    source_reference: "ref",
    title: "t",
    description: "d",
    acceptance_criteria: [],
    risk_level: "low",
    priority: null,
    status: "OPEN",
    organization_id: "o1",
    source_context: {},
  };
  const pool = { query: async () => ({ rows: [task] }) };
  const seen = [];
  registerSourceNotifier({ sourceType: "orq12_test", notify: async (_t, _r, outcome) => seen.push(outcome) });
  try {
    await notifyRunOutcome(
      pool,
      { id: "run1", taskId: "t1" },
      { id: "tr1", fromState: "IMPLEMENTING", toState: "FAILED", reason: `worker session failed: ${SECRET}` },
      () => {},
    );
  } finally {
    unregisterSourceNotifier("orq12_test");
  }
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].reason.includes(SECRET));
  assert.match(seen[0].reason, /^worker session failed/);
});

test("#389: the verdict a source hears is numbers only — no finding, check output or summary text", async () => {
  const verdictModule = await import("../dist/intake/verdict.js");
  const { verdictLine } = verdictModule;
  const riskSummary = {
    blocking: [{ id: "f1", title: `exfiltrate ${SECRET}` }],
    unsatisfied: ["AC2"],
    satisfied: ["AC1"],
    evidence: [{ id: "ev-01", stage: "checks", type: "command", status: "failed", summary: `stderr: ${SECRET}` }],
  };
  const verdict = verdictModule.verdictFromRow({ verdict: "fail", risk_summary: riskSummary, criteria_count: 2 });
  assert.deepEqual(
    { passed: verdict.passed, failed: verdict.failed, total: verdict.total, blocking: verdict.blocking },
    { passed: 1, failed: 1, total: 2, blocking: 1 },
  );
  assert.equal(verdict.summary, "1 of 2 criteria failed, 1 blocking finding");
  assert.ok(!JSON.stringify(verdict).includes(SECRET));
  assert.equal(verdictLine(verdict), "Not verified: 1 of 2 criteria failed, 1 blocking finding");
  assert.equal(verdictLine(null), "No verification result");
  // A verdict the reader does not recognise is no verdict, never a pass.
  assert.equal(verdictModule.verdictFromRow({ verdict: "maybe", risk_summary: {} }), null);

  // Through the seam: a hand-off carries the verdict read from the latest verification.
  const task = {
    id: "t1", repository_id: "r1", source_type: "orq12_verdict", source_reference: "ref", title: "t", description: "d",
    acceptance_criteria: [], risk_level: "low", priority: null, status: "OPEN", organization_id: "o1", source_context: {},
  };
  const pool = {
    query: async (sql) =>
      /from verification_run/.test(sql)
        ? { rows: [{ verdict: "pass", risk_summary: { satisfied: ["AC1", "AC2"], unsatisfied: [], blocking: [] }, criteria_count: 2 }] }
        : { rows: [task] },
  };
  const seen = [];
  registerSourceNotifier({ sourceType: "orq12_verdict", notify: async (_t, _r, outcome) => seen.push(outcome) });
  try {
    await notifyRunOutcome(pool, { id: "run1", taskId: "t1" }, { id: "tr1", fromState: "PR_READY", toState: "WAITING_FOR_HUMAN", reason: null }, () => {});
    await notifyRunOutcome(pool, { id: "run1", taskId: "t1" }, { id: "tr2", fromState: "IMPLEMENTING", toState: "VERIFYING", reason: null }, () => {});
  } finally {
    unregisterSourceNotifier("orq12_verdict");
  }
  assert.equal(seen[0].kind, "state");
  assert.deepEqual(seen[0].verdict, { result: "pass", passed: 2, failed: 0, total: 2, blocking: 0, summary: "2/2 criteria met" });
  assert.equal(seen[1].kind, "progress");
  assert.equal(seen[1].verdict, undefined, "a progress update carries no verdict: there is none yet");
});
