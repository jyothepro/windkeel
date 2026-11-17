import { test } from "node:test";
import assert from "node:assert/strict";
import { costBySource, costLabel, keySourceLabel, showsSourceSplit } from "./cost.ts";
import type { CostBreakdown } from "./types.ts";

const breakdown = (over: Partial<CostBreakdown>): CostBreakdown => ({
  totalUsd: 0,
  byStage: [],
  spendCapUsd: null,
  runRowCost: 0,
  ...over,
});

test("the Cost tab splits model spend by whose key paid, Windkeel first, sandbox left out", () => {
  const sources = costBySource(
    breakdown({
      byStage: [
        { stageType: "verification_run", kind: "model", keySource: "customer", usd: 0.2, tokensIn: 10, tokensOut: 2, events: 1, unpricedEvents: 0 },
        { stageType: "agent_run", kind: "model", keySource: "orqon", usd: 1.5, tokensIn: 100, tokensOut: 20, events: 1, unpricedEvents: 0 },
        { stageType: "criteria", kind: "model", keySource: "customer", usd: 0.05, tokensIn: 5, tokensOut: 1, events: 1, unpricedEvents: 0 },
        { stageType: "workspace", kind: "sandbox", keySource: null, usd: 0.01, tokensIn: null, tokensOut: null, events: 2, unpricedEvents: 0 },
      ],
    }),
  );
  assert.deepEqual(
    sources.map((s) => [s.keySource, s.label, Number(s.usd.toFixed(4)), s.events]),
    [
      ["orqon", "Windkeel's key", 1.5, 1],
      ["customer", "Your organization's key", 0.25, 2],
    ],
  );
  assert.equal(showsSourceSplit(sources), true);
});

test("the API's own split is used when it sends one, and unpriced calls make a figure a lower bound", () => {
  const sources = costBySource(
    breakdown({
      byStage: [],
      bySource: [{ keySource: "customer", usd: 0, tokensIn: 900, tokensOut: 90, events: 1, unpricedEvents: 1 }],
    }),
  );
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.unpricedEvents, 1);
  assert.equal(costLabel("$0.00", sources[0]!.unpricedEvents), "at least $0.00");
  assert.equal(costLabel("$1.00", 0), "$1.00");
});

test("a run on one unsplit source shows no split; an older API's rows are not guessed Windkeel's", () => {
  const windkeel = costBySource(breakdown({ bySource: [{ keySource: "orqon", usd: 1, tokensIn: 1, tokensOut: 1, events: 1, unpricedEvents: 0 }] }));
  assert.equal(showsSourceSplit(windkeel), false);
  const legacy = costBySource(
    breakdown({ byStage: [{ stageType: "agent_run", kind: "model", usd: 1, tokensIn: 1, tokensOut: 1, events: 3 }] }),
  );
  assert.deepEqual(legacy.map((s) => [s.keySource, s.label]), [[null, "Not recorded"]]);
  assert.equal(showsSourceSplit(legacy), false, "a pre-M9 run has nothing to split");
  assert.equal(keySourceLabel(undefined), "Not recorded");
});
