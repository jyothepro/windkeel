import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SPEND_CAP_USD,
  DEFAULT_WALL_CLOCK_CAP_SECONDS,
  REPAIR_ATTEMPT_CAPS,
  UncappedRunError,
  checkCaps,
  checkRepairLoop,
  isStuck,
  packetFingerprint,
  runRails,
  terminalStateFor,
} from "../dist/factory/rails.js";

/** A RepairPacket with just the identity-bearing fields the fingerprint reads. */
function packet({ criteria = [], checks = [], security = [], review = [], browser = [] } = {}) {
  const finding = (id) => ({ id, claim: `claim for ${id}`, severity: "blocking" });
  return {
    failed_acceptance_criteria: criteria.map((id) => ({ id, text: "", reason: "unmet" })),
    failed_checks: checks.map((check) => ({ check })),
    security_findings: security.map(finding),
    review_findings: review.map(finding),
    browser_findings: browser.map(finding),
    evidence_links: [],
    recommended_focus: [],
    repair_constraints: [],
  };
}

const start = new Date("2026-08-17T00:00:00Z");
const run = (rails, cost) => ({ rails, cost, started_at: start });
const secondsLater = (s) => new Date(start.getTime() + s * 1000);

test("a cap is required by default and lands on the ADR-0011 value", () => {
  assert.equal(runRails().spend_cap_usd, DEFAULT_SPEND_CAP_USD);
  assert.equal(runRails().wall_clock_cap_seconds, DEFAULT_WALL_CLOCK_CAP_SECONDS);
});

test("running uncapped demands explicit confirmation", () => {
  assert.throws(() => runRails({ spendCapUsd: null }), UncappedRunError);
  assert.equal(runRails({ spendCapUsd: null, uncappedConfirmed: true }).spend_cap_usd, null);
});

test("a run with spend_cap_usd = 0 refuses to spawn anything", () => {
  assert.equal(checkCaps(run(runRails({ spendCapUsd: 0 }), 0), start), "spend_cap");
});

test("spend under the cap passes; at or over the cap stops", () => {
  const rails = runRails({ spendCapUsd: 25 });
  assert.equal(checkCaps(run(rails, 24.99), start), null);
  assert.equal(checkCaps(run(rails, 25), start), "spend_cap");
  assert.equal(checkCaps(run(rails, 40), start), "spend_cap");
});

test("a confirmed-uncapped run never spend-stops", () => {
  const rails = runRails({ spendCapUsd: null, uncappedConfirmed: true });
  assert.equal(checkCaps(run(rails, 10_000), start), null);
});

test("the wall clock stops the run past the cap, not before", () => {
  const rails = runRails({ wallClockCapSeconds: 7200 });
  assert.equal(checkCaps(run(rails, 0), secondsLater(7200)), null);
  assert.equal(checkCaps(run(rails, 0), secondsLater(7201)), "wall_clock_cap");
});

test("the fingerprint ignores ordering and prose, and sees every failure category", () => {
  const a = packet({ criteria: ["AC-1", "AC-2"], checks: ["tests"], review: ["R-1"] });
  const b = packet({ criteria: ["AC-2", "AC-1"], checks: ["tests"], review: ["R-1"] });
  b.recommended_focus = ["different prose entirely"];
  assert.equal(packetFingerprint(a), packetFingerprint(b));

  for (const changed of [
    packet({ criteria: ["AC-1"], checks: ["tests"], review: ["R-1"] }),
    packet({ criteria: ["AC-1", "AC-2"], checks: ["lint"], review: ["R-1"] }),
    packet({ criteria: ["AC-1", "AC-2"], checks: ["tests"], security: ["S-1"], review: ["R-1"] }),
    packet({ criteria: ["AC-1", "AC-2"], checks: ["tests"], review: ["R-1"], browser: ["B-1"] }),
  ]) {
    assert.notEqual(packetFingerprint(a), packetFingerprint(changed));
  }
});

test("a stuck threshold of 2 stops after two no-delta repair attempts", () => {
  const same = packet({ criteria: ["AC-1"] });
  assert.equal(isStuck([same], 2), false, "one packet is not a streak");
  assert.equal(isStuck([same, same], 2), true);
  assert.equal(checkRepairLoop([same, same], "low", 2), "stuck");
});

test("a moving failure set is progress, not stuckness", () => {
  const shrinking = [
    packet({ criteria: ["AC-1", "AC-2"], checks: ["tests"] }),
    packet({ criteria: ["AC-2"] }),
    packet({ checks: ["lint"] }),
  ];
  assert.equal(isStuck(shrinking, 2), false);
  assert.equal(checkRepairLoop(shrinking, "low"), null);
});

test("stuckness reads only the trailing streak", () => {
  const early = packet({ criteria: ["AC-1"] });
  const late = packet({ criteria: ["AC-2"] });
  assert.equal(isStuck([early, early, late], 2), false, "an old streak the repairer escaped");
  assert.equal(isStuck([early, late, late], 2), true);
});

test("repair caps are risk-tiered: 3 low, 2 medium, 1 high", () => {
  assert.deepEqual(REPAIR_ATTEMPT_CAPS, { low: 3, medium: 2, high: 1 });
  for (const [risk, cap] of Object.entries(REPAIR_ATTEMPT_CAPS)) {
    const distinct = Array.from({ length: cap + 1 }, (_, i) => packet({ criteria: [`AC-${i}`] }));
    assert.equal(checkRepairLoop(distinct.slice(0, cap), risk), null, `${risk}: cap not yet hit`);
    assert.equal(checkRepairLoop(distinct, risk), "repair_cap", `${risk}: one past the cap`);
  }
});

test("every rail lands in an existing ADR-0003 terminal state", () => {
  assert.equal(terminalStateFor("repair_cap"), "MAX_REPAIR_ATTEMPTS_REACHED");
  assert.equal(terminalStateFor("stuck"), "MAX_REPAIR_ATTEMPTS_REACHED");
  assert.equal(terminalStateFor("spend_cap"), "FAILED");
  assert.equal(terminalStateFor("wall_clock_cap"), "FAILED");
  assert.equal(terminalStateFor("error"), "FAILED");
});
