import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CRITERIA_SYSTEM_PROMPT,
  MAPPING_SYSTEM_PROMPT,
} from "@windkeel/verification/providers/prompt.js";
import { demandsExecution } from "@windkeel/verification/stages/execution-criteria.js";

/**
 * #273: a criterion no change could ever satisfy used to fail a correct change.
 *
 * Run `db2bdce9` was failed on one criterion — *"all seven pre-existing tests in
 * src/queue/slots.test.ts pass unchanged"* — because the file holds **eight** tests. The number
 * came from the issue's own prose and the issue was wrong. The mapper's recorded reason ends
 * "even though these tests are unchanged and pass", so it judged accurately and marked the
 * criterion `unsatisfied` anyway, which is a `fail`, which bought a repair turn that could not
 * possibly close it: no change to the candidate can make eight tests be seven.
 *
 * Two prompts and one classifier are the fix, and prompts are hard to test. What is pinned here
 * is that the *instructions* carry the distinction, and that the classifier covers the family it
 * missed — not that a model obeys, which only a live run can show.
 */

test("the mapper is told unsatisfied is about the change, not about the repository", () => {
  // The distinction the run turned on: a false premise is not a defect in the diff.
  assert.match(MAPPING_SYSTEM_PROMPT, /premise is factually wrong is "unknown", never "unsatisfied"/);
  assert.match(MAPPING_SYSTEM_PROMPT, /does not do what the criterion asks/);
  // The consequence, stated so the instruction is not merely a rule to memorise.
  assert.match(MAPPING_SYSTEM_PROMPT, /no change can fix it/);
  assert.match(MAPPING_SYSTEM_PROMPT, /miscount/);

  // `unknown` must keep the property that makes this safe — since #241 it warns rather than
  // fails. If that sentence ever leaves the prompt, this fix stops working silently.
  assert.match(MAPPING_SYSTEM_PROMPT, /"unknown" does not fail the change/);
});

test("the criteria generator is told not to invent quantities", () => {
  assert.match(CRITERIA_SYSTEM_PROMPT, /free of counts and quantities you have not verified/i);
  // Named with its consequence rather than as a style rule, and with the real example.
  assert.match(CRITERIA_SYSTEM_PROMPT, /seven pre-existing tests/);
  assert.match(CRITERIA_SYSTEM_PROMPT, /line numbers, file counts/);
});

test("the test-suite family is recognised as demanding execution", () => {
  // The three most ordinary phrasings there are. All three returned false before #273.
  for (const text of [
    "npm test passes",
    "The existing test suite still passes",
    "the pre-existing tests are unchanged and still pass",
    "All seven pre-existing tests in src/queue/slots.test.ts pass unchanged",
    "npm run typecheck passes",
    "the suite is green",
  ]) {
    assert.equal(demandsExecution(text), true, `should demand execution: ${text}`);
  }
});

test("a criterion answerable from the diff alone is still not an execution claim", () => {
  /**
   * The classifier only ever appends an explanation to a criterion the mapper *already* marked
   * `unknown`, so a false positive costs a sentence. It is still worth keeping narrow: the
   * sentence tells an author their criterion needs a declared check, and saying that about a
   * criterion the diff settles is advice that would send them the wrong way.
   *
   * The last one matters most — it mentions a test file and a test, and asserts something the
   * diff shows. A rule keyed on the word "test" alone would catch it.
   */
  for (const text of [
    "A file named LICENSE exists at the repository root",
    "It contains the full Apache License 2.0 text",
    "The doc comment on nextSlot names the new setting instead of describing the rule as fixed",
    "publishing.min_pillar_gap_slots is accepted by projectConfigSchema, is optional, defaults to 1",
    "A test in src/queue/slots.test.ts verifies that a post with no pillar ignores min_pillar_gap_slots",
  ]) {
    assert.equal(demandsExecution(text), false, `should not demand execution: ${text}`);
  }
});

test("the window does not run past the end of a criterion", () => {
  // `[^\n]{0,80}` rather than `[^.]{0,80}`: the first version could not cross the dots in
  // `slots.test.ts`, which is exactly the criterion that caused this. One line is the unit.
  assert.equal(
    demandsExecution("All seven pre-existing tests in src/queue/slots.test.ts pass unchanged"),
    true,
  );
  // But it must not span two criteria concatenated by a caller.
  assert.equal(
    demandsExecution("A test file exists\nnothing else about it passes judgement here"),
    false,
  );
});
