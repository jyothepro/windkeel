/**
 * Model presets, enabled harnesses and *Run again with…* (ADR-0029 §6, #365, G15).
 *
 * The pass criteria: presets are organization rows read with `models.read` and written with
 * `models.manage`; `GET /v1/model-policy` carries them and the enabled harnesses; a preset whose
 * pairing is not independent is refused with intake's reason; a re-run can take its own models,
 * which intake resolves over the task's into the **new** run's snapshot — and nothing changes the
 * snapshot of a run that has one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { apiControl } from "../apps/ingress/dist/src/api/control.js";
import { matchRoute, ROUTES } from "../apps/ingress/dist/src/api/route.js";
import { enabledHarnesses } from "../dist/factory/harnesses.js";
import {
  chosenCheckerIndex,
  independenceReason,
  mergeModelOverrides,
  ModelPolicyError,
  operatorModelDefaults,
  parseTaskModelOverride,
  putModelPolicy,
  resolveRunModels,
} from "../dist/factory/model-policy.js";
import { getEngineeringRun, insertEngineeringRun, insertEngineeringTask, updateEngineeringRun } from "../dist/factory/repositories.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createIntakeHandlers } from "../dist/factory/workflow/handlers/intake.js";
// The console's mirror of the checker selection, imported as its own TypeScript (Node strips types).
import { selectedCheckerIndex } from "../apps/console/lib/models.ts";
import { FIXTURE_REPOSITORY_ID as REPO_ID, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const TOKEN = "test-operator-token";
const { publicKey: PUBLIC_KEY } = generateSecretKeyPair();
const MODEL_KEY = "sk-or-v1-Zx9QqRt7vB2mN4pL8sW1yH6jD3fA5gC0";

function request(method, path, extra = {}) {
  const params = extra.query ?? {};
  return { method, path, query: { get: (n) => params[n] }, headers: { authorization: `Bearer ${TOKEN}` }, body: extra.body };
}

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
      endpoints: [{ vendor: "anthropic", model: "claude-sonnet-4-5", apiKey: "sk-ant-operator-not-real" }],
      maker: { vendor: "openai", model: "gpt-5-codex" },
    },
  };
}

let counter = 0;
async function withApi(fn, overrides = {}) {
  const schema = `windkeel_presets_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const { rows } = await pool.query("select id from organization where is_default");
    const enqueued = [];
    const control = apiControl({
      pool,
      control: { cancel: async () => {}, signal: async () => {}, startRun: async (id) => (enqueued.push(id), { enqueued: true }) },
      github: {},
    });
    const deps = { pool, control, secretPublicKey: PUBLIC_KEY, ...overrides };
    const auth = { token: TOKEN, subject: "operator" };
    await fn({ pool, org: rows[0].id, enqueued, call: (m, p, e) => handleApiRequest(deps, auth, request(m, p, e)) });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

async function seedTask(pool, modelOverride = null) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: REPO_ID,
    sourceType: "local",
    sourceReference: "cli",
    title: "Add retries",
    description: "Retries are missing.",
    acceptanceCriteria: [{ id: "AC1", text: "retries a 500", source: { kind: "explicit", ref: "cli" } }],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
    ...(modelOverride ? { modelOverride } : {}),
  });
  return task;
}

// --- pure ---------------------------------------------------------------------------------------

test("the preset routes sit under model-policy: read with models.read, written with models.manage", () => {
  assert.equal(matchRoute("GET", "/v1/orgs/acme/model-policy/presets").matched.route.permission, "models.read");
  for (const [method, path] of [
    ["POST", "/v1/model-policy/presets"],
    ["PUT", "/v1/model-policy/presets/abc"],
    ["DELETE", "/v1/model-policy/presets/abc"],
  ]) {
    const { route, params } = matchRoute(method, path).matched;
    assert.equal(route.permission, "models.manage", `${method} ${path}`);
    if (method !== "POST") assert.equal(params.presetId, "abc");
  }
  // The policy read is still models.read: a member choosing a task's models sees the presets too.
  assert.equal(matchRoute("GET", "/v1/model-policy").matched.route.permission, "models.read");
});

test("no route writes to an existing run's models: changing them is a new run (ADR-0026 §4)", () => {
  const writes = ROUTES.filter((r) => r.method !== "GET" && r.pattern.startsWith("/v1/runs/:runId")).map((r) => r.name).sort();
  // Each of these is a command about the run's progress (merging its verified PR, #371, included);
  // none takes `models`, and none is a PUT/PATCH. ADR-0029 §3's intents (take over, submit, hand
  // back, open the workspace) take no `models` either.
  assert.deepEqual(writes, [
    "approveRun",
    "cancelRun",
    "captureRun",
    "handbackRun",
    "mergeRun",
    "openWorkspaceSession",
    "sendRunMessage",
    "submitRun",
    "takeoverRun",
  ]);
});

test("enabled harnesses: codex by default; the operator's list, its default first-or-named", () => {
  assert.deepEqual(enabledHarnesses({}), [{ id: "codex", label: "OpenAI's Codex CLI", default: true }]);
  const two = enabledHarnesses({ WINDKEEL_MAKER_HARNESSES: "codex, claude-code,BAD ID", WINDKEEL_DEFAULT_MAKER_HARNESS: "claude-code" });
  assert.deepEqual(two.map((h) => [h.id, h.default]), [["codex", false], ["claude-code", true]]);
  assert.equal(enabledHarnesses({ WINDKEEL_MAKER_HARNESSES: " , " })[0].id, "codex");
  assert.equal(enabledHarnesses({ WINDKEEL_MAKER_HARNESSES: "codex", WINDKEEL_DEFAULT_MAKER_HARNESS: "opencode" })[0].default, true);
});

test("a task's models may name the maker's harness, and only the maker's", () => {
  assert.deepEqual(parseTaskModelOverride({ maker: { model: "gpt-5", provider: "openai", harness: "codex" } }), {
    maker: { model: "gpt-5", provider: "openai", harness: "codex" },
  });
  assert.throws(() => parseTaskModelOverride({ checker: { model: "claude-opus-4-1", provider: "anthropic", harness: "codex" } }), ModelPolicyError);
  assert.throws(() => parseTaskModelOverride({ maker: { model: "gpt-5", harness: "Codex CLI" } }), ModelPolicyError);
});

test("a re-run's models replace the task's per role", () => {
  const task = { maker: { model: "gpt-5" }, checker: [{ model: "claude-opus-4-1", provider: "anthropic" }] };
  assert.deepEqual(mergeModelOverrides(task, { maker: { model: "gpt-5-mini" } }), {
    maker: { model: "gpt-5-mini" },
    checker: [{ model: "claude-opus-4-1", provider: "anthropic" }],
  });
  assert.equal(mergeModelOverrides(null, null), null);
});

test("independenceReason is intake's refusal, in intake's words", () => {
  const same = independenceReason({ vendor: "anthropic", model: "claude-sonnet-4-5" }, [
    { vendor: "anthropic", provider: "openrouter", model: "anthropic/claude-opus-4.1", apiKey: "" },
  ]);
  assert.match(same, /^no checker model is independent of the maker \(anthropic\/claude-sonnet-4-5\)/);
  assert.match(same, /ADR-0010, ADR-0026 §5/);
  assert.equal(
    independenceReason({ vendor: "openai", model: "gpt-5" }, [{ vendor: "anthropic", provider: "anthropic", model: "claude-opus-4-1", apiKey: "" }]),
    null,
  );
});

test("the console's header picks the checker the gateway will: parity with chosenCheckerIndex", () => {
  const choice = (provider, vendor, model, extra = {}) => ({ provider, vendor, model, keySource: "orqon", source: "task", ...extra });
  const makers = [
    choice("openai", "openai", "gpt-5-codex"),
    choice("openrouter", "anthropic", "anthropic/claude-sonnet-4.5"),
    choice("openai-compatible", "openai-compatible", "mystery-model"),
    choice("openrouter", "openrouter", "openai/gpt-5"),
    choice("anthropic", "anthropic", "claude-opus-4-1"),
  ];
  const checkers = [
    choice("anthropic", "anthropic", "claude-opus-4-1"),
    choice("openrouter", "openai", "openai/gpt-5-mini"),
    choice("openrouter", "google", "google/gemini-2.5-pro"),
    choice("openai", "openai", "gpt-5-codex"),
    choice("openai-compatible", "openai-compatible", "unknown-thing"),
    choice("openai-compatible", "deepseek", "local-deepseek", { baseUrl: "http://localhost:1234/v1" }),
    choice("openrouter", "anthropic", "anthropic/claude-sonnet-4.5"),
  ];
  // Every maker against every ordered pair of checkers, and each checker alone.
  const lists = [[], ...checkers.map((c) => [c]), ...checkers.flatMap((a) => checkers.filter((b) => b !== a).map((b) => [a, b]))];
  let cases = 0;
  for (const maker of makers) {
    for (const checker of lists) {
      const config = { version: 1, maker, checker, resolvedAt: "", policyIds: [] };
      assert.equal(selectedCheckerIndex(config), chosenCheckerIndex(config), JSON.stringify({ maker, checker }));
      cases++;
    }
  }
  assert.ok(cases > 200);
  // And the case the header got wrong: a same-vendor first checker is not the one used.
  assert.equal(chosenCheckerIndex({ version: 1, maker: makers[0], checker: [checkers[1], checkers[0]], resolvedAt: "", policyIds: [] }), 1);
});

// --- presets over the API -----------------------------------------------------------------------

test("presets: create, list on GET /v1/model-policy with the harnesses, update, delete", { skip }, async () => {
  await withApi(async ({ call }) => {
    const credential = (await call("POST", "/v1/model-credentials", { body: { provider: "openrouter", label: "router", value: MODEL_KEY } })).body.credential;

    const created = await call("POST", "/v1/model-policy/presets", {
      body: {
        name: "Thorough",
        harness: "codex",
        maker: { provider: "openai", model: "gpt-5-codex" },
        checker: [{ model: "anthropic/claude-opus-4.1", credentialId: credential.id }],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const preset = created.body.preset;
    assert.equal(preset.name, "Thorough");
    assert.equal(preset.harness, "codex");
    assert.deepEqual(preset.maker, { provider: "openai", model: "gpt-5-codex" });
    assert.deepEqual(preset.checker, [{ model: "anthropic/claude-opus-4.1", credentialId: credential.id }]);

    const policy = await call("GET", "/v1/model-policy");
    assert.equal(policy.status, 200);
    assert.deepEqual(policy.body.presets.map((p) => p.name), ["Thorough"]);
    assert.deepEqual(policy.body.harnesses, [{ id: "codex", label: "OpenAI's Codex CLI", default: true }]);
    assert.ok(!JSON.stringify(policy.body).includes(MODEL_KEY), "a preset names a credential id, never a value");
    assert.deepEqual((await call("GET", "/v1/model-policy/presets")).body.items.map((p) => p.id), [preset.id]);

    const taken = await call("POST", "/v1/model-policy/presets", {
      body: { name: "thorough", maker: { provider: "openai", model: "gpt-5" }, checker: { provider: "anthropic", model: "claude-opus-4-1" } },
    });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.code, "preset_name_taken");

    const updated = await call("PUT", `/v1/model-policy/presets/${preset.id}`, {
      body: { name: "Fast", maker: { provider: "openai", model: "gpt-5-mini" }, checker: { provider: "anthropic", model: "claude-sonnet-4-5" } },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.preset.name, "Fast");
    assert.equal(updated.body.preset.harness, null, "replaced whole: no harness is the operator's default");
    assert.deepEqual(updated.body.preset.checker, [{ provider: "anthropic", model: "claude-sonnet-4-5" }]);

    assert.equal((await call("DELETE", `/v1/model-policy/presets/${preset.id}`)).status, 200);
    assert.equal((await call("DELETE", `/v1/model-policy/presets/${preset.id}`)).status, 404);
    assert.equal((await call("PUT", `/v1/model-policy/presets/${preset.id}`, { body: {} })).status, 404);
    // Not UUIDs, though 36 characters of hex and hyphens: not found, not Postgres's 22P02 as a 500.
    for (const notAnId of ["-".repeat(36), "0".repeat(36), `${preset.id.slice(0, 35)}-`]) {
      assert.equal((await call("DELETE", `/v1/model-policy/presets/${notAnId}`)).status, 404, notAnId);
      const put = await call("PUT", `/v1/model-policy/presets/${notAnId}`, {
        body: { name: "X", maker: { provider: "openai", model: "gpt-5" }, checker: { provider: "anthropic", model: "claude-opus-4-1" } },
      });
      assert.equal(put.status, 404, `${notAnId}: ${JSON.stringify(put.body)}`);
    }
    assert.deepEqual((await call("GET", "/v1/model-policy")).body.presets, []);
  });
});

test("a preset is refused when its pairing is not independent, with intake's reason", { skip }, async () => {
  await withApi(async ({ call }) => {
    const credential = (await call("POST", "/v1/model-credentials", { body: { provider: "openrouter", label: "router", value: MODEL_KEY } })).body.credential;
    // OpenAI's model through OpenRouter is still OpenAI's: it cannot check gpt-5's work.
    const refused = await call("POST", "/v1/model-policy/presets", {
      body: { name: "Mirror", maker: { provider: "openai", model: "gpt-5" }, checker: [{ model: "openai/gpt-5-mini", credentialId: credential.id }] },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "no_independent_checker");
    assert.match(refused.body.error, /no checker model is independent of the maker \(openai\/gpt-5\)/);
    assert.match(refused.body.error, /openrouter\/openai\/gpt-5-mini serves openai's model/);

    // A fallback that is independent makes the list acceptable, as intake takes the first that is.
    const ok = await call("POST", "/v1/model-policy/presets", {
      body: {
        name: "Mirror",
        maker: { provider: "openai", model: "gpt-5" },
        checker: [{ model: "openai/gpt-5-mini", credentialId: credential.id }, { provider: "anthropic", model: "claude-opus-4-1" }],
      },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual((await call("GET", "/v1/model-policy/presets")).body.items.map((p) => p.name), ["Mirror"]);
  });
});

test("a preset is refused for a harness the deployment doesn't enable, a missing role, or a bare model", { skip }, async () => {
  await withApi(async ({ call }) => {
    const pair = { maker: { provider: "openai", model: "gpt-5" }, checker: { provider: "anthropic", model: "claude-opus-4-1" } };
    const harness = await call("POST", "/v1/model-policy/presets", { body: { name: "Claude", harness: "claude-code", ...pair } });
    assert.equal(harness.status, 422);
    assert.equal(harness.body.code, "harness_unavailable");

    const noChecker = await call("POST", "/v1/model-policy/presets", { body: { name: "Half", maker: pair.maker } });
    assert.equal(noChecker.status, 400);
    assert.equal(noChecker.body.code, "invalid_model_preset");

    const bare = await call("POST", "/v1/model-policy/presets", { body: { name: "Bare", maker: "gpt-5", checker: pair.checker } });
    assert.equal(bare.status, 400);
    assert.match(bare.body.error, /provider or a model credential/);

    const noName = await call("POST", "/v1/model-policy/presets", { body: { name: "  ", ...pair } });
    assert.equal(noName.status, 400);
    assert.equal((await call("GET", "/v1/model-policy/presets")).body.items.length, 0);
  });
});

test("with a second harness enabled, a preset may name it and the policy read lists both", { skip }, async () => {
  await withApi(
    async ({ call }) => {
      const policy = await call("GET", "/v1/model-policy");
      assert.deepEqual(policy.body.harnesses.map((h) => h.id), ["codex", "claude-code"]);
      const created = await call("POST", "/v1/model-policy/presets", {
        body: { name: "Claude", harness: "claude-code", maker: { provider: "anthropic", model: "claude-sonnet-4-5" }, checker: { provider: "openai", model: "gpt-5" } },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    },
    { makerHarnesses: enabledHarnesses({ WINDKEEL_MAKER_HARNESSES: "codex,claude-code" }) },
  );
});

test("PUT /v1/model-policy takes a maker harness: refused when not enabled or incompatible, stored when it is", { skip }, async () => {
  await withApi(async ({ call }) => {
    const claude = { maker: { provider: "anthropic", model: "claude-sonnet-4-5", harness: "claude-code" } };
    const refused = await call("PUT", "/v1/model-policy", { body: claude });
    assert.equal(refused.status, 422, "a codex-only deployment refuses claude-code");
    assert.equal(refused.body.code, "harness_unavailable");
    const checker = await call("PUT", "/v1/model-policy", { body: { checker: { provider: "openai", model: "gpt-5", harness: "codex" } } });
    assert.equal(checker.status, 400);
    const shape = await call("PUT", "/v1/model-policy", { body: { maker: { provider: "openai", model: "gpt-5", harness: 7 } } });
    assert.equal(shape.status, 400);
    assert.equal((await call("GET", "/v1/model-policy")).body.items.length, 0, "a refusal writes nothing");
  });
  await withApi(
    async ({ call }) => {
      const incompatible = await call("PUT", "/v1/model-policy", { body: { maker: { provider: "openai", model: "gpt-5", harness: "claude-code" } } });
      assert.equal(incompatible.status, 422);
      assert.equal(incompatible.body.code, "harness_incompatible");
      const codexOnAnthropic = await call("PUT", "/v1/model-policy", { body: { maker: { provider: "anthropic", model: "claude-sonnet-4-5", harness: "codex" } } });
      assert.equal(codexOnAnthropic.body.code, "harness_incompatible");
      const stored = await call("PUT", "/v1/model-policy", { body: { maker: { provider: "openai", model: "gpt-5", harness: "codex" } } });
      assert.equal(stored.status, 200, JSON.stringify(stored.body));
      assert.equal(stored.body.items[0].harness, "codex");
      assert.equal((await call("GET", "/v1/model-policy")).body.items[0].harness, "codex");
    },
    { makerHarnesses: enabledHarnesses({ WINDKEEL_MAKER_HARNESSES: "codex,claude-code" }) },
  );
});

// --- Run again with…----------------------------------------------------------------------------

test("POST /v1/runs takes models: a new run of the same task, with its own choice on the row", { skip }, async () => {
  await withApi(async ({ pool, call, enqueued }) => {
    const task = await seedTask(pool, { maker: { model: "gpt-5" } });
    const first = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    await pool.query("update engineering_run set status = 'FAILED' where id = $1", [first.id]);

    const refusedHarness = await call("POST", "/v1/runs", { body: { taskId: task.id, models: { maker: { model: "gpt-5", provider: "openai", harness: "opencode" } } } });
    assert.equal(refusedHarness.status, 422);
    assert.equal(refusedHarness.body.code, "harness_unavailable");
    const refusedShape = await call("POST", "/v1/runs", { body: { taskId: task.id, models: { maker: { model: "x", provider: "bedrock" } } } });
    assert.equal(refusedShape.status, 400);
    const missingCredential = await call("POST", "/v1/runs", {
      body: { taskId: task.id, models: { checker: { model: "x", credentialId: "00000000-0000-4000-8000-000000000000" } } },
    });
    assert.equal(missingCredential.status, 404);

    const again = await call("POST", "/v1/runs", {
      body: { taskId: task.id, models: { maker: { model: "gpt-5-mini", provider: "openai" }, checker: [{ model: "claude-opus-4-1", provider: "anthropic" }] } },
    });
    assert.equal(again.status, 202, JSON.stringify(again.body));
    assert.notEqual(again.body.engineeringRunId, first.id);
    assert.deepEqual(enqueued, [again.body.engineeringRunId]);
    const run = await getEngineeringRun(pool, again.body.engineeringRunId);
    assert.equal(run.taskId, task.id);
    assert.deepEqual(run.modelOverride, {
      maker: { model: "gpt-5-mini", provider: "openai" },
      checker: [{ model: "claude-opus-4-1", provider: "anthropic" }],
    });
    // The task's own choice is untouched: the re-run's is the run's.
    const { rows } = await pool.query("select model_override from engineering_task where id = $1", [task.id]);
    assert.deepEqual(rows[0].model_override, { maker: { model: "gpt-5" } });
    assert.equal((await getEngineeringRun(pool, first.id)).modelOverride, null);

    // While that run is live, another choice is refused — even while it is still CREATED.
    const live = await call("POST", "/v1/runs", { body: { taskId: task.id, models: { maker: "gpt-5" } } });
    assert.equal(live.status, 409);
    assert.equal(live.body.code, "run_in_flight");
  });
});

test("a re-run's models resolve over the task's into the new run's snapshot, marked as the run's", { skip }, async () => {
  await withApi(async ({ pool, org }) => {
    await putModelPolicy(pool, { organizationId: org, repositoryId: null, role: "checker", provider: "anthropic", model: "claude-opus-4-1" });
    const snapshot = await resolveRunModels(pool, {
      organizationId: org,
      repositoryId: REPO_ID,
      taskOverride: { maker: { model: "gpt-5" }, checker: [{ model: "claude-sonnet-4-5", provider: "anthropic" }] },
      runOverride: { maker: { model: "gpt-5-mini" } },
      operatorDefaults: operatorModelDefaults(stageConfig()),
      worker: "codex",
    });
    assert.equal(snapshot.maker.model, "gpt-5-mini");
    assert.equal(snapshot.maker.source, "run");
    assert.equal(snapshot.maker.provider, "openai", "a bare model inherits the provider beneath it");
    assert.equal(snapshot.checker[0].model, "claude-sonnet-4-5", "the role the re-run didn't name is the task's");
    assert.equal(snapshot.checker[0].source, "task");

    await assert.rejects(
      resolveRunModels(pool, {
        organizationId: org,
        repositoryId: REPO_ID,
        taskOverride: null,
        runOverride: { maker: { model: "claude-sonnet-4-5", provider: "anthropic", harness: "claude-code" } },
        operatorDefaults: operatorModelDefaults(stageConfig()),
        worker: "codex",
      }),
      (error) => error instanceof ModelPolicyError && error.code === "harness_unavailable" && /drives the maker with codex/.test(error.message),
    );
  });
});

test("intake freezes a re-run's choice; a run that already has a snapshot keeps it", { skip }, async () => {
  await withApi(async ({ pool }) => {
    const task = await seedTask(pool, { maker: { model: "gpt-5" } });
    const run = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: 25,
      wallClockCapSeconds: 7200,
      modelOverride: { maker: { model: "gpt-5-mini", provider: "openai" } },
    });
    const deps = {
      pool,
      sandboxes: new FakeSandboxProvider(),
      worker: new FakeWorkerAdapter([]),
      registry: new SandboxRegistry(),
      sessions: new WorkerSessionRegistry(),
      config: stageConfig(),
    };
    const drive = async (runId) => {
      const provider = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool) });
      for (const handler of createIntakeHandlers(deps)) provider.register(handler);
      await provider.start();
      try {
        await provider.startRun(runId);
        await provider.drain();
      } finally {
        await provider.stop();
      }
      return getEngineeringRun(pool, runId);
    };
    const after = await drive(run.id);
    assert.equal(after.modelConfig.maker.model, "gpt-5-mini");
    assert.equal(after.modelConfig.maker.source, "run");
    assert.equal(after.selectedModel, "gpt-5-mini");

    // Nothing re-resolves a frozen run: a later change to its override row is not read.
    const frozen = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    const snapshot = { ...after.modelConfig, maker: { ...after.modelConfig.maker, model: "gpt-5-codex", source: "task" } };
    await updateEngineeringRun(pool, frozen.id, { modelConfig: snapshot });
    await pool.query("update engineering_run set model_override = $2 where id = $1", [frozen.id, JSON.stringify({ maker: { model: "gpt-5-nano", provider: "openai" } })]);
    const kept = await drive(frozen.id);
    assert.equal(kept.modelConfig.maker.model, "gpt-5-codex");
  });
});
