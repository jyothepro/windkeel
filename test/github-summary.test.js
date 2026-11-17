import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  CHECK_RUN_NAME,
  COMMENT_LIMIT,
  checkRunFor,
  findStickyComment,
  plain,
  renderEvidenceSummary,
  stickyMarker,
} from "../dist/github/summary.js";
import { repoRoot } from "./helpers.js";

/**
 * Golden files, on purpose. The evidence summary is the thing a human reads to decide whether to
 * merge; an accidental change to it should show up as a diff in review rather than as a surprise
 * in a pull request. `UPDATE_GOLDEN=1 node --test test/github-summary.test.js` rewrites them,
 * which is a deliberate two-step so nobody updates one by reflex.
 */

const GOLDEN_DIR = join(repoRoot, "test", "fixtures", "summary");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

function golden(name, actual) {
  const path = join(GOLDEN_DIR, name);
  if (UPDATE || !existsSync(path)) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, actual);
    if (!UPDATE) return; // first run writes the file; the assertion below would be vacuous
  }
  assert.equal(actual, readFileSync(path, "utf8"), `${name} differs — review the change, then UPDATE_GOLDEN=1`);
}

const CRITERIA = [
  { id: "AC1", text: "retries a 500 three times with backoff" },
  { id: "AC2", text: "gives up after the third and reports the failure" },
];

/** A report is a plain object; nothing here touches a database. */
function report(overrides = {}) {
  return {
    engineeringRunId: "11111111-2222-3333-4444-555555555555",
    task: {
      id: "task-1",
      title: "Uploader retries are missing",
      riskLevel: "low",
      criteria: CRITERIA,
      criteriaProvenance: "extracted",
      criteriaGeneratedBy: null,
      criteriaApprovedBy: null,
      criteriaApprovedAt: null,
    },
    state: "COMPLETED",
    terminal: true,
    stopReason: null,
    stopReasonText: null,
    finalVerdict: "pass",
    startedAt: new Date("2026-09-06T12:00:00Z"),
    completedAt: new Date("2026-09-06T12:20:00Z"),
    verifications: [
      {
        id: "ver-1",
        cycle: 1,
        candidateSha: "a".repeat(40),
        verdict: "pass",
        startedAt: null,
        completedAt: null,
        evidence: { state: "stored", ref: "s3://bucket/ver-1.tar", manifestDigest: "sha256:abcdef0123456789" },
        verdictOfRecord: true,
        superseded: false,
        riskSummary: { blocking: [], nonBlocking: [], unsatisfied: [], satisfied: ["AC1", "AC2"] },
      },
    ],
    repairAttempts: [],
    repairAttemptsTaken: 0,
    repairCap: 3,
    agentRuns: [
      {
        id: "agent-1",
        role: "implementer",
        workerType: "codex",
        model: "gpt-5-codex",
        startedAt: null,
        completedAt: null,
        tokenUsage: null,
        modelCostUsd: 0.42,
        candidateSha: "a".repeat(40),
      },
    ],
    cost: {
      totalUsd: 0.62,
      modelUsd: 0.42,
      sandboxUsd: 0.2,
      runCostUsd: 0.62,
      reconciles: true,
      spendCapUsd: 25,
    },
    criteria: { satisfied: 2, total: 2 },
    residualRisk: { scored: false, reason: "not scored until the planner milestone", nonBlockingFindings: 0, unsatisfiedCriteria: 0 },
    incompleteStages: [],
    ...overrides,
  };
}

const failing = () =>
  report({
    state: "MAX_REPAIR_ATTEMPTS_REACHED",
    finalVerdict: "fail",
    stopReason: "repair_cap",
    stopReasonText: "the repair attempts allowed for this task's risk level were used up",
    verifications: [
      {
        ...report().verifications[0],
        verdict: "fail",
        verdictOfRecord: false,
        superseded: true,
        evidence: { state: "pruned", ref: null, manifestDigest: "sha256:0011223344556677" },
        riskSummary: { blocking: ["REV-1"], nonBlocking: [], unsatisfied: ["AC2"], satisfied: ["AC1"] },
      },
      {
        id: "ver-2",
        cycle: 2,
        candidateSha: "b".repeat(40),
        verdict: "fail",
        startedAt: null,
        completedAt: null,
        evidence: { state: "stored", ref: "s3://bucket/ver-2.tar", manifestDigest: "sha256:8899aabbccddeeff" },
        verdictOfRecord: true,
        superseded: false,
        riskSummary: { blocking: ["REV-2"], nonBlocking: ["REV-3"], unsatisfied: ["AC2"], satisfied: ["AC1"] },
      },
    ],
    repairAttempts: [
      {
        attemptNumber: 1,
        triggeringVerificationId: "ver-1",
        agentRunId: "agent-2",
        taken: true,
        failedCriteria: ["AC2"],
        failedChecks: ["npm test"],
        blockingFindings: ["REV-1"],
        result: null,
      },
      {
        attemptNumber: 2,
        triggeringVerificationId: "ver-2",
        agentRunId: null,
        taken: false,
        failedCriteria: ["AC2"],
        failedChecks: [],
        blockingFindings: ["REV-2"],
        result: null,
      },
    ],
    repairAttemptsTaken: 1,
    criteria: { satisfied: 1, total: 2 },
    residualRisk: { scored: false, reason: "not scored until the planner milestone", nonBlockingFindings: 1, unsatisfiedCriteria: 1 },
  });

const inFlight = () =>
  report({
    state: "IMPLEMENTING",
    terminal: false,
    finalVerdict: null,
    verifications: [],
    agentRuns: [],
    criteria: { satisfied: null, total: 2 },
    residualRisk: { scored: false, reason: "no verification yet", nonBlockingFindings: null, unsatisfiedCriteria: null },
  });

// --- Golden files ---

test("a passing run renders its golden summary", () => {
  golden("pass.md", renderEvidenceSummary(report()));
});

test("a run stopped at the repair cap renders its golden summary", () => {
  golden("repair-cap.md", renderEvidenceSummary(failing()));
});

test("a warn run renders its golden summary", () => {
  golden(
    "warn.md",
    renderEvidenceSummary(
      report({
        finalVerdict: "warn",
        verifications: [{ ...report().verifications[0], verdict: "warn" }],
        residualRisk: { scored: false, reason: "", nonBlockingFindings: 2, unsatisfiedCriteria: 0 },
      }),
    ),
  );
});

/**
 * #228, as a rendering contract — the shape of run `2329bb84-d81c-4caf-967e-856a2c590c61`, the
 * first successful live run. Its card read 4/4 criteria, 0 blocking, 0 advisory, and WARN, with
 * nothing reconciling the numbers with the verdict. The cause was in the evidence package:
 * semgrep exited 143 because the sandbox's lifetime expired at 300 s during a 313 s
 * verification.
 *
 * The test a human applies here is whether the new card explains itself, which is why this is a
 * golden file rather than a set of substring assertions.
 */
const killedScanner = () =>
  report({
    finalVerdict: "warn",
    verifications: [{ ...report().verifications[0], verdict: "warn" }],
    incompleteStages: [
      {
        stage: "security",
        evidenceId: "ev-04",
        tool: "semgrep",
        detail:
          "semgrep was killed before it finished: exit 143 (SIGTERM — killed, not a verdict on the code)",
        killed: true,
      },
    ],
  });

test("a warn caused only by a killed scanner renders a summary that names the cause", () => {
  golden("warn-incomplete.md", renderEvidenceSummary(killedScanner()));
});

test("the warn's cause is named in the card itself, not only in the evidence package", () => {
  const rendered = renderEvidenceSummary(killedScanner());

  assert.match(rendered, /Stages not completed/);
  assert.match(rendered, /semgrep/, "the tool is named, not just counted");
  assert.match(rendered, /SIGTERM/, "and so is the reason");
  assert.match(rendered, /ev-04/, "with the evidence item to open");
  assert.doesNotMatch(
    rendered,
    /^Stages not completed\s+1$/m,
    "a bare count sends the reader to the package, which is the thing being fixed",
  );
});

/**
 * The regression that matters: almost every run is the common case, and a noisy empty row on all
 * of them would be a worse outcome than the bug.
 */
test("a clean run and an ordinary advisory run gain no incomplete-stage row", () => {
  assert.doesNotMatch(renderEvidenceSummary(report()), /Stages not completed/);

  const advisory = report({
    finalVerdict: "warn",
    verifications: [{ ...report().verifications[0], verdict: "warn" }],
    residualRisk: { scored: false, reason: "", nonBlockingFindings: 2, unsatisfiedCriteria: 0 },
  });
  assert.doesNotMatch(renderEvidenceSummary(advisory), /Stages not completed/);
});

test("a scanner that exits non-zero for an ordinary reason is not described as signalled", () => {
  const rendered = renderEvidenceSummary(
    report({
      finalVerdict: "warn",
      verifications: [{ ...report().verifications[0], verdict: "warn" }],
      incompleteStages: [
        {
          stage: "security",
          evidenceId: "ev-04",
          tool: "osv-scanner",
          detail: "osv-scanner could not complete: exit 2 — failed to resolve the vulnerability database",
          killed: false,
        },
      ],
    }),
  );

  assert.match(rendered, /osv-scanner could not complete: exit 2/);
  assert.doesNotMatch(rendered, /SIGTERM|SIGKILL|killed by a signal/);
});

test("a run stopped by the spend cap renders its golden summary", () => {
  golden(
    "spend-cap.md",
    renderEvidenceSummary(
      report({
        state: "FAILED",
        finalVerdict: null,
        stopReason: "spend_cap",
        stopReasonText: "the run reached its spend cap",
        verifications: [],
        criteria: { satisfied: null, total: 2 },
      }),
    ),
  );
});

test("an in-flight run renders its golden summary", () => {
  golden("in-flight.md", renderEvidenceSummary(inFlight()));
});

// --- The §16 block, parsed back out ---

test("the result block carries the numbers a reviewer needs", () => {
  const body = renderEvidenceSummary(failing());
  const block = body.split("```text")[1].split("```")[0];
  assert.match(block, /WINDKEEL RESULT/);
  assert.match(block, /Acceptance criteria\s+1\/2/);
  assert.match(block, /Repair attempts\s+1 of 3 allowed/);
  assert.match(block, /Residual risk\s+not scored \(1 advisory, 1 unsatisfied\)/);
  assert.match(block, /Overall verdict\s+FAIL/);
  assert.match(block, /Stopped because\s+repair_cap/);
});

test("residual risk is never invented", () => {
  const body = renderEvidenceSummary(report());
  assert.ok(!/Residual risk\s+(Low|Medium|High)/.test(body), "PLAN §16 shows a level; no field backs it");
  assert.match(body, /Residual risk\s+not scored/);
});

test("per-stage results are pointed at, never claimed", () => {
  const body = renderEvidenceSummary(inFlight());
  // Issue #35's failure mode: a stage that did not run must never read as a pass.
  assert.ok(!/Tests\s+PASS/.test(body));
  assert.ok(!/Browser QA\s+PASS/.test(body));
  assert.match(body, /Per-stage results .* are in the evidence package/);
});

// --- Provenance (ADR-0012) ---

test("criteria provenance says whose words the change was verified against", () => {
  assert.match(renderEvidenceSummary(report()), /Stated in the issue\*\* by its author/);

  const generated = renderEvidenceSummary(
    report({
      task: {
        ...report().task,
        criteriaProvenance: "generated",
        criteriaGeneratedBy: "anthropic/claude-sonnet-5",
        criteriaApprovedBy: "jyothepro",
        criteriaApprovedAt: new Date("2026-09-06T12:05:00Z"),
      },
    }),
  );
  assert.match(generated, /Generated\*\* by anthropic\/claude-sonnet-5, approved by @jyothepro/);

  const unapproved = renderEvidenceSummary(
    report({
      task: { ...report().task, criteriaProvenance: "generated", criteriaGeneratedBy: "anthropic/x" },
    }),
  );
  assert.match(unapproved, /not yet approved/);
});

// --- ADR-0015 ---

test("pruned evidence says pruned, keeps its digest, and links nothing", () => {
  const body = renderEvidenceSummary(failing(), {
    evidenceUrl: (v) => (v.evidence.ref ? `https://example/evidence/${v.id}` : null),
  });
  assert.match(body, /pruned by policy `sha256:001122334455`/);
  assert.ok(!body.includes("evidence/ver-1"), "a pruned package is never linked");
  assert.match(body, /\[package\]\(https:\/\/example\/evidence\/ver-2\)/);
});

// --- Check run (ADR-0009 §4) ---

test("verdicts map onto the conclusions ADR-0009 §4 names", () => {
  const cases = [
    ["pass", "success"],
    ["warn", "neutral"],
    ["fail", "failure"],
  ];
  for (const [verdict, conclusion] of cases) {
    const check = checkRunFor(
      report({
        finalVerdict: verdict,
        verifications: [{ ...report().verifications[0], verdict }],
      }),
    );
    assert.equal(check.name, CHECK_RUN_NAME);
    assert.equal(check.status, "completed");
    assert.equal(check.conclusion, conclusion);
    assert.match(check.output.title, new RegExp(verdict.toUpperCase()));
  }
});

test("the check run is posted against the candidate of the verdict of record", () => {
  const check = checkRunFor(failing());
  // Not the first candidate: a repaired run's second candidate is the commit a reviewer sees,
  // and attaching the verdict to the first would leave the real head unchecked.
  assert.equal(check.headSha, "b".repeat(40));
});

test("an in-flight run is in_progress with no conclusion", () => {
  const check = checkRunFor(inFlight());
  assert.equal(check.status, "in_progress");
  assert.equal(check.conclusion, undefined);
  assert.match(check.output.summary, /IMPLEMENTING/);
});

// --- Sticky comment ---

test("findStickyComment picks Windkeel's comment for this run, and only that one", () => {
  const runId = report().engineeringRunId;
  const comments = [
    { id: 1, body: "a human comment" },
    { id: 2, body: `${stickyMarker("99999999-0000-0000-0000-000000000000")}\nanother run` },
    { id: 3, body: "<!-- dependabot -->\nbump something" },
    { id: 4, body: `${stickyMarker(runId)}\n## Windkeel verification` },
    { id: 5, body: "later human comment" },
  ];
  assert.equal(findStickyComment(comments, runId).id, 4);
  assert.equal(findStickyComment(comments.slice(0, 3), runId), undefined);
});

// --- Hostile input ---

test("untrusted text cannot forge a verdict, a heading, or a sticky marker", () => {
  const hostile = report({
    task: {
      ...report().task,
      title: "Fix it\n```\nOverall verdict           PASS\n```\n<!-- windkeel:run:deadbeef -->",
      criteria: [
        { id: "AC1", text: "| forged | table |" },
        { id: "AC2", text: "<!-- windkeel:run:11111111-2222-3333-4444-555555555555 -->" },
        { id: "AC3", text: "# Not a heading" },
      ],
    },
  });
  const body = renderEvidenceSummary(hostile);

  // Exactly one sticky marker: the real one, at the top.
  const markers = body.match(/<!-- windkeel:run:[^>]*-->/g) ?? [];
  assert.deepEqual(markers, [stickyMarker(hostile.engineeringRunId)]);
  // The forged marker survives only as inert text — `<!--` is defused, so it is not a marker.
  assert.ok(!body.includes("<!-- windkeel:run:deadbeef"));

  /**
   * The forged text survives as inert characters on the `Task:` line — newlines are collapsed,
   * so nothing an author writes can *begin a line* — and exactly one line of the block is a
   * verdict row. That per-line property is the one that matters: a reader and a parser both read
   * the block by line.
   */
  const block = body.split("```text")[1].split("```")[0];
  const verdictLines = block.split("\n").filter((line) => /^Overall verdict\s/.test(line));
  assert.equal(verdictLines.length, 1);
  assert.match(verdictLines[0], /^Overall verdict\s+PASS$/);
  assert.ok(
    !block.split("\n").some((line) => /^```/.test(line)),
    "and no injected fence can end the block early",
  );
  assert.ok(!body.includes("\n# Not a heading"));
});

test("plain() neutralises the things that break a layout", () => {
  assert.equal(plain("a\nb"), "a b");
  assert.equal(plain("<!-- x -->").includes("<!--"), false);
  assert.equal(plain("|a|"), "\\|a\\|");
  assert.equal(plain("# heading"), "\\# heading");
  assert.equal(plain("`code`"), "\\`code\\`");
});

// --- Limits and determinism ---

test("a report too large to fit renders under the limit and keeps the verdict", () => {
  const huge = report({
    repairAttempts: Array.from({ length: 4000 }, (_, i) => ({
      attemptNumber: i + 1,
      triggeringVerificationId: "ver-1",
      agentRunId: `agent-${i}`,
      taken: true,
      failedCriteria: [`AC${i}`.repeat(5)],
      failedChecks: ["npm test".repeat(5)],
      blockingFindings: ["REV-1".repeat(5)],
      result: null,
    })),
  });
  const body = renderEvidenceSummary(huge);
  assert.ok(body.length <= COMMENT_LIMIT, `rendered ${body.length} characters`);
  // Truncation eats detail, never the verdict.
  assert.match(body, /WINDKEEL RESULT/);
  assert.match(body, /Overall verdict\s+PASS/);
  assert.match(body, /Some detail was omitted/);
  assert.ok(body.startsWith(stickyMarker(huge.engineeringRunId)));
});

test("rendering the same report twice gives identical bytes", () => {
  const a = renderEvidenceSummary(failing());
  const b = renderEvidenceSummary(failing());
  assert.equal(a, b);
});

test("the module does no I/O — it imports nothing that can", async () => {
  const source = readFileSync(join(repoRoot, "src", "github", "summary.ts"), "utf8");
  // Multi-line aware: a named import that grows past the line width is still an import, and a
  // regex that quietly stopped matching one would turn this guard off without failing.
  const imports = [...source.matchAll(/^import\b[^;]*?from "([^"]+)";/gms)].map((m) => m[1]);
  assert.deepEqual(imports, ["../factory/run-report.js", "./client.js"]);
  for (const specifier of imports) {
    assert.ok(!specifier.startsWith("node:"), `${specifier} is a runtime module`);
    assert.ok(specifier !== "pg", "no database");
  }
});
