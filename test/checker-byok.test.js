/**
 * The checker on an organization's own key (ADR-0026 §3, §6, §7; M9-4 #322).
 *
 * The "provider" is a scripted OpenRouter on localhost, reached through the same guarded transport
 * a deployment uses (`WINDKEEL_ALLOW_LOCALHOST_MODEL_BASE_URL=1` is the guard's own development flag).
 * The global `fetch` — what a Windkeel-managed checker call would use — is replaced with one that
 * fails the test, so "no fallback to Windkeel's key" is observed rather than inferred. No real provider
 * is called and no real key exists.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import { getEngineeringRun, insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { getModelCredential, putModelCredential } from "../dist/factory/model-credentials.js";
import { putModelPolicy } from "../dist/factory/model-policy.js";
import { assembleRunReport } from "../dist/factory/run-report.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { withCheckerModels, CheckerKeyError } from "../dist/factory/workflow/checker-models.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createIntakeHandlers } from "../dist/factory/workflow/handlers/intake.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { selectGateway } from "@windkeel/verification/providers/index.js";
import { FIXTURE_REPOSITORY_ID, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

process.env.WINDKEEL_ALLOW_LOCALHOST_MODEL_BASE_URL = "1";

const PAIR = generateSecretKeyPair();
/** Shaped like no known vendor's key, so only the by-value scrub can catch it. */
const KEY = "custkey-Zx9QqRt7vB2mN4pL8sW1yH6jD3fA5gC0";
const OPERATOR_ANTHROPIC_KEY = "operator-anthropic-not-real-0000";

// --- the scripted provider ----------------------------------------------------------------------

/** What the next request gets: `{ status, body }`. Each request is recorded. */
let script = () => ({ status: 200, body: completion("{}") });
const requests = [];
let server;
let base;

function completion(content, usage = { prompt_tokens: 1200, completion_tokens: 80 }) {
  return { choices: [{ message: { content }, finish_reason: "stop" }], usage };
}

const realFetch = globalThis.fetch;
before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const request = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw || "{}") };
      requests.push(request);
      const { status, body } = script(request);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://localhost:${server.address().port}/api/v1`;
  // A Windkeel-managed checker call goes through the global fetch. None may happen here.
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected call through the global fetch to ${url}: a fallback to another key`);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

// --- the factory --------------------------------------------------------------------------------

function stageConfig() {
  return {
    repository: { url: "/nonexistent", baseRevision: "HEAD" },
    makerModel: "gpt-5-codex",
    makerVendor: "openai",
    modelApiDomain: "api.openai.com",
    modelKeyEnvVar: "OPENAI_API_KEY",
    modelPricing: { usdPerInputToken: 0, usdPerOutputToken: 0 },
    checkerPricing: { usdPerInputToken: 0.000001, usdPerOutputToken: 0.00001 },
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
    checkerModels: {
      endpoints: [{ vendor: "anthropic", model: "claude-sonnet-4-5", apiKey: OPERATOR_ANTHROPIC_KEY }],
      maker: { vendor: "openai", model: "gpt-5-codex" },
    },
  };
}

let counter = 0;
async function withSchema(fn) {
  const schema = `windkeel_checkerbyok_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  requests.length = 0;
  try {
    await seedFixtureRepository(pool);
    const { rows } = await pool.query("select id from organization where is_default");
    const org = rows[0].id;
    const credential = await putModelCredential(pool, {
      organizationId: org,
      provider: "openrouter",
      baseUrl: base,
      label: "team-router",
      value: KEY,
      publicKey: PAIR.publicKey,
      endpoint: { allowLocalhostHttp: true },
    });
    await putModelPolicy(pool, {
      organizationId: org,
      repositoryId: null,
      role: "checker",
      model: "google/gemini-2.5-pro",
      credentialId: credential.id,
    });
    await fn({ pool, org, credential });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

async function seedRun(pool, { criteria = [] } = {}) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: FIXTURE_REPOSITORY_ID,
    sourceType: "local",
    sourceReference: "cli",
    title: "Add retries",
    description: "Uploads fail on a 500 and nothing retries them.",
    acceptanceCriteria: criteria,
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  return insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
}

function makeDeps(pool) {
  return {
    pool,
    sandboxes: new FakeSandboxProvider(),
    worker: new FakeWorkerAdapter([]),
    registry: new SandboxRegistry(),
    sessions: new WorkerSessionRegistry(),
    config: stageConfig(),
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
    "select reason from run_state_transition where engineering_run_id = $1 order by seq desc limit 1",
    [runId],
  );
  return rows[0]?.reason ?? null;
}

/** Every text column a run, its transitions, its costs and the credential's status could hold. */
async function everythingWritten(pool) {
  const { rows } = await pool.query(`
    select coalesce((select json_agg(r)::text from engineering_run r), '') ||
           coalesce((select json_agg(t)::text from run_state_transition t), '') ||
           coalesce((select json_agg(c)::text from cost_event c), '') ||
           coalesce((select json_agg(k.status_reason)::text from model_credential k), '') as text`);
  return rows[0].text;
}

const GENERATED = JSON.stringify({ criteria: [{ text: "retries a 500 three times" }, { text: "reports the final failure" }] });

// --- tests --------------------------------------------------------------------------------------

test("criteria are generated on the organization's key, and their tokens are recorded", { skip }, async () => {
  await withSchema(async ({ pool, credential }) => {
    script = () => ({ status: 200, body: completion(GENERATED) });
    const run = await seedRun(pool);
    const after = await drive(pool, makeDeps(pool), run.id);
    assert.equal(after.status, "WAITING_FOR_APPROVAL", await lastReason(pool, run.id));

    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/api/v1/chat/completions");
    assert.equal(requests[0].authorization, `Bearer ${KEY}`, "the customer's key, not the operator's");
    assert.equal(requests[0].body.model, "google/gemini-2.5-pro");

    const { rows } = await pool.query(
      "select stage_type, stage_id, kind, tokens_in, tokens_out, usd, key_source, credential_id from cost_event where engineering_run_id = $1",
      [run.id],
    );
    assert.equal(rows.length, 1, "criteria generation is a cost event now");
    assert.equal(rows[0].kind, "model");
    // Its own stage since migration 0031, under the run's id (no verification exists yet).
    assert.equal(rows[0].stage_type, "criteria");
    assert.equal(rows[0].stage_id, run.id);
    assert.equal(rows[0].tokens_in, 1200);
    assert.equal(rows[0].tokens_out, 80);
    // The pinned `WINDKEEL_CHECKER_USD_PER_*` wins over the catalog's Gemini price.
    assert.equal(Number(rows[0].usd), 1200 * 0.000001 + 80 * 0.00001);
    // Whose key paid, and which of the organization's credentials (#324).
    assert.equal(rows[0].key_source, "customer");
    assert.equal(rows[0].credential_id, credential.id);
    assert.ok(!(await everythingWritten(pool)).includes(KEY));
  });
});

test("with nothing pinned, the checker's call is priced from the catalog for its model (#324)", { skip }, async () => {
  await withSchema(async ({ pool }) => {
    script = () => ({ status: 200, body: completion(GENERATED) });
    const run = await seedRun(pool);
    const deps = makeDeps(pool);
    deps.config.checkerPricing = {};
    const after = await drive(pool, deps, run.id);
    assert.equal(after.status, "WAITING_FOR_APPROVAL", await lastReason(pool, run.id));
    const { rows } = await pool.query("select usd, key_source from cost_event where engineering_run_id = $1", [run.id]);
    // google/gemini-2.5-pro: $1.25 in, $10 out per million (catalog, verified 2026-10-06).
    assert.ok(Math.abs(Number(rows[0].usd) - (1200 * 1.25e-6 + 80 * 10e-6)) < 1e-12);
    assert.equal(rows[0].key_source, "customer");
    const { rows: [planning] } = await pool.query(
      "select reason from run_state_transition where engineering_run_id = $1 and to_state = 'PLANNING'",
      [run.id],
    );
    assert.equal(planning.reason, "no separate plan; the maker plans", "priced models need no note");
  });
});

test("a checker model the catalog does not know is recorded unpriced, not $0 (#324)", { skip }, async () => {
  await withSchema(async ({ pool, org, credential }) => {
    await putModelPolicy(pool, {
      organizationId: org,
      repositoryId: null,
      role: "checker",
      model: "google/gemini-9-experimental",
      credentialId: credential.id,
    });
    script = () => ({ status: 200, body: completion(GENERATED) });
    const run = await seedRun(pool);
    const deps = makeDeps(pool);
    deps.config.checkerPricing = {};
    const after = await drive(pool, deps, run.id);
    assert.equal(after.status, "WAITING_FOR_APPROVAL", await lastReason(pool, run.id));
    const { rows } = await pool.query(
      "select usd, tokens_in, key_source from cost_event where engineering_run_id = $1",
      [run.id],
    );
    assert.equal(rows[0].usd, null, "unknown is not zero");
    assert.equal(rows[0].tokens_in, 1200, "the tokens are still recorded");
    assert.equal(rows[0].key_source, "customer");
    const report = await assembleRunReport(pool, run.id);
    assert.equal(report.cost.unpricedModelCalls, 1);
    assert.deepEqual(report.cost.modelBySource.map((s) => [s.keySource, s.unpricedCalls]), [["customer", 1]]);
    // Said at intake, before any spend: the cap will count this model at the conservative estimate.
    const { rows: [planning] } = await pool.query(
      "select reason from run_state_transition where engineering_run_id = $1 and to_state = 'PLANNING'",
      [run.id],
    );
    assert.match(planning.reason, /checker google\/gemini-9-experimental has no catalog price/);
    assert.match(planning.reason, /spend cap counts those tokens at the conservative estimate/);
    assert.equal(after.stopReason ?? null, null, "a note, not a refusal");
  });
});

test("a review runs on the customer key, in the call and nowhere else", { skip }, async () => {
  await withSchema(async ({ pool }) => {
    // Stated criteria: intake freezes the snapshot without a model call.
    const run = await seedRun(pool, {
      criteria: [{ id: "AC1", text: "retries a 500", source: { kind: "explicit", ref: "cli" } }],
    });
    const deps = makeDeps(pool);
    await drive(pool, deps, run.id);
    assert.equal(requests.length, 0);

    const review = JSON.stringify({ summary: "looks right", findings: [] });
    script = () => ({ status: 200, body: completion(review) });
    const author = { login: "fake", kind: "agent", agent: "fake/gpt-5-codex" };
    const { text, keySource } = await withCheckerModels(deps, run.id, async (policy, checker) => {
      const gateway = selectGateway(policy, author, "review");
      assert.equal(gateway.vendor, "google", "vendor derived from the model, not the router");
      const response = await gateway.generate({ system: "review", user: "diff" });
      return { text: response.text, keySource: checker.keySource };
    });
    assert.equal(text, review);
    assert.equal(keySource, "customer");
    assert.equal(requests[0].authorization, `Bearer ${KEY}`);
    assert.ok(!JSON.stringify(deps.config).includes(KEY), "the key is not left on deps");
    assert.deepEqual(Object.keys(deps).sort(), ["config", "pool", "registry", "sandboxes", "sessions", "worker"]);
  });
});

test("a 401 marks the credential invalid and fails the run naming it; no other key is tried", { skip }, async () => {
  await withSchema(async ({ pool, org, credential }) => {
    // A provider that echoes what it was sent, as some do.
    script = (request) => ({ status: 401, body: { error: { message: `bad key: ${request.authorization}` } } });
    const run = await seedRun(pool);
    const after = await drive(pool, makeDeps(pool), run.id);
    assert.equal(after.status, "FAILED");
    assert.equal(after.stopReason, "model_policy");
    const reason = await lastReason(pool, run.id);
    assert.match(reason, /refused the checker's model credential "team-router" \(HTTP 401\)/);
    assert.match(reason, /will not use another key/);
    assert.equal(requests.length, 1, "no retry, and the global fetch (Windkeel's key) was never reached");

    const stored = await getModelCredential(pool, org, credential.id);
    assert.equal(stored.status, "invalid");
    assert.match(stored.statusReason, /HTTP 401/);
    assert.ok(!(await everythingWritten(pool)).includes(KEY));
  });
});

test("a 429 fails the run as retryable later, and leaves the credential alone", { skip }, async () => {
  await withSchema(async ({ pool, org, credential }) => {
    script = () => ({ status: 429, body: { error: { message: "rate limited" } } });
    const run = await seedRun(pool);
    const after = await drive(pool, makeDeps(pool), run.id);
    assert.equal(after.status, "FAILED");
    assert.equal(after.stopReason, "model_policy");
    assert.match(await lastReason(pool, run.id), /"team-router" is rate-limited or out of quota .*retry the run later/);
    assert.equal(requests.length, 1);
    assert.equal((await getModelCredential(pool, org, credential.id)).status, "unverified");
  });
});

test("any other failure keeps today's handling, with the key scrubbed out by value", { skip }, async () => {
  await withSchema(async ({ pool }) => {
    script = (request) => ({ status: 500, body: { error: `upstream rejected ${request.authorization}` } });
    const run = await seedRun(pool);
    const after = await drive(pool, makeDeps(pool), run.id);
    assert.equal(after.status, "FAILED");
    assert.equal(after.stopReason, "error");
    const reason = await lastReason(pool, run.id);
    assert.match(reason, /500/);
    assert.match(reason, /\[redacted\]/);
    assert.ok(!(await everythingWritten(pool)).includes(KEY));
  });
});

test("a deployment without the private key refuses rather than using Windkeel's", { skip }, async () => {
  await withSchema(async ({ pool }) => {
    const run = await seedRun(pool);
    const deps = makeDeps(pool);
    delete deps.config.secretPrivateKey;
    const after = await drive(pool, deps, run.id);
    assert.equal(after.status, "FAILED");
    assert.equal(after.stopReason, "model_policy");
    assert.match(await lastReason(pool, run.id), /no WINDKEEL_SECRET_PRIVATE_KEY to open it/);
    assert.equal(requests.length, 0);
    await assert.rejects(withCheckerModels(deps, run.id, async () => "unreached"), CheckerKeyError);
  });
});
