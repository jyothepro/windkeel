import assert from "node:assert/strict";
import { test } from "node:test";
import { canSignKeyless, signPackage } from "@windkeel/verification/attest/sigstore.js";
import { signatureLines } from "../dist/factory/run-report.js";
import { renderEvidenceSummary } from "../dist/github/summary.js";

/**
 * ADR-0022 (#232): signing stays best-effort, and an unsigned package says so.
 *
 * The question the issue asked is not "is it signed?" but "six months from now, can someone
 * reading a package tell whether `signed: false` means *this was never meant to be signed* or
 * *something went wrong*?" So what is tested here is mostly what gets **said**, and the three
 * states that must not render the same: signed, unsigned, and never recorded.
 */

const row = (label, value) => `${label.padEnd(26)}${value}`;

test("a Vercel function has no ambient OIDC identity, so the deployed path never signs", () => {
  // The fact ADR-0022 turns on, pinned as a test rather than left in prose. Vercel's own OIDC
  // token is not among these on purpose: Fulcio's public-good instance does not trust
  // `oidc.vercel.com`, so reading it would produce an identity no CA will answer.
  assert.equal(canSignKeyless({ VERCEL: "1", VERCEL_ENV: "production" }), false);
  assert.equal(canSignKeyless({ VERCEL_OIDC_TOKEN: "ey.not.fulcios" }), false);
  assert.equal(canSignKeyless({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" }), true);
  assert.equal(canSignKeyless({ SIGSTORE_ID_TOKEN: "t" }), true);
});

test("signing is best-effort: no identity produces an unsigned package, not a failed run", () => {
  const result = signPackage("/nonexistent", { VERCEL: "1" });
  assert.equal(result.signed, false);
  // The reason is what an operator reads. It has to be a reason, not an error.
  assert.match(result.reason, /no ambient OIDC identity/);
});

test("an unsigned verdict of record says so, with what it costs and what it does not", () => {
  const lines = signatureLines({ signed: false }, row);
  assert.equal(lines.length, 1);
  const [line] = lines;

  assert.match(line, /Evidence signature/);
  assert.match(line, /unsigned/);
  // Both halves matter. Without the first an operator over-reads it as broken; without the
  // second they under-read it and assume the package proves who made it.
  assert.match(line, /tamper-evident/);
  assert.match(line, /provenance/);
  assert.match(line, /ADR-0022/);
});

test("signed renders nothing, and so does a package nobody measured", () => {
  // A row on every run is a row an operator learns to skip, which is how the unsigned case
  // would go unread — the failure mode this whole change exists to avoid.
  assert.deepEqual(signatureLines({ signed: true }, row), []);

  // `null` is a row that predates the field; `undefined` is a report a caller built without it.
  // Neither is a measurement, and rendering "unsigned" for either would invent one.
  assert.deepEqual(signatureLines({ signed: null }, row), []);
  assert.deepEqual(signatureLines({}, row), []);
});

test("the check run and the CLI cannot disagree, because they call the same helper", () => {
  // #228's arrangement, reused. The guarantee is structural rather than asserted: both surfaces
  // import `signatureLines` from `run-report.ts`. What is checked here is that the GitHub side
  // actually reaches it, since an import nobody calls guarantees nothing.
  const summary = renderEvidenceSummary(unsignedReport());
  assert.match(summary, /Evidence signature/);
  assert.match(summary, /unsigned/);

  const signed = renderEvidenceSummary({ ...unsignedReport(), signed: true });
  assert.doesNotMatch(signed, /Evidence signature/);
});

function unsignedReport() {
  return {
    engineeringRunId: "11111111-1111-1111-1111-111111111111",
    task: {
      id: "t",
      title: "Add an MIT LICENSE file",
      riskLevel: "low",
      criteria: [{ id: "AC1", text: "a LICENSE file exists at the repository root" }],
      criteriaProvenance: "extracted",
      criteriaGeneratedBy: null,
      criteriaApprovedBy: null,
    },
    state: "WAITING_FOR_HUMAN",
    terminal: false,
    finalVerdict: "warn",
    stopReason: null,
    stopReasonText: null,
    startedAt: new Date("2026-09-19T22:00:00Z"),
    completedAt: null,
    verifications: [
      {
        id: "ver-1",
        cycle: 1,
        candidateSha: "a".repeat(40),
        verdict: "warn",
        startedAt: null,
        completedAt: null,
        evidence: { state: "stored", ref: "s3://bucket/ver-1.tar", manifestDigest: "sha256:abc" },
        verdictOfRecord: true,
        superseded: false,
        riskSummary: { blocking: [], nonBlocking: [], unsatisfied: [], satisfied: ["AC1"] },
      },
    ],
    repairAttempts: [],
    repairAttemptsTaken: 0,
    repairCap: 3,
    agentRuns: [],
    cost: {
      totalUsd: 0.3181,
      modelUsd: 0.3168,
      sandboxUsd: 0.0013,
      runCostUsd: 0.3181,
      reconciles: true,
      spendCapUsd: 25,
    },
    criteria: { satisfied: 1, total: 1 },
    residualRisk: {
      scored: false,
      reason: "not scored until the planner milestone",
      nonBlockingFindings: 0,
      unsatisfiedCriteria: 0,
    },
    incompleteStages: [],
    signed: false,
  };
}
