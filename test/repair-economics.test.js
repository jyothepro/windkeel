import assert from "node:assert/strict";
import { test } from "node:test";
import { renderRunReport } from "../dist/factory/run-report.js";

/**
 * #243: ADR-0011's cap counts *attempts*. A repair resumes the maker's session, so each turn
 * carries every turn before it and costs more than the last — on run `f28748b2` four turns went
 * $0.55 → $0.90 → $1.21 → $1.56, the last 2.9x the first, for a documentation change that was
 * correct at the first turn.
 *
 * The cap is deliberately unchanged (that needs an ADR-0011 amendment — see the PR). What changes
 * is that the curve is legible after one run instead of reconstructed from `cost_event`.
 */

/**
 * Rendered directly from a `RunReport` rather than assembled from Postgres, deliberately: the
 * property under test is the *order* of the turns and the delta between them, and four agent
 * runs inserted in the same instant have no deterministic order to assert against. In a real run
 * they are minutes apart.
 */
const report = (costs, repairsTaken) => ({
  engineeringRunId: "r",
  task: { id: "t", title: "t", riskLevel: "low", criteria: [], criteriaProvenance: "author_stated", criteriaGeneratedBy: null, criteriaApprovedBy: null, criteriaApprovedAt: null },
  state: "PR_READY",
  terminal: false,
  stopReason: null,
  stopReasonText: null,
  finalVerdict: "pass",
  startedAt: null,
  completedAt: null,
  criteria: { satisfied: 1, total: 1 },
  verifications: [],
  repairAttempts: [],
  repairAttemptsTaken: repairsTaken,
  repairCap: 3,
  incompleteStages: [],
  residualRisk: { scored: false, blockingFindings: 0, nonBlockingFindings: 0, unsatisfiedCriteria: 0 },
  agentRuns: costs.map((usd, i) => ({
    id: `a${i}`,
    role: i === 0 ? "implementer" : "repairer",
    workerType: "codex",
    model: "gpt-5-codex",
    startedAt: null,
    completedAt: null,
    tokenUsage: null,
    modelCostUsd: usd,
    candidateSha: null,
  })),
  cost: {
    totalUsd: costs.reduce((a, b) => a + b, 0),
    modelUsd: costs.reduce((a, b) => a + b, 0),
    sandboxUsd: 0,
    runCostUsd: costs.reduce((a, b) => a + b, 0),
    reconciles: true,
    spendCapUsd: 25,
    unpricedModelCalls: 0,
  },
});

test("each turn's cost is shown with its growth over the previous one", () => {
  // The real figures from run f28748b2.
  const text = renderRunReport(report([0.5461, 0.902, 1.2121, 1.5627], 3));
  assert.match(text, /\$0\.5461/);
  // The deltas are the point: a curve, not a flat rate.
  assert.match(text, /\$0\.9020\s+\(\+\$0\.3559\)/);
  assert.match(text, /\$1\.2121\s+\(\+\$0\.3101\)/);
  assert.match(text, /\$1\.5627\s+\(\+\$0\.3506\)/);
});

test("the first turn has no delta, because there is nothing to grow from", () => {
  const text = renderRunReport(report([0.5461], 0));
  assert.match(text, /\$0\.5461/);
  assert.doesNotMatch(text, /\(\+\$/);
});

/**
 * The common case must not gain noise. A note explaining a curve, printed where there is no
 * curve, is the kind of thing that trains people to stop reading the report.
 */
test("a run with no repairs gains no repair commentary", () => {
  assert.doesNotMatch(renderRunReport(report([0.5461], 0)), /the cap counts attempts, not spend/);
});

test("a run that repaired says the cap counts attempts rather than spend", () => {
  assert.match(renderRunReport(report([0.5461, 0.902], 1)), /the cap counts attempts, not spend/);
});
