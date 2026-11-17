/**
 * #387 end to end: environment snapshots through the real run loop — `VercelWorkflowProvider` on the
 * loopback World, real Postgres, `FakeSandboxProvider`, a scripted worker.
 *
 * 1. Run 1 is cold and records a build request; the build (the stage side's step, called here
 *    directly) makes a ready snapshot.
 * 2. Run 2's maker **and** verifier restore it, run no install command, and reach the same verdict.
 * 3. Run 3's maker edits the lockfile: the verifier restores, sees the change, and reinstalls
 *    without the repository's secrets.
 * 4. A secret is updated: the snapshot is invalidated, and run 4 is cold again.
 * 5. With the flag off there are no snapshot rows and no environment columns set.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import { getEngineeringRun, listVerificationRuns } from "../dist/factory/repositories.js";
import { putRepositorySecret } from "../dist/factory/repository-secrets.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { processSnapshotRequests, secretsFromTable } from "../dist/factory/environment-snapshots.js";
import { assembleRunReport, renderRunReport } from "../dist/factory/run-report.js";
import { createAndStartTask } from "./start-task.js";
import { bareFixtureRepo, repoRoot, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { startFactory } from "./factory-stack.js";
import { closeWorkflowRuntime, endExecutions, runtimeSkip } from "./workflow-runtime.js";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);
const REPO_ID = "11111111-1111-1111-1111-111111111111";
const SECRET = "npm_e2eSnapshotSecret_7Hq2";
const LOCK = JSON.stringify({ name: "fixture", version: "0.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fixture", version: "0.0.0" } } }) + "\n";
const CRITERIA = [{ id: "ac-1", text: "the module keeps passing its own tests" }];
const STREAM = [
  { type: "started", sessionId: "sess-env" },
  { type: "file_changed", path: "index.js", kind: "update" },
  { type: "completed", usage: { inputTokens: 10, outputTokens: 5 } },
];
let counter = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(async () => {
  await closeWorkflowRuntime();
});

/** A maker that edits the checkout: `index.js` always, and the lockfile when told to. */
class EditingWorker {
  constructor() {
    this.inner = new FakeWorkerAdapter(STREAM);
    this.editLockfile = false;
  }
  get name() { return this.inner.name; }
  get capabilities() { return this.inner.capabilities; }
  get calls() { return this.inner.calls; }
  async start(input) {
    await input.sandbox.writeFile("index.js", `console.log(${Date.now()});\n`);
    if (this.editLockfile) await input.sandbox.writeFile("package-lock.json", LOCK + "\n");
    return this.inner.start(input);
  }
  send(s, m) { return this.inner.send(s, m); }
  cancel(s) { return this.inner.cancel(s); }
  events(s) { return this.inner.events(s); }
  async result(s) {
    const result = await this.inner.result(s);
    if (result.outcome !== "completed") return result;
    return { ...result, diff: { patch: "+x\n", filesChanged: ["index.js"], truncated: false } };
  }
}

/** Remembers every handle it creates, so a test can read what ran in it. */
class RecordingProvider extends FakeSandboxProvider {
  constructor() {
    super();
    this.handles = new Map();
  }
  async create(options) {
    const handle = await super.create(options);
    this.handles.set(handle.id, handle);
    return handle;
  }
}

async function withStack(enabled, fn) {
  const schema = `windkeel_e2e_env_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const schemaUrl = `${schemaDbUrl}${schemaDbUrl.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo(
    { test: "true" },
    {
      "package-lock.json": LOCK,
      "windkeel.config.json": JSON.stringify({
        checks: [{ name: "tests", command: "true" }],
        setup: { commands: [{ name: "bootstrap", run: 'test -n "$NPM_TOKEN" && echo ok > .bootstrapped' }], secrets: ["NPM_TOKEN"] },
      }),
    },
  );
  const keys = generateSecretKeyPair();
  const sandboxes = new RecordingProvider();
  const worker = new EditingWorker();
  let stack;
  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    const { rows } = await pool.query("select id from organization where is_default");
    const org = rows[0].id;
    await putRepositorySecret(pool, { organizationId: org, repositoryId: REPO_ID, key: "NPM_TOKEN", value: SECRET, setBy: "op", publicKey: keys.publicKey });
    stack = await startFactory(
      {
        databaseUrl: schemaUrl,
        repository: { url: remote.bare, baseRevision: "HEAD" },
        makerModel: "gpt-5-codex",
        makerVendor: "openai",
        modelApiDomain: "api.openai.com",
        modelKeyEnvVar: "OPENAI_API_KEY",
        modelPricing: { usdPerInputToken: 0, usdPerOutputToken: 0 },
        usdPerCpuMs: 0,
        usdPerEgressByte: 0,
        railsCheckIntervalMs: 1_000,
        workspaceTtlMs: 600_000,
        gitHost: "github.com",
        gitAuthorName: "Windkeel Factory",
        gitAuthorEmail: "factory@windkeel.invalid",
        policyVersion: "e2e",
        secretPrivateKey: keys.privateKey,
        codex: { binary: "codex", pinnedVersion: "0.0.0-e2e", allowVersionDrift: false },
        evidence: undefined,
        checkerEndpoints: [],
        ...(enabled ? { environmentSnapshots: { enabled: true, forVerifier: true, ttlDays: 14 } } : {}),
      },
      { applicationSchema: schema, sandboxes, worker },
    );
    const scripted = (name, value) => {
      const path = join(tempDir(name), `${name}.json`);
      writeFileSync(path, JSON.stringify(value));
      return path;
    };
    stack.deps.config.fakeSecurity = join(repoRoot, "test", "fixtures", "no-scanners.json");
    stack.deps.config.checkerModels.fakes = {
      review: scripted("review", { summary: "no defects found", findings: [] }),
      mapping: scripted("mapping", { mappings: CRITERIA.map((c) => ({ criterion: c.id, status: "satisfied", evidence: ["ev-01"], reason: "checks pass" })) }),
    };

    const runOnce = async () => {
      const created = await createAndStartTask({
        databaseUrl: schemaUrl,
        backing: "vercel-workflow",
        title: "Touch index.js",
        description: "Make index.js log something.",
        criteria: CRITERIA,
        riskLevel: "low",
        repositoryId: REPO_ID,
      });
      const deadline = Date.now() + 90_000;
      for (;;) {
        const run = await getEngineeringRun(pool, created.engineeringRunId);
        const verified = (await listVerificationRuns(pool, created.engineeringRunId)).find((v) => v.verdict);
        if (verified && ["PR_CREATING", "PR_READY", "FAILED", "BLOCKED"].includes(run.status)) {
          const { rows: ws } = await pool.query(
            "select id, role, provider_handle, environment_mode, environment_snapshot_id from workspace where engineering_run_id = $1 order by id",
            [created.engineeringRunId],
          );
          const view = (role) => {
            const row = ws.find((w) => w.role === role);
            return { ...row, handle: sandboxes.handles.get(row.provider_handle) };
          };
          return { runId: created.engineeringRunId, verdict: verified.verdict, verification: verified, maker: view("maker"), verifier: view("verifier") };
        }
        if (Date.now() > deadline) throw new Error(`run ${created.engineeringRunId} stuck at ${run.status}`);
        await sleep(200);
      }
    };
    const build = () =>
      processSnapshotRequests(pool, sandboxes, { secrets: secretsFromTable(pool, [keys.privateKey]), ttlDays: 14 });
    await fn({ pool, org, keys, worker, runOnce, build, remote });
  } finally {
    await endExecutions(pool).catch(() => {});
    await stack?.stop().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

const npmExecs = (handle) => handle.calls.filter((c) => c.type === "exec" && c.command === "npm");

test("cold, then warm for maker and verifier, a lockfile edit reinstalls without secrets, a secret rotation goes cold", { skip, timeout: 600_000 }, async () => {
  await withStack(true, async ({ pool, org, keys, worker, runOnce, build, remote }) => {
    // 1. Cold, and a build is requested.
    const first = await runOnce();
    assert.equal(first.maker.environment_mode, "cold");
    assert.equal(first.verifier.environment_mode, "cold");
    assert.ok(npmExecs(first.maker.handle).length > 0, "a cold maker installs");
    const { rows: requests } = await pool.query("select reason from environment_snapshot_request");
    assert.equal(requests.length, 1);
    const [built] = await build();
    assert.equal(built.status, "ready", JSON.stringify(built));
    const snapshotId = built.snapshot.id;

    // 2. Warm, both roles, no install, same verdict.
    const second = await runOnce();
    for (const role of ["maker", "verifier"]) {
      const w = second[role];
      assert.equal(w.environment_mode, "snapshot", role);
      assert.equal(w.environment_snapshot_id, snapshotId, role);
      assert.deepEqual(w.handle.calls[0], { type: "create", fromSnapshot: built.snapshot.providerSnapshotId });
      assert.deepEqual(npmExecs(w.handle), [], `the ${role}'s SandboxCallRecord shows no install command`);
    }
    assert.equal(second.verdict, first.verdict, "the warm verdict is the cold verdict");
    const tree = spawnSync("git", ["ls-tree", "-r", "--name-only", second.verification.candidateSha], { cwd: remote.bare, encoding: "utf8" });
    assert.equal(tree.status, 0, tree.stderr);
    assert.ok(!tree.stdout.split("\n").includes(".bootstrapped"), "setup's output never lands in a candidate");
    assert.equal(second.verification.riskSummary.environment.mode, "snapshot");
    // The snapshot was never taken from a sandbox any workspace row names.
    const { rows: named } = await pool.query("select count(*)::int as n from workspace where provider_handle = any($1)", [
      [...(await pool.query("select provider_snapshot_id from environment_snapshot")).rows.map((r) => r.provider_snapshot_id)],
    ]);
    assert.equal(named[0].n, 0);
    const report = renderRunReport(await assembleRunReport(pool, second.runId));
    assert.match(report, /Environment\s+(maker|verifier) warm \(snapshot [0-9a-f]{8}\), (maker|verifier) warm \(snapshot [0-9a-f]{8}\)/);

    // 3. The maker edits the lockfile: the verifier restores, then reinstalls without the secret.
    worker.editLockfile = true;
    const third = await runOnce();
    worker.editLockfile = false;
    assert.equal(third.verifier.environment_mode, "snapshot");
    const reinstall = npmExecs(third.verifier.handle);
    assert.ok(reinstall.length > 0, "the changed lockfile is installed again");
    for (const exec of reinstall) assert.equal(exec.options.env?.NPM_TOKEN, undefined, "without the repository's secrets");
    assert.deepEqual(third.verification.riskSummary.environment.installInputChanges, ["package-lock.json"]);

    // 4. A secret changes: invalidated, and the next run is cold.
    await putRepositorySecret(pool, { organizationId: org, repositoryId: REPO_ID, key: "NPM_TOKEN", value: `${SECRET}-rotated`, setBy: "op", publicKey: keys.publicKey });
    const { rows: statuses } = await pool.query("select status from environment_snapshot where id = $1", [snapshotId]);
    assert.equal(statuses[0].status, "invalidated");
    const fourth = await runOnce();
    assert.equal(fourth.maker.environment_mode, "cold");
    assert.equal(fourth.verifier.environment_mode, "cold");
  });
});

test("with the flag off there are no snapshot rows, requests or environment columns", { skip, timeout: 300_000 }, async () => {
  await withStack(false, async ({ pool, runOnce }) => {
    const run = await runOnce();
    assert.equal(run.maker.environment_mode, null);
    assert.equal(run.verifier.environment_mode, null);
    assert.equal(run.verification.riskSummary.environment, undefined);
    for (const table of ["environment_snapshot", "environment_snapshot_request"]) {
      const { rows } = await pool.query(`select count(*)::int as n from ${table}`);
      assert.equal(rows[0].n, 0, table);
    }
    assert.doesNotMatch(renderRunReport(await assembleRunReport(pool, run.runId)), /Environment/);
  });
});
