import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  IllegalTransitionError,
  MAX_GENERATED_CRITERIA,
  MakerIdentityRequiredError,
  UnapprovedCriteriaError,
  applyCommand,
  approveCriteria,
  assertProvisionable,
  criteriaGateway,
  decideCriteria,
  extractIssueCriteria,
  needsGeneration,
  normalizeGeneratedCriteria,
  parseCommand,
} from "../dist/factory/criteria-gate.js";
import { NoIndependentProviderError } from "@windkeel/verification/providers/index.js";
import { persistedCriteriaOutcome } from "../dist/factory/workflow/handlers/intake.js";
import { tempDir } from "./helpers.js";

const issue = (body, overrides = {}) => ({
  number: 74,
  url: "https://github.com/jyothepro/orqon/issues/74",
  title: "Criteria approval gate",
  body,
  ...overrides,
});

/** ADR-0010: the maker is OpenAI, so an Anthropic endpoint is the independent one. */
const MAKER = { vendor: "openai", model: "gpt-5-codex" };
const endpoint = (vendor, model) => ({ vendor, model, apiKey: "test-key" });

/** The scripted fake at the model boundary — the pipeline's only test double. */
function scripted(text) {
  const path = join(tempDir("criteria"), "generated.json");
  writeFileSync(path, text);
  return { endpoints: [endpoint("anthropic", "claude-sonnet-4-5")], maker: MAKER, fakes: { criteria: path } };
}

const generated = (...texts) =>
  scripted(JSON.stringify({ criteria: texts.map((text) => ({ text })) }));

const run = (overrides = {}) => ({
  status: "WAITING_FOR_APPROVAL",
  acceptance_criteria: [{ id: "AC1", text: "the gate holds", source: { kind: "linked_issue", ref: "x" } }],
  criteria_provenance: "generated",
  criteria_approved_at: null,
  ...overrides,
});

const ISSUE_WITH_CRITERIA = `Implement the gate.

## Acceptance criteria

- [ ] a zero-criteria issue holds at WAITING_FOR_APPROVAL
- [ ] approval provisions
`;

// ADR-0012 §1–2: extraction decides the path, deterministically.

test("an issue with a checklist proceeds on the author's own words, with no model call", async () => {
  // No endpoints and no fake: any model call at all would throw here.
  const decision = await decideCriteria(issue(ISSUE_WITH_CRITERIA), { endpoints: [] });

  assert.equal(decision.kind, "proceed");
  assert.equal(decision.provenance, "extracted");
  assert.equal(decision.nextState, "PROVISIONING");
  assert.deepEqual(
    decision.criteria.map((c) => c.text),
    ["a zero-criteria issue holds at WAITING_FOR_APPROVAL", "approval provisions"],
  );
});

test("one extracted criterion is enough — generation triggers only on zero", () => {
  assert.equal(needsGeneration(extractIssueCriteria(issue("- [ ] just this one"))), false);
  assert.equal(needsGeneration(extractIssueCriteria(issue("Please fix the thing."))), true);
});

test("extraction is verbatim and identical issues take identical paths", () => {
  const first = extractIssueCriteria(issue(ISSUE_WITH_CRITERIA));
  const second = extractIssueCriteria(issue(ISSUE_WITH_CRITERIA));
  assert.deepEqual(first, second);
  assert.deepEqual(first[0].source, {
    kind: "linked_issue",
    ref: "https://github.com/jyothepro/orqon/issues/74",
  });
});

// ADR-0012 §4: generated criteria wait.

test("a zero-criteria issue holds at WAITING_FOR_APPROVAL with the criteria to sign off on", async () => {
  const decision = await decideCriteria(
    issue("Make the dashboard load faster."),
    generated("the dashboard's first contentful paint is under 1s", "the slow query is covered by a test"),
  );

  assert.equal(decision.kind, "await_approval");
  assert.equal(decision.provenance, "generated");
  assert.equal(decision.nextState, "WAITING_FOR_APPROVAL");
  assert.deepEqual(
    decision.criteria.map((c) => c.id),
    ["AC1", "AC2"],
  );
  assert.match(decision.comment, /the dashboard's first contentful paint is under 1s/);
  assert.match(decision.comment, /\/windkeel approve/);
  assert.match(decision.comment, /\/windkeel cancel/);
});

test("the approval comment names the model that guessed, so the operator knows whose words these are", async () => {
  const decision = await decideCriteria(issue("Speed it up."), generated("it is faster"));
  assert.equal(decision.generatedBy.model, "scripted-fake");
  assert.match(decision.comment, /scripted-fake/);
});

// ADR-0012 §3 with ADR-0010: the checker's side generates.

test("generation selects an endpoint independent of the maker", () => {
  const gateway = criteriaGateway({
    endpoints: [endpoint("openai", "gpt-5-codex"), endpoint("anthropic", "claude-sonnet-4-5")],
    maker: MAKER,
  });
  assert.equal(gateway.vendor, "anthropic");
});

test("the maker's vendor never authors the yardstick — no independent endpoint is run-fatal", () => {
  assert.throws(
    () => criteriaGateway({ endpoints: [endpoint("openai", "gpt-5-codex")], maker: MAKER }),
    NoIndependentProviderError,
  );
  assert.throws(
    () => criteriaGateway({ endpoints: [], maker: MAKER }),
    NoIndependentProviderError,
  );
});

test("the factory must state the maker explicitly rather than have it inferred", () => {
  assert.throws(
    () => criteriaGateway({ endpoints: [endpoint("anthropic", "claude-sonnet-4-5")] }),
    MakerIdentityRequiredError,
  );
});

test("a run that cannot generate independently fails rather than skipping the criteria", async () => {
  await assert.rejects(
    decideCriteria(issue("Fix it."), { endpoints: [endpoint("openai", "gpt-5-codex")], maker: MAKER }),
    NoIndependentProviderError,
  );
});

// ADR-0012 §5: no criteria, no run.

test("generation that produces nothing usable cancels the run with a reason", async () => {
  for (const response of [
    JSON.stringify({ criteria: [] }),
    JSON.stringify({ criteria: [{ text: "   " }] }),
    "I could not determine any acceptance criteria for this issue.",
  ]) {
    const decision = await decideCriteria(issue("Do the needful."), scripted(response));
    assert.equal(decision.kind, "cancel", `response: ${response}`);
    assert.equal(decision.nextState, "CANCELLED");
    assert.match(decision.reason, /no verifiable acceptance criteria/);
    assert.match(decision.comment, /re-add the `windkeel` label/);
  }
});

// Normalization: what the operator approves is exactly what verification is held to.

test("generated text is stripped of markers, de-duplicated, and capped", () => {
  const criteria = normalizeGeneratedCriteria(
    ["- [ ] the page loads", "The Page Loads", "", "  * ships   a   test  "],
    issue(""),
  );
  assert.deepEqual(
    criteria.map((c) => c.text),
    ["the page loads", "ships a test"],
  );
  assert.deepEqual(
    criteria.map((c) => c.id),
    ["AC1", "AC2"],
  );

  const many = normalizeGeneratedCriteria(
    Array.from({ length: 25 }, (_, i) => `criterion ${i}`),
    issue(""),
  );
  assert.equal(many.length, MAX_GENERATED_CRITERIA);
});

// ADR-0009 §3 as amended: the comment commands.

test("a command is a line of its own, and a quoted one is not a command", () => {
  assert.equal(parseCommand("/windkeel approve"), "approve");
  assert.equal(parseCommand("looks right to me\n/windkeel approve\n"), "approve");
  assert.equal(parseCommand("  /WINDKEEL Cancel  "), "cancel");
  assert.equal(parseCommand("say /windkeel approve when you are happy"), null);
  assert.equal(parseCommand("> /windkeel approve\n\nnot yet — AC2 is wrong"), null);
  assert.equal(parseCommand("/windkeel retry"), null);
  assert.equal(parseCommand("no commands here"), null);
});

test("approve advances the waiting run and only the waiting run", () => {
  assert.equal(applyCommand(run(), "approve"), "PROVISIONING");
  assert.throws(() => applyCommand(run({ status: "PLANNING" }), "approve"), IllegalTransitionError);
  assert.throws(() => applyCommand(run({ status: "IMPLEMENTING" }), "approve"), IllegalTransitionError);
});

test("cancel ends any non-terminal run; nothing leaves a terminal state", () => {
  assert.equal(applyCommand(run(), "cancel"), "CANCELLED");
  assert.equal(applyCommand(run({ status: "IMPLEMENTING" }), "cancel"), "CANCELLED");
  assert.throws(() => applyCommand(run({ status: "COMPLETED" }), "cancel"), IllegalTransitionError);
  assert.throws(() => applyCommand(run({ status: "CANCELLED" }), "approve"), IllegalTransitionError);
});

// #74 §4: the gate is enforced by the service, not by convention.

test("nothing provisions while generated criteria are unapproved", () => {
  assert.throws(() => assertProvisionable(run()), UnapprovedCriteriaError);
  assert.throws(
    // Even a service bug that walked the run past the wait provisions nothing.
    () => assertProvisionable(run({ status: "PROVISIONING" })),
    UnapprovedCriteriaError,
  );
});

test("approved generated criteria and extracted criteria both provision", () => {
  const approved = approveCriteria(run(), new Date("2026-08-18T00:00:00Z"));
  assert.equal(approved.status, "PROVISIONING");
  assert.doesNotThrow(() => assertProvisionable(approved));
  assert.doesNotThrow(() => assertProvisionable(run({ criteria_provenance: "extracted" })));
});

test("a retry keeps persisted generated criteria behind their approval gate", () => {
  const task = {
    acceptanceCriteria: run().acceptance_criteria,
    criteriaProvenance: "generated",
    criteriaApprovedAt: null,
  };
  assert.equal(persistedCriteriaOutcome(task).to, "WAITING_FOR_APPROVAL");
  assert.equal(
    persistedCriteriaOutcome({ ...task, criteriaApprovedAt: new Date("2026-09-26T00:00:00Z") }).to,
    "PROVISIONING",
  );
  assert.equal(persistedCriteriaOutcome({ ...task, acceptanceCriteria: [] }), null);
});

test("a run with no criteria at all never provisions", () => {
  assert.throws(
    () => assertProvisionable(run({ criteria_provenance: "extracted", acceptance_criteria: [] })),
    UnapprovedCriteriaError,
  );
});
