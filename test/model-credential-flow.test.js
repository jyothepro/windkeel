/**
 * The credential check end to end through the real Workflow runtime (M9-2, #320).
 *
 * `startModelCredentialValidation` — what ingress calls — starts `orqonValidateModelCredentialFlow`
 * by id in a local World, the built bundle executes its one step, and the step opens the value and
 * asks an OpenAI-compatible endpoint this file serves on loopback. No model provider is contacted.
 *
 * The assertion worth the setup is the last one: **the World's journal never holds the value.**
 * Step arguments and results are persisted; ADR-0026 §3 says only ids may cross that boundary, and
 * this reads every byte the World wrote to check that it is so.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { getModelCredential, putModelCredential } from "../dist/factory/model-credentials.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { startModelCredentialValidation } from "../dist/factory/workflow/vercel.js";
import { TEST_POOL } from "./helpers.js";
import { closeWorkflowRuntime, dataDir, runtimeSkip, workflowRuntime } from "./workflow-runtime.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);
const KEY = "sk-proj-FlowTestKey0123456789abcdef";

after(async () => {
  await closeWorkflowRuntime();
});

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/**
 * Every byte the World wrote, and every base64 blob in it decoded. The World stores step inputs
 * and outputs as base64 of a serialised payload, so the raw files alone would pass a search for the
 * key vacuously.
 */
function readJournal() {
  const raw = filesUnder(dataDir).map((file) => readFileSync(file).toString("utf8")).join("\n");
  const decoded = [...raw.matchAll(/"data":\s*"([A-Za-z0-9+/=]+)"/g)]
    .map((match) => Buffer.from(match[1], "base64").toString("utf8"))
    .join("\n");
  return { decoded, journal: `${raw}\n${decoded}` };
}

test("ingress's start runs the check on the step host, and the journal never holds the key", { skip }, async () => {
  const schema = `windkeel_credflow_${Date.now()}_${process.pid}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });

  const seen = [];
  const provider = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise((done) => provider.listen(0, "127.0.0.1", done));

  const pair = generateSecretKeyPair();
  const saved = {};
  const env = {
    // The step reads its database and keys from the environment, as it does when deployed.
    DATABASE_URL: `${schemaDbUrl}${schemaDbUrl.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`,
    DATABASE_POOL_URL: undefined,
    WINDKEEL_SECRET_PRIVATE_KEY: pair.privateKey,
    WINDKEEL_SECRET_PREVIOUS_PRIVATE_KEY: undefined,
    WINDKEEL_ALLOW_LOCALHOST_MODEL_BASE_URL: "1",
  };
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  try {
    const { rows } = await pool.query("select id from organization where is_default");
    const organizationId = rows[0].id;
    const stored = await putModelCredential(pool, {
      organizationId,
      provider: "openai-compatible",
      label: "local",
      baseUrl: `http://localhost:${provider.address().port}/v1`,
      value: KEY,
      publicKey: pair.publicKey,
      endpoint: { allowLocalhostHttp: true },
    });

    const { world } = await workflowRuntime();
    const { executionId } = await startModelCredentialValidation(organizationId, stored.id, { world });

    let credential = stored;
    for (let i = 0; i < 200 && credential.status === "unverified"; i++) {
      await new Promise((done) => setTimeout(done, 100));
      credential = await getModelCredential(pool, organizationId, stored.id);
    }
    assert.equal(credential.status, "valid", credential.statusReason ?? "still unverified after 20s");
    assert.deepEqual(seen, [{ url: "/v1/models", authorization: `Bearer ${KEY}` }]);

    // The row turns `valid` inside the step, before the step's result is journalled and the run
    // ends. Read the journal only once the run has finished, or it can be missing the result.
    let run = await world.runs.get(executionId, { resolveData: "none" });
    for (let i = 0; i < 300 && !["completed", "failed", "cancelled"].includes(run.status); i++) {
      await new Promise((done) => setTimeout(done, 100));
      run = await world.runs.get(executionId, { resolveData: "none" });
    }
    assert.equal(run.status, "completed", `the check's run ended ${run.status}`);

    // A finished run should already have the step's output on disk, but the assertion is about the
    // journal, so wait on the journal itself (#352): up to 5s for the result to appear. The key
    // checks below then search that final read, never a partial one.
    let { decoded, journal } = readJournal();
    for (let i = 0; i < 50 && !decoded.includes("valid"); i++) {
      await new Promise((done) => setTimeout(done, 100));
      ({ decoded, journal } = readJournal());
    }

    // The ids are asserted present first — proof the search can see what crosses the boundary.
    assert.ok(decoded.includes(stored.id) && decoded.includes(organizationId), "the step's ids are in the journal");
    assert.ok(decoded.includes("valid"), "and so is its result");
    assert.ok(!journal.includes(KEY), "the key crossed a step boundary into the journal");
    assert.ok(!journal.includes(KEY.slice(8)), "nor any recognisable part of it");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise((done) => provider.close(done));
    await pool.end();
    await dropMigratedDatabase(schema);
  }
});
