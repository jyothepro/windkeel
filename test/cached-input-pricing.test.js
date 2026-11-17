import assert from "node:assert/strict";
import { test } from "node:test";
import { modelCostUsd, pricingFor } from "../dist/factory/workflow/stage-deps.js";
import { renderRunReport } from "../dist/factory/run-report.js";

/**
 * #263. Codex reports `cached_input_tokens`, the normalizer has parsed it since M3, `WorkerUsage`
 * has typed it since M4 — and nothing read it. Every cached token was billed at the full input
 * rate.
 *
 * That is not a rounding error on this workload. ADR-0011 §2 resumes the maker's session for a
 * repair turn, so turn *n* re-sends the prefix of turns 1…n-1, and a re-sent prefix is exactly
 * what a provider caches. Across the 21 agent turns this system has run, **94.3% of input tokens
 * were cached**; on the four turns of run `f28748b2` the share went 94.8% → 96.2% → 96.7% →
 * 97.1%. Priced correctly that run cost about $0.67, not the $4.22 on the row — and $4.22 is the
 * number ADR-0011's repair-cap question (#257) was argued from.
 *
 * So what these tests hold is the arithmetic, in the one direction that matters: an accounting
 * error that makes a run look *cheaper* than it was would leave the spend rail armed and never
 * firing, which `ModelPricing`'s own comment calls worse than no cap at all.
 */

const PRICING = {
  usdPerInputToken: 0.00000125,
  usdPerOutputToken: 0.00001,
  usdPerCachedInputToken: 0.000000125,
};

test("cached input is billed at the cached rate, and only once", () => {
  // Turn 4 of run f28748b2, verbatim from agent_run.token_usage.
  const usage = { inputTokens: 1_207_733, cachedInputTokens: 1_172_822, outputTokens: 5_308 };

  const uncached = 1_207_733 - 1_172_822;
  const expected =
    uncached * 0.00000125 + 1_172_822 * 0.000000125 + 5_308 * 0.00001;

  assert.equal(modelCostUsd(usage, PRICING), expected);
  // The shape of the claim, not just the number: about a quarter of a dollar, not $1.56.
  assert.ok(modelCostUsd(usage, PRICING) < 0.3, "the corrected turn is well under $0.30");
});

test("the cached prefix is subtracted from input, never added to it", () => {
  const usage = { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 0 };
  // 100 uncached + 900 cached. Adding the cached term on top of the full input would give
  // 1000*rate + 900*cached — the mistake this asserts against, and it reads plausibly.
  assert.equal(modelCostUsd(usage, PRICING), 100 * 0.00000125 + 900 * 0.000000125);
});

test("no configured cached rate bills exactly as it did before", () => {
  const usage = { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 10 };
  const before = { usdPerInputToken: 0.00000125, usdPerOutputToken: 0.00001 };
  assert.equal(modelCostUsd(usage, before), 1000 * 0.00000125 + 10 * 0.00001);
});

test("no reported cached count bills everything at the uncached rate", () => {
  // A vendor that says nothing about caching is not a vendor claiming nothing was cached.
  const usage = { inputTokens: 1000, outputTokens: 10 };
  assert.equal(modelCostUsd(usage, PRICING), 1000 * 0.00000125 + 10 * 0.00001);
});

test("a cached count larger than the input cannot reduce the bill", () => {
  /**
   * A vendor reporting more cached tokens than input tokens is reporting something this code
   * does not understand. Clamped rather than trusted: unclamped, the uncached term goes negative
   * and the run bills *less* than zero for its input — the one direction a spend rail must never
   * be wrong in.
   */
  const usage = { inputTokens: 1000, cachedInputTokens: 5000, outputTokens: 0 };
  const cost = modelCostUsd(usage, PRICING);
  assert.equal(cost, 1000 * 0.000000125);
  assert.ok(cost > 0, "a nonsense cached count never produces a negative or zero charge");
});

test("output-only pricing is untouched by any of this", () => {
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 500 };
  assert.equal(modelCostUsd(usage, PRICING), 500 * 0.00001);
});

const reportWith = (turns) => ({
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
  repairAttemptsTaken: turns.length - 1,
  repairCap: 3,
  incompleteStages: [],
  residualRisk: { scored: false, blockingFindings: 0, nonBlockingFindings: 0, unsatisfiedCriteria: 0 },
  agentRuns: turns.map((t, i) => ({
    id: `a${i}`,
    role: i === 0 ? "implementer" : "repairer",
    workerType: "codex",
    model: "gpt-5.3-codex",
    startedAt: null,
    completedAt: null,
    tokenUsage: null,
    modelCostUsd: t.usd,
    candidateSha: null,
    cachedInputShare: t.share,
  })),
  cost: {
    totalUsd: 0, modelUsd: 0, sandboxUsd: 0, runCostUsd: 0,
    reconciles: true, spendCapUsd: 25, unpricedModelCalls: 0,
  },
});

test("the report prints the cached share beside the cost", () => {
  /**
   * The growth is the alarming part and the cache is the explanation, so they belong on the same
   * line. A report that showed a turn costing more than the last without saying 97% of the
   * increase was a cached prefix is what sent #257 looking for a spend rail.
   */
  const text = renderRunReport(reportWith([
    { usd: 0.093, share: 0.948 },
    { usd: 0.144, share: 0.962 },
  ]));
  assert.match(text, /95% cached/);
  assert.match(text, /96% cached/);
  assert.match(text, /served from cache and billed at a tenth of the rate/);
});

test("a turn whose vendor reported no cache count says nothing rather than 0%", () => {
  // "Absent is not zero" — the same rule #242 established for checker usage.
  const text = renderRunReport(reportWith([{ usd: 0.093, share: null }]));
  assert.doesNotMatch(text, /\d+% cached/);
  // And the cost is still there — silence about the cache is not silence about the turn.
  assert.match(text, /\$0\.0930/);
});

// --- per-model prices (ADR-0026 §9, #324) -------------------------------------------------------

test("a model is priced from the catalog, and each pinned field wins over it", () => {
  assert.deepEqual(pricingFor("gpt-5-codex", {}), PRICING, "the catalog's gpt-5-codex is the old default");
  assert.deepEqual(pricingFor("openai/gpt-5-codex", { usdPerOutputToken: 0.00002 }), {
    ...PRICING,
    usdPerOutputToken: 0.00002,
  });
  // A rate pinned at zero is a price of zero — not the same thing as no price.
  assert.equal(
    modelCostUsd({ inputTokens: 10, outputTokens: 10 }, pricingFor("gpt-5", { usdPerInputToken: 0, usdPerOutputToken: 0 })),
    0,
  );
});

test("a model the catalog does not know is unpriced: null, never 0", () => {
  assert.equal(pricingFor("someone/unheard-of-model", {}), undefined);
  assert.equal(pricingFor(null, undefined), undefined);
  assert.equal(modelCostUsd({ inputTokens: 1000, outputTokens: 100 }, undefined), null);
  // Half a price is not a price.
  assert.equal(pricingFor("someone/unheard-of-model", { usdPerInputToken: 0.000001 }), undefined);
  // Both halves pinned price even a model the catalog has never heard of.
  assert.deepEqual(pricingFor("someone/unheard-of-model", { usdPerInputToken: 1, usdPerOutputToken: 2 }), {
    usdPerInputToken: 1,
    usdPerOutputToken: 2,
  });
  // No usage at all — a scripted worker — is still nothing to bill, priced or not.
  assert.equal(modelCostUsd(undefined, undefined), 0);
});

test("the report splits model cost by whose key paid once an organization's key paid for any", () => {
  const base = reportWith([{ usd: 0.5, share: null }]);
  const onWindkeel = renderRunReport({
    ...base,
    cost: { ...base.cost, modelBySource: [{ keySource: "orqon", usd: 0.5, calls: 1, unpricedCalls: 0, tokensIn: 1, tokensOut: 1 }] },
  });
  assert.doesNotMatch(onWindkeel, /Windkeel's key/, "a run all on Windkeel's key reads as it always did");

  const split = renderRunReport({
    ...base,
    cost: {
      ...base.cost,
      totalUsd: 0.75, modelUsd: 0.75, runCostUsd: 0.75, unpricedModelCalls: 1,
      modelBySource: [
        { keySource: "orqon", usd: 0.5, calls: 1, unpricedCalls: 0, tokensIn: 1, tokensOut: 1 },
        { keySource: "customer", usd: 0.25, calls: 2, unpricedCalls: 1, tokensIn: 1, tokensOut: 1 },
      ],
    },
  });
  assert.match(split, /Windkeel's key\s+\$0\.5000/);
  assert.match(split, /organization's key\s+\$0\.2500 {2}\(at least; 1 unpriced\)/);
  assert.match(split, /a lower bound: 1 model call\(s\) reported tokens but no price/);
});

test("ORQ-09: forged negative usage prices at zero, never as a refund", () => {
  const pricing = { usdPerInputToken: 2.5e-6, usdPerOutputToken: 1e-5, usdPerCachedInputToken: 2.5e-7 };
  // The audit's reproduction: 4M honest input tokens replaced by -9M priced at -$22.50.
  assert.equal(modelCostUsd({ inputTokens: -9000000, outputTokens: 0, totalTokens: -9000000 }, pricing), 0);
  assert.equal(modelCostUsd({ inputTokens: Number.NaN, outputTokens: Number.NEGATIVE_INFINITY }, pricing), 0);
  // A negative count beside an honest one does not net it down.
  assert.equal(modelCostUsd({ inputTokens: 1000, outputTokens: -1000000 }, pricing), 1000 * 2.5e-6);
  assert.equal(modelCostUsd({ inputTokens: 1000, cachedInputTokens: -1000, outputTokens: 0 }, pricing), 1000 * 2.5e-6);
});

test("ORQ-09: with a cached rate above the input rate, the reported split cannot move the bill", () => {
  // An input rate pinned below the catalog's cached rate. Under-reporting the cached count (which
  // the agent can write, and which a duplicate report's merge takes the minimum of) must not
  // lower the bill: a cached read is billed at most at the input rate.
  const pricing = { usdPerInputToken: 1e-6, usdPerOutputToken: 0, usdPerCachedInputToken: 3e-6 };
  const honest = modelCostUsd({ inputTokens: 100, cachedInputTokens: 100 }, pricing);
  const forged = modelCostUsd({ inputTokens: 100, cachedInputTokens: 0 }, pricing);
  assert.equal(honest, 100 * 1e-6);
  assert.equal(forged, honest);
});

// --- cache writes (ADR-0027 §8, #395) -----------------------------------------------------------

test("cache writes are billed at the write rate, out of the input total", () => {
  const pricing = { usdPerInputToken: 3e-6, usdPerOutputToken: 15e-6, usdPerCachedInputToken: 0.3e-6, usdPerCacheWriteInputToken: 3.75e-6 };
  // Claude Code's result.usage, normalised: input 120 + cache reads 18000 + cache writes 2000.
  const usage = { inputTokens: 20_120, cachedInputTokens: 18_000, cacheWriteInputTokens: 2_000, outputTokens: 640 };
  const expected = 120 * 3e-6 + 18_000 * 0.3e-6 + 2_000 * 3.75e-6 + 640 * 15e-6;
  assert.ok(Math.abs(modelCostUsd(usage, pricing) - expected) < 1e-12);
});

test("a cache write never bills below base input, whatever is pinned", () => {
  const pinnedLow = { usdPerInputToken: 3e-6, usdPerOutputToken: 0, usdPerCacheWriteInputToken: 1e-9 };
  assert.ok(Math.abs(modelCostUsd({ inputTokens: 1_000, cacheWriteInputTokens: 1_000 }, pinnedLow) - 1_000 * 3e-6) < 1e-12);
  const noWriteRate = { usdPerInputToken: 3e-6, usdPerOutputToken: 0 };
  assert.ok(Math.abs(modelCostUsd({ inputTokens: 1_000, cacheWriteInputTokens: 600 }, noWriteRate) - 1_000 * 3e-6) < 1e-12, "absent rate is base");
});

test("ORQ-09: a forged cache-write count cannot exceed the input or lower the bill", () => {
  const pricing = { usdPerInputToken: 3e-6, usdPerOutputToken: 0, usdPerCachedInputToken: 0.3e-6, usdPerCacheWriteInputToken: 3.75e-6 };
  const honest = modelCostUsd({ inputTokens: 1_000, cachedInputTokens: 900, cacheWriteInputTokens: 100 }, pricing);
  const inflated = modelCostUsd({ inputTokens: 1_000, cachedInputTokens: 900, cacheWriteInputTokens: 10_000 }, pricing);
  assert.ok(Math.abs(honest - inflated) < 1e-12, "writes are clamped to what is left after cached reads");
  assert.ok(Math.abs(modelCostUsd({ inputTokens: 1_000, cacheWriteInputTokens: -5_000 }, pricing) - 1_000 * 3e-6) < 1e-12);
});

test("the catalog prices Anthropic cache writes at 1.25x base input", () => {
  const sonnet = pricingFor("claude-sonnet-4-5", {});
  assert.ok(Math.abs(sonnet.usdPerCacheWriteInputToken - 3.75e-6) < 1e-15);
  assert.ok(Math.abs(sonnet.usdPerCacheWriteInputToken / sonnet.usdPerInputToken - 1.25) < 1e-9);
  assert.equal(pricingFor("gpt-5-codex", {}).usdPerCacheWriteInputToken, undefined, "OpenAI bills no cache writes");
  assert.equal(pricingFor("claude-sonnet-4-5", { usdPerCacheWriteInputToken: 5e-6 }).usdPerCacheWriteInputToken, 5e-6, "a pin wins");
});
