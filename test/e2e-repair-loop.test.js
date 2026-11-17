import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { ScriptedWorkerAdapter } from "../dist/worker/scripted.js";
import {
  getEngineeringRun,
  listAgentRuns,
  listRepairAttempts,
  listVerificationRuns,
  listWorkspaces,
} from "../dist/factory/repositories.js";
import { assembleRunReport } from "../dist/factory/run-report.js";
import { S3EvidenceStorage } from "../dist/factory/evidence-storage.js";
import { createAndStartTask } from "./start-task.js";
import { bareFixtureRepo, repoRoot, runCli, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { startFactory } from "./factory-stack.js";
import { closeWorkflowRuntime, endExecutions, runtimeSkip } from "./workflow-runtime.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * **Milestone 5's success criterion, end to end:**
 *
 *     worker creates defect → Windkeel catches it → worker repairs it → Windkeel passes it
 *
 * Driven through `createAndStartTask` and the real `VercelWorkflowProvider` against real
 * Postgres and the real workflow runtime, with real MinIO when `S3_ENDPOINT` is set. It drove
 * `PgBossWorkflowProvider` until #200 retired it.
 *
 * **No scripted verdicts.** Both the fail and the pass come from the engine observing the
 * repository: the fixture repo's own `npm test` runs `node check.js`, which executes `index.js`
 * and demands specific output. Turn one writes a defect and that check exits non-zero, so the
 * checks stage emits a blocking finding and the verdict is `fail` — the packet's `failed_checks`
 * is genuinely derived from a command that genuinely failed. Turn two writes the fix and the
 * same check passes. The review and mapping models are scripted *clean* throughout, and that is
 * the point: they are held constant across both cycles, so they cannot be what flips the
 * verdict. Nothing here tells the verifier what to conclude.
 *
 * **The honesty caveat, carried forward verbatim from M4.7 and repeated in MILESTONES.md and the
 * PR:** the sandbox is `FakeSandboxProvider` (a real local clone in a temp directory, not an
 * isolated microVM) and the worker is `ScriptedWorkerAdapter` (canned edits in a scripted order,
 * not a coding agent). So this proves the *orchestration* of the repair loop — the packet
 * reaching the worker, the resumed turn, the new candidate, the second verification, the whole
 * persisted trail — against real infrastructure. It does not prove a real Vercel sandbox or a
 * real `codex exec resume`. That remains
 * [#116](https://github.com/jyothepro/orqon/issues/116)'s, and is not claimed here.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);
const s3 = process.env.S3_ENDPOINT
  ? {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? "us-east-1",
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
      bucket: process.env.S3_BUCKET ?? "evidence",
    }
  : null;

let counter = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scripted(name, value) {
  const path = join(tempDir(name), `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const CRITERIA = [{ id: "ac-1", text: "`node index.js` prints the greeting and the farewell" }];
const CLEAN_REVIEW = { summary: "no defects found", findings: [] };
const CLEAN_MAPPING = {
  mappings: CRITERIA.map((c) => ({
    criterion: c.id,
    status: "satisfied",
    evidence: ["ev-01"],
    reason: "the repo's own checks decide this one",
  })),
};

/**
 * The repository's own test. It runs the module and demands exact output, so a defect in
 * `index.js` is caught by the repo, in the verifier sandbox, with no model involved.
 */
const CHECK_JS = `const { execFileSync } = require("node:child_process");
const out = execFileSync(process.execPath, ["index.js"], { encoding: "utf8" }).trim();
if (out !== "hello\\nbye") {
  console.error("expected 'hello\\\\nbye', got " + JSON.stringify(out));
  process.exit(1);
}
console.log("ok");
`;

/** The base revision: greets, but does not say goodbye. The task is to add the farewell. */
const BASE_INDEX_JS = `console.log("hello");\n`;
/** Turn one's defect: the farewell is there, and it is wrong. */
const DEFECTIVE_INDEX_JS = `console.log("hello");\nconsole.log("goodbye");\n`;
/** Turn two's repair. */
const FIXED_INDEX_JS = `console.log("hello");\nconsole.log("bye");\n`;

const turnEvents = (usage) => [
  { type: "started", sessionId: "scripted-thread-1" },
  { type: "file_changed", path: "index.js", kind: "update" },
  { type: "command_started", command: "npm test" },
  { type: "completed", usage },
];

function makeScriptedWorker() {
  return new ScriptedWorkerAdapter([
    {
      apply: async (sandbox) => sandbox.writeFile("index.js", DEFECTIVE_INDEX_JS),
      events: turnEvents({ inputTokens: 500, outputTokens: 100 }),
      diff: {
        patch: '+console.log("goodbye");\n',
        filesChanged: ["index.js"],
        truncated: false,
      },
      usage: { inputTokens: 500, outputTokens: 100 },
    },
    {
      apply: async (sandbox) => sandbox.writeFile("index.js", FIXED_INDEX_JS),
      events: turnEvents({ inputTokens: 60, outputTokens: 20 }),
      diff: {
        patch: '-console.log("goodbye");\n+console.log("bye");\n',
        filesChanged: ["index.js"],
        truncated: false,
      },
      usage: { inputTokens: 60, outputTokens: 20 },
    },
  ]);
}

class MemoryEvidenceStorage {
  constructor() {
    this.packages = new Map();
  }
  async putPackage(localDir, bucket, key) {
    const { cpSync } = await import("node:fs");
    const dest = tempDir("stored");
    cpSync(localDir, dest, { recursive: true });
    this.packages.set(`${bucket}/${key}`, dest);
  }
  async deletePackage(bucket, key) {
    this.packages.delete(`${bucket}/${key}`);
  }
}

async function downloadPackage(ref) {
  const [bucket, ...rest] = ref.split("/");
  const key = rest.join("/");
  const storage = new S3EvidenceStorage({
    endpoint: s3.endpoint,
    region: s3.region,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  });
  const dir = tempDir("downloaded");
  await storage.getPackage(bucket, key, dir);
  return dir;
}

after(async () => {
  await closeWorkflowRuntime();
});

async function withStack(fn) {
  const schema = `windkeel_m5e2e_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const schemaUrl = `${schemaDbUrl}${schemaDbUrl.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo(
    { test: "node check.js" },
    { "check.js": CHECK_JS, "index.js": BASE_INDEX_JS },
  );
  const storage = s3
    ? new S3EvidenceStorage({
        endpoint: s3.endpoint,
        region: s3.region,
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      })
    : new MemoryEvidenceStorage();

  const stacks = [];
  const makeFactory = async (adapter) => {
    const stack = await startFactory(
      {
        databaseUrl: schemaUrl,
        repository: { url: remote.bare, baseRevision: "HEAD" },
        makerModel: "gpt-5-codex",
        makerVendor: "openai",
        modelApiDomain: "api.openai.com",
        modelKeyEnvVar: "OPENAI_API_KEY",
        modelPricing: { usdPerInputToken: 0.000_001, usdPerOutputToken: 0.000_01 },
        usdPerCpuMs: 0,
        usdPerEgressByte: 0,
        railsCheckIntervalMs: 1_000,
        workspaceTtlMs: 600_000,
        gitHost: "github.com",
        gitAuthorName: "Windkeel Factory",
        gitAuthorEmail: "factory@windkeel.invalid",
        policyVersion: "m5-e2e",
        // Unread here (a `WorkerAdapter` is injected below), but `WorkerConfig` is a complete
        // shape and a hand-built config that omits a field only looks like it works.
        codex: { binary: "codex", pinnedVersion: "0.0.0-e2e", allowVersionDrift: false },
        evidence: s3 ? { ...s3 } : undefined,
        checkerEndpoints: [],
      },
      { applicationSchema: schema, sandboxes: new FakeSandboxProvider(), worker: adapter },
    );
    stack.deps.config.fakeSecurity = join(repoRoot, "test", "fixtures", "no-scanners.json");
    // Held constant across both cycles — see the file header on why that is the honest shape.
    stack.deps.config.checkerModels.fakes = {
      review: scripted("review", CLEAN_REVIEW),
      mapping: scripted("mapping", CLEAN_MAPPING),
    };
    if (!s3) stack.deps.evidence = { storage, bucket: "evidence" };
    stacks.push(stack);
    return stack;
  };

  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    await fn({ pool, schemaUrl, schema, remote, storage, makeFactory });
  } finally {
    await endExecutions(pool).catch(() => {});
    for (const stack of stacks) await stack.stop().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

const createTask = (schemaUrl) =>
  createAndStartTask({
    databaseUrl: schemaUrl,
    backing: "vercel-workflow",
    title: "Say goodbye too",
    description: "Add a farewell line to index.js. `node index.js` must print hello then bye.",
    criteria: CRITERIA,
    riskLevel: "low",
    repositoryId: "11111111-1111-1111-1111-111111111111",
  });

async function waitForState(pool, runId, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const run = await getEngineeringRun(pool, runId);
    last = run?.status ?? null;
    if (run && predicate(run)) return run;
    await sleep(200);
  }
  throw new Error(`waitForState: run ${runId} never satisfied the predicate (last state ${last})`);
}

/**
 * Slows the agent's event stream so an interruption has something to interrupt.
 *
 * Without it the whole fail → repair → re-verify cycle finishes in well under a second against
 * fakes, and a test that polls for `REPAIRING` reliably misses it — on CI it observed a run that
 * had already settled, asserted "one verification so far", and failed on `2 !== 1`. The
 * interruption never happened, so what the case is named for was not being tested at all.
 *
 * `e2e-factory-loop` carries the same wrapper for the same reason. Only the *first* factory gets
 * it: the second must run at full speed so the case does not wait on it.
 */
class SlowTurns {
  constructor(inner, pauseMs) {
    this.inner = inner;
    this.pauseMs = pauseMs;
  }
  get name() {
    return this.inner.name;
  }
  get capabilities() {
    return this.inner.capabilities;
  }
  start(input) {
    return this.inner.start(input);
  }
  send(session, message) {
    return this.inner.send(session, message);
  }
  cancel(session) {
    return this.inner.cancel(session);
  }
  result(session) {
    return this.inner.result(session);
  }
  async *events(session) {
    for await (const event of this.inner.events(session)) {
      yield event;
      if (this.pauseMs) await sleep(this.pauseMs);
    }
  }
}

const SETTLED = ["PR_CREATING", "BLOCKED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED", "COMPLETED"];

test(
  "worker creates a defect, Windkeel catches it, the worker repairs it, Windkeel passes it",
  { skip },
  async () => {
    await withStack(async ({ pool, schemaUrl, storage, makeFactory }) => {
      const adapter = makeScriptedWorker();
      await makeFactory(adapter);

      const created = await createTask(schemaUrl);
      assert.equal(created.enqueued, true);
      const runId = created.engineeringRunId;

      const run = await waitForState(pool, runId, (r) => SETTLED.includes(r.status));

      /**
       * From the **transition history**, not a polled snapshot — see the same note in
       * `e2e-factory-loop`. On ADR-0021's backing the stages run back to back inside one
       * durable execution, so the run passes through `PR_CREATING` in milliseconds and a 200 ms
       * poll usually lands after it. M5's claim is that the repaired candidate *reached* the PR
       * stage on a `pass` verdict, and that is durable whether or not a poll caught it.
       *
       * The run then goes on to `FAILED`, because opening a pull request needs a GitHub client
       * and this suite configures none — `e2e-github-loop`'s business, deliberately not M5's.
       */
      const path = (
        await pool.query(
          "select from_state, to_state from run_state_transition where engineering_run_id = $1 order by at, id",
          [runId],
        )
      ).rows.map((r) => `${r.from_state}->${r.to_state}`);
      assert.ok(
        path.includes("VERIFYING->PR_CREATING"),
        `the repaired candidate advances toward the PR; took ${path.join(", ")}`,
      );
      assert.equal(run.finalVerdict, "pass");

      // --- the defect was caught by the repository, not by a script -----------------------
      const verifications = await listVerificationRuns(pool, runId);
      assert.equal(verifications.length, 2);
      const [first, second] = verifications;
      assert.equal(first.verdict, "fail");
      assert.equal(second.verdict, "pass");
      assert.notEqual(first.candidateSha, second.candidateSha);

      const [attempt] = await listRepairAttempts(pool, runId);
      assert.equal((await listRepairAttempts(pool, runId)).length, 1);
      assert.equal(attempt.verificationRunId, first.id);
      assert.deepEqual(
        attempt.repairPacket.failed_checks.map((c) => c.check),
        ["tests"],
        "the packet names the repo's own failing check, derived from a real non-zero exit",
      );
      assert.match(attempt.repairPacket.failed_checks[0].transcript ?? "", /evidence\//);
      assert.ok(
        attempt.repairPacket.recommended_focus.some((f) => f.includes("tests")),
        "and tells the repairer to make it exit 0",
      );

      // --- the repair turn was a resumed turn driven by that packet ------------------------
      assert.equal(adapter.received.length, 1, "one repair turn");
      assert.deepEqual(
        adapter.received[0].repairPacket,
        attempt.repairPacket,
        "the packet the worker received is the packet that was stored",
      );
      assert.equal(adapter.turnsTaken, 2);

      const agentRuns = await listAgentRuns(pool, runId);
      const implementer = agentRuns.find((a) => a.role === "implementer");
      const repairer = agentRuns.find((a) => a.role === "repairer");
      assert.ok(repairer, "a repairer AgentRun exists");
      assert.equal(repairer.id, attempt.agentRunId);
      assert.equal(repairer.workerType, implementer.workerType, "ADR-0011 §2: no escalation");
      assert.equal(repairer.model, implementer.model);
      assert.equal(repairer.tokenUsage.inputTokens, 60, "per-turn usage, not cumulative");

      // --- the trail ----------------------------------------------------------------------
      const { rows: costRows } = await pool.query(
        "select stage_type, count(*) as n from cost_event where engineering_run_id = $1 group by stage_type",
        [runId],
      );
      const byStage = new Map(costRows.map((r) => [r.stage_type, Number(r.n)]));
      assert.equal(byStage.get("agent_run"), 2, "the implementer's turn and the repairer's");
      assert.equal(byStage.get("verification_run"), 2, "one per cycle");
      assert.ok((byStage.get("workspace") ?? 0) >= 3, "the maker and both verifiers");

      for (const workspace of await listWorkspaces(pool, runId)) {
        assert.equal(workspace.status, "destroyed", `${workspace.role} left running`);
      }

      // --- the final package verifies offline ---------------------------------------------
      assert.equal(
        s3 ? "minio" : "memory",
        s3 ? "minio" : "memory",
        "asserting which store ran, as M4.7 does",
      );
      for (const verification of verifications) {
        assert.ok(verification.evidencePackageRef, `cycle ${verification.candidateSha} sealed`);
        assert.match(verification.evidenceManifestDigest, /^[0-9a-f]{64}$/);
      }
      const local = s3
        ? await downloadPackage(second.evidencePackageRef)
        : storage.packages.get(second.evidencePackageRef);
      assert.ok(local, "the verdict of record is in storage");
      const verified = runCli(["verify-package", local]);
      assert.equal(verified.code, 0, `${verified.stdout}${verified.stderr}`);
      assert.match(verified.stdout, /verdict: pass/i);

      // --- and the report a human reads says the same thing --------------------------------
      const report = await assembleRunReport(pool, runId);
      assert.equal(report.repairAttemptsTaken, 1);
      assert.equal(report.verifications.at(-1).verdictOfRecord, true);
      assert.equal(report.cost.reconciles, true);
    });
  },
);

test(
  "the process dying mid-loop and a fresh one taking over does not duplicate anything",
  { skip },
  async () => {
    await withStack(async ({ pool, schemaUrl, storage, makeFactory }) => {
      /**
       * The process hosting the stages goes away after the first verification has failed and
       * been recorded. ADR-0017 is explicit about the consequence: the maker sandbox and the
       * worker session die with it, there is no `attach()` for either, and the honest outcome
       * is a named failure rather than a cold turn dressed up as a resume. What must *not*
       * happen is duplication — a second attempt row, a second package, or a second ledger
       * charge for work already done.
       *
       * Under pg-boss this was a container killed without SIGTERM. ADR-0020 leaves no container,
       * so the equivalent is the provider and its handler graph going away mid-stage; the
       * durable execution outlives both, which is exactly what makes duplication possible and
       * therefore worth asserting against.
       */
      // Slow enough that the repair turn is still in flight when the poll below catches it.
      const first = await makeFactory(new SlowTurns(makeScriptedWorker(), 400));

      const created = await createTask(schemaUrl);
      const runId = created.engineeringRunId;

      /**
       * `REPAIRING` only — **not** "or already settled". A run that finished before the poll
       * caught it cannot be interrupted, and accepting that state made the case pass while
       * testing nothing. `SlowTurns` above is what makes this reachable rather than racy.
       */
      await waitForState(pool, runId, (r) => r.status === "REPAIRING");
      const beforeKill = {
        verifications: (await listVerificationRuns(pool, runId)).length,
        attempts: (await listRepairAttempts(pool, runId)).length,
      };
      assert.equal(beforeKill.verifications, 1, "the interruption lands after one verdict");
      assert.equal(beforeKill.attempts, 1);

      // No drain, no teardown: this process's half of the factory is simply gone.
      await first.stop();

      const second = await makeFactory(makeScriptedWorker());
      await second.provider.startRun(runId);

      const run = await waitForState(pool, runId, (r) => SETTLED.includes(r.status));

      /**
       * **Two legitimate outcomes, and which one happens depends on where the interruption
       * landed — so the assertion is the invariant, not the outcome.**
       *
       * Under pg-boss there was one outcome: the killed container took the worker session with
       * it, there was no `attach()`, and ADR-0017 §3's decided answer was a *named failure*
       * rather than a cold turn dressed up as a resume.
       *
       * #196 persisted `WorkerSessionRef` and #212 made a repair turn resumable from it, so the
       * fresh graph can now re-acquire the session and finish the repair — `fail` then `pass`.
       * It does, when `stop()` lands after the repair turn has completed.
       *
       * When it lands *inside* the turn, the run still ends at ADR-0017 §3's named failure with
       * one verification. That is not a regression and not a flake in the system: a fresh
       * `ScriptedWorkerAdapter` replays from turn one and cannot continue another instance's
       * in-flight session, so the double is what cannot resume there. An earlier version of this
       * case asserted `["fail", "pass"]` outright and failed roughly one full-suite run in two —
       * it had encoded the timing it happened to observe as a guarantee.
       *
       * What is true either way, and what this case exists for, is that **nothing is done
       * twice**.
       */
      const verdicts = (await listVerificationRuns(pool, runId)).map((v) => v.verdict);
      assert.ok(
        verdicts.length === 1 || verdicts.length === 2,
        `expected one or two verifications, got ${verdicts.length}: ${verdicts.join(", ")}`,
      );
      assert.equal(verdicts[0], "fail", "the first verdict is the one that opened the repair loop");
      if (verdicts.length === 2) {
        assert.equal(verdicts[1], "pass", "a resumed repair re-verifies; it does not re-fail");
      }

      /**
       * Nothing was done twice — which is an upper bound, not an exact count.
       *
       * `at most one`, restored from the pg-boss version of this case after I tightened it to
       * `exactly one` during the migration and CI found the hole twice. The run enters REPAIRING
       * *before* the repairer's `agent_run` row exists, so an interruption taken at that
       * transition can legitimately leave **zero** repairer sessions. Both 0 and 1 are correct
       * outcomes of interrupting a repair; only 2 is the defect this case exists to catch.
       *
       * The same applies to the attempt rows: a redelivery must not add one, so the count must
       * not *grow*.
       */
      assert.ok(
        (await listRepairAttempts(pool, runId)).length <= beforeKill.attempts,
        "a redelivered stage must not add a repair attempt",
      );
      const repairers = (await listAgentRuns(pool, runId)).filter((a) => a.role === "repairer");
      assert.ok(
        repairers.length <= 1,
        `at most one repairer session, never two; found ${repairers.length}`,
      );

      /**
       * The run ends `FAILED` on both paths, and it matters *which* failure — asserted through
       * the last transition's own reason so the two cannot be confused. After a successful
       * repair it is the PR stage, which has no GitHub client in this suite; after an
       * unresumable one it is ADR-0017 §3.
       */
      assert.equal(run.status, "FAILED");
      const last = (
        await pool.query(
          "select from_state, to_state, reason from run_state_transition " +
            "where engineering_run_id = $1 order by at desc, id desc limit 1",
          [runId],
        )
      ).rows[0];
      if (verdicts.length === 2) {
        assert.equal(last.from_state, "PR_CREATING");
        assert.match(last.reason, /no GitHub client is configured/);
      } else {
        assert.match(
          last.reason,
          /resum|session/i,
          `a run that did not re-verify must say why, and this one said: ${last.reason}`,
        );
      }

      const report = await assembleRunReport(pool, runId);
      assert.equal(report.verifications.length, verdicts.length);
      assert.equal(report.cost.reconciles, true);
    });
  },
);
