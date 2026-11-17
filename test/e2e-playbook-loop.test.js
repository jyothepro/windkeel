/**
 * A task filed under a playbook, through the whole factory loop (#390, ADR-0033).
 *
 * The real `VercelWorkflowProvider`, real Postgres and the real verification engine; the sandbox
 * and worker are fakes (as in `e2e-factory-loop`). What it proves:
 *
 * 1. The maker's prompt carries the playbook's `## Playbook:` section, the playbook's extra check
 *    runs in the verifier as `playbook.<name>`, and the sealed manifest records the playbook.
 * 2. A failing playbook check fails the gate and sends the run to repair exactly as a failing
 *    repository check does — no special path.
 * 3. The repository's own base-revision check still runs beside the playbook's: base preserved.
 * 4. The playbook edited after the task was filed changes nothing: the run uses its snapshot.
 */

import assert from "node:assert/strict";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import { getEngineeringRun, getEngineeringTask, listVerificationRuns } from "../dist/factory/repositories.js";
import { createPlaybook, snapshotPlaybook, updatePlaybook } from "../dist/factory/playbooks.js";
import { assembleRunReport, renderRunReport } from "../dist/factory/run-report.js";
import { renderEvidenceSummary } from "../dist/github/summary.js";
import { createAndStartTask } from "./start-task.js";
import { bareFixtureRepo, repoRoot, runCli, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { startFactory } from "./factory-stack.js";
import { closeWorkflowRuntime, endExecutions, runtimeSkip } from "./workflow-runtime.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;

const CRITERIA = [{ id: "ac-1", text: "the module keeps passing its own tests" }];
const MAPPING = {
  mappings: ["ac-1", "PB1"].map((criterion) => ({
    criterion,
    status: "satisfied",
    evidence: ["ev-01"],
    reason: "the checks pass on the candidate",
  })),
};
const STREAM = [
  { type: "started", sessionId: "sess-pb" },
  { type: "file_changed", path: "index.js", kind: "update" },
  { type: "completed", usage: { inputTokens: 500, outputTokens: 100 } },
];

function scripted(name, value) {
  const path = join(tempDir(name), `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/** Edits the checkout so there is a real candidate, and keeps the fake's record of the prompt. */
class MutatingWorkerAdapter {
  constructor(inner) {
    this.inner = inner;
  }
  get name() {
    return this.inner.name;
  }
  get capabilities() {
    return this.inner.capabilities;
  }
  get calls() {
    return this.inner.calls;
  }
  async start(input) {
    await input.sandbox.writeFile("index.js", `console.log('hello ${Math.random()}');\n`);
    return this.inner.start(input);
  }
  send(s, m) {
    return this.inner.send(s, m);
  }
  cancel(s) {
    return this.inner.cancel(s);
  }
  events(s) {
    return this.inner.events(s);
  }
  async result(s) {
    const result = await this.inner.result(s);
    if (result.outcome !== "completed") return result;
    return { ...result, diff: { patch: "+console.log('hello');\n", filesChanged: ["index.js"], truncated: false } };
  }
}

class MemoryEvidenceStorage {
  constructor() {
    this.packages = new Map();
  }
  async putPackage(localDir, bucket, key) {
    const dest = tempDir("stored");
    cpSync(localDir, dest, { recursive: true });
    this.packages.set(`${bucket}/${key}`, dest);
  }
  async deletePackage(bucket, key) {
    this.packages.delete(`${bucket}/${key}`);
  }
  async getPackageFile(bucket, key, path) {
    return readFileSync(join(this.packages.get(`${bucket}/${key}`), path));
  }
}

after(async () => {
  await closeWorkflowRuntime();
});

async function withStack(fn, { files = {} } = {}) {
  const schema = `windkeel_e2e_pb_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const schemaUrl = `${schemaDbUrl}${schemaDbUrl.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "true" }, files);
  const storage = new MemoryEvidenceStorage();
  const worker = new MutatingWorkerAdapter(new FakeWorkerAdapter(STREAM));
  let stack = null;
  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    stack = await startFactory(
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
        policyVersion: "e2e",
        codex: { binary: "codex", pinnedVersion: "0.0.0-e2e", allowVersionDrift: false },
        checkerEndpoints: [],
      },
      { applicationSchema: schema, sandboxes: new FakeSandboxProvider(), worker },
    );
    stack.deps.config.fakeSecurity = join(repoRoot, "test", "fixtures", "no-scanners.json");
    stack.deps.config.checkerModels.fakes = {
      review: scripted("review", { summary: "no defects found", findings: [] }),
      mapping: scripted("mapping", MAPPING),
    };
    stack.deps.evidence = { storage, bucket: "evidence" };
    const { rows } = await pool.query("select id from organization where is_default");
    await fn({ pool, org: rows[0].id, schemaUrl, storage, worker });
  } finally {
    await endExecutions(pool).catch(() => {});
    if (stack) await stack.stop().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

async function file(schemaUrl, playbook) {
  return createAndStartTask({
    databaseUrl: schemaUrl,
    title: "Add a greeting",
    description: "Make index.js print hello.",
    criteria: CRITERIA,
    riskLevel: "high",
    repositoryId: "11111111-1111-1111-1111-111111111111",
    playbook,
  });
}

async function path(pool, runId) {
  const { rows } = await pool.query(
    "select from_state, to_state from run_state_transition where engineering_run_id = $1 order by at, id",
    [runId],
  );
  return rows.map((r) => `${r.from_state}->${r.to_state}`);
}

/** Until the run has left VERIFYING for the first time (or ended), from the transition history. */
async function firstVerdict(pool, runId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const steps = await path(pool, runId);
    const out = steps.find((s) => s.startsWith("VERIFYING->"));
    if (out) return { out, steps };
    const run = await getEngineeringRun(pool, runId);
    if (run && ["FAILED", "CANCELLED", "COMPLETED", "MAX_REPAIR_ATTEMPTS_REACHED"].includes(run.status)) return { out: null, steps };
    await sleep(200);
  }
  throw new Error(`run ${runId} never left VERIFYING (${(await path(pool, runId)).join(", ")})`);
}

/** The first sealed package's manifest and evidence items. */
async function firstPackage(pool, storage, runId) {
  const [verification] = await listVerificationRuns(pool, runId);
  const dir = storage.packages.get(verification.evidencePackageRef);
  assert.ok(dir, `package ${verification.evidencePackageRef} is stored`);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const evidence = readdirSync(join(dir, "evidence"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, "evidence", f), "utf8")));
  return { verification, dir, manifest, evidence };
}

const STRICT = (command) => ({
  slug: "strict-lint",
  name: "Strict lint",
  makerInstructions: "Fix every lint warning you touch.",
  criteria: [{ text: "No new lint warnings" }],
  verifier: { extraChecks: [{ name: "lint-strict", command }] },
});

test("a playbook's check runs in the verifier, its section reaches the maker, and the manifest records it", { skip }, async () => {
  await withStack(async ({ pool, org, schemaUrl, storage, worker }) => {
    const playbook = await createPlaybook(pool, org, STRICT("true"));
    const created = await file(schemaUrl, snapshotPlaybook(playbook));
    const { out, steps } = await firstVerdict(pool, created.engineeringRunId);
    assert.equal(out, "VERIFYING->PR_CREATING", steps.join(", "));

    const start = worker.calls.find((c) => c.type === "start");
    assert.match(start.prompt, /## Playbook: strict-lint \(v1\)\nFix every lint warning you touch\./);
    assert.match(start.prompt, /- \[PB1\] No new lint warnings/);

    const { manifest, evidence, dir, verification } = await firstPackage(pool, storage, created.engineeringRunId);
    assert.equal(verification.verdict, "pass");
    assert.equal(manifest.playbook.slug, "strict-lint");
    assert.equal(manifest.playbook.version, 1);
    assert.equal(manifest.playbook.builtin, false);
    assert.deepEqual(manifest.playbook.added_checks, ["playbook.lint-strict"]);
    assert.deepEqual(manifest.playbook.added_criteria, ["PB1"]);
    const check = evidence.find((e) => e.stage === "checks" && JSON.stringify(e).includes("playbook.lint-strict"));
    assert.ok(check, JSON.stringify(evidence.map((e) => [e.id, e.stage, e.summary])));
    assert.equal(check.status, "passed");
    const intent = JSON.parse(readFileSync(join(dir, "intent.json"), "utf8"));
    assert.deepEqual(intent.criteria.map((c) => c.id), ["ac-1", "PB1"]);
    assert.equal(intent.criteria[1].source.ref, "playbook:strict-lint@1");
    // The report and the PR summary say what the run was held to, on top of the repository's.
    const report = await assembleRunReport(pool, created.engineeringRunId);
    assert.deepEqual(report.playbook, {
      slug: "strict-lint",
      version: 1,
      builtin: false,
      criteria: [{ id: "PB1", text: "No new lint warnings" }],
      verifierAdds: ["run check playbook.lint-strict (`true`)"],
    });
    assert.deepEqual(report.task.criteria.map((c) => c.id), ["ac-1", "PB1"]);
    assert.match(renderRunReport(report), /Playbook\s+strict-lint v1 — also: 1 added criteria; run check playbook\.lint-strict/);
    const summary = renderEvidenceSummary(report);
    assert.match(summary, /### Playbook/);
    assert.match(summary, /can only add to verification/);
    // The package still verifies offline, playbook and all.
    const verified = runCli(["verify-package", dir]);
    assert.equal(verified.code, 0, `${verified.stdout}${verified.stderr}`);
  });
});

test("a failing playbook check fails the gate and goes to repair, like any failing check", { skip }, async () => {
  await withStack(async ({ pool, org, schemaUrl, storage }) => {
    const playbook = await createPlaybook(pool, org, STRICT("exit 1"));
    const created = await file(schemaUrl, snapshotPlaybook(playbook));
    const { out, steps } = await firstVerdict(pool, created.engineeringRunId);
    assert.equal(out, "VERIFYING->REPAIRING", steps.join(", "));
    const { verification, evidence } = await firstPackage(pool, storage, created.engineeringRunId);
    assert.equal(verification.verdict, "fail");
    const check = evidence.find((e) => e.stage === "checks" && JSON.stringify(e).includes("playbook.lint-strict"));
    assert.equal(check.status, "failed");
    assert.ok(check.findings.some((f) => f.severity === "blocking"));
  });
});

test("the repository's base check runs beside the playbook's: nothing of the base is dropped", { skip }, async () => {
  const config = JSON.stringify({ checks: [{ name: "base-check", command: "true" }] });
  await withStack(
    async ({ pool, org, schemaUrl, storage }) => {
      const playbook = await createPlaybook(pool, org, STRICT("true"));
      const created = await file(schemaUrl, snapshotPlaybook(playbook));
      const { out, steps } = await firstVerdict(pool, created.engineeringRunId);
      assert.equal(out, "VERIFYING->PR_CREATING", steps.join(", "));
      const { evidence } = await firstPackage(pool, storage, created.engineeringRunId);
      const checks = evidence.filter((e) => e.stage === "checks").map((e) => JSON.stringify(e));
      assert.ok(checks.some((c) => c.includes("base-check")), "the base revision's own check ran");
      assert.ok(checks.some((c) => c.includes("playbook.lint-strict")), "and the playbook's");
    },
    { files: { "windkeel.config.json": config } },
  );
});

test("editing the playbook after the task was filed changes nothing: the run uses its snapshot", { skip }, async () => {
  await withStack(async ({ pool, org, schemaUrl, storage }) => {
    const playbook = await createPlaybook(pool, org, STRICT("true"));
    const created = await file(schemaUrl, snapshotPlaybook(playbook));
    // The run is started; now edit the playbook to a failing check and a required stage, before it verifies.
    const edited = await updatePlaybook(pool, org, playbook.id, {
      verifier: { extraChecks: [{ name: "lint-strict", command: "exit 1" }], requireStages: ["browser"] },
    });
    assert.equal(edited.version, 2);
    const atEdit = await path(pool, created.engineeringRunId);
    assert.ok(!atEdit.some((s) => s.startsWith("VERIFYING->")), `edited mid-run, before the verdict: ${atEdit.join(", ")}`);

    const { out, steps } = await firstVerdict(pool, created.engineeringRunId);
    assert.equal(out, "VERIFYING->PR_CREATING", steps.join(", "));
    const { manifest, evidence } = await firstPackage(pool, storage, created.engineeringRunId);
    assert.equal(manifest.playbook.version, 1);
    assert.deepEqual(manifest.playbook.required_stages, [], "the edit's requireStages did not reach the run");
    const check = evidence.find((e) => e.type === "playbook.lint-strict_result");
    assert.equal(check?.producer?.command, "true", "the snapshot's command ran, not the edited one");
    const task = await getEngineeringTask(pool, created.taskId);
    assert.equal(task.playbook.version, 1);
    assert.deepEqual(task.playbook.verifier, { extraChecks: [{ name: "lint-strict", command: "true" }] });
  });
});
