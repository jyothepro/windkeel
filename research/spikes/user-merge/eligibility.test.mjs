import { test } from "node:test";
import assert from "node:assert/strict";
import { BYPASS_REASON, evaluateMergeEligibility, workflowPaths } from "./eligibility.mjs";

const SHA = "a".repeat(40);

function base(overrides = {}) {
  return {
    verdictOfRecord: { candidateSha: SHA, verdict: "pass", needsALook: [] },
    acknowledgements: [],
    pr: {
      state: "OPEN",
      headSha: SHA,
      isDraft: false,
      changedPaths: ["src/a.ts"],
      changedPathsComplete: true,
      mergeStateStatus: "CLEAN",
      viewerCanMergeAsAdmin: false,
      viewerCanBypassRulesets: false,
    },
    principal: { permissions: ["runs.merge"] },
    org: { allowMergingFromWindkeel: true },
    app: { workflowsPermission: null },
    markReady: false,
    ...overrides,
  };
}
const withPr = (pr, rest = {}) => base({ ...rest, pr: { ...base().pr, ...pr } });
const ruleOf = (r, id) => r.rules.find((x) => x.id === id);

test("a verified pass on a clean, ready PR is eligible and every rule says why", () => {
  const r = evaluateMergeEligibility(base());
  assert.equal(r.eligible, true);
  assert.deepEqual(
    r.rules.map((x) => x.id),
    ["pr-open", "head-verified", "verdict", "warn-acknowledged", "permission", "org-allows", "draft", "workflows", "protection", "bypass"],
  );
  for (const x of r.rules) {
    assert.equal(x.ok, true, x.id);
    assert.ok(x.reason.length > 0);
  }
});

test("head != verified candidate refuses: the verdict is stale (§5.2)", () => {
  const r = evaluateMergeEligibility(withPr({ headSha: "b".repeat(40) }));
  assert.equal(r.eligible, false);
  assert.match(ruleOf(r, "head-verified").reason, /stale/);
});

test("SHA comparison ignores case", () => {
  assert.equal(evaluateMergeEligibility(withPr({ headSha: SHA.toUpperCase() })).eligible, true);
});

test("no verdict of record refuses (§5.2)", () => {
  const r = evaluateMergeEligibility(base({ verdictOfRecord: null }));
  assert.equal(r.eligible, false);
  assert.equal(ruleOf(r, "verdict").ok, false);
  assert.equal(ruleOf(r, "head-verified").ok, false);
});

test("fail refuses (§5.2)", () => {
  const r = evaluateMergeEligibility(base({ verdictOfRecord: { candidateSha: SHA, verdict: "fail" } }));
  assert.equal(r.eligible, false);
  assert.match(ruleOf(r, "verdict").reason, /fail/);
});

test("warn needs every Needs-a-look item acknowledged (§5.3)", () => {
  const v = { candidateSha: SHA, verdict: "warn", needsALook: [{ id: "n1" }, { id: "n2" }] };
  const partial = evaluateMergeEligibility(base({ verdictOfRecord: v, acknowledgements: ["n1"] }));
  assert.equal(partial.eligible, false);
  assert.match(ruleOf(partial, "warn-acknowledged").reason, /n2/);
  const all = evaluateMergeEligibility(base({ verdictOfRecord: v, acknowledgements: ["n2", "n1", "extra"] }));
  assert.equal(all.eligible, true);
});

test("warn with nothing listed is acknowledged vacuously", () => {
  const r = evaluateMergeEligibility(base({ verdictOfRecord: { candidateSha: SHA, verdict: "warn" } }));
  assert.equal(r.eligible, true);
});

test("without runs.merge refuses (§5.5)", () => {
  const r = evaluateMergeEligibility(base({ principal: { permissions: ["runs.read"] } }));
  assert.equal(r.eligible, false);
  assert.equal(ruleOf(r, "permission").ok, false);
});

test("org flag off refuses (§5.5)", () => {
  const r = evaluateMergeEligibility(base({ org: { allowMergingFromWindkeel: false } }));
  assert.equal(r.eligible, false);
  assert.match(ruleOf(r, "org-allows").reason, /off/);
});

test("a draft merges only with Mark ready and merge (§5.4)", () => {
  const draft = { isDraft: true, mergeStateStatus: "DRAFT" };
  assert.equal(evaluateMergeEligibility(withPr(draft)).eligible, false);
  const r = evaluateMergeEligibility(withPr(draft, { markReady: true }));
  assert.equal(r.eligible, true);
  assert.equal(ruleOf(r, "protection").checked, false, "protection must be re-checked after marking ready");
});

test("a workflow-touching PR is flagged and blocked without the App's Workflows permission", () => {
  const r = evaluateMergeEligibility(withPr({ changedPaths: ["src/a.ts", ".github/workflows/ci.yml"] }));
  assert.equal(r.eligible, false);
  assert.deepEqual(r.flags, ["touches-workflows"]);
  assert.match(ruleOf(r, "workflows").reason, /Workflows permission/);
  const ok = evaluateMergeEligibility(
    withPr({ changedPaths: [".github/workflows/ci.yml"] }, { app: { workflowsPermission: "write" } }),
  );
  assert.equal(ok.eligible, true);
  assert.deepEqual(ok.flags, ["touches-workflows"], "still flagged when allowed");
});

test("a rename out of .github/workflows counts (previous names are in changedPaths)", () => {
  assert.deepEqual(workflowPaths(["ci/old.yml", ".github/workflows/old.yml"]), [".github/workflows/old.yml"]);
  assert.deepEqual(workflowPaths([".github/workflows-notes.md", "x/.github/workflows/a.yml"]), []);
});

test("a truncated file list may hide a workflow file and is treated as touching", () => {
  const r = evaluateMergeEligibility(withPr({ changedPathsComplete: false }));
  assert.equal(r.eligible, false);
  assert.deepEqual(r.flags, ["touches-workflows"]);
  assert.match(ruleOf(r, "workflows").reason, /truncated/);
});

test("BLOCKED is refused even when the viewer could merge as admin: Windkeel never bypasses (§5.1)", () => {
  const r = evaluateMergeEligibility(withPr({ mergeStateStatus: "BLOCKED", viewerCanMergeAsAdmin: true }));
  assert.equal(r.eligible, false);
  assert.match(ruleOf(r, "protection").reason, /bypass/);
});

test("BEHIND, DIRTY and UNKNOWN refuse; UNSTABLE and HAS_HOOKS merge", () => {
  for (const s of ["BEHIND", "DIRTY", "UNKNOWN", "BLOCKED"]) {
    assert.equal(evaluateMergeEligibility(withPr({ mergeStateStatus: s })).eligible, false, s);
  }
  for (const s of ["UNSTABLE", "HAS_HOOKS"]) {
    assert.equal(evaluateMergeEligibility(withPr({ mergeStateStatus: s })).eligible, true, s);
  }
});

test("a closed or merged PR refuses", () => {
  assert.equal(evaluateMergeEligibility(withPr({ state: "MERGED" })).eligible, false);
  assert.equal(evaluateMergeEligibility(withPr({ state: "CLOSED" })).eligible, false);
});

test("unknown live facts are not passes: missing PR state makes it ineligible, rules marked unchecked", () => {
  const r = evaluateMergeEligibility(base({ pr: {} }));
  assert.equal(r.eligible, false);
  for (const id of ["pr-open", "head-verified", "draft", "workflows", "protection"]) {
    assert.equal(ruleOf(r, id).checked, false, id);
  }
});

test("anyone GitHub reports can bypass is refused, even on CLEAN: a read-then-merge check can't stop a bypass (§5.1, amended)", () => {
  const admin = evaluateMergeEligibility(withPr({ viewerCanMergeAsAdmin: true }));
  assert.equal(admin.eligible, false);
  assert.equal(ruleOf(admin, "bypass").reason, BYPASS_REASON);
  assert.match(ruleOf(admin, "bypass").detail, /admin/);
  const ruleset = evaluateMergeEligibility(withPr({ viewerCanBypassRulesets: true, bypassRulesets: ["main protection"] }));
  assert.equal(ruleset.eligible, false);
  assert.match(ruleOf(ruleset, "bypass").detail, /main protection/);
});

test("an unknown bypass blocks for the person's token, and is reported but not blocking in the App's preview", () => {
  const unknown = { viewerCanMergeAsAdmin: undefined, viewerCanBypassRulesets: undefined };
  const person = evaluateMergeEligibility(withPr(unknown));
  assert.equal(person.eligible, false);
  assert.equal(ruleOf(person, "bypass").checked, false);
  const app = evaluateMergeEligibility(withPr(unknown, { seenBy: "app" }));
  assert.equal(app.eligible, true);
  assert.equal(ruleOf(app, "bypass").blocking, false);
  const seen = evaluateMergeEligibility(withPr(unknown, { seenBy: "app", bypassSeenAtLastMerge: true }));
  assert.equal(ruleOf(seen, "bypass").reason, BYPASS_REASON);
  assert.equal(ruleOf(seen, "bypass").checked, true);
});
