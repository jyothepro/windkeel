/**
 * Spike C (#370): ADR-0029 §5's merge-eligibility rules.
 *
 * Promoted to `src/factory/merge-eligibility.ts` by #371; this file re-exports the shipped module so
 * the spike's tests (`eligibility.test.mjs`) and harness run against the code that ships. Build
 * first: `npm run build` at the repository root.
 */
export { BYPASS_REASON, evaluateMergeEligibility, workflowPaths, WORKFLOWS_PREFIX } from "../../../dist/factory/merge-eligibility.js";
