import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAPPING_SYSTEM_PROMPT,
  mappingUserPrompt,
} from "../packages/verification/dist/providers/prompt.js";

/**
 * #246: a criterion about the change *itself* — "no file outside README.md is modified", "the
 * existing line is unchanged" — is settled by reading the diff, and no evidence item's `id` names
 * the diff. The mapper judged two such criteria correctly in run `6d7151f5`, cited nothing
 * because it had nothing obvious to cite, and the uncited-claim guard turned both into
 * `unsatisfied`. The run failed on a change that met every criterion.
 *
 * The guard is not the bug and is deliberately untouched — `mapping.test.js` still covers it.
 * What changed is that the mapper is now told which item carries the diff, and is given the same
 * repository fact sheet the reviewer gets.
 *
 * Prompt text is the behaviour here, so it is pinned the way `TASK_USAGE` is: these instructions
 * are load-bearing, and losing one to an edit would restore a failure that costs a whole run.
 */

test("the mapper is told which evidence item carries the diff", () => {
  assert.match(MAPPING_SYSTEM_PROMPT, /criterion about the change itself is demonstrated by the diff/i);
  assert.match(MAPPING_SYSTEM_PROMPT, /Cite the \*\*review\*\* evidence item/);
});

/**
 * The half that keeps the guard honest. Redirecting every diff-level claim at the review item is
 * only correct while that item exists; with no reviewer configured the package genuinely contains
 * nothing that speaks for the diff, and the answer is "unknown" — which warns and reaches a human
 * — not a "satisfied" nobody can support.
 */
test("with no review item, a diff-only criterion is unknown rather than satisfied", () => {
  assert.match(MAPPING_SYSTEM_PROMPT, /no review item/i);
  assert.match(MAPPING_SYSTEM_PROMPT, /is "unknown"/);
  assert.match(MAPPING_SYSTEM_PROMPT, /Do not claim "satisfied" with a citation you cannot make/);
});

test("every satisfied mapping still requires a citation", () => {
  // The rule this issue must not weaken: the fix makes the claim citable, not optional.
  assert.match(MAPPING_SYSTEM_PROMPT, /"satisfied" requires evidence/);
  assert.match(MAPPING_SYSTEM_PROMPT, /still needs a citation/);
});

test("the mapper is given the repository context when there is one, and works without it", () => {
  const base = {
    criteria: [{ id: "AC1", text: "x" }],
    evidence: [{ id: "ev-01", stage: "tests", status: "passed", summary: "ok" }],
    diff: "--- a\n+++ b\n",
  };
  assert.doesNotMatch(mappingUserPrompt(base), /REPOSITORY CONTEXT/);

  const withContext = mappingUserPrompt({ ...base, repositoryContext: "REPOSITORY CONTEXT — x" });
  assert.match(withContext, /REPOSITORY CONTEXT/);
  // The criteria and the diff are still there; context is added, nothing is displaced.
  assert.match(withContext, /Acceptance criteria:/);
  assert.match(withContext, /Evidence collected:/);
  assert.match(withContext, /```diff/);
});
