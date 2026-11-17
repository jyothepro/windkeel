import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import {
  getEngineeringRun,
  listRepairAttempts,
  listVerificationRuns,
  insertEngineeringRun,
  insertEngineeringTask,
  updateVerificationRun,
} from "../dist/factory/repositories.js";
import { assembleRunReport, renderRunReport } from "../dist/factory/run-report.js";
import { collectMetrics } from "../dist/factory/metrics.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { createImplementingHandler } from "../dist/factory/workflow/handlers/implementing.js";
import { createVerifyingHandler } from "../dist/factory/workflow/handlers/verifying.js";
import { createRepairingHandler } from "../dist/factory/workflow/handlers/repairing.js";
import { bareFixtureRepo, repoRoot, runCli, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * The run report (#145) and the metrics views behind it.
 *
 * Every fixture here is a *real run through the real handlers* rather than hand-inserted rows.
 * That is deliberate: the claim the report makes is "this is what the database says happened",
 * and a fixture built by inserting the rows the report expects would prove only that the
 * assembler can read what a test wrote.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let counter = 0;

const CRITERIA = [{ id: "ac-1", text: "the module keeps passing its own tests" }];
const CLEAN_REVIEW = { summary: "no defects found", findings: [] };
const dirtyReview = (id) => ({
  summary: `blocking defect ${id}`,
  findings: [
    {
      id,
      severity: "blocking",
      category: "correctness",
      claim: "the greeting is never printed",
      location: "index.js",
      failure_scenario: "a user runs the module and sees nothing",
    },
  ],
});

const mappingFor = (criteria) => ({
  mappings: criteria.map((c) => ({
    criterion: c.id,
    status: "satisfied",
    evidence: ["ev-01"],
    reason: "the repo's own checks pass on the candidate",
  })),
});

const TURN = [
  { type: "started", sessionId: "sess-1" },
  { type: "file_changed", path: "index.js", kind: "update" },
  { type: "completed", usage: { inputTokens: 100, outputTokens: 20 } },
];

class LoopWorker {
  constructor(options = {}) {
    this.name = "fake-resumable";
    this.capabilities = { resumableSessions: true };
    this.turn = 0;
    this.sends = [];
    this.sandbox = null;
    this.onTurn = options.onTurn ?? null;
  }
  async start(input) {
    this.sandbox = input.sandbox;
    this.turn = 1;
    await input.sandbox.writeFile("index.js", `// attempt ${this.turn}\n`);
    if (this.onTurn) await this.onTurn(this.turn);
    return { id: "session-1", workerSessionId: "sess-1" };
  }
  async send(_session, message) {
    this.sends.push(message);
    this.turn += 1;
    await this.sandbox.writeFile("index.js", `// attempt ${this.turn}\n`);
    if (this.onTurn) await this.onTurn(this.turn);
  }
  async cancel() {}
  async *events() {
    for (const event of TURN) yield event;
  }
  async result() {
    return {
      outcome: "completed",
      diff: { patch: `+// attempt ${this.turn}\n`, filesChanged: ["index.js"], truncated: false },
      usage: { inputTokens: 100, outputTokens: 20 },
    };
  }
}

class MemoryEvidenceStorage {
  constructor() {
    this.packages = new Map();
  }
  async putPackage(_localDir, bucket, key) {
    const ref = `${bucket}/${key}`;
    this.packages.set(ref, true);
    return ref;
  }
  async deletePackage(bucket, key) {
    this.packages.delete(`${bucket}/${key}`);
  }
}

/**
 * `shape` decides the run's story:
 *   "first-try"   — passes on cycle one
 *   "repaired"    — fails, repairs, passes
 *   "repair-cap"  — keeps failing with a moving failure set until the cap stops it
 *   "stuck"       — keeps failing with the same failure set
 *   "in-flight"   — stopped partway, so the report has to cope with an unfinished run
 *   "spend-cap" / "wall-clock" — a rail stops it before anything spawns
 */
async function withReport(shape, fn, options = {}) {
  const schema = `windkeel_report_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const schemaUrl = `${schemaDbUrl}${schemaDbUrl.includes("?") ? "&" : "?"}options=${encodeURIComponent(
    `-c search_path=${schema}`,
  )}`;
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "true" });
  const sandboxes = new FakeSandboxProvider();
  const registry = new SandboxRegistry();
  const sessions = new WorkerSessionRegistry();
  const storage = new MemoryEvidenceStorage();

  const reviewPath = join(tempDir("review"), "review.json");
  const mappingPath = join(tempDir("mapping"), "mapping.json");
  writeFileSync(mappingPath, JSON.stringify(mappingFor(CRITERIA)));

  const reviewFor = (turn) => {
    if (shape === "first-try") return CLEAN_REVIEW;
    if (shape === "repaired") return turn === 1 ? dirtyReview("REV-1") : CLEAN_REVIEW;
    if (shape === "stuck") return dirtyReview("REV-SAME");
    return dirtyReview(`REV-${turn}`);
  };
  writeFileSync(reviewPath, JSON.stringify(reviewFor(1)));

  const worker = new LoopWorker({
    onTurn: async (turn) => writeFileSync(reviewPath, JSON.stringify(reviewFor(turn))),
  });

  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "local",
      sourceReference: "m5.5",
      title: "Add a greeting",
      description: "Make index.js print hello.",
      acceptanceCriteria: CRITERIA,
      riskLevel: options.riskLevel ?? "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: shape === "spend-cap" ? 0 : 10_000,
      wallClockCapSeconds: shape === "wall-clock" ? 3600 : 7200,
    });
    for (const to of ["CLASSIFYING", "PLANNING", "PROVISIONING"]) {
      await advanceRun(pool, run.id, to, "test seed");
    }
    if (shape === "wall-clock") {
      await pool.query(
        "update engineering_run set started_at = now() - interval '3 hours' where id = $1",
        [run.id],
      );
    }

    const deps = {
      pool,
      sandboxes,
      worker,
      registry,
      sessions,
      evidence: { storage, bucket: "evidence" },
      config: {
        repository: { url: remote.bare, baseRevision: "HEAD" },
        makerModel: "gpt-5-codex",
        makerVendor: "openai",
        modelApiDomain: "api.openai.com",
        modelKeyEnvVar: "OPENAI_API_KEY",
        modelPricing: { usdPerInputToken: 0.001, usdPerOutputToken: 0.002 },
        usdPerCpuMs: 0.000001,
        usdPerEgressByte: 0,
        railsCheckIntervalMs: 60_000,
        workspaceTtlMs: 60_000,
        gitHost: "github.com",
        gitAuthorName: "Windkeel Factory",
        gitAuthorEmail: "factory@windkeel.invalid",
        policyVersion: "test",
        fakeSecurity: join(repoRoot, "test", "fixtures", "no-scanners.json"),
        checkerModels: {
          endpoints: [],
          maker: { vendor: "openai", model: "gpt-5-codex" },
          fakes: { review: reviewPath, mapping: mappingPath },
        },
      },
    };

    const provider = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool) });
    provider.register(createProvisioningHandler(deps));
    provider.register(createImplementingHandler(deps));
    provider.register(createVerifyingHandler(deps));
    // An in-flight run is one that stopped between stages: no REPAIRING handler, so a fail
    // verdict parks at REPAIRING with the cycle-one story complete and nothing after it.
    if (shape !== "in-flight") provider.register(createRepairingHandler(deps));
    await provider.start();

    await provider.startRun(run.id);
    await provider.drain();

    await fn({ pool, schemaUrl, runId: run.id, storage, worker, provider, deps });
  } finally {
    for (const [, handle] of registry.entries()) await handle.destroy().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

test("a first-try pass reports zero repair attempts and a verdict of record", { skip }, async () => {
  await withReport("first-try", async ({ pool, runId }) => {
    const report = await assembleRunReport(pool, runId);
    assert.equal(report.repairAttemptsTaken, 0);
    assert.equal(report.repairAttempts.length, 0);
    assert.equal(report.finalVerdict, "pass");
    assert.equal(report.verifications.length, 1);
    assert.equal(report.verifications[0].verdictOfRecord, true);
    assert.equal(report.verifications[0].superseded, false);
    assert.equal(report.verifications[0].evidence.state, "stored");
    assert.match(report.verifications[0].evidence.manifestDigest, /^[0-9a-f]{64}$/);

    const text = renderRunReport(report);
    assert.match(text, /^WINDKEEL RESULT$/m);
    assert.match(text, /^Task: Add a greeting$/m);
    assert.match(text, /^Acceptance criteria {7}1\/1$/m);
    assert.match(text, /^Repair attempts {11}0$/m);
    assert.match(text, /^Overall verdict {11}PASS$/m);
  });
});

test("a pass-after-repair reports one attempt and both cycles", { skip }, async () => {
  await withReport("repaired", async ({ pool, runId }) => {
    const report = await assembleRunReport(pool, runId);

    assert.equal(report.repairAttemptsTaken, 1);
    assert.equal(report.repairAttempts[0].taken, true);
    assert.deepEqual(report.repairAttempts[0].blockingFindings, ["REV-1"]);
    assert.equal(report.verifications.length, 2);
    assert.equal(report.verifications[0].superseded, true);
    assert.equal(report.verifications[0].verdictOfRecord, false);
    assert.equal(report.verifications[1].verdictOfRecord, true);
    assert.notEqual(
      report.verifications[0].candidateSha,
      report.verifications[1].candidateSha,
    );

    // Provenance, per ADR-0011 §2: the repairer is the implementer, resumed.
    const implementer = report.agentRuns.find((a) => a.role === "implementer");
    const repairer = report.agentRuns.find((a) => a.role === "repairer");
    assert.equal(repairer.workerType, implementer.workerType);
    assert.equal(repairer.model, implementer.model);
    assert.equal(repairer.id, report.repairAttempts[0].agentRunId);

    const text = renderRunReport(report);
    assert.match(text, /^Repair attempts {11}1$/m);
    assert.match(text, /\[verdict of record\]/);
    assert.match(text, /\[superseded\]/);
    assert.match(text, /asked to fix: finding REV-1/);
  });
});

test("the report distinguishes attempts recorded from attempts taken", { skip }, async () => {
  await withReport(
    "repair-cap",
    async ({ pool, runId }) => {
      const report = await assembleRunReport(pool, runId);
      assert.equal(report.state, "MAX_REPAIR_ATTEMPTS_REACHED");
      assert.equal(report.stopReason, "repair_cap");
      assert.match(report.stopReasonText, /risk level were used up/);

      // High risk allows one attempt. The failure that stopped the run still stored a packet, so
      // there are two rows and one of them was never acted on — the §16 line is the taken count.
      assert.equal(report.repairCap, 1);
      assert.equal(report.repairAttemptsTaken, 1);
      assert.equal(report.repairAttempts.length, 2);
      assert.equal(report.repairAttempts[1].taken, false);

      const text = renderRunReport(report);
      assert.match(text, /^Repair attempts {11}1$/m);
      assert.match(text, /attempt 2 \(not taken — the run stopped first\)/);
      assert.match(text, /^Stopped because {11}repair_cap/m);
    },
    { riskLevel: "high" },
  );
});

test("a stuck run reports its reason in human words", { skip }, async () => {
  await withReport("stuck", async ({ pool, runId }) => {
    const report = await assembleRunReport(pool, runId);
    assert.equal(report.state, "MAX_REPAIR_ATTEMPTS_REACHED");
    assert.equal(report.stopReason, "stuck");
    assert.match(renderRunReport(report), /stopped making progress/);
  });
});

for (const shape of ["spend-cap", "wall-clock"]) {
  test(`a ${shape} stop reports correctly with nothing having run`, { skip }, async () => {
    await withReport(shape, async ({ pool, runId }) => {
      const report = await assembleRunReport(pool, runId);
      assert.equal(report.state, "FAILED");
      assert.equal(report.stopReason, shape === "spend-cap" ? "spend_cap" : "wall_clock_cap");
      assert.equal(report.verifications.length, 0);
      assert.equal(report.agentRuns.length, 0);
      assert.equal(report.repairAttemptsTaken, 0);

      // The report is most valuable on the runs that stopped, so it must not throw on the ones
      // where there is nothing to show.
      const text = renderRunReport(report);
      assert.match(text, /Verification cycles\n {2}\(none yet\)/);
      assert.match(text, /Repair history\n {2}\(none\)/);
    });
  });
}

test("a run still in flight reports what has happened so far", { skip }, async () => {
  await withReport("in-flight", async ({ pool, runId }) => {
    const report = await assembleRunReport(pool, runId);
    assert.equal(report.terminal, false);
    assert.equal(report.state, "REPAIRING");
    assert.equal(report.stopReason, null);
    assert.equal(report.verifications.length, 1);
    assert.equal(report.verifications[0].verdict, "fail");
    // The packet is on the record; nothing has acted on it yet.
    assert.equal(report.repairAttempts.length, 1);
    assert.equal(report.repairAttempts[0].taken, false);
    assert.match(renderRunReport(report), /^Run state {17}REPAIRING$/m);
  });
});

test("cost in the report reconciles exactly with the ledger", { skip }, async () => {
  await withReport("repaired", async ({ pool, runId }) => {
    const report = await assembleRunReport(pool, runId);
    const { rows } = await pool.query(
      "select coalesce(sum(usd), 0) as total from cost_event where engineering_run_id = $1",
      [runId],
    );
    const run = await getEngineeringRun(pool, runId);

    assert.equal(report.cost.totalUsd, Number(rows[0].total));
    assert.equal(report.cost.runCostUsd, run.cost);
    assert.equal(report.cost.reconciles, true);
    assert.ok(report.cost.modelUsd > 0, "the agent turns cost something");
    assert.ok(report.cost.sandboxUsd > 0, "and so did the sandboxes");
    // A run with no snapshot ran on Windkeel's key, and every model row says so (#324).
    assert.deepEqual(report.cost.modelBySource.map((s) => s.keySource), ["orqon"]);
    assert.equal(report.cost.modelBySource[0].usd, report.cost.modelUsd);
    assert.match(renderRunReport(report), /^ {2}total {4}\$/m);
  });
});

test("a pruned package reports as pruned, never as missing or present", { skip }, async () => {
  await withReport("repaired", async ({ pool, runId, storage }) => {
    const [first] = await listVerificationRuns(pool, runId);
    // What the ADR-0015 sweep leaves behind: no ref, a tombstone timestamp, digest intact.
    await storage.deletePackage(...first.evidencePackageRef.split(/\/(.*)/s));
    await updateVerificationRun(pool, first.id, {
      evidencePackageRef: null,
      evidencePrunedAt: new Date(),
    });

    const report = await assembleRunReport(pool, runId);
    assert.equal(report.verifications[0].evidence.state, "pruned");
    assert.equal(report.verifications[0].evidence.manifestDigest, first.evidenceManifestDigest);
    assert.equal(report.verifications[1].evidence.state, "stored");

    const text = renderRunReport(report);
    assert.match(text, /pruned by policy \(ADR-0015\)/);
  });
});

test("the run report renders the block against real Postgres", { skip }, async () => {
  // Served by GET /v1/runs/{id} as `rendered`, which `windkeel show` prints (ADR-0023 §10).
  await withReport("repaired", async ({ schemaUrl, runId }) => {
    const pool = new Pool({ connectionString: schemaUrl, ...TEST_POOL });
    try {
      const text = renderRunReport(await assembleRunReport(pool, runId));
      assert.match(text, /^WINDKEEL RESULT$/m);
      assert.match(text, /^Repair attempts {11}1$/m);
      assert.match(text, /Verification cycles/);
    } finally {
      await pool.end();
    }
  });
});

/**
 * #228's other renderer. The issue asks that the two agree or that the PR says why only one
 * changed; they agree because both call `incompleteLines`, and this is the assertion that the
 * local report actually does.
 *
 * Driven by writing the row VERIFYING would have written, because the row-to-text path is the
 * one being tested: `RunReport` is assembled from rows alone, which is how the fact went missing
 * in the first place.
 */
test("the local run report names an incomplete stage too", { skip }, async () => {
  await withReport("repaired", async ({ pool, runId }) => {
    // The verdict *of record* is the last completed verification (ADR-0015), and that is the one
    // the report reads — a repaired run has more than one, and writing to the wrong one would
    // make this pass for the wrong reason.
    const completed = (await listVerificationRuns(pool, runId)).filter((v) => v.completedAt);
    const verification = completed[completed.length - 1];
    await updateVerificationRun(pool, verification.id, {
      riskSummary: {
        ...verification.riskSummary,
        incomplete: [
          {
            stage: "security",
            evidenceId: "ev-04",
            tool: "semgrep",
            detail: "semgrep was killed before it finished: exit 143 (SIGTERM)",
            killed: true,
          },
        ],
      },
    });

    const report = await assembleRunReport(pool, runId);
    assert.equal(report.incompleteStages.length, 1);

    const text = renderRunReport(report);
    assert.match(text, /^Stages not completed/m);
    assert.match(text, /semgrep/);
    assert.match(text, /SIGTERM/);
    assert.match(text, /ev-04/);
  });
});

test("a run with nothing incomplete gains no row in the local report", { skip }, async () => {
  await withReport("repaired", async ({ pool, runId }) => {
    const report = await assembleRunReport(pool, runId);
    assert.deepEqual(report.incompleteStages, []);
    assert.doesNotMatch(renderRunReport(report), /Stages not completed/);
  });
});

test("residual risk is reported as unscored, never invented", { skip }, async () => {
  await withReport("repaired", async ({ pool, runId }) => {
    const report = await assembleRunReport(pool, runId);
    assert.equal(report.residualRisk.scored, false);
    assert.match(report.residualRisk.reason, /planner milestone/);
    assert.match(renderRunReport(report), /^Residual risk {13}not scored \(Milestone 10\)/m);
  });
});

test("the metrics views say what they claim for a repaired run", { skip }, async () => {
  await withReport("repaired", async ({ pool, runId }) => {
    const metrics = await collectMetrics(pool);

    assert.equal(Number(metrics.summary.repair_success_rate.total_repaired), 1);
    assert.equal(Number(metrics.summary.repair_success_rate.repaired_to_success), 1);
    assert.equal(Number(metrics.summary.repair_success_rate.repair_success_rate_pct), 100);

    // The run repaired, so its *first* verification failed.
    assert.equal(Number(metrics.summary.first_pass_verification_rate.first_pass), 0);
    assert.equal(Number(metrics.summary.first_pass_verification_rate.total), 1);

    const perRun = metrics.perRun.repair_attempts_per_run.find(
      (r) => r.engineering_run_id === runId,
    );
    assert.equal(Number(perRun.attempts_recorded), 1);
    assert.equal(Number(perRun.attempts_taken), 1);

    // sandbox_duration pairs occurrence by occurrence, so a repaired run gets one row per cycle.
    const durations = metrics.perRun.sandbox_duration.filter(
      (r) => r.engineering_run_id === runId,
    );
    assert.equal(durations.filter((r) => r.workspace_role === "verifier").length, 2);
    assert.equal(durations.filter((r) => r.workspace_role === "maker").length, 1);
  });
});

test("the metrics views say what they claim for a first-try pass", { skip }, async () => {
  await withReport("first-try", async ({ pool }) => {
    const metrics = await collectMetrics(pool);
    assert.equal(Number(metrics.summary.first_pass_verification_rate.first_pass), 1);
    assert.equal(Number(metrics.summary.first_pass_verification_rate.first_pass_rate_pct), 100);
    // No repair attempt row at all, so the repaired denominator stays empty rather than
    // counting a run that never entered the loop.
    assert.equal(Number(metrics.summary.repair_success_rate.total_repaired), 0);
    assert.equal(metrics.summary.repair_success_rate.repair_success_rate_pct, null);
  });
});

test("a stuck run counts as a repair that did not succeed, not as a success", { skip }, async () => {
  await withReport("stuck", async ({ pool, runId }) => {
    const metrics = await collectMetrics(pool);
    assert.equal(Number(metrics.summary.repair_success_rate.total_repaired), 1);
    assert.equal(Number(metrics.summary.repair_success_rate.repaired_to_success), 0);
    assert.equal(Number(metrics.summary.repair_success_rate.repair_success_rate_pct), 0);

    // And the recorded/taken gap is visible: the last failure stored a packet nobody acted on.
    const perRun = metrics.perRun.repair_attempts_per_run.find(
      (r) => r.engineering_run_id === runId,
    );
    assert.ok(
      Number(perRun.attempts_recorded) > Number(perRun.attempts_taken),
      "a rail stop leaves one packet unacted on",
    );
    assert.equal((await listRepairAttempts(pool, runId)).length, Number(perRun.attempts_recorded));
  });
});

test("an in-flight run does not drag the metrics", { skip }, async () => {
  await withReport("in-flight", async ({ pool }) => {
    const metrics = await collectMetrics(pool);
    // The run is parked at REPAIRING with final_verdict 'fail'. The pre-M5 view counted it as a
    // repair failure immediately; it is not terminal, so it should not be counted at all.
    assert.equal(Number(metrics.summary.repair_success_rate.total_repaired), 0);
  });
});
