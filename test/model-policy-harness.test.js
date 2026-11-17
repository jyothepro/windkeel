/**
 * The maker harness as part of the maker choice (ADR-0027 §1, §2, §4; #395 sub-tasks A and D):
 * `model_policy.harness`, its layering, the pair checked on write and at intake, the harness frozen
 * into the run's snapshot, and independence still judged on the model's vendor.
 *
 * Postgres-backed tests skip without TEST_DATABASE_URL, like the rest of the policy suite.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { getEngineeringRun, insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { putModelCredential } from "../dist/factory/model-credentials.js";
import {
  chosenCheckerIndex,
  listModelPolicies,
  ModelPolicyError,
  operatorModelDefaults,
  putModelPolicy,
  resolveRunModels,
} from "../dist/factory/model-policy.js";
import { makerModelFor } from "../dist/factory/workflow/run-models.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createIntakeHandlers } from "../dist/factory/workflow/handlers/intake.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { FIXTURE_REPOSITORY_ID, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const PAIR = generateSecretKeyPair();

const BOTH = { versions: { codex: "0.154.0", "claude-code": "2.1.304" }, defaultId: "codex" };
const CODEX_ONLY = { versions: { codex: "0.154.0" }, defaultId: "codex" };

/** A registered adapter as intake sees one: a name, a version, and nothing it would call. */
const adapter = (name, version) => ({ name, version, capabilities: { resumableSessions: true, reattachableSessions: false, reattachedSessionsAcceptNewTurns: false } });

function stageConfig(checkers = [{ vendor: "anthropic", model: "claude-sonnet-4-5", apiKey: "sk-ant-operator-not-real" }]) {
  return {
    repository: { url: "/nonexistent", baseRevision: "HEAD" },
    makerModel: "gpt-5-codex",
    makerVendor: "openai",
    modelApiDomain: "api.openai.com",
    modelKeyEnvVar: "OPENAI_API_KEY",
    modelPricing: {},
    usdPerCpuMs: 0,
    usdPerEgressByte: 0,
    railsCheckIntervalMs: 60_000,
    workspaceTtlMs: 60_000,
    gitHost: "github.com",
    gitAuthorName: "Windkeel Factory",
    gitAuthorEmail: "factory@windkeel.invalid",
    policyVersion: "test",
    installScanners: false,
    secretPrivateKey: PAIR.privateKey,
    checkerModels: { endpoints: checkers, maker: { vendor: "openai", model: "gpt-5-codex" } },
  };
}

let counter = 0;
async function withSchema(fn) {
  const schema = `windkeel_harness_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const { rows } = await pool.query("select id from organization where is_default");
    await fn({ pool, org: rows[0].id });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

const anthropicKey = (pool, org) =>
  putModelCredential(pool, { organizationId: org, provider: "anthropic", label: "claude", value: "sk-ant-api03-not-real", publicKey: PAIR.publicKey });

const resolve = (pool, org, overrides = {}) =>
  resolveRunModels(pool, {
    organizationId: org,
    repositoryId: FIXTURE_REPOSITORY_ID,
    taskOverride: null,
    operatorDefaults: operatorModelDefaults(stageConfig()),
    harnesses: BOTH,
    ...overrides,
  });

const refusedWith = (code) => (error) => error instanceof ModelPolicyError && error.code === code;

// --- writes ---------------------------------------------------------------------------------------

test("a policy write checks the harness: maker only, enabled, and able to call the provider", { skip }, async () => {
  await withSchema(async ({ pool, org }) => {
    const base = { organizationId: org, repositoryId: null, enabledHarnesses: ["codex", "claude-code"] };
    await assert.rejects(
      putModelPolicy(pool, { ...base, role: "checker", provider: "anthropic", model: "claude-opus-4-1", harness: "claude-code" }),
      (error) => error instanceof ModelPolicyError && error.status === 400 && /only the maker has a harness/.test(error.message),
    );
    await assert.rejects(
      putModelPolicy(pool, { ...base, enabledHarnesses: ["codex"], role: "maker", provider: "anthropic", model: "claude-sonnet-4-5", harness: "claude-code" }),
      refusedWith("harness_unavailable"),
      "a codex-only deployment refuses claude-code",
    );
    await assert.rejects(
      putModelPolicy(pool, { ...base, role: "maker", provider: "openai", model: "gpt-5", harness: "claude-code" }),
      (error) => refusedWith("harness_incompatible")(error) && error.status === 422 && /claude-code harness cannot call openai/.test(error.message),
    );
    await assert.rejects(
      putModelPolicy(pool, { ...base, role: "maker", provider: "anthropic", model: "claude-sonnet-4-5", harness: "codex" }),
      refusedWith("harness_incompatible"),
    );
    const key = await anthropicKey(pool, org);
    const row = await putModelPolicy(pool, { ...base, role: "maker", model: "claude-sonnet-4-5", credentialId: key.id, harness: "claude-code" });
    assert.equal(row.harness, "claude-code");
    const [listed] = await listModelPolicies(pool, org);
    assert.equal(listed.harness, "claude-code");
    // Writing the layer again without a harness clears it: null inherits.
    const cleared = await putModelPolicy(pool, { ...base, role: "maker", provider: "openai", model: "gpt-5" });
    assert.equal(cleared.harness, null);
  });
});

test("the migration's constraints refuse a checker harness and a malformed one", { skip }, async () => {
  await withSchema(async ({ pool, org }) => {
    const insert = (role, harness) =>
      pool.query(
        "insert into model_policy (organization_id, role, provider, model, harness) values ($1, $2, 'openai', 'gpt-5', $3)",
        [org, role, harness],
      );
    await assert.rejects(insert("checker", "codex"), /model_policy_harness_maker_only/);
    await assert.rejects(insert("maker", "Not A Harness"), /check constraint/);
    await insert("maker", "codex");
    const { rows } = await pool.query("select harness from model_policy where organization_id = $1", [org]);
    assert.deepEqual(rows, [{ harness: "codex" }]);
  });
});

// --- resolution ---------------------------------------------------------------------------------

test("nothing configured: the snapshot freezes the operator's default harness and its version", { skip }, async () => {
  await withSchema(async ({ pool, org }) => {
    const snapshot = await resolve(pool, org);
    assert.deepEqual(snapshot.maker.harness, { id: "codex", version: "0.154.0" });
    assert.equal(snapshot.maker.worker, "codex", "maker.worker === harness.id");
    const claudeDefault = await resolve(pool, org, { harnesses: { ...BOTH, defaultId: "claude-code" }, taskOverride: { maker: { model: "gpt-5", provider: "openai" } } }).catch((e) => e);
    assert.ok(refusedWith("harness_incompatible")(claudeDefault), "the default harness is checked against the resolved provider too");
  });
});

test("layering: null inherits the harness, and a layer that sets only a model keeps it", { skip }, async () => {
  await withSchema(async ({ pool, org }) => {
    const key = await anthropicKey(pool, org);
    const enabled = ["codex", "claude-code"];
    await putModelPolicy(pool, { organizationId: org, repositoryId: null, role: "maker", model: "claude-sonnet-4-5", credentialId: key.id, harness: "claude-code", enabledHarnesses: enabled });
    // The repository's maker names a model and a key but no harness: it inherits claude-code.
    await putModelPolicy(pool, { organizationId: org, repositoryId: FIXTURE_REPOSITORY_ID, role: "maker", model: "claude-opus-4-1", credentialId: key.id, enabledHarnesses: enabled });
    const layered = await resolve(pool, org);
    assert.equal(layered.maker.model, "claude-opus-4-1");
    assert.equal(layered.maker.source, "repository");
    assert.deepEqual(layered.maker.harness, { id: "claude-code", version: "2.1.304" });

    const modelOnly = await resolve(pool, org, { taskOverride: { maker: { model: "claude-haiku-4-5" } } });
    assert.equal(modelOnly.maker.model, "claude-haiku-4-5");
    assert.equal(modelOnly.maker.harness.id, "claude-code", "a model-only task layer inherits the harness");

    // A task asking for Codex over an inherited Anthropic maker is an incompatible pair.
    await assert.rejects(resolve(pool, org, { taskOverride: { maker: { model: "claude-haiku-4-5", harness: "codex" } } }), refusedWith("harness_incompatible"));
    // The operator disabled claude-code after the policy named it: refused, never substituted.
    await assert.rejects(resolve(pool, org, { harnesses: CODEX_ONLY }), (error) => refusedWith("harness_unavailable")(error) && /claude-code/.test(error.message));
  });
});

// --- intake ---------------------------------------------------------------------------------------

async function seedRun(pool) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: FIXTURE_REPOSITORY_ID,
    sourceType: "local",
    sourceReference: "cli",
    title: "Add retries",
    description: "Retries are missing.",
    acceptanceCriteria: [{ id: "AC1", text: "retries a 500", source: { kind: "explicit", ref: "cli" } }],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  return insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
}

function makeDeps(pool, { workers, checkers } = {}) {
  const sandboxes = new FakeSandboxProvider();
  const creates = [];
  return {
    creates,
    deps: {
      pool,
      sandboxes: {
        name: "counting",
        capabilities: sandboxes.capabilities,
        async create(options) {
          creates.push(options);
          return sandboxes.create(options);
        },
      },
      workers: workers ?? new Map([["codex", adapter("codex", "0.154.0")], ["claude-code", adapter("claude-code", "2.1.304")]]),
      defaultHarness: "codex",
      registry: new SandboxRegistry(),
      sessions: new WorkerSessionRegistry(),
      config: stageConfig(checkers),
    },
  };
}

async function drive(pool, deps, runId, { provisioning = true } = {}) {
  const provider = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool) });
  for (const handler of createIntakeHandlers(deps)) provider.register(handler);
  // Without a provisioning handler a run that passes intake parks at PROVISIONING, which is the point.
  if (provisioning) provider.register(createProvisioningHandler(deps));
  await provider.start();
  try {
    await provider.startRun(runId);
    await provider.drain();
  } finally {
    await provider.stop();
  }
  return getEngineeringRun(pool, runId);
}

const lastReason = async (pool, runId) =>
  (await pool.query("select reason from run_state_transition where engineering_run_id = $1 and to_state = 'FAILED'", [runId])).rows[0]?.reason ?? null;

test("intake refuses a harness the deployment no longer registers, before any sandbox", { skip }, async () => {
  await withSchema(async ({ pool, org }) => {
    const key = await anthropicKey(pool, org);
    await putModelPolicy(pool, { organizationId: org, repositoryId: null, role: "maker", model: "claude-sonnet-4-5", credentialId: key.id, harness: "claude-code", enabledHarnesses: ["codex", "claude-code"] });
    const run = await seedRun(pool);
    const { deps, creates } = makeDeps(pool, { workers: new Map([["codex", adapter("codex", "0.154.0")]]) });
    const after = await drive(pool, deps, run.id);
    assert.equal(after.status, "FAILED");
    assert.equal(after.stopReason, "model_policy");
    assert.equal(creates.length, 0);
    assert.match(await lastReason(pool, run.id), /claude-code.*drives the maker with codex/);
  });
});

test("an Anthropic maker on Claude Code: an Anthropic-only checker list is dependent; [anthropic, openai] picks openai", { skip }, async () => {
  await withSchema(async ({ pool, org }) => {
    const key = await anthropicKey(pool, org);
    await putModelPolicy(pool, { organizationId: org, repositoryId: null, role: "maker", model: "claude-sonnet-4-5", credentialId: key.id, harness: "claude-code", enabledHarnesses: ["codex", "claude-code"] });

    const dependent = await seedRun(pool);
    const refused = await drive(pool, makeDeps(pool).deps, dependent.id);
    assert.equal(refused.status, "FAILED");
    assert.equal(refused.stopReason, "model_policy");
    assert.match(await lastReason(pool, dependent.id), /no checker model is independent/);

    const run = await seedRun(pool);
    const checkers = [
      { vendor: "anthropic", model: "claude-sonnet-4-5", apiKey: "sk-ant-operator-not-real" },
      { vendor: "openai", model: "gpt-5", apiKey: "sk-openai-operator-not-real" },
    ];
    const { deps } = makeDeps(pool, { checkers });
    const after = await drive(pool, deps, run.id, { provisioning: false });
    assert.equal(after.status, "PROVISIONING", await lastReason(pool, run.id));
    assert.deepEqual(after.modelConfig.maker.harness, { id: "claude-code", version: "2.1.304" });
    assert.equal(after.modelConfig.maker.worker, "claude-code");
    assert.equal(after.modelConfig.checker[chosenCheckerIndex(after.modelConfig)].vendor, "openai");

    // A policy changed mid-run does not move the run onto another agent.
    await putModelPolicy(pool, { organizationId: org, repositoryId: null, role: "maker", provider: "openai", model: "gpt-5", harness: "codex", enabledHarnesses: ["codex", "claude-code"] });
    assert.deepEqual(await makerModelFor(deps, run.id), { model: "claude-sonnet-4-5", workerType: "claude-code" });
    assert.deepEqual((await getEngineeringRun(pool, run.id)).modelConfig.maker.harness, { id: "claude-code", version: "2.1.304" });
  });
});
