/**
 * The maker on the run's models (ADR-0026 §7, M9-5 #323).
 *
 * The pass criterion: `agent_run.model` equals what Codex was told to use, and a customer key never
 * appears in a sandbox env, a row, a log, or a step payload. Driven with the stub `codex` in a
 * `FakeSandboxProvider` sandbox — the real adapter, the real stages, the real broker rules — and no
 * provider is ever called: the stub replays a recording, and a resolver rule is opened only by the
 * test itself, to check what a provider *would* have been handed.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { CODEX_API_KEY_PLACEHOLDER, resolvedModelKeyRule } from "../dist/sandbox/credential-broker.js";
import { WorkerRouteChangedError } from "../dist/worker/adapter.js";
import { codexModelArgs } from "../dist/worker/codex/adapter.js";
import { getModelCredential, putModelCredential, revokeModelCredential } from "../dist/factory/model-credentials.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { getEngineeringRun, insertEngineeringRun, insertEngineeringTask, listAgentRuns } from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { classifyMakerFailure, MakerCredentialUnavailableError, MakerRouteError, makerRouteFor } from "../dist/factory/workflow/maker-route.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { createImplementingHandler } from "../dist/factory/workflow/handlers/implementing.js";
import {
  adapterFor,
  bareFixtureRepo,
  codexFixture,
  FIXTURE_REPOSITORY_ID,
  installStubCodex,
  makerSandbox,
  repoRoot,
  seedFixtureRepository,
  TEST_POOL,
} from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const PAIR = generateSecretKeyPair();
/** Shaped like an OpenRouter key so a leak would also trip a pattern scan; not a real one. */
const KEY = "sk-or-v1-Mk5RtB8nQ2vX7cL4pW9zH1jD6fA3gE0yU";
const ROUTER_MODEL = "openai/gpt-5-codex";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

async function drain(adapter, session) {
  for await (const _event of adapter.events(session)) {
    // consumed for its side effects
  }
}

/** A route the way `makerRouteFor` builds one for an OpenRouter credential, with a counting resolver. */
function routerRoute(opened = { count: 0 }) {
  return {
    model: ROUTER_MODEL,
    provider: "openrouter",
    modelApiDomain: "openrouter.ai",
    credentialRules: [
      resolvedModelKeyRule(
        "openrouter.ai",
        async () => {
          opened.count++;
          return KEY;
        },
        "team-router",
      ),
    ],
  };
}

// --- the argv -----------------------------------------------------------------------------------

test("Codex is always told its model; a non-default provider is a -c override pointing at the placeholder", () => {
  assert.deepEqual(codexModelArgs({ model: "gpt-5-codex", provider: "openai" }), ["--model", "gpt-5-codex"]);
  assert.deepEqual(
    codexModelArgs({ model: "gpt-5-codex", provider: "openai-compatible" }),
    ["--model", "gpt-5-codex"],
    "no base URL to point at: Codex's built-in provider, as before M9",
  );
  assert.deepEqual(codexModelArgs({ model: ROUTER_MODEL, provider: "openrouter" }), [
    "--model",
    ROUTER_MODEL,
    "-c",
    'model_provider="windkeel"',
    "-c",
    `model_providers.windkeel={ name = "Windkeel openrouter", base_url = "${OPENROUTER_BASE}", env_key = "CODEX_API_KEY", wire_api = "responses" }`,
  ]);
  const custom = codexModelArgs({ model: "qwen3-coder", provider: "openai-compatible", baseUrl: "https://llm.example.com/v1" });
  assert.match(custom.at(-1), /base_url = "https:\/\/llm\.example\.com\/v1"/);
});

test("a provider's 401 and 429 are told apart from an agent failure", () => {
  assert.equal(classifyMakerFailure("unexpected status 401 Unauthorized: invalid key"), "unauthorized");
  assert.equal(classifyMakerFailure("model provider returned 429 after 3 retries"), "rate_limited");
  assert.equal(classifyMakerFailure("insufficient_quota"), "rate_limited");
  assert.equal(classifyMakerFailure("the agent could not install dependencies"), null);
  assert.equal(classifyMakerFailure(undefined), null);
});

// --- the adapter --------------------------------------------------------------------------------

test("the adapter launches Codex on the route: --model, the provider override, the provider's host, the placeholder", async () => {
  const handle = await makerSandbox();
  try {
    const stub = await installStubCodex(handle, {
      fixtures: [codexFixture("successful-session"), codexFixture("resumed-turn")],
    });
    const adapter = adapterFor(stub.binPath, { makerModelKeyEnvVar: "OPENAI_API_KEY" });
    const opened = { count: 0 };
    handle.calls.length = 0;
    const session = await adapter.start({ prompt: "fix the pager", sandbox: handle, route: routerRoute(opened) });
    await drain(adapter, session);

    const launch = handle.calls.findIndex((c) => c.type === "exec" && c.options?.env?.WINDKEEL_RUNNER !== undefined);
    const before = handle.calls.slice(0, launch);
    const lastPolicy = [...before].reverse().find((c) => c.type === "policy");
    const lastRules = [...before].reverse().find((c) => c.type === "credentialBroker");
    assert.deepEqual(lastPolicy.policy, { mode: "allowlist", allowedDomains: ["openrouter.ai"] });
    assert.equal(lastRules.rules.length, 1);
    assert.equal(lastRules.rules[0].domain, "openrouter.ai");
    assert.equal(lastRules.rules[0].secretEnvVar, undefined, "not the operator's variable");
    assert.equal(await lastRules.rules[0].resolveSecret(), KEY, "a provider applying it gets the opened value");
    assert.ok(
      handle.calls.every((c) => c.type !== "credentialBroker" || c.rules.every((r) => r.domain === "openrouter.ai")),
      "Windkeel's key is never brokered on this session",
    );

    const env = handle.calls[launch].options.env;
    assert.equal(env.CODEX_API_KEY, CODEX_API_KEY_PLACEHOLDER);
    assert.ok(!Object.values(env).join(" ").includes(KEY));

    // A repair turn resumes on the same model and provider, flags before `resume`.
    await adapter.send(session, { text: "again" });
    await drain(adapter, session);
    const invoked = await stub.invocations();
    const turns = invoked.split(/^exec /m).filter(Boolean);
    assert.equal(turns.length, 2);
    for (const turn of turns) {
      assert.match(turn, /--ignore-user-config --model openai\/gpt-5-codex -c model_provider="windkeel" -c model_providers\.windkeel=\{ /);
      assert.match(turn, /env_key = "CODEX_API_KEY"/);
    }
    assert.match(turns[1], /wire_api = "responses" \} resume 01JQ8Z9Y2K3M4N5P6Q7R8S9T0V /);
    assert.ok(!invoked.includes(KEY));

    // The reference names the model, never a rule; a different model on the next delivery is refused.
    const ref = adapter.reference(session);
    assert.deepEqual(ref.adapterState.startedOn, { model: ROUTER_MODEL, provider: "openrouter" });
    assert.ok(!JSON.stringify(ref).includes(KEY));
    assert.throws(
      () => adapter.useRoute(session, { ...routerRoute(), model: "anthropic/claude-opus-4.1" }),
      WorkerRouteChangedError,
    );
    // In another process: the reference alone holds the session to the model it started on.
    const elsewhere = adapterFor(stub.binPath);
    const reattached = await elsewhere.attach(ref, handle);
    assert.throws(() => elsewhere.useRoute(reattached, { ...routerRoute(), model: "openai/gpt-5" }), WorkerRouteChangedError);
    elsewhere.useRoute(reattached, routerRoute());
  } finally {
    await handle.destroy();
  }
});

// --- the stages ---------------------------------------------------------------------------------

const STAGE_CONFIG = {
  makerModel: "gpt-5-codex",
  makerVendor: "openai",
  modelApiDomain: "api.openai.com",
  modelKeyEnvVar: "OPENAI_API_KEY",
  // Nothing pinned: the maker is priced from the catalog for the run's own model (#324).
  modelPricing: {},
  usdPerCpuMs: 0,
  usdPerEgressByte: 0,
  railsCheckIntervalMs: 60_000,
  workspaceTtlMs: 60_000,
  gitHost: "github.com",
  gitAuthorName: "Windkeel Factory",
  gitAuthorEmail: "factory@windkeel.invalid",
  secretPrivateKey: PAIR.privateKey,
};

function snapshotWith(maker) {
  return { version: 1, maker: { worker: "codex", source: "organization", ...maker }, checker: [], resolvedAt: new Date().toISOString(), policyIds: [] };
}

function routerMaker(credential) {
  return {
    provider: "openrouter",
    vendor: "openai",
    model: ROUTER_MODEL,
    credentialId: credential.id,
    credentialLabel: credential.label,
    keySource: "customer",
  };
}

let counter = 0;

/**
 * A schema, a run at PROVISIONING with the snapshot `modelConfig(org)` returns (none for null), and
 * the provisioning and implementing stages wired to the real Codex adapter over a stub binary.
 */
async function withRun(fn, { modelConfig = null, fixture = codexFixture("successful-session"), before, afterProvisioning, config = {} } = {}) {
  const schema = `windkeel_makerbyok_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "true" });
  const stubHost = await makerSandbox();
  const registry = new SandboxRegistry();
  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    const { rows } = await pool.query("select id from organization where is_default");
    const org = rows[0].id;
    const credential = await putModelCredential(pool, {
      organizationId: org,
      provider: "openrouter",
      label: "team-router",
      value: KEY,
      publicKey: PAIR.publicKey,
    });
    const task = await insertEngineeringTask(pool, {
      repositoryId: FIXTURE_REPOSITORY_ID,
      sourceType: "local",
      sourceReference: "m9.5",
      title: "Add a greeting",
      description: "Make index.js print hello.",
      acceptanceCriteria: [{ id: "ac-1", text: "index.js prints hello" }],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    for (const to of ["CLASSIFYING", "PLANNING", "PROVISIONING"]) await advanceRun(pool, run.id, to, "test seed");
    const snapshot = modelConfig ? modelConfig(credential) : null;
    if (snapshot) await pool.query("update engineering_run set model_config = $2 where id = $1", [run.id, snapshot]);
    if (before) await before({ pool, org, credential });

    const stub = await installStubCodex(stubHost, { fixture });
    const diagnostics = [];
    const fake = new FakeSandboxProvider();
    const creates = [];
    const handles = [];
    const deps = {
      pool,
      sandboxes: {
        name: fake.name,
        capabilities: fake.capabilities,
        async create(options) {
          creates.push(options);
          const handle = await fake.create(options);
          handles.push(handle);
          return handle;
        },
        attach: fake.attach?.bind(fake),
      },
      worker: adapterFor(stub.binPath, {
        makerModelKeyEnvVar: "OPENAI_API_KEY",
        onDiagnostic: (d) => diagnostics.push(d),
      }),
      registry,
      sessions: new WorkerSessionRegistry(),
      config: { ...STAGE_CONFIG, ...config, repository: { url: remote.bare, baseRevision: "HEAD" } },
    };
    // The fake re-queues a poll at once (it has no clock), and the stub takes real time to replay,
    // so a session is many polls. The cycle guard is for handlers that loop, not for a live agent.
    const provider = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool), maxSteps: 100_000 });
    const provisioning = createProvisioningHandler(deps);
    provider.register({
      ...provisioning,
      async handle(context) {
        const outcome = await provisioning.handle(context);
        if (afterProvisioning) await afterProvisioning({ pool, org, credential });
        return outcome;
      },
    });
    provider.register(createImplementingHandler(deps));
    await provider.start();
    try {
      await provider.startRun(run.id);
      await provider.drain();
    } finally {
      await provider.stop();
    }
    await fn({ pool, org, credential, run, deps, stub, creates, handles, diagnostics, schema });
  } finally {
    for (const [, handle] of registry.entries()) await handle.destroy().catch(() => {});
    await stubHost.destroy().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

async function lastReason(pool, runId) {
  const { rows } = await pool.query(
    "select reason from run_state_transition where engineering_run_id = $1 and to_state = 'FAILED'",
    [runId],
  );
  return rows[0]?.reason ?? null;
}

/** Every row of every table in the schema, as text. Where a leaked key would have to be. */
async function everyRow(pool, schema) {
  const { rows: tables } = await pool.query(
    "select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE'",
    [schema],
  );
  const dump = [];
  for (const { table_name: table } of tables) {
    const { rows } = await pool.query(`select t::text as text from "${table}" t`);
    dump.push(...rows.map((r) => r.text));
  }
  return dump.join("\n");
}

test("a customer OpenRouter key: Codex told the model, egress to openrouter.ai, the key opened only by the broker", { skip }, async () => {
  await withRun(
    async ({ pool, run, stub, creates, handles, diagnostics, schema }) => {
      const [implementer] = (await listAgentRuns(pool, run.id)).filter((r) => r.role === "implementer");
      assert.ok(implementer, `the session ran (${await lastReason(pool, run.id)})`);
      const invoked = await stub.invocations();
      assert.equal(implementer.model, ROUTER_MODEL);
      assert.match(invoked, new RegExp(`--model ${ROUTER_MODEL.replace("/", "\\/")} `), "agent_run.model is what Codex was told");
      assert.match(invoked, /model_providers\.windkeel=\{ name = "Windkeel openrouter", base_url = "https:\/\/openrouter\.ai\/api\/v1"/);

      // Windkeel's key is kept out of the sandbox from create onwards, and nothing is brokered for install.
      assert.equal(creates.length, 1);
      assert.equal(creates[0].operatorModelKey, false);
      const maker = handles[0];
      const brokered = maker.calls.filter((c) => c.type === "credentialBroker");
      assert.ok(brokered.length > 0);
      assert.ok(brokered.every((c) => c.rules.length === 1 && c.rules[0].domain === "openrouter.ai"));
      const first = maker.calls.indexOf(brokered[0]);
      // The sandbox is narrowed to the execution phase *before* the key is brokered (ORQ-15), so
      // the key is never in force alongside the install phase's allowlist, even between calls.
      assert.deepEqual(
        maker.calls[first - 1],
        { type: "policy", policy: { mode: "allowlist", allowedDomains: ["openrouter.ai"] } },
        "the key first rides an execution-phase transition, never the install phase",
      );
      assert.equal(await brokered[0].rules[0].resolveSecret(), KEY);

      // Never in a sandbox env, a row, a log, or the recorded calls.
      for (const call of maker.calls.filter((c) => c.type === "exec")) {
        assert.ok(!JSON.stringify(call.options ?? {}).includes(KEY), call.command);
      }
      assert.ok(!JSON.stringify(maker.calls).includes(KEY), "rules hold a resolver, which serialises to nothing");
      assert.ok(!(await everyRow(pool, schema)).includes(KEY));
      assert.ok(!JSON.stringify(diagnostics).includes(KEY));
      assert.ok(!invoked.includes(KEY));

      // The pass criterion of #324: the customer's key is reported as the customer's, priced from
      // the catalog for the snapshot's model (openai/gpt-5-codex: $1.25 in, $0.125 cached, $10 out
      // per million). The fixture's turn: 12,400 in of which 8,000 cached, 980 out.
      const { rows: costs } = await pool.query(
        "select usd, key_source, credential_id from cost_event where engineering_run_id = $1 and stage_type = 'agent_run'",
        [run.id],
      );
      assert.equal(costs.length, 1);
      assert.equal(costs[0].key_source, "customer");
      assert.ok(costs[0].credential_id, "the credential that paid is named");
      assert.ok(Math.abs(Number(costs[0].usd) - (4400 * 1.25e-6 + 8000 * 0.125e-6 + 980 * 10e-6)) < 1e-12);
      assert.ok(Math.abs(implementer.modelCost - Number(costs[0].usd)) < 1e-12);
    },
    { modelConfig: (credential) => snapshotWith(routerMaker(credential)) },
  );
});

test("a run with no snapshot keeps the operator's maker and now tells Codex its model", { skip }, async () => {
  await withRun(async ({ pool, run, stub, creates, handles }) => {
    const [implementer] = await listAgentRuns(pool, run.id);
    assert.equal(implementer.model, "gpt-5-codex");
    const invoked = await stub.invocations();
    assert.match(invoked, /--ignore-user-config --model gpt-5-codex -- /, "the built-in provider, no override");
    assert.equal(creates[0].operatorModelKey, undefined);
    const rules = handles[0].calls.filter((c) => c.type === "credentialBroker").flatMap((c) => c.rules);
    assert.ok(rules.length > 0);
    assert.ok(rules.every((r) => r.domain === "api.openai.com" && r.secretEnvVar === "OPENAI_API_KEY"));
    const { rows: costs } = await pool.query(
      "select usd, key_source, credential_id from cost_event where engineering_run_id = $1 and stage_type = 'agent_run'",
      [run.id],
    );
    assert.deepEqual(costs.map((c) => [c.key_source, c.credential_id]), [["orqon", null]]);
    assert.ok(Number(costs[0].usd) > 0, "gpt-5-codex is in the catalog");
  });
});

const fixtureFailing = (message) =>
  [
    '{"type":"thread.started","thread_id":"01JQ8ZBYOKFAIL0000000000"}',
    '{"type":"turn.started"}',
    JSON.stringify({ type: "turn.failed", error: { message } }),
    "",
  ].join("\n");

test("a 401 from the provider fails the run by name and marks the credential invalid; no fallback", { skip }, async () => {
  await withRun(
    async ({ pool, org, credential, run, creates }) => {
      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "FAILED");
      assert.equal(after.stopReason, "model_policy");
      const reason = await lastReason(pool, run.id);
      assert.match(reason, /"team-router" was refused by openrouter\.ai \(401 Unauthorized\) and is now marked invalid/);
      assert.match(reason, /did not fall back to Windkeel's key/);
      const stored = await getModelCredential(pool, org, credential.id);
      assert.equal(stored.status, "invalid");
      assert.equal(creates.length, 1, "one sandbox, no retry on another key");
    },
    {
      modelConfig: (credential) => snapshotWith(routerMaker(credential)),
      fixture: fixtureFailing("unexpected status 401 Unauthorized: No auth credentials found"),
    },
  );
});

test("a 429 fails the run with a retry-later reason and leaves the credential as it was", { skip }, async () => {
  await withRun(
    async ({ pool, org, credential, run }) => {
      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "FAILED");
      assert.match(await lastReason(pool, run.id), /"team-router" was rate-limited or out of quota at openrouter\.ai \(429\); retry the run later/);
      assert.equal((await getModelCredential(pool, org, credential.id)).status, "unverified");
    },
    {
      modelConfig: (credential) => snapshotWith(routerMaker(credential)),
      fixture: fixtureFailing("exceeded retry limit, last status: 429 Too Many Requests"),
    },
  );
});

test("a revoked credential fails at provisioning, by name, before a sandbox exists", { skip }, async () => {
  await withRun(
    async ({ pool, run, creates }) => {
      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "FAILED");
      assert.equal(after.stopReason, "model_policy");
      assert.equal(creates.length, 0);
      assert.match(await lastReason(pool, run.id), /"team-router" is revoked/);
    },
    {
      modelConfig: (credential) => snapshotWith(routerMaker(credential)),
      // Revoked between intake and provisioning: the snapshot still names it.
      before: ({ pool, org, credential }) => revokeModelCredential(pool, org, credential.id),
    },
  );
});

test("the route refuses what the maker cannot use: a private base_url, Anthropic's API, Windkeel's key elsewhere", { skip }, async () => {
  const schema = `windkeel_makerroute_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const { rows } = await pool.query("select id from organization where is_default");
    const org = rows[0].id;
    // Stored while its host resolved publicly…
    const proxy = await putModelCredential(pool, {
      organizationId: org,
      provider: "openai-compatible",
      baseUrl: "https://llm.example.test/v1",
      declaredVendor: "alibaba",
      label: "self-hosted",
      value: KEY,
      publicKey: PAIR.publicKey,
      endpoint: { resolve: async () => ["93.184.216.34"] },
    });
    const task = await insertEngineeringTask(pool, {
      repositoryId: FIXTURE_REPOSITORY_ID,
      sourceType: "local",
      sourceReference: "m9.5",
      title: "t",
      description: "d",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    const deps = (maker) => ({
      pool,
      runModels: async () => snapshotWith(maker),
      config: STAGE_CONFIG,
      worker: { name: "codex" },
    });
    const proxyMaker = {
      provider: "openai-compatible",
      vendor: "alibaba",
      model: "qwen3-coder",
      baseUrl: "https://llm.example.test/v1",
      credentialId: proxy.id,
      credentialLabel: "self-hosted",
      keySource: "customer",
    };

    // …and to the cloud metadata address now: refused, not sent the key.
    await assert.rejects(
      makerRouteFor(deps(proxyMaker), run.id, { resolve: async () => ["169.254.169.254"] }),
      (err) => err instanceof MakerRouteError && /169\.254\.169\.254/.test(err.message) && /"self-hosted"/.test(err.message),
    );
    const publicRoute = await makerRouteFor(deps(proxyMaker), run.id, { resolve: async () => ["93.184.216.34"] });
    assert.equal(publicRoute.route.modelApiDomain, "llm.example.test", "egress narrows to the base_url's host");
    assert.equal(publicRoute.model, "qwen3-coder");
    assert.ok(!JSON.stringify(publicRoute).includes(KEY));
    assert.equal(await publicRoute.route.credentialRules[0].resolveSecret(), KEY);

    await assert.rejects(
      makerRouteFor(deps({ provider: "anthropic", vendor: "anthropic", model: "claude-sonnet-4-5", keySource: "orqon" }), run.id),
      /Codex cannot call/,
    );
    await assert.rejects(
      makerRouteFor(deps({ provider: "openrouter", vendor: "openai", model: ROUTER_MODEL, keySource: "orqon" }), run.id),
      /Windkeel-managed maker key is for api\.openai\.com/,
    );
    await pool.query("update model_credential set status = 'invalid', status_reason = 'probe said 401' where id = $1", [proxy.id]);
    await assert.rejects(makerRouteFor(deps(proxyMaker), run.id), /"self-hosted" is marked invalid \(probe said 401\)/);
    await revokeModelCredential(pool, org, proxy.id);
    await assert.rejects(makerRouteFor(deps(proxyMaker), run.id), /"self-hosted" is revoked/);
    await assert.rejects(
      makerRouteFor({ ...deps(proxyMaker), config: { ...STAGE_CONFIG, secretPrivateKey: undefined } }, run.id),
      /no WINDKEEL_SECRET_PRIVATE_KEY/,
    );
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
});

/** The pass criterion's "never anywhere", for a run that failed on its key. */
async function assertKeyNowhere({ pool, schema, handles, diagnostics, stub }) {
  assert.ok(!(await everyRow(pool, schema)).includes(KEY), "not in any row");
  for (const { calls } of handles) assert.ok(!JSON.stringify(calls).includes(KEY), "not in a sandbox env or call");
  assert.ok(!JSON.stringify(diagnostics).includes(KEY), "not in a log");
  assert.ok(!(await stub.invocations()).includes(KEY), "not in Codex's argv");
}

test("a credential revoked between provisioning and implementing fails the run by name, without retries", { skip }, async () => {
  await withRun(
    async (ctx) => {
      const { pool, run } = ctx;
      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "FAILED");
      assert.equal(after.stopReason, "model_policy");
      assert.match(await lastReason(pool, run.id), /"team-router" is revoked/);
      assert.equal((await listAgentRuns(pool, run.id)).length, 0, "no agent was started on it");
      const { rows } = await pool.query(
        "select count(*)::int as n from run_state_transition where engineering_run_id = $1 and from_state = 'IMPLEMENTING'",
        [run.id],
      );
      assert.equal(rows[0].n, 1, "one decision, not a retry loop");
      await assertKeyNowhere(ctx);
    },
    {
      modelConfig: (credential) => snapshotWith(routerMaker(credential)),
      afterProvisioning: ({ pool, org, credential }) => revokeModelCredential(pool, org, credential.id),
    },
  );
});

test("a credential that stops opening at a phase change fails the run by name, not by retry", { skip }, async () => {
  // Sealed to a pair this deployment does not hold: the row looks fine, and the open at the
  // implementing stage's first phase change is what fails — inside the broker rule's resolver.
  const other = generateSecretKeyPair();
  await withRun(
    async (ctx) => {
      const { pool, run, handles } = ctx;
      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "FAILED");
      assert.equal(after.stopReason, "model_policy");
      const reason = await lastReason(pool, run.id);
      assert.match(reason, /"team-router" became unusable during the run: it could not be opened/);
      assert.match(reason, /will not run on Windkeel's key instead/);
      assert.ok(handles[0].calls.some((c) => c.type === "credentialBroker"), "it failed at a phase change");
      const { rows } = await pool.query(
        "select count(*)::int as n from run_state_transition where engineering_run_id = $1 and from_state = 'IMPLEMENTING'",
        [run.id],
      );
      assert.equal(rows[0].n, 1);
      await assertKeyNowhere(ctx);
    },
    {
      modelConfig: (credential) => snapshotWith(routerMaker(credential)),
      config: { secretPrivateKey: other.privateKey },
    },
  );
});

test("the resolver turns a revocation after the route was built into a named, typed error", { skip }, async () => {
  await withRun(
    async ({ pool, org, credential, run, deps }) => {
      const route = await makerRouteFor(deps, run.id);
      assert.equal(await route.route.credentialRules[0].resolveSecret(), KEY);
      await revokeModelCredential(pool, org, credential.id);
      await assert.rejects(
        route.route.credentialRules[0].resolveSecret(),
        (err) =>
          err instanceof MakerCredentialUnavailableError &&
          err instanceof MakerRouteError &&
          /"team-router" became unusable during the run: it was revoked/.test(err.message) &&
          !err.message.includes(KEY),
      );
    },
    {
      modelConfig: (credential) => snapshotWith(routerMaker(credential)),
    },
  );
});
