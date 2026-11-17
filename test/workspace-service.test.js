import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import {
  getWorkspace,
  insertEngineeringRun,
  insertEngineeringTask,
} from "../dist/factory/repositories.js";
import { sumCostEvents } from "../dist/factory/cost-ledger.js";
import { provisionWorkspace, teardownWorkspace } from "../dist/factory/workspace-service.js";
import { fixtureRepo, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

/** One schema per test file run, migrated once, torn down at the end. */
async function withSchema(fn) {
  const schema = `windkeel_workspace_service_test_${Date.now()}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    await fn(pool);
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

function newTask(overrides = {}) {
  return {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "github_issue",
    sourceReference: "102",
    title: "Wire SandboxProvider into workspace persistence",
    description: "Provision and tear down sandboxes for workspaces.",
    acceptanceCriteria: [{ id: "c1", text: "workspace-service works", source: { kind: "explicit", ref: "" } }],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
    ...overrides,
  };
}

async function newRun(pool) {
  const task = await insertEngineeringTask(pool, newTask());
  return insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
}

function headSha(repoDir) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" });
  return result.stdout.trim();
}

/** A test-only stub provider whose create() always rejects. */
class ThrowingSandboxProvider {
  name = "throwing-stub";
  capabilities = { credentialBrokering: false, phasedEgress: false };
  async create() {
    throw new Error("stub provider always fails");
  }
}

/** A test-only stub handle with fixed, nonzero usage figures. */
class StubSandboxHandle {
  id = "stub-handle-1";
  role = "maker";
  usageValue;
  destroyThrows;
  destroyed = false;

  constructor({ usageValue, destroyThrows = false } = {}) {
    this.usageValue = usageValue ?? { activeCpuMs: 1000, wallClockMs: 1000, networkEgressBytes: 2_000_000 };
    this.destroyThrows = destroyThrows;
  }

  async usage() {
    return this.usageValue;
  }

  async destroy() {
    if (this.destroyThrows) throw new Error("stub destroy failed");
    this.destroyed = true;
  }
}

test("provisionWorkspace inserts a workspace row, calls the fake provider, and ends ready", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await newRun(pool);
    const repoDir = fixtureRepo({});
    const provider = new FakeSandboxProvider();

    const { workspace } = await provisionWorkspace(pool, provider, {
      engineeringRunId: run.id,
      role: "maker",
      repository: repoDir,
      baseSha: headSha(repoDir),
    });

    assert.equal(workspace.status, "ready");
    assert.equal(workspace.sandboxProvider, "fake");
    assert.ok(workspace.providerHandle, "providerHandle should be set to the fake handle's id");
    assert.match(workspace.providerHandle, /^fake-maker-/);

    const refetched = await getWorkspace(pool, workspace.id);
    assert.equal(refetched.status, "ready");
    assert.equal(refetched.providerHandle, workspace.providerHandle);
  });
});

test("a provider whose create() rejects leaves the workspace failed and rethrows", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await newRun(pool);
    const provider = new ThrowingSandboxProvider();

    await assert.rejects(
      provisionWorkspace(pool, provider, {
        engineeringRunId: run.id,
        role: "maker",
        repository: "https://example.invalid/repo.git",
        baseSha: "deadbeef",
      }),
      /stub provider always fails/,
    );

    // The workspace row was inserted before the provider call, so we can find it and confirm
    // it landed in "failed".
    const { rows } = await pool.query(
      "select * from workspace where engineering_run_id = $1",
      [run.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "failed");
  });
});

test("teardownWorkspace destroys the handle, records one cost_event, and marks destroyed", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await newRun(pool);
    const repoDir = fixtureRepo({});
    const provider = new FakeSandboxProvider();
    const { workspace } = await provisionWorkspace(pool, provider, {
      engineeringRunId: run.id,
      role: "verifier",
      repository: repoDir,
      baseSha: headSha(repoDir),
    });

    const handle = new StubSandboxHandle({
      usageValue: { activeCpuMs: 5000, wallClockMs: 61_000, networkEgressBytes: 1_000_000 },
    });
    const usdPerCpuMs = 0.0001;
    const usdPerEgressByte = 0.000_000_01;

    await teardownWorkspace(pool, handle, workspace.id, run.id, usdPerCpuMs, usdPerEgressByte);

    assert.equal(handle.destroyed, true);

    const { rows } = await pool.query(
      "select * from cost_event where engineering_run_id = $1",
      [run.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stage_type, "workspace");
    assert.equal(rows[0].stage_id, workspace.id);
    assert.equal(rows[0].kind, "sandbox");
    const expectedUsd = 5000 * usdPerCpuMs + 1_000_000 * usdPerEgressByte;
    assert.equal(Number(rows[0].usd), expectedUsd);
    assert.equal(Number(rows[0].sandbox_ms), 61_000, "#439: credits price the sandbox's wall clock, start to stop, not its CPU time");

    const refetched = await getWorkspace(pool, workspace.id);
    assert.equal(refetched.status, "destroyed");

    const total = await sumCostEvents(pool, run.id);
    assert.equal(total, expectedUsd);
  });
});

test("teardownWorkspace against a handle whose destroy() throws marks teardown_failed and records no cost", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await newRun(pool);
    const repoDir = fixtureRepo({});
    const provider = new FakeSandboxProvider();
    const { workspace } = await provisionWorkspace(pool, provider, {
      engineeringRunId: run.id,
      role: "maker",
      repository: repoDir,
      baseSha: headSha(repoDir),
    });

    const handle = new StubSandboxHandle({ destroyThrows: true });

    await assert.rejects(
      teardownWorkspace(pool, handle, workspace.id, run.id, 0.0001, 0.00000001),
      /stub destroy failed/,
    );

    const refetched = await getWorkspace(pool, workspace.id);
    assert.equal(refetched.status, "teardown_failed");

    const { rows } = await pool.query(
      "select * from cost_event where engineering_run_id = $1",
      [run.id],
    );
    assert.equal(rows.length, 0);

    const total = await sumCostEvents(pool, run.id);
    assert.equal(total, 0);
  });
});

/**
 * #219: the install phase is where a binary can be installed at all — between `create()`, which
 * applies `installPhasePolicy`, and the first `runInExecutionPhase`, which narrows egress for
 * good. These assert that `provisionWorkspace` reports what it did there, and that it does not
 * touch the policy while doing it.
 */

test("a repo's `tools` declaration is honoured in the install phase, and refusals are reported", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await newRun(pool);
    // A declaration that is not a package name never reaches a package manager, so this asserts
    // the reporting path with no network and no install.
    const repoDir = fixtureRepo({}, {
      "windkeel.config.json": JSON.stringify({ tools: ["https://evil.example.com/tool.sh"] }),
    });
    const provider = new FakeSandboxProvider();

    const { handle, tools } = await provisionWorkspace(pool, provider, {
      engineeringRunId: run.id,
      role: "verifier",
      repository: repoDir,
      baseSha: headSha(repoDir),
    });

    try {
      assert.equal(tools.length, 1);
      assert.equal(tools[0].status, "rejected");
      assert.match(tools[0].detail, /never URLs or commands/);
      /*
       * ADR-0014 §3, as amended 2026-09-24. This used to assert *zero* policy changes, on the
       * reasoning that "the install phase is a phase, not a policy change". That stopped being true
       * when §5 put a repository's own credential into this phase's environment: the allowlist is now
       * derived from the repository, so provisioning narrows it exactly once, before the install runs.
       *
       * The assertion is therefore stronger rather than merely different — one narrowing, and it is
       * the derived one. This fixture declares no lockfile, so the registry hosts must be absent;
       * a policy that still carried them would be the old fixed eighteen-host list.
       */
      const policies = handle.calls.filter((c) => c.type === "policy");
      assert.equal(policies.length, 1, "the install phase narrows once, and only once");
      const domains = policies[0].policy.allowedDomains;
      assert.ok(domains.includes("github.com"));
      assert.ok(
        !domains.includes("registry.npmjs.org"),
        "a checkout with no lockfile has no business reaching a package registry",
      );
      // The declared tool is refused, but the archives are open: the decision is made before the
      // declaration is read, because re-widening mid-phase is the ordering failure ADR-0014 forbids.
      assert.ok(domains.includes("deb.debian.org"));
    } finally {
      await handle.destroy();
    }
  });
});

test("a caller that installs nothing gets no tool report at all, rather than an empty claim", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await newRun(pool);
    const repoDir = fixtureRepo({});
    const provider = new FakeSandboxProvider();

    const { handle, tools } = await provisionWorkspace(pool, provider, {
      engineeringRunId: run.id,
      role: "maker",
      repository: repoDir,
      baseSha: headSha(repoDir),
      installDeclaredTools: false,
    });

    try {
      assert.equal(tools, undefined, "`undefined` means nobody tried; `[]` would mean nothing was needed");
    } finally {
      await handle.destroy();
    }
  });
});

/**
 * The wiring for the gate, asserted where the decision is actually made.
 *
 * `installScanners` and `installDeclaredTools` have their own tests for *what* they do when told
 * the filesystem is not the sandbox's. This one asserts that `provisionWorkspace` asks — because
 * the defect was never in those functions, it was that nobody consulted
 * `provider.capabilities.isolatedFilesystem` before calling them, and `FakeSandboxProvider`
 * executes through `spawnSync` on the machine running the factory.
 */
test("provisioning asks the provider whether a sandbox is a sandbox before installing binaries", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await newRun(pool);
    const repoDir = fixtureRepo({}, {
      "windkeel.config.json": JSON.stringify({ tools: ["restic"] }),
    });
    const provider = new FakeSandboxProvider();
    assert.equal(
      provider.capabilities.isolatedFilesystem,
      false,
      "the fake provider must keep saying so honestly — this whole test rests on it",
    );

    const { handle, tools, scannerAssetDir } = await provisionWorkspace(pool, provider, {
      engineeringRunId: run.id,
      role: "verifier",
      repository: repoDir,
      baseSha: headSha(repoDir),
      installScanners: true,
    });

    try {
      // The scanners were asked for and every one is reported as not installed...
      const engine = tools.filter((t) => t.source === "engine");
      assert.equal(engine.length, 3);
      for (const install of engine) {
        assert.equal(install.status, "failed");
        assert.match(install.detail, /isolatedFilesystem is false/);
      }
      // ...as is the tool the repository declared, so a reader of the evidence is never told a
      // binary is present that is not.
      const declared = tools.find((t) => t.source === "repository");
      assert.equal(declared.tool, "restic");
      assert.equal(declared.status, "failed");

      // Nothing was fetched, so there is no asset directory to hand the engine — which is how
      // the security stage knows to use the network forms and say it could not complete.
      assert.equal(scannerAssetDir, undefined);

      // The load-bearing assertion, and the reason this test exists: not one of the commands
      // that would have changed this machine was ever run. The fake handle executes through
      // `spawnSync`, so a recorded call here is a real command on the developer's laptop.
      const ran = handle.calls
        .filter((c) => c.type === "exec")
        .map((c) => c.command);
      for (const command of ["curl", "install", "pip", "pip3", "apt-get", "dnf", "apk", "sudo"]) {
        assert.ok(!ran.includes(command), `provisioning ran \`${command}\` on the host: ${ran.join(", ")}`);
      }
    } finally {
      await handle.destroy();
    }
  });
});

// ─── #387: the restore path ──────────────────────────────────────────────────────────────────────

const LOCK = JSON.stringify({ name: "fixture", version: "0.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fixture", version: "0.0.0" } } }) + "\n";

/** A repo with a lockfile, a snapshot of it at HEAD on the fake, and a ready row for that snapshot. */
async function snapshotOf(pool, repoDir, setup) {
  const { claimSnapshotBuild, markSnapshotReady } = await import("../dist/factory/environment-snapshots.js");
  const { snapshotKeyPaths } = await import("../dist/sandbox/environment-snapshot.js");
  const provider = new FakeSandboxProvider();
  const handle = await provider.create({ role: "verifier", repoUrl: repoDir });
  await handle.writeFile(".installed-by-snapshot", "from the snapshot\n");
  const baseSha = (await handle.exec("git", { args: ["rev-parse", "HEAD"] })).stdout.trim();
  const snap = await handle.snapshot({ expirationMs: 60_000 });
  const { rows } = await pool.query("select id from organization where is_default");
  const row = await claimSnapshotBuild(pool, {
    organizationId: rows[0].id,
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sandboxProvider: "fake",
    cacheKey: `key-${snap.snapshotId}`,
    keyPaths: snapshotKeyPaths(setup ?? null),
    baseSha,
    builtBy: "test",
  });
  await markSnapshotReady(pool, row.id, { providerSnapshotId: snap.snapshotId, detail: "", ttlDays: 1 });
  return {
    provider,
    restorable: { id: row.id, providerSnapshotId: snap.snapshotId, baseSha, cacheKey: row.cacheKey, keyPaths: row.keyPaths },
  };
}

function commit(repoDir, files, message) {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repoDir, name), content);
  spawnSync("git", ["add", "-A"], { cwd: repoDir });
  spawnSync("git", ["commit", "-qm", message], { cwd: repoDir });
  return headSha(repoDir);
}

const installRan = (handle) => handle.calls.some((c) => c.type === "exec" && c.command === "npm");

test("restore: the install is skipped when no install input differs from the snapshot", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await newRun(pool);
    const repoDir = fixtureRepo({ test: "true" }, { "package-lock.json": LOCK });
    const { provider, restorable } = await snapshotOf(pool, repoDir);
    commit(repoDir, { "index.js": "module.exports = 1;\n" }, "an ordinary change after the snapshot");

    const result = await provisionWorkspace(pool, provider, {
      engineeringRunId: run.id,
      role: "maker",
      repository: repoDir,
      baseSha: headSha(repoDir),
      installDeclaredTools: false,
      environment: { snapshot: restorable },
    });
    try {
      assert.deepEqual(result.handle.calls[0], { type: "create", fromSnapshot: restorable.providerSnapshotId });
      assert.equal(installRan(result.handle), false, "no install command ran");
      assert.equal(result.dependencies.status, "skipped");
      assert.match(result.dependencies.detail, /restored from environment snapshot/);
      assert.deepEqual(result.environment, { mode: "snapshot", snapshotId: restorable.id, snapshotKey: restorable.cacheKey, installInputChanges: [] });
      assert.equal(result.workspace.baseSha, headSha(repoDir), "the checkout is the revision asked for");
      assert.ok(await result.handle.exists(".installed-by-snapshot"), "the installed tree came from the snapshot");
      const { rows } = await pool.query("select environment_mode, environment_snapshot_id from workspace where id = $1", [result.workspace.id]);
      assert.deepEqual(rows[0], { environment_mode: "snapshot", environment_snapshot_id: restorable.id });
    } finally {
      await result.handle.destroy();
    }
  });
});

test("restore: a full install when the comparison cannot be made", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await newRun(pool);
    const repoDir = fixtureRepo({ test: "true" }, { "package-lock.json": LOCK });
    const { provider, restorable } = await snapshotOf(pool, repoDir);
    // A provider whose git cannot answer the diff: `installInputChanges` returns null.
    const create = provider.create.bind(provider);
    provider.create = async (options) => {
      const handle = await create(options);
      const exec = handle.exec.bind(handle);
      handle.exec = (command, opts) =>
        command === "git" && opts?.args?.includes("--name-only") && opts.args.some((a) => a.includes("package-lock.json"))
          ? Promise.resolve({ status: 128, signal: null, stdout: "", stderr: "fatal: bad object" })
          : exec(command, opts);
      return handle;
    };
    const result = await provisionWorkspace(pool, provider, {
      engineeringRunId: run.id,
      role: "maker",
      repository: repoDir,
      baseSha: headSha(repoDir),
      installDeclaredTools: false,
      installSecrets: { values: { NPM_TOKEN: "npm_full_install_secret" }, unopenable: [] },
      environment: { snapshot: restorable },
    });
    try {
      assert.equal(result.environment.installInputChanges, null);
      const npm = result.handle.calls.find((c) => c.type === "exec" && c.command === "npm");
      assert.ok(npm, "the install ran");
      assert.equal(npm.options.env.NPM_TOKEN, "npm_full_install_secret", "on the maker's tree, exactly as cold");
    } finally {
      await result.handle.destroy();
    }
  });
});

test("restore: a candidate that changed the lockfile reinstalls without the repository's secrets", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await newRun(pool);
    const repoDir = fixtureRepo({ test: "true" }, { "package-lock.json": LOCK });
    const { provider, restorable } = await snapshotOf(pool, repoDir);
    const candidate = commit(repoDir, { "package-lock.json": LOCK.replace('"0.0.0"', '"0.0.1"') }, "candidate edits the lockfile");

    const result = await provisionWorkspace(pool, provider, {
      engineeringRunId: run.id,
      role: "verifier",
      repository: repoDir,
      baseSha: candidate,
      candidateTree: true,
      trustedBase: restorable.baseSha,
      installDeclaredTools: false,
      installSecrets: { values: { NPM_TOKEN: "npm_must_not_reach_candidate" }, unopenable: [] },
      environment: { snapshot: restorable },
    });
    try {
      assert.deepEqual(result.environment.installInputChanges, ["package-lock.json"]);
      const npm = result.handle.calls.find((c) => c.type === "exec" && c.command === "npm");
      assert.ok(npm, "the candidate's changed tree is installed again");
      assert.equal(npm.options.env.NPM_TOKEN, undefined, "without the secrets");
      assert.ok(npm.options.args.includes("--ignore-scripts"), "with candidate-tree semantics");
      assert.match(result.dependencies.detail, /repository secrets were not given to this install/);
    } finally {
      await result.handle.destroy();
    }
  });
});

test("restore: services start on every restore, and a readiness timeout is reported, not thrown", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await newRun(pool);
    const setup = {
      services: [
        { name: "ready", start: "true", ready: "true", readyTimeoutSec: 5 },
        { name: "slow", start: "true", ready: "false", readyTimeoutSec: 1 },
        { name: "broken", start: "exit 4", readyTimeoutSec: 5 },
      ],
    };
    const repoDir = fixtureRepo({ test: "true" }, { "windkeel.config.json": JSON.stringify({ checks: [], setup }) });
    const { provider, restorable } = await snapshotOf(pool, repoDir, setup);
    const result = await provisionWorkspace(pool, provider, {
      engineeringRunId: run.id,
      role: "maker",
      repository: repoDir,
      baseSha: headSha(repoDir),
      installDeclaredTools: false,
      environment: { snapshot: restorable },
    });
    try {
      assert.equal(result.workspace.status, "ready");
      assert.deepEqual(
        result.environment.services.map((s) => [s.name, s.status]),
        [["ready", "started"], ["slow", "not_ready"], ["broken", "failed"]],
      );
      assert.match(result.environment.services[1].detail, /not ready within 1s/);
    } finally {
      await result.handle.destroy();
    }
  });
});

test("restore: a snapshot whose commit is not an ancestor of the checkout is not used", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await newRun(pool);
    const repoDir = fixtureRepo({ test: "true" }, { "package-lock.json": LOCK });
    const main = headSha(repoDir);
    // The snapshot is built on a side branch the checkout does not descend from.
    spawnSync("git", ["checkout", "-qb", "side"], { cwd: repoDir });
    commit(repoDir, { "side.txt": "x\n" }, "side");
    const { provider, restorable } = await snapshotOf(pool, repoDir);
    spawnSync("git", ["checkout", "-q", main], { cwd: repoDir });

    const result = await provisionWorkspace(pool, provider, {
      engineeringRunId: run.id,
      role: "verifier",
      repository: repoDir,
      baseSha: main,
      installDeclaredTools: false,
      installDependencies: false,
      environment: { snapshot: restorable },
    });
    try {
      assert.equal(result.environment.mode, "cold");
      assert.match(result.environment.fallback, /is not an ancestor of the checkout/);
      assert.ok(!result.handle.calls.some((c) => c.type === "create"), "the workspace's sandbox is a cold clone");
      assert.equal(await result.handle.exists(".installed-by-snapshot"), false);
      const { rows } = await pool.query("select environment_mode, environment_snapshot_id from workspace where id = $1", [result.workspace.id]);
      assert.deepEqual(rows[0], { environment_mode: "cold", environment_snapshot_id: null });
    } finally {
      await result.handle.destroy();
    }
  });
});

test("with the feature off, nothing about environments is recorded", { skip }, async () => {
  await withSchema(async (pool) => {
    const run = await newRun(pool);
    const repoDir = fixtureRepo({ test: "true" });
    const result = await provisionWorkspace(pool, new FakeSandboxProvider(), {
      engineeringRunId: run.id,
      role: "maker",
      repository: repoDir,
      baseSha: headSha(repoDir),
      installDeclaredTools: false,
    });
    try {
      assert.equal(result.environment, undefined);
      const { rows } = await pool.query("select environment_mode, environment_snapshot_id from workspace where id = $1", [result.workspace.id]);
      assert.deepEqual(rows[0], { environment_mode: null, environment_snapshot_id: null });
    } finally {
      await result.handle.destroy();
    }
  });
});
