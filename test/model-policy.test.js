/**
 * Layered model policy and the per-run snapshot (ADR-0026 §4–6, M9-3 #321).
 *
 * The pass criterion is "every new run has `model_config`, and no stage reads model settings from
 * env for a run that has one". The tests drive real runs through the intake stages on a fake
 * workflow provider, against Postgres, with a sandbox provider that counts creations — so "fails at
 * intake before provisioning" is observed, not inferred. No model is called and no key is opened.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import {
  getEngineeringRun,
  insertEngineeringRun,
  insertEngineeringTask,
} from "../dist/factory/repositories.js";
import { putModelCredential, revokeModelCredential } from "../dist/factory/model-credentials.js";
import {
  deleteModelPolicy,
  independenceOf,
  listModelPolicies,
  ModelPolicyError,
  operatorModelDefaults,
  parseTaskModelOverride,
  putModelPolicy,
  resolveRunModels,
  unwiredCustomerKey,
} from "../dist/factory/model-policy.js";
import { checkerModelsFor, makerModelFor } from "../dist/factory/workflow/run-models.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createIntakeHandlers } from "../dist/factory/workflow/handlers/intake.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { matchRoute } from "../apps/ingress/dist/src/api/route.js";
import { FIXTURE_REPOSITORY_ID, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const PAIR = generateSecretKeyPair();
const KEY = "sk-or-v1-Zx9QqRt7vB2mN4pL8sW1yH6jD3fA5gC0";
const OPERATOR_ANTHROPIC_KEY = "sk-ant-operator-key-not-real-0000";

/** Today's operator environment, as `buildStageDeps` hands it to the stages. */
function stageConfig() {
  return {
    repository: { url: "/nonexistent", baseRevision: "HEAD" },
    makerModel: "gpt-5-codex",
    makerVendor: "openai",
    modelApiDomain: "api.openai.com",
    modelKeyEnvVar: "OPENAI_API_KEY",
    modelPricing: { usdPerInputToken: 0, usdPerOutputToken: 0 },
    usdPerCpuMs: 0,
    usdPerEgressByte: 0,
    railsCheckIntervalMs: 60_000,
    workspaceTtlMs: 60_000,
    gitHost: "github.com",
    gitAuthorName: "Windkeel Factory",
    gitAuthorEmail: "factory@windkeel.invalid",
    policyVersion: "test",
    installScanners: false,
    checkerModels: {
      endpoints: [{ vendor: "anthropic", model: "claude-sonnet-4-5", apiKey: OPERATOR_ANTHROPIC_KEY }],
      maker: { vendor: "openai", model: "gpt-5-codex" },
    },
  };
}

let counter = 0;
async function withSchema(fn) {
  const schema = `windkeel_modelpolicy_${Date.now()}_${process.pid}_${counter++}`;
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

async function seedRun(pool, { modelOverride = null } = {}) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: FIXTURE_REPOSITORY_ID,
    sourceType: "local",
    sourceReference: "cli",
    title: "Add retries",
    description: "Retries are missing.",
    // Stated criteria: the gate needs no model call, so the run reaches PROVISIONING if allowed.
    acceptanceCriteria: [{ id: "AC1", text: "retries a 500", source: { kind: "explicit", ref: "cli" } }],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
    ...(modelOverride ? { modelOverride } : {}),
  });
  const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
  return { task, run };
}

function makeDeps(pool) {
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
      worker: new FakeWorkerAdapter([]),
      registry: new SandboxRegistry(),
      sessions: new WorkerSessionRegistry(),
      config: stageConfig(),
    },
  };
}

async function drive(pool, deps, runId) {
  const provider = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool) });
  for (const handler of createIntakeHandlers(deps)) provider.register(handler);
  provider.register(createProvisioningHandler(deps));
  await provider.start();
  try {
    await provider.startRun(runId);
    await provider.drain();
  } finally {
    await provider.stop();
  }
  return getEngineeringRun(pool, runId);
}

async function lastReason(pool, runId) {
  const { rows } = await pool.query(
    "select reason from run_state_transition where engineering_run_id = $1 and to_state = 'FAILED'",
    [runId],
  );
  return rows[0]?.reason ?? null;
}

const credential = (pool, org, overrides = {}) =>
  putModelCredential(pool, {
    organizationId: org,
    provider: "openrouter",
    label: "router",
    value: KEY,
    publicKey: PAIR.publicKey,
    ...overrides,
  });

// --- pure ---------------------------------------------------------------------------------------

test("operator defaults are today's environment, without a key", () => {
  const defaults = operatorModelDefaults(stageConfig());
  assert.deepEqual(defaults, {
    maker: { provider: "openai", vendor: "openai", model: "gpt-5-codex" },
    checker: [{ provider: "anthropic", vendor: "anthropic", model: "claude-sonnet-4-5" }],
  });
  assert.ok(!JSON.stringify(defaults).includes(OPERATOR_ANTHROPIC_KEY));
});

test("a task's models are checked for shape; a bare name is a model-only override", () => {
  assert.equal(parseTaskModelOverride(undefined), null);
  assert.deepEqual(parseTaskModelOverride({ maker: "gpt-5", checker: "claude-opus-4-1" }), {
    maker: { model: "gpt-5" },
    checker: [{ model: "claude-opus-4-1" }],
  });
  assert.throws(() => parseTaskModelOverride({ maker: { model: "x", provider: "bedrock" } }), ModelPolicyError);
  assert.throws(() => parseTaskModelOverride({ reviewer: "x" }), /no field reviewer/);
  assert.throws(() => parseTaskModelOverride({ maker: { model: "x", credentialId: "nope" } }), ModelPolicyError);
});

test("independence is judged on the derived vendor: Claude via OpenRouter is Anthropic", () => {
  const snapshot = (checker) => ({
    version: 1,
    maker: { provider: "anthropic", vendor: "anthropic", model: "claude-sonnet-4-5", keySource: "orqon", source: "operator" },
    checker,
    resolvedAt: new Date().toISOString(),
    policyIds: [],
  });
  const viaRouter = { provider: "openrouter", vendor: "anthropic", model: "anthropic/claude-opus-4.1", keySource: "orqon", source: "task" };
  assert.match(independenceOf(snapshot([viaRouter])), /anthropic's model/);
  const gpt = { provider: "openrouter", vendor: "openai", model: "openai/gpt-5", keySource: "orqon", source: "task" };
  assert.equal(independenceOf(snapshot([viaRouter, gpt])), null, "an independent fallback in the list is enough");
  assert.equal(independenceOf(snapshot([])), null, "no checker is not a refusal — the stages say skipped");
  const customer = snapshot([{ ...gpt, keySource: "customer", credentialId: "c", credentialLabel: "router" }]);
  // A role without in-handler opening is refused by name; the checker has it since M9-4, the maker since M9-5.
  assert.match(unwiredCustomerKey(customer, new Set()), /"router".*Windkeel's key/);
  assert.equal(unwiredCustomerKey(customer), null);
  const customerMaker = {
    ...snapshot([]),
    maker: { provider: "openai", vendor: "openai", model: "gpt-5", keySource: "customer", credentialId: "m", credentialLabel: "mine", source: "organization" },
  };
  assert.match(unwiredCustomerKey(customerMaker, new Set(["checker"])), /"mine".*maker/);
  assert.equal(unwiredCustomerKey(customerMaker), null);
});

test("the policy routes exist under the organization prefix with their permissions", () => {
  const get = matchRoute("GET", "/v1/orgs/acme/model-policy").matched;
  assert.equal(get.route.permission, "models.read");
  assert.equal(get.params.orgId, "acme");
  assert.equal(matchRoute("PUT", "/v1/model-policy").matched.route.permission, "models.manage");
  assert.equal(matchRoute("DELETE", "/v1/model-policy").matched.route.permission, "models.manage");
});

// --- resolution ---------------------------------------------------------------------------------

test("nothing configured: the snapshot is exactly today's defaults, Windkeel-managed", { skip }, async () => {
  await withSchema(async ({ pool, org }) => {
    const snapshot = await resolveRunModels(pool, {
      organizationId: org,
      repositoryId: FIXTURE_REPOSITORY_ID,
      taskOverride: null,
      operatorDefaults: operatorModelDefaults(stageConfig()),
      worker: "codex",
      now: new Date("2026-10-06T00:00:00Z"),
    });
    assert.deepEqual(snapshot, {
      version: 1,
      maker: { provider: "openai", vendor: "openai", model: "gpt-5-codex", keySource: "orqon", source: "operator", worker: "codex" },
      checker: [{ provider: "anthropic", vendor: "anthropic", model: "claude-sonnet-4-5", keySource: "orqon", source: "operator" }],
      resolvedAt: "2026-10-06T00:00:00.000Z",
      policyIds: [],
    });
  });
});

test("layering: task over repository over organization, per role", { skip }, async () => {
  await withSchema(async ({ pool, org }) => {
    const router = await credential(pool, org);
    const orgChecker = await putModelPolicy(pool, {
      organizationId: org,
      repositoryId: null,
      role: "checker",
      provider: "anthropic",
      model: "claude-opus-4-1",
    });
    const orgMaker = await putModelPolicy(pool, {
      organizationId: org,
      repositoryId: null,
      role: "maker",
      provider: "openai",
      model: "gpt-5",
    });
    const repoMaker = await putModelPolicy(pool, {
      organizationId: org,
      repositoryId: FIXTURE_REPOSITORY_ID,
      role: "maker",
      model: "openai/gpt-5-codex",
      credentialId: router.id,
    });
    // Setting a layer again replaces it rather than adding a second row.
    await putModelPolicy(pool, { organizationId: org, repositoryId: null, role: "maker", provider: "openai", model: "gpt-5-mini" });
    assert.equal((await listModelPolicies(pool, org)).length, 3);

    const resolve = (taskOverride) =>
      resolveRunModels(pool, {
        organizationId: org,
        repositoryId: FIXTURE_REPOSITORY_ID,
        taskOverride,
        operatorDefaults: operatorModelDefaults(stageConfig()),
      });

    const layered = await resolve(null);
    assert.equal(layered.maker.model, "openai/gpt-5-codex", "the repository's maker wins over the org's");
    assert.equal(layered.maker.provider, "openrouter");
    assert.equal(layered.maker.vendor, "openai");
    assert.equal(layered.maker.keySource, "customer");
    assert.equal(layered.maker.credentialId, router.id);
    assert.equal(layered.maker.credentialLabel, "router");
    assert.equal(layered.maker.source, "repository");
    assert.deepEqual(layered.checker.map((c) => [c.model, c.source, c.keySource]), [
      ["claude-opus-4-1", "organization", "orqon"],
    ]);
    assert.deepEqual(new Set(layered.policyIds), new Set([repoMaker.id, orgChecker.id]));
    assert.ok(!layered.policyIds.includes(orgMaker.id));

    // A model-only task override keeps the layer's provider and key; a full one replaces them.
    const task = await resolve({ maker: { model: "openai/gpt-5" }, checker: [{ model: "claude-sonnet-4-5", provider: "anthropic", credentialId: null }] });
    assert.equal(task.maker.model, "openai/gpt-5");
    assert.equal(task.maker.credentialId, router.id);
    assert.equal(task.maker.source, "task");
    assert.deepEqual(task.checker.map((c) => [c.model, c.source, c.keySource]), [["claude-sonnet-4-5", "task", "orqon"]]);

    // Another repository sees only the organization layer.
    assert.equal((await listModelPolicies(pool, org, { repositoryId: null })).length, 2);
    assert.equal(await deleteModelPolicy(pool, org, FIXTURE_REPOSITORY_ID), 1);
    assert.equal((await resolve(null)).maker.model, "gpt-5-mini");

    // Nothing in the snapshot is a key.
    assert.ok(!JSON.stringify(layered).includes(KEY));
  });
});

test("a policy that could never resolve is refused when it is written", { skip }, async () => {
  await withSchema(async ({ pool, org }) => {
    const router = await credential(pool, org);
    await assert.rejects(
      putModelPolicy(pool, { organizationId: org, repositoryId: null, role: "maker", provider: "openai", model: "gpt-5", credentialId: router.id }),
      /is for openrouter, not openai/,
    );
    await assert.rejects(
      putModelPolicy(pool, { organizationId: org, repositoryId: null, role: "checker", model: "someone/mystery", credentialId: router.id }),
      /declare its vendor/,
    );
    await revokeModelCredential(pool, org, router.id);
    await assert.rejects(
      putModelPolicy(pool, { organizationId: org, repositoryId: null, role: "maker", model: "openai/gpt-5", credentialId: router.id }),
      /"router" is revoked/,
    );
  });
});

// --- intake -------------------------------------------------------------------------------------

test("every new run gets a snapshot and selected_model at intake, and the stages read it", { skip }, async () => {
  await withSchema(async ({ pool }) => {
    const { run } = await seedRun(pool, { modelOverride: { maker: { model: "gpt-5" } } });
    const { deps, creates } = makeDeps(pool);
    const after = await drive(pool, deps, run.id);
    assert.ok(creates.length > 0, `expected provisioning to be reached, got ${after.status}`);
    assert.equal(after.modelConfig.maker.model, "gpt-5");
    assert.equal(after.modelConfig.maker.source, "task");
    assert.equal(after.modelConfig.maker.worker, "fake");
    assert.equal(after.selectedModel, "gpt-5");
    assert.equal(after.selectedWorker, "fake");

    // The stages read the run, not `config.makerModel` / `config.checkerModels`.
    assert.deepEqual(await makerModelFor(deps, run.id), { model: "gpt-5", workerType: "fake" });
    deps.config.makerModel = "something-else-entirely";
    deps.config.checkerModels.endpoints[0].model = "claude-from-env";
    const policy = await checkerModelsFor(deps, run.id);
    assert.equal(policy.endpoints[0].model, "claude-sonnet-4-5", "frozen at intake, not re-read from env");
    assert.equal(policy.endpoints[0].apiKey, OPERATOR_ANTHROPIC_KEY, "Windkeel-managed: the operator's key, in-call");
    assert.deepEqual(policy.maker, { vendor: "openai", model: "gpt-5" });
    assert.equal((await makerModelFor(deps, run.id)).model, "gpt-5");

    // The key exists only in that in-call policy, never on the row.
    const { rows } = await pool.query("select model_config::text as text from engineering_run where id = $1", [run.id]);
    assert.ok(!rows[0].text.includes(OPERATOR_ANTHROPIC_KEY));
  });
});

test("a dependent pairing via OpenRouter fails at intake, before provisioning", { skip }, async () => {
  await withSchema(async ({ pool, org }) => {
    // The maker is OpenAI's (operator default); the checker is OpenAI's too, routed through OpenRouter.
    await putModelPolicy(pool, {
      organizationId: org,
      repositoryId: null,
      role: "checker",
      provider: "openrouter",
      model: "openai/gpt-5",
      credentialId: (await credential(pool, org)).id,
    });
    const { run } = await seedRun(pool);
    const { deps, creates } = makeDeps(pool);
    const after = await drive(pool, deps, run.id);
    assert.equal(after.status, "FAILED");
    assert.equal(after.stopReason, "model_policy");
    assert.equal(creates.length, 0, "no sandbox for a run whose checker is the maker's vendor");
    assert.match(await lastReason(pool, run.id), /openrouter\/openai\/gpt-5 serves openai's model/);
    // Written anyway, so the run shows which models it was refused for.
    assert.equal(after.modelConfig.checker[0].vendor, "openai");
  });
});

test("a revoked credential fails the run at intake with a reason naming it", { skip }, async () => {
  await withSchema(async ({ pool, org }) => {
    const router = await credential(pool, org, { label: "team-router" });
    await putModelPolicy(pool, {
      organizationId: org,
      repositoryId: null,
      role: "checker",
      model: "google/gemini-2.5-pro",
      credentialId: router.id,
    });
    await revokeModelCredential(pool, org, router.id);
    const { run } = await seedRun(pool);
    const { deps, creates } = makeDeps(pool);
    const after = await drive(pool, deps, run.id);
    assert.equal(after.status, "FAILED");
    assert.equal(after.stopReason, "model_policy");
    assert.equal(creates.length, 0);
    assert.match(await lastReason(pool, run.id), /model credential "team-router" is revoked/);
    assert.equal(after.modelConfig, null, "nothing true to freeze");
  });
});

test("a usable customer checker credential passes intake on its own key (M9-4)", { skip }, async () => {
  await withSchema(async ({ pool, org }) => {
    const router = await credential(pool, org);
    await pool.query("update model_credential set status = 'valid' where id = $1", [router.id]);
    await putModelPolicy(pool, {
      organizationId: org,
      repositoryId: null,
      role: "checker",
      model: "google/gemini-2.5-pro",
      credentialId: router.id,
    });
    const { run } = await seedRun(pool);
    const { deps, creates } = makeDeps(pool);
    const after = await drive(pool, deps, run.id);
    assert.ok(creates.length > 0, `expected provisioning to be reached, got ${after.status}`);
    assert.ok(after.stopReason !== "model_policy");
    assert.equal(after.modelConfig.checker[0].keySource, "customer");
    assert.equal(after.modelConfig.checker[0].vendor, "google");
    assert.ok(!JSON.stringify(after.modelConfig).includes(KEY));
  });
});

test("a run without a snapshot keeps the environment's models", { skip }, async () => {
  await withSchema(async ({ pool }) => {
    const { run } = await seedRun(pool);
    const { deps } = makeDeps(pool);
    assert.deepEqual(await makerModelFor(deps, run.id), { model: "gpt-5-codex", workerType: "fake" });
    assert.equal(await checkerModelsFor(deps, run.id), deps.config.checkerModels);
  });
});
