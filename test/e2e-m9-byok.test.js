import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { FakeGitHubClient } from "../dist/github/fake.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { getEngineeringRun, listAgentRuns } from "../dist/factory/repositories.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { runEnqueuer } from "../apps/ingress/dist/src/windkeel-actions.js";
import {
  adapterFor,
  bareFixtureRepo,
  branchHeadsIn,
  codexFixture,
  FIXTURE_REPOSITORY_ID,
  installStubCodex,
  makerSandbox,
  redirectPushes,
  repoRoot,
  seedFixtureRepository,
  TEST_POOL,
} from "./helpers.js";
import { startFactory } from "./factory-stack.js";
import { closeWorkflowRuntime, dataDir, endExecutions, runtimeSkip } from "./workflow-runtime.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * **Milestone 9's success criterion, end to end** (#326): an organization runs the factory on its
 * own model keys and its own model choices, independence is enforced, and every dollar is
 * attributed to whose key paid.
 *
 *     POST /v1/model-credentials (sealed with the public key; ingress cannot read it)
 *       → PUT /v1/model-policy (maker on OpenRouter `openai/…`, checker on `anthropic/…`)
 *       → POST /v1/tasks
 *       → intake: the snapshot frozen on the run, independence checked on derived vendors
 *       → provisioning → implementing: the real Codex adapter over the stub `codex`, told
 *         `--model` and the `-c model_providers…` override, its key a brokered value
 *       → verifying: review and mapping on the organization's checker key, through the guarded
 *         transport, to a scripted OpenRouter on loopback
 *       → cost events attributed `customer`, per credential
 *       → a verified draft pull request
 *
 * Real: Postgres, the Workflow runtime and `VercelWorkflowProvider`, the ingress API router, the
 * stage handlers, the Codex adapter, the credential broker's rules, the sealed box, the policy
 * resolver, the checker's `fetch`-based gateway and its transport guard. Fakes, at the edges only:
 * `FakeSandboxProvider` (local directories), a stub `codex` binary replaying a recorded session,
 * `FakeGitHubClient`, and an HTTP server on loopback standing in for OpenRouter
 * (`WINDKEEL_ALLOW_LOCALHOST_MODEL_BASE_URL=1`, the guard's own development flag).
 *
 * **What this does not prove**, stated here as well as in `research/MILESTONES.md`: no real model
 * was called, so whether OpenRouter honours exactly what Codex is told — and whether the pinned
 * Codex binary accepts the `-c model_providers.windkeel={…}` syntax — is the live run's to show
 * (#318), not this suite's. The maker's key is checked as a broker rule whose resolver yields the
 * opened value; a fake sandbox has no egress proxy to attach it.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);

process.env.WINDKEEL_ALLOW_LOCALHOST_MODEL_BASE_URL = "1";

const PAIR = generateSecretKeyPair();
const BOOTSTRAP = "m9-e2e-bootstrap-token";
/** Shaped like an OpenRouter key so a leak would also trip a pattern scan; neither is real. */
const MAKER_KEY = "sk-or-v1-MakerE2eKey7vB2mN4pL8sW1yH6jD3fA5gC";
const CHECKER_KEY = "sk-or-v1-CheckerE2eKey0Zx9QqRt7vB2mN4pL8sW";
const MAKER_MODEL = "openai/gpt-5-codex";
const CHECKER_MODEL = "anthropic/claude-sonnet-4.5";

const OWNER = "jyothepro";
const NAME = `windkeel-fixture-${FIXTURE_REPOSITORY_ID.slice(0, 8)}`;
const CLONE_URL = `https://github.com/${OWNER}/${NAME}.git`;
const CRITERION = "`node index.js` prints hello";
const CHECK_JS = `const { execFileSync } = require("node:child_process");
const out = execFileSync(process.execPath, ["index.js"], { encoding: "utf8" }).trim();
if (out !== "hello") { console.error("expected hello, got " + JSON.stringify(out)); process.exit(1); }
`;

// --- the scripted OpenRouter ---------------------------------------------------------------------

/** Every request the "provider" received: the path, the bearer it was sent, and the model. */
const requests = [];
let server;
let checkerBase;

const USAGE = { prompt_tokens: 1200, completion_tokens: 80 };

/** Review and mapping are told apart by their system prompts (`providers/prompt.ts`). */
function answer(body) {
  const system = (body.messages ?? []).find((m) => m.role === "system")?.content ?? "";
  if (/adversarial code reviewer/.test(system)) {
    return { summary: "no defects found", findings: [] };
  }
  if (/acceptance\s+criteria/.test(system)) {
    return {
      mappings: [{ criterion: "AC1", status: "satisfied", evidence: ["ev-01"], reason: "the repository's own check passes" }],
    };
  }
  return {};
}

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push({ path: req.url, authorization: req.headers.authorization, model: body.model });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(answer(body)) }, finish_reason: "stop" }],
          usage: USAGE,
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  checkerBase = `http://localhost:${server.address().port}/api/v1`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeWorkflowRuntime();
});

// --- the stack -----------------------------------------------------------------------------------

let counter = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultBranchOf(bare) {
  const result = spawnSync("git", ["--git-dir", bare, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" });
  return (result.stdout || "main").trim();
}

/**
 * The stub `codex`, wrapped so a turn really edits the checkout — the verifier re-runs the
 * repository's own check on the candidate, so a turn that changed nothing would rightly fail.
 */
async function installMaker(host) {
  const stub = await installStubCodex(host, { fixture: codexFixture("successful-session") });
  const dir = stub.binPath.slice(0, stub.binPath.lastIndexOf("/"));
  const wrapper = `${dir}/codex-maker`;
  await host.writeFile(
    wrapper,
    [
      "#!/bin/sh",
      `if [ "$1" != "--version" ]; then printf 'console.log("hello");\\n' > index.js; fi`,
      `exec ${stub.binPath} "$@"`,
      "",
    ].join("\n"),
  );
  await host.exec("chmod", { args: ["+x", wrapper] });
  return { ...stub, binPath: wrapper };
}

/**
 * `FakeSandboxProvider`, cloning the local bare repository wherever the row says github.com, and
 * recording what was created so a case can say "no sandbox existed". `onCreate` runs after each.
 */
function sandboxes(bare, created, onCreate) {
  const inner = new FakeSandboxProvider();
  return {
    name: inner.name,
    capabilities: inner.capabilities,
    async create(options) {
      const handle = redirectPushes(
        await inner.create({ ...options, repoUrl: options.repoUrl === CLONE_URL ? bare : options.repoUrl }),
        CLONE_URL,
        bare,
      );
      created.push({ options, handle });
      if (onCreate) await onCreate(options);
      return handle;
    },
    attach: (options) => inner.attach(options),
  };
}

async function withStack(fn, { onCreate } = {}) {
  const schema = `windkeel_m9e2e_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const schemaUrl = `${schemaDbUrl}${schemaDbUrl.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  const pool = new Pool({ connectionString: schemaDbUrl, max: 4, idleTimeoutMillis: 1_000, options: `-c search_path=${schema}` });

  const remote = bareFixtureRepo({ test: "node check.js" }, { "check.js": CHECK_JS, "index.js": 'console.log("hi");\n' });
  const defaultBranch = defaultBranchOf(remote.bare);
  const github = new FakeGitHubClient(
    { repositories: [{ owner: OWNER, name: NAME, defaultBranch, issues: [] }] },
    { resolveBranchHead: branchHeadsIn(remote.bare) },
  );
  const stubHost = await makerSandbox();
  const stub = await installMaker(stubHost);
  const created = [];
  const enqueue = runEnqueuer({ connectionString: schemaDbUrl, applicationSchema: schema, backing: "vercel-workflow" });
  const ctx = { pool };
  let stack;
  requests.length = 0;

  try {
    await seedFixtureRepository(pool, { cloneUrl: CLONE_URL, defaultBranch });

    stack = await startFactory(
      {
        databaseUrl: schemaUrl,
        repository: { url: remote.bare, baseRevision: "HEAD" },
        // The operator's defaults, which a configured organization must not fall back to.
        makerModel: "gpt-5-codex",
        makerVendor: "openai",
        modelApiDomain: "api.openai.com",
        modelKeyEnvVar: "OPENAI_API_KEY",
        // Nothing pinned: both roles are priced from the catalog for the snapshot's models (#324).
        modelPricing: {},
        checkerPricing: {},
        usdPerCpuMs: 0,
        usdPerEgressByte: 0,
        railsCheckIntervalMs: 1_000,
        workspaceTtlMs: 600_000,
        gitHost: "github.com",
        gitAuthorName: "Windkeel Factory",
        gitAuthorEmail: "factory@windkeel.invalid",
        policyVersion: "m9-e2e",
        codex: { binary: stub.binPath, pinnedVersion: "0.0.0-e2e", allowVersionDrift: false },
        // No Windkeel-managed checker at all: a fallback to Windkeel's key would have nowhere to go but
        // a refusal, so a verified run proves the customer endpoint answered.
        checkerEndpoints: [],
        secretPrivateKey: PAIR.privateKey,
      },
      {
        applicationSchema: schema,
        sandboxes: sandboxes(remote.bare, created, onCreate ? (options) => onCreate(options, ctx) : undefined),
        worker: adapterFor(stub.binPath, { makerModelKeyEnvVar: "OPENAI_API_KEY" }),
        github,
      },
    );
    stack.deps.config.fakeSecurity = join(repoRoot, "test", "fixtures", "no-scanners.json");
    stack.deps.evidence = { storage: { putPackage: async () => {}, deletePackage: async () => {} }, bucket: "evidence" };

    // The ingress's API, holding only the public key — it can seal and cannot open.
    const deps = {
      pool,
      control: { enqueue: (runId) => enqueue.startRun(runId) },
      secretPublicKey: PAIR.publicKey,
      modelEndpoint: { allowLocalhostHttp: true, resolve: async () => ["93.184.216.34"] },
    };
    const auth = { token: BOOTSTRAP, subject: "operator" };
    ctx.api = (method, target, body) =>
      handleApiRequest(deps, auth, {
        method,
        path: target.split("?")[0],
        query: new URLSearchParams(target.includes("?") ? target.slice(target.indexOf("?")) : ""),
        headers: { authorization: `Bearer ${BOOTSTRAP}` },
        body,
      });
    Object.assign(ctx, { schema, github, stub, created, handles: () => created.map((c) => c.handle) });
    await fn(ctx);
  } finally {
    await endExecutions(pool).catch(() => {});
    await stack?.stop().catch(() => {});
    await enqueue.stop().catch(() => {});
    for (const { handle } of created) await handle.destroy().catch(() => {});
    await stubHost.destroy().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

/** Both credentials and the organization's policy, through the API as a person would set them. */
async function configureOrganization(api, { checkerModel = CHECKER_MODEL } = {}) {
  const maker = await api("POST", "/v1/model-credentials", { provider: "openrouter", label: "team-router", value: MAKER_KEY });
  assert.equal(maker.status, 201, JSON.stringify(maker.body));
  const checker = await api("POST", "/v1/model-credentials", {
    provider: "openrouter",
    label: "review-router",
    value: CHECKER_KEY,
    baseUrl: checkerBase,
  });
  assert.equal(checker.status, 201, JSON.stringify(checker.body));
  for (const response of [maker, checker]) {
    assert.equal(response.body.credential.status, "unverified");
    assert.ok(!JSON.stringify(response.body).includes(MAKER_KEY) && !JSON.stringify(response.body).includes(CHECKER_KEY));
  }

  const policy = await api("PUT", "/v1/model-policy", {
    maker: { provider: "openrouter", model: MAKER_MODEL, credentialId: maker.body.credential.id },
    checker: { provider: "openrouter", model: checkerModel, credentialId: checker.body.credential.id },
  });
  assert.equal(policy.status, 200, JSON.stringify(policy.body));
  return { maker: maker.body.credential, checker: checker.body.credential };
}

async function createTask(api) {
  const created = await api("POST", "/v1/tasks", {
    repositoryId: FIXTURE_REPOSITORY_ID,
    title: "Say hello",
    description: `Make index.js print hello.\n\n- [ ] ${CRITERION}`,
    riskLevel: "low",
  });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  return created.body.engineeringRunId;
}

const SETTLED = ["WAITING_FOR_HUMAN", "COMPLETED", "BLOCKED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED", "CANCELLED"];

async function settled(pool, runId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getEngineeringRun(pool, runId);
    if (run && SETTLED.includes(run.status)) return run;
    await sleep(200);
  }
  throw new Error(`run ${runId} never settled`);
}

async function path(pool, runId) {
  const { rows } = await pool.query(
    "select from_state, to_state, reason from run_state_transition where engineering_run_id = $1 order by at, id",
    [runId],
  );
  return rows;
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

/** What the Workflow World journalled — step arguments and results, decoded as well as raw. */
function journal() {
  const files = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  let raw = "";
  try {
    raw = files(dataDir).map((file) => readFileSync(file).toString("utf8")).join("\n");
  } catch {
    return "";
  }
  const decoded = [...raw.matchAll(/"data":\s*"([A-Za-z0-9+/=]+)"/g)]
    .map((match) => Buffer.from(match[1], "base64").toString("utf8"))
    .join("\n");
  return `${raw}\n${decoded}`;
}

async function assertKeysNowhere({ pool, schema, handles, stub }, runId) {
  const rows = await everyRow(pool, schema);
  const calls = JSON.stringify(handles().map((h) => h.calls));
  const argv = await stub.invocations();
  const journalled = journal();
  // Proof the search can see what crosses a step boundary, so the absence below is not vacuous.
  assert.ok(journalled.includes(runId), "the run's id is in the journal");
  for (const key of [MAKER_KEY, CHECKER_KEY]) {
    assert.ok(!rows.includes(key), "not in any row");
    assert.ok(!calls.includes(key), "not in a sandbox env or call");
    assert.ok(!argv.includes(key), "not in Codex's argv");
    assert.ok(!journalled.includes(key), "not across a step boundary");
  }
}

// --- the cases -----------------------------------------------------------------------------------

test(
  "BYOK end to end: credentials and policy via the API, a frozen snapshot, Codex on OpenRouter, the checker on the org's key, cost attributed customer, a verified PR",
  { skip, timeout: 300_000 },
  async () => {
    await withStack(async (ctx) => {
      const { pool, api, github, stub, created } = ctx;
      const credentials = await configureOrganization(api);
      const runId = await createTask(api);
      const run = await settled(pool, runId);
      const transitions = await path(pool, runId);
      assert.equal(
        run.status,
        "WAITING_FOR_HUMAN",
        `the run ended ${run.status}: ${transitions.map((t) => `${t.to_state}${t.reason ? ` (${t.reason})` : ""}`).join(" → ")}`,
      );
      assert.equal(run.finalVerdict, "pass", "verified");
      assert.ok(run.prNumber, "with a pull request");
      assert.equal((await github.listPullRequests({ repository: { owner: OWNER, name: NAME }, state: "all" })).length, 1);

      // Intake froze the snapshot: derived vendors, both on the organization's credentials.
      const snapshot = run.modelConfig;
      assert.equal(snapshot.maker.provider, "openrouter");
      assert.equal(snapshot.maker.model, MAKER_MODEL);
      assert.equal(snapshot.maker.vendor, "openai");
      assert.equal(snapshot.maker.keySource, "customer");
      assert.equal(snapshot.maker.credentialId, credentials.maker.id);
      assert.equal(snapshot.maker.source, "organization");
      assert.equal(snapshot.checker.length, 1);
      assert.equal(snapshot.checker[0].model, CHECKER_MODEL);
      assert.equal(snapshot.checker[0].vendor, "anthropic", "derived from the model, not the router");
      assert.equal(snapshot.checker[0].credentialId, credentials.checker.id);
      assert.equal(run.selectedModel, MAKER_MODEL);
      const detail = await api("GET", `/v1/runs/${runId}`);
      assert.equal(detail.status, 200);
      assert.deepEqual(detail.body.run?.modelConfig ?? detail.body.modelConfig, snapshot, "the API shows the snapshot");

      // The maker: told its model and provider, and its key a brokered value for openrouter.ai.
      const [implementer] = (await listAgentRuns(pool, runId)).filter((r) => r.role === "implementer");
      assert.equal(implementer.model, MAKER_MODEL, "agent_run.model is what Codex was told");
      const argv = await stub.invocations();
      assert.match(argv, /--model openai\/gpt-5-codex -c model_provider="windkeel" -c model_providers\.windkeel=\{ name = "Windkeel openrouter", base_url = "https:\/\/openrouter\.ai\/api\/v1", env_key = "CODEX_API_KEY"/);
      const maker = created.find((c) => c.options.role === "maker");
      assert.equal(maker.options.operatorModelKey, false, "Windkeel's maker key is kept out from create onwards");
      const brokered = maker.handle.calls.filter((c) => c.type === "credentialBroker").flatMap((c) => c.rules);
      assert.ok(brokered.length > 0);
      for (const rule of brokered) {
        assert.equal(rule.domain, "openrouter.ai");
        assert.equal(rule.secretEnvVar, undefined, "a value, not the operator's variable");
      }
      assert.equal(await brokered[0].resolveSecret(), MAKER_KEY, "the egress proxy would be handed the customer's key");
      const launch = maker.handle.calls.find((c) => c.type === "exec" && c.options?.env?.CODEX_API_KEY !== undefined);
      assert.ok(launch, "Codex was launched in the maker sandbox");
      assert.notEqual(launch.options.env.CODEX_API_KEY, MAKER_KEY, "the sandbox sees a placeholder");

      // The checker: every call to the scripted OpenRouter, on the organization's checker key.
      assert.ok(requests.length >= 2, `review and mapping both called the provider (${requests.length})`);
      for (const request of requests) {
        assert.equal(request.path, "/api/v1/chat/completions");
        assert.equal(request.authorization, `Bearer ${CHECKER_KEY}`);
        assert.equal(request.model, CHECKER_MODEL);
      }

      // Cost: every model event is the customer's, named by credential, priced from the catalog.
      const { rows: costs } = await pool.query(
        "select stage_type, usd, tokens_in, tokens_out, key_source, credential_id from cost_event where engineering_run_id = $1 and kind = 'model'",
        [runId],
      );
      assert.ok(costs.length >= 2);
      for (const cost of costs) {
        assert.equal(cost.key_source, "customer", `${cost.stage_type} was paid by the customer`);
        assert.ok(cost.usd !== null, `${cost.stage_type} is priced`);
      }
      const makerCost = costs.find((c) => c.stage_type === "agent_run");
      assert.equal(makerCost.credential_id, credentials.maker.id);
      // openai/gpt-5-codex: $1.25 in, $0.125 cached, $10 out per million; the fixture's turn is
      // 12,400 in of which 8,000 cached, 980 out.
      assert.ok(Math.abs(Number(makerCost.usd) - (4400 * 1.25e-6 + 8000 * 0.125e-6 + 980 * 10e-6)) < 1e-12);
      const checkerCosts = costs.filter((c) => c.stage_type !== "agent_run");
      assert.ok(checkerCosts.length > 0);
      for (const cost of checkerCosts) assert.equal(cost.credential_id, credentials.checker.id);
      // anthropic/claude-sonnet-4.5 is Anthropic's claude-sonnet-4-5 price ($3 in, $15 out per
      // million) for each of the scripted provider's answers (1,200 in, 80 out).
      const checkerUsd = checkerCosts.reduce((sum, c) => sum + Number(c.usd), 0);
      assert.ok(Math.abs(checkerUsd - requests.length * (1200 * 3e-6 + 80 * 15e-6)) < 1e-12, `checker cost ${checkerUsd}`);

      const cost = await api("GET", `/v1/runs/${runId}/cost`);
      assert.equal(cost.status, 200, JSON.stringify(cost.body));
      assert.deepEqual(cost.body.bySource.map((s) => s.keySource), ["customer"], "no model spend on Windkeel's keys");
      assert.equal(cost.body.unpricedEvents, 0);

      await assertKeysNowhere(ctx, runId);
    });
  },
);

test("a dependent pairing fails at intake, by reason, before any sandbox exists", { skip, timeout: 120_000 }, async () => {
  await withStack(async (ctx) => {
    const { pool, api, created } = ctx;
    // The checker on another OpenAI model: an OpenRouter route does not make it independent.
    await configureOrganization(api, { checkerModel: "openai/gpt-5" });
    const runId = await createTask(api);
    const run = await settled(pool, runId);
    assert.equal(run.status, "FAILED");
    assert.equal(run.stopReason, "model_policy");
    const transitions = await path(pool, runId);
    const failed = transitions.find((t) => t.to_state === "FAILED");
    assert.match(failed.reason, /no checker model is independent of the maker/);
    assert.match(failed.reason, /ADR-0026 §5/);
    assert.ok(
      !transitions.some((t) => ["PROVISIONING", "IMPLEMENTING"].includes(t.to_state)),
      `failed at intake: ${transitions.map((t) => t.to_state).join(" → ")}`,
    );
    assert.equal(created.length, 0, "no sandbox was provisioned");
    assert.equal(requests.length, 0, "no model was called");
    assert.equal(run.modelConfig.checker[0].vendor, "openai", "the refused snapshot is kept, to show why");
    await assertKeysNowhere(ctx, runId);
  });
});

test("a credential revoked mid-run fails the run naming it, with no fallback to Windkeel's key", { skip, timeout: 120_000 }, async () => {
  await withStack(
    async (ctx) => {
      const { pool, api, created } = ctx;
      const credentials = await configureOrganization(api);
      ctx.makerCredentialId = credentials.maker.id;
      const runId = await createTask(api);
      const run = await settled(pool, runId);
      assert.equal(run.status, "FAILED");
      assert.equal(run.stopReason, "model_policy");
      const transitions = await path(pool, runId);
      const failed = transitions.find((t) => t.to_state === "FAILED");
      assert.equal(failed.from_state, "IMPLEMENTING", "after intake and provisioning had used it");
      assert.match(failed.reason, /"team-router" is revoked/);
      assert.equal((await listAgentRuns(pool, runId)).length, 0, "no agent was started on another key");
      assert.equal(created.filter((c) => c.options.role === "maker").length, 1, "one sandbox, no retry");
      const operatorRules = created
        .flatMap((c) => c.handle.calls)
        .filter((c) => c.type === "credentialBroker")
        .flatMap((c) => c.rules)
        .filter((r) => r.secretEnvVar !== undefined || r.domain !== "openrouter.ai");
      assert.deepEqual(operatorRules, [], "Windkeel's key was never brokered");
      assert.equal(requests.length, 0);
      const { rows } = await pool.query(
        "select count(*)::int as n from cost_event where engineering_run_id = $1 and key_source = 'orqon'",
        [runId],
      );
      assert.equal(rows[0].n, 0, "nothing was spent on Windkeel's key");
      const listed = await api("GET", "/v1/model-credentials?include=revoked");
      assert.equal(listed.body.items.find((c) => c.id === credentials.maker.id).status, "revoked");
      await assertKeysNowhere(ctx, runId);
    },
    {
      // Revoked through the API the moment the maker's sandbox exists: the snapshot and the
      // provisioning stage have both already accepted it.
      onCreate: async (options, ctx) => {
        if (options.role !== "maker") return;
        const revoked = await ctx.api("DELETE", `/v1/model-credentials/${ctx.makerCredentialId}`);
        assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
      },
    },
  );
});

