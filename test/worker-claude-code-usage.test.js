/**
 * Claude Code's usage, normalised (ADR-0027 §8, #395): its `input_tokens` excludes cache reads and
 * writes, so they are added back into `inputTokens`, which stays the total for every vendor.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeClaudeUsage } from "../dist/worker/claude-code/events.js";
import { modelCostUsd, pricingFor } from "../dist/factory/workflow/stage-deps.js";

test("cache reads and writes are added back into the input total", () => {
  assert.deepEqual(
    normalizeClaudeUsage({ input_tokens: 120, cache_read_input_tokens: 18_000, cache_creation_input_tokens: 2_000, output_tokens: 640 }),
    { inputTokens: 20_120, cachedInputTokens: 18_000, cacheWriteInputTokens: 2_000, outputTokens: 640, totalTokens: 20_760 },
  );
});

test("absent or null cache fields are zero", () => {
  assert.deepEqual(normalizeClaudeUsage({ input_tokens: 10, output_tokens: 5 }), {
    inputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 5,
    totalTokens: 15,
  });
  assert.equal(normalizeClaudeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null }).cachedInputTokens, 0);
  assert.deepEqual(normalizeClaudeUsage({ input_tokens: 0, output_tokens: 0 }).inputTokens, 0, "zero is a count");
});

test("no usage, half a usage, or a forged count is no usage — which fails a reporting adapter's turn", () => {
  assert.equal(normalizeClaudeUsage(undefined), undefined);
  assert.equal(normalizeClaudeUsage({ output_tokens: 5 }), undefined);
  assert.equal(normalizeClaudeUsage({ input_tokens: 5 }), undefined);
  assert.equal(normalizeClaudeUsage({ input_tokens: -1, output_tokens: 5 }), undefined);
  assert.equal(normalizeClaudeUsage({ input_tokens: 1.5, output_tokens: 5 }), undefined);
  assert.equal(normalizeClaudeUsage({ input_tokens: 1, output_tokens: 5, cache_read_input_tokens: -100 }), undefined, "dropping it would understate");
});

test("priced from the catalog, a Claude Code turn charges reads below and writes above base input", () => {
  const usage = normalizeClaudeUsage({ input_tokens: 120, cache_read_input_tokens: 18_000, cache_creation_input_tokens: 2_000, output_tokens: 640 });
  const pricing = pricingFor("claude-sonnet-4-5", {});
  const usd = modelCostUsd(usage, pricing);
  const expected = 120 * 3e-6 + 18_000 * 0.3e-6 + 2_000 * 3.75e-6 + 640 * 15e-6;
  assert.ok(Math.abs(usd - expected) < 1e-12);
  assert.ok(usd > modelCostUsd({ ...usage, cacheWriteInputTokens: 0 }, pricing), "the write premium is charged");
});
