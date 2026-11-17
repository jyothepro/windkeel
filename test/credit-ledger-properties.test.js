/**
 * #439 / ADR-0040: the credit math's invariants, checked on generated and exhaustively enumerated
 * inputs rather than a handful of examples.
 *
 *   - billed overage never exceeds the cap; what the cap leaves unbilled is still recorded;
 *   - compute is rounded once per run: the seconds and micro-credits of a run's charges sum to one
 *     rounding of their total, whatever the split;
 *   - nothing goes negative.
 *
 * formal/CreditLedger.tla states the same invariants for TLC.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import {
  allocate,
  billableOverageMicro,
  billedSeconds,
  computeMicro,
  MICRO,
  NO_COMPUTE,
  priceCostLine,
  priceCostLines,
} from "../dist/factory/config/credits.js";

const RUNS = { numRuns: 500 };
const sandbox = (engineeringRunId, sandboxMs) => ({ engineeringRunId, kind: "sandbox", usd: 0, keySource: null, sandboxMs });

test("billable overage: up to the cap, never past it, and none without a cap", () => {
  const cap = 3 * MICRO;
  assert.equal(billableOverageMicro(2 * MICRO, cap, 0), 2 * MICRO, "under the cap: all of it");
  assert.equal(billableOverageMicro(3 * MICRO, cap, 0), 3 * MICRO, "exactly to the cap: all of it");
  assert.equal(billableOverageMicro(5 * MICRO, cap, 2 * MICRO), 1 * MICRO, "a line straddling the cap: only up to it");
  assert.equal(billableOverageMicro(1, cap, cap), 0, "at the cap: nothing more");
  assert.equal(billableOverageMicro(1, cap, cap + 7), 0, "past a lowered cap: nothing more, never negative");
  assert.equal(billableOverageMicro(5 * MICRO, 0, 0), 0, "a cap of 0 bills nothing");
  assert.equal(billableOverageMicro(5 * MICRO, null, 0), 0, "no cap, no billing");
  assert.equal(billableOverageMicro(0, cap, 0), 0);
});

test("compute is rounded once per run: 1.5 s + 2.5 s bills 4 s, not 5", () => {
  const priced = priceCostLines([sandbox("r1", 1_500), sandbox("r1", 2_500)]);
  assert.deepEqual(
    priced.map((p) => p.sandboxSeconds),
    [2, 2],
  );
  assert.equal(priced[0].amountMicro + priced[1].amountMicro, computeMicro(4));
  assert.equal(computeMicro(4), 133_333);
  const split = priceCostLines([sandbox("r1", 1_500), sandbox("r2", 2_500)]);
  assert.deepEqual(split.map((p) => p.sandboxSeconds), [2, 3], "each run rounds its own total");
  assert.deepEqual(priceCostLine(sandbox("r1", 90_500)), { kind: "compute", amountMicro: computeMicro(91), sandboxSeconds: 91, unpriced: false });
  assert.deepEqual(priceCostLines([sandbox("r1", 0)]).map((p) => [p.sandboxSeconds, p.amountMicro]), [[0, 0]], "0 ms is free");
});

test("compute already debited is the starting tally: a later charge pays only the rounding it adds", () => {
  const debited = new Map([["r1", { ms: 1_500, seconds: 2, micro: computeMicro(2) }]]);
  const [next] = priceCostLines([sandbox("r1", 2_500)], debited);
  assert.deepEqual([next.sandboxSeconds, next.amountMicro], [2, computeMicro(4) - computeMicro(2)]);
  const [inside] = priceCostLines([sandbox("r1", 400)], debited);
  assert.deepEqual([inside.sandboxSeconds, inside.amountMicro], [0, 0], "inside a second already paid for");
  const legacy = new Map([["r1", { ms: 3_000, seconds: 4, micro: computeMicro(4) }]]);
  const [after] = priceCostLines([sandbox("r1", 500)], legacy);
  assert.deepEqual([after.sandboxSeconds, after.amountMicro], [0, 0], "a debit rounded per charge before #439 is never refunded or charged twice");
  assert.equal(debited.get("r1").ms, 1_500, "the caller's tallies are not changed");
});

const msArb = fc.oneof(fc.integer({ min: 0, max: 5_000 }), fc.integer({ min: 0, max: 3_600_000 }));
const lineArb = fc.record({ run: fc.constantFrom("a", "b", "c"), ms: msArb, kind: fc.constantFrom("sandbox", "sandbox", "model"), usd: fc.double({ min: 0, max: 5, noNaN: true }) });

test("property: per run, the charges' seconds and credits equal one rounding of the run's total", () => {
  fc.assert(
    fc.property(fc.array(lineArb, { maxLength: 40 }), (lines) => {
      const costLines = lines.map((l) => ({ engineeringRunId: l.run, kind: l.kind, usd: l.usd, keySource: "orqon", sandboxMs: l.kind === "sandbox" ? l.ms : null }));
      const priced = priceCostLines(costLines);
      for (const run of ["a", "b", "c"]) {
        const mine = costLines.map((l, i) => [l, priced[i]]).filter(([l]) => l.engineeringRunId === run && l.kind === "sandbox");
        const totalMs = mine.reduce((s, [l]) => s + l.sandboxMs, 0);
        const seconds = mine.reduce((s, [, p]) => s + p.sandboxSeconds, 0);
        const micro = mine.reduce((s, [, p]) => s + p.amountMicro, 0);
        assert.equal(seconds, billedSeconds(totalMs));
        assert.equal(micro, computeMicro(billedSeconds(totalMs)));
        for (const [, p] of mine) assert.ok(p.sandboxSeconds >= 0 && p.amountMicro >= 0);
      }
    }),
    RUNS,
  );
});

test("property: splitting a run's charges between already-debited and pending never changes its total", () => {
  fc.assert(
    fc.property(fc.array(msArb, { minLength: 1, maxLength: 20 }), fc.nat(), (ms, cut) => {
      const at = cut % (ms.length + 1);
      const first = priceCostLines(ms.slice(0, at).map((m) => sandbox("r", m)));
      const debited = new Map([
        [
          "r",
          {
            ms: ms.slice(0, at).reduce((s, m) => s + m, 0),
            seconds: first.reduce((s, p) => s + p.sandboxSeconds, 0),
            micro: first.reduce((s, p) => s + p.amountMicro, 0),
          },
        ],
      ]);
      const rest = priceCostLines(ms.slice(at).map((m) => sandbox("r", m)), debited);
      const all = [...first, ...rest];
      const total = ms.reduce((s, m) => s + m, 0);
      assert.equal(all.reduce((s, p) => s + p.sandboxSeconds, 0), billedSeconds(total));
      assert.equal(all.reduce((s, p) => s + p.amountMicro, 0), computeMicro(billedSeconds(total)));
    }),
    RUNS,
  );
});

test("property: a legacy tally (rounded per charge) is never charged below what it already paid", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 50 }), fc.array(msArb, { maxLength: 10 }), (ms, extraSeconds, more) => {
      const seconds = billedSeconds(ms) + extraSeconds;
      const debited = new Map([["r", { ms, seconds, micro: computeMicro(seconds) }]]);
      const priced = priceCostLines(more.map((m) => sandbox("r", m)), debited);
      const total = ms + more.reduce((s, m) => s + m, 0);
      for (const p of priced) assert.ok(p.sandboxSeconds >= 0 && p.amountMicro >= 0);
      const paid = seconds + priced.reduce((s, p) => s + p.sandboxSeconds, 0);
      assert.equal(paid, Math.max(seconds, billedSeconds(total)));
    }),
    RUNS,
  );
});

function ledger(grantMicro, capMicro, charges) {
  const grants = grantMicro > 0
    ? [{ id: "g", source: "topup", startsAt: new Date(0), expiresAt: new Date(8.64e15), createdAt: new Date(0), remainingMicro: grantMicro }]
    : [];
  let billed = 0;
  let unbilled = 0;
  let allocated = 0;
  const at = new Date(1_000);
  for (const { amount, billable } of charges) {
    const { allocations, overageMicro } = allocate(amount, grants, at);
    const take = allocations.reduce((s, a) => s + a.amountMicro, 0);
    assert.equal(take + overageMicro, amount, "every micro-credit is either allocated or overage");
    allocated += take;
    const bill = billable ? billableOverageMicro(overageMicro, capMicro, billed) : 0;
    assert.ok(bill >= 0 && bill <= overageMicro);
    billed += bill;
    unbilled += overageMicro - bill;
  }
  return { billed, unbilled, allocated, left: grants[0]?.remainingMicro ?? 0 };
}

test("property: billed overage never exceeds the cap; the balance never goes below zero", () => {
  const charge = fc.record({ amount: fc.integer({ min: 0, max: 5 * MICRO }), billable: fc.boolean() });
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 10 * MICRO }), fc.option(fc.integer({ min: 0, max: 10 * MICRO })), fc.array(charge, { maxLength: 40 }), (grant, cap, charges) => {
      const out = ledger(grant, cap, charges);
      const total = charges.reduce((s, c) => s + c.amount, 0);
      assert.ok(out.billed <= (cap ?? 0), "billed overage is within the cap");
      assert.ok(out.left >= 0, "a grant is never overdrawn");
      assert.equal(out.allocated + out.billed + out.unbilled, total, "spend is conserved: credits, billed overage, unbilled overage");
      assert.equal(out.left, grant - out.allocated);
    }),
    RUNS,
  );
});

test("exhaustive: every charge sequence up to 4 lines of 0–3 units, every grant and cap up to 3", () => {
  const U = MICRO;
  let checked = 0;
  const sequences = [[]];
  for (let len = 0; len < 4; len += 1) {
    for (const s of sequences.filter((x) => x.length === len)) {
      for (let a = 0; a <= 3; a += 1) for (const billable of [false, true]) sequences.push([...s, { amount: a * U, billable }]);
    }
  }
  for (const charges of sequences) {
    for (let grant = 0; grant <= 3; grant += 1) {
      for (const cap of [null, 0, 1, 2, 3]) {
        const out = ledger(grant * U, cap === null ? null : cap * U, charges);
        const total = charges.reduce((s, c) => s + c.amount, 0);
        assert.ok(out.billed <= (cap ?? 0) * U);
        assert.equal(out.allocated + out.billed + out.unbilled, total);
        assert.ok(out.left >= 0);
        const reachable = charges.filter((c) => c.billable).reduce((s, c) => s + c.amount, 0);
        if (cap !== null && grant === 0 && charges.every((c) => c.billable)) assert.equal(out.billed, Math.min(cap * U, reachable), "with nothing prepaid, billable spend is billed up to the cap exactly");
        checked += 1;
      }
    }
  }
  assert.equal(checked, sequences.length * 4 * 5);
  for (let a = 0; a <= 4; a += 1) {
    for (let b = 0; b <= 4; b += 1) {
      for (let c = 0; c <= 4; c += 1) {
        const ms = [a * 500, b * 500, c * 500];
        const priced = priceCostLines(ms.map((m) => sandbox("r", m)));
        assert.equal(priced.reduce((s, p) => s + p.sandboxSeconds, 0), billedSeconds(ms[0] + ms[1] + ms[2]));
      }
    }
  }
  assert.deepEqual(NO_COMPUTE, { ms: 0, seconds: 0, micro: 0 });
});

const spec = readFileSync(new URL("../formal/CreditLedger.tla", import.meta.url), "utf8");
const cfg = readFileSync(new URL("../formal/CreditLedger.cfg", import.meta.url), "utf8");

test("formal/CreditLedger.tla's clamp and rounding are the shapes this test re-implements", () => {
  assert.match(spec, /^Bill\(over\) == IF overageOn THEN Min\(over, IF cap > billed THEN cap - billed ELSE 0\) ELSE 0$/m);
  assert.match(spec, /^ {2}\/\\ secs' = Max\(secs, CeilDiv\(ms \+ d, Unit\)\)$/m);
  assert.match(spec, /^ {2}\/\\ Spend\(Max\(secs, CeilDiv\(ms \+ d, Unit\)\) - secs\)$/m);
  assert.match(spec, /^StartStep ==\n {2}\/\\ phase = "idle"\n {2}\/\\ Admits$/m, "a step starts only when admitted");
  assert.match(spec, /^EndStep ==\n {2}\/\\ phase = "making"\n {2}\/\\ phase' = "verifying"$/m, "and ends whatever it spent");
  for (const name of ["SafetyInvariants", "NeverBillsPastTheCapInForce", "StepsStartOnlyWhenAdmitted", "StepsAlwaysFinish", "VerificationAlwaysFinishes"]) {
    assert.match(cfg, new RegExp(`\\b${name}\\b`), `${name} is checked`);
    assert.match(spec, new RegExp(`^${name} ==`, "m"));
  }
  assert.match(readFileSync(new URL("../scripts/formal-check.mjs", import.meta.url), "utf8"), /CreditLedger\.tla/, "CI's formal job runs it");
});

test("the model's Bill is the code's billableOverageMicro on the model's whole domain, and its rounding is priceCostLines'", () => {
  const modelBill = (over, cap, billed) => Math.min(over, cap > billed ? cap - billed : 0);
  for (let over = 0; over <= 8; over += 1) {
    for (let cap = 0; cap <= 8; cap += 1) {
      for (let billed = 0; billed <= 9; billed += 1) {
        assert.equal(billableOverageMicro(over * MICRO, cap * MICRO, billed * MICRO), modelBill(over, cap, billed) * MICRO, `${over} ${cap} ${billed}`);
      }
    }
  }
  const Unit = 1000;
  for (const ticks of [[1], [1, 1], [2, 1, 2], [1, 2, 1, 2, 1], [2, 2, 2, 2, 2]]) {
    let ms = 0;
    let secs = 0;
    const model = [];
    for (const d of ticks) {
      const next = Math.max(secs, Math.ceil((ms + d * 500) / Unit));
      model.push(next - secs);
      ms += d * 500;
      secs = next;
    }
    assert.deepEqual(priceCostLines(ticks.map((d) => sandbox("r", d * 500))).map((p) => p.sandboxSeconds), model);
  }
});
