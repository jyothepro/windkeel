/**
 * Organization model credentials (ADR-0026 §1–3, M9-2 #320): the store, the one reader, and the
 * stage-side check.
 *
 * The assertions that matter are the pass criteria: **a ciphertext moved to another organization's
 * row fails to open**, and **nothing a reader can call returns a value**. The rest — rotation, soft
 * revocation, the check's status mapping — is what makes those two properties survive ordinary use.
 *
 * No test here reaches a model provider. The check takes an injected probe; the real probe is
 * driven against a loopback server this file starts, under the localhost development flag.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Pool } from "pg";
import {
  ModelCredentialError,
  getModelCredential,
  listModelCredentials,
  openModelCredential,
  putModelCredential,
  revokeModelCredential,
  rotateModelCredential,
} from "../dist/factory/model-credentials.js";
import { httpProbe, validateModelCredential } from "../dist/factory/model-credential-validation.js";
import { generateSecretKeyPair, keypairIdOf } from "../dist/factory/secret-box.js";
import { redactSecrets } from "../dist/factory/log.js";
import { TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const PAIR = generateSecretKeyPair();
const KEY = "sk-proj-Zx9QqRt7vB2mN4pL8sW1yH6jD3fA5gC0";
const resolve = async () => ["93.184.216.34"];

let counter = 0;
async function withSchema(fn) {
  const schema = `windkeel_modelcred_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    const { rows: def } = await pool.query("select id from organization where is_default");
    const { rows: other } = await pool.query(
      `insert into organization (account_id, name) select account_id, 'platform' from organization where is_default
       returning id`,
    );
    await fn({ pool, orgA: def[0].id, orgB: other[0].id });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

function put(pool, organizationId, overrides = {}) {
  return putModelCredential(pool, {
    organizationId,
    provider: "openai",
    label: "prod",
    value: KEY,
    publicKey: PAIR.publicKey,
    endpoint: { resolve },
    ...overrides,
  });
}

// --- the store -------------------------------------------------------------------------------

test("put stores a sealed value, unverified, and nothing it returns carries the value", { skip }, async () => {
  await withSchema(async ({ pool, orgA }) => {
    const stored = await put(pool, orgA);
    assert.equal(stored.status, "unverified");
    assert.equal(stored.last4, KEY.slice(-4));
    assert.equal(stored.keypairId, keypairIdOf(PAIR.publicKey));
    assert.ok(!("value" in stored) && !("sealedValue" in stored), "the view has no field for a value");

    const listed = await listModelCredentials(pool, orgA);
    assert.deepEqual(listed.map((c) => c.label), ["prod"]);
    const serialised = JSON.stringify([stored, listed, await getModelCredential(pool, orgA, stored.id)]);
    assert.ok(!serialised.includes(KEY), "no reader may return the value");
    assert.ok(!serialised.includes("orqonsealv2"), "no reader may return the ciphertext either");

    const { rows } = await pool.query("select sealed_value, keypair_id from model_credential");
    assert.match(rows[0].sealed_value, /^orqonsealv2\./);
    assert.ok(!rows[0].sealed_value.includes(KEY));
    assert.equal(rows[0].keypair_id, stored.keypairId);

    const opened = await openModelCredential(pool, PAIR.privateKey, orgA, stored.id);
    assert.equal(opened.value, KEY);
  });
});

test("a ciphertext moved to another organization's row fails to open", { skip }, async () => {
  await withSchema(async ({ pool, orgA, orgB }) => {
    const mine = await put(pool, orgA);
    const theirs = await put(pool, orgB, { value: "sk-their-own-key-0000" });
    // Someone with write access to the table copies A's sealed value into B's row.
    await pool.query(
      `update model_credential set sealed_value = (select sealed_value from model_credential where id = $1)
        where id = $2`,
      [mine.id, theirs.id],
    );
    await assert.rejects(
      () => openModelCredential(pool, PAIR.privateKey, orgB, theirs.id),
      (err) => err.name === "SealedSecretError" && /authentication failed/.test(err.message) && !err.message.includes(KEY),
    );
    // And moving the whole row to the other organization does not help either.
    await pool.query("update model_credential set organization_id = $1, label = 'moved' where id = $2", [orgB, mine.id]);
    await assert.rejects(() => openModelCredential(pool, PAIR.privateKey, orgB, mine.id), /authentication failed/);
  });
});

test("another organization cannot open a credential by id, and gets the same answer as for none", { skip }, async () => {
  await withSchema(async ({ pool, orgA, orgB }) => {
    const stored = await put(pool, orgA);
    for (const [org, id] of [
      [orgB, stored.id],
      [orgA, "00000000-0000-4000-8000-000000000000"],
      [orgA, "not-a-uuid"],
    ]) {
      await assert.rejects(
        () => openModelCredential(pool, PAIR.privateKey, org, id),
        (err) => err instanceof ModelCredentialError && err.status === 404,
      );
    }
    assert.equal(await getModelCredential(pool, orgB, stored.id), null);
    assert.deepEqual(await listModelCredentials(pool, orgB), []);
    assert.equal(await revokeModelCredential(pool, orgB, stored.id), null, "revoke is scoped too");
    assert.equal(
      await rotateModelCredential(pool, { organizationId: orgB, credentialId: stored.id, value: "sk-x-12345678", publicKey: PAIR.publicKey }),
      null,
      "rotate is scoped too",
    );
  });
});

test("rotate replaces the value under the same id and resets the status", { skip }, async () => {
  await withSchema(async ({ pool, orgA }) => {
    const stored = await put(pool, orgA);
    await pool.query("update model_credential set status = 'valid', validated_at = now() where id = $1", [stored.id]);
    const rotated = await rotateModelCredential(pool, {
      organizationId: orgA,
      credentialId: stored.id,
      value: "sk-proj-SecondValue9876",
      publicKey: PAIR.publicKey,
    });
    assert.equal(rotated.id, stored.id);
    assert.equal(rotated.status, "unverified", "nothing has been seen to work with the new value");
    assert.equal(rotated.validatedAt, null);
    assert.equal(rotated.last4, "9876");
    assert.equal((await openModelCredential(pool, PAIR.privateKey, orgA, stored.id)).value, "sk-proj-SecondValue9876");
  });
});

test("revoke is soft and final: the row stays, the ciphertext is gone, and nothing opens it", { skip }, async () => {
  await withSchema(async ({ pool, orgA }) => {
    const stored = await put(pool, orgA);
    const revoked = await revokeModelCredential(pool, orgA, stored.id);
    assert.equal(revoked.status, "revoked");
    assert.ok(revoked.revokedAt instanceof Date);
    const { rows } = await pool.query("select sealed_value from model_credential where id = $1", [stored.id]);
    assert.equal(rows[0].sealed_value, "", "a revoked key is not kept, even sealed");

    await assert.rejects(
      () => openModelCredential(pool, PAIR.privateKey, orgA, stored.id),
      (err) => err instanceof ModelCredentialError && err.code === "credential_revoked",
    );
    assert.equal(
      await rotateModelCredential(pool, { organizationId: orgA, credentialId: stored.id, value: "sk-again-12345678", publicKey: PAIR.publicKey }),
      null,
    );
    assert.deepEqual(await listModelCredentials(pool, orgA), [], "revoked credentials are hidden by default");
    assert.equal((await listModelCredentials(pool, orgA, { includeRevoked: true })).length, 1);

    // The label is free again.
    const again = await put(pool, orgA);
    assert.notEqual(again.id, stored.id);
  });
});

test("a label is unique among live credentials, and the refusals never quote a value", { skip }, async () => {
  await withSchema(async ({ pool, orgA, orgB }) => {
    await put(pool, orgA);
    await assert.rejects(() => put(pool, orgA), (err) => err.code === "label_taken" && err.status === 409);
    await put(pool, orgB); // another organization's labels are its own

    const refusals = [
      [{ provider: "made-up" }, /provider must be one of/],
      [{ label: "" }, /label/],
      [{ label: "sk-proj-AAAAAAAAAAAAAAAA" }, /looks like a key/],
      [{ value: "short" }, /8-4096/],
      [{ value: `${KEY}\n${KEY}` }, /whitespace/],
      [{ provider: "openai-compatible", label: "local" }, /needs a base URL/],
      [{ baseUrl: "http://api.example.com/v1", label: "b" }, /https/],
      [{ baseUrl: "https://169.254.169.254/", label: "c" }, /metadata/],
      [{ declaredVendor: "Not A Vendor", label: "d" }, /declared vendor/],
    ];
    for (const [overrides, why] of refusals) {
      await assert.rejects(
        () => put(pool, orgA, overrides),
        (err) => err instanceof ModelCredentialError && err.status === 400 && why.test(err.message) && !err.message.includes(KEY),
        JSON.stringify(overrides),
      );
    }
    const { rows } = await pool.query("select count(*)::int as n from model_credential");
    assert.equal(rows[0].n, 2, "a refused write stores nothing");
  });
});

test("an openai-compatible credential stores its checked base URL and declared vendor", { skip }, async () => {
  await withSchema(async ({ pool, orgA }) => {
    const stored = await put(pool, orgA, {
      provider: "openai-compatible",
      label: "vllm",
      baseUrl: "https://llm.example.com/v1/",
      declaredVendor: "meta",
    });
    assert.equal(stored.baseUrl, "https://llm.example.com/v1");
    assert.equal(stored.declaredVendor, "meta");
  });
});

// --- the stage-side check --------------------------------------------------------------------

function recordingProbe(status) {
  const calls = [];
  const probe = async (request) => {
    calls.push(request);
    if (typeof status === "function") return status(request);
    return { status };
  };
  return { probe, calls };
}

test("the check sends the key to the provider's probe and records valid or invalid", { skip }, async () => {
  await withSchema(async ({ pool, orgA }) => {
    const stored = await put(pool, orgA);
    const ok = recordingProbe(200);
    assert.deepEqual(await validateModelCredential({ pool, privateKeys: [PAIR.privateKey], probe: ok.probe }, orgA, stored.id), { status: "valid" });
    assert.equal(ok.calls[0].url, "https://api.openai.com/v1/models");
    assert.equal(ok.calls[0].headers.authorization, `Bearer ${KEY}`);
    let row = await getModelCredential(pool, orgA, stored.id);
    assert.equal(row.status, "valid");
    assert.ok(row.validatedAt instanceof Date);

    const refused = recordingProbe(401);
    await validateModelCredential({ pool, privateKeys: [PAIR.privateKey], probe: refused.probe }, orgA, stored.id);
    row = await getModelCredential(pool, orgA, stored.id);
    assert.equal(row.status, "invalid");
    assert.match(row.statusReason, /refused the key \(HTTP 401/);
  });
});

test("each provider is probed at its own cheapest authenticated endpoint", { skip }, async () => {
  await withSchema(async ({ pool, orgA }) => {
    const cases = [
      ["anthropic", undefined, "https://api.anthropic.com/v1/models", "x-api-key"],
      ["openrouter", undefined, "https://openrouter.ai/api/v1/key", "authorization"],
      ["openai-compatible", "https://llm.example.com/v1", "https://llm.example.com/v1/models", "authorization"],
    ];
    for (const [provider, baseUrl, url, header] of cases) {
      const stored = await put(pool, orgA, { provider, label: provider, ...(baseUrl ? { baseUrl } : {}) });
      const { probe, calls } = recordingProbe(200);
      await validateModelCredential({ pool, privateKeys: [PAIR.privateKey], probe }, orgA, stored.id);
      assert.equal(calls[0].url, url);
      assert.ok(calls[0].headers[header]?.includes(KEY), `${provider} carries the key in ${header}`);
    }
  });
});

test("rate limits, outages and network errors leave a credential unverified, with a reason", { skip }, async () => {
  await withSchema(async ({ pool, orgA }) => {
    const stored = await put(pool, orgA);
    for (const status of [429, 503]) {
      const { probe } = recordingProbe(status);
      assert.deepEqual(await validateModelCredential({ pool, privateKeys: [PAIR.privateKey], probe }, orgA, stored.id), { status: "unverified" });
      assert.match((await getModelCredential(pool, orgA, stored.id)).statusReason, new RegExp(`HTTP ${status}`));
    }
    const { probe } = recordingProbe(() => {
      throw Object.assign(new Error(`connect ECONNREFUSED while sending ${KEY}`), { code: "ECONNREFUSED" });
    });
    await validateModelCredential({ pool, privateKeys: [PAIR.privateKey], probe }, orgA, stored.id);
    const row = await getModelCredential(pool, orgA, stored.id);
    assert.equal(row.status, "unverified");
    assert.match(row.statusReason, /ECONNREFUSED/);
    assert.ok(!row.statusReason.includes(KEY), "an error's message is never copied into the row");
  });
});

test("a value that will not open is recorded invalid without quoting anything secret", { skip }, async () => {
  await withSchema(async ({ pool, orgA, orgB }) => {
    const mine = await put(pool, orgA);
    const theirs = await put(pool, orgB, { value: "sk-their-own-key-0000" });
    await pool.query(
      `update model_credential set sealed_value = (select sealed_value from model_credential where id = $1) where id = $2`,
      [mine.id, theirs.id],
    );
    const { probe, calls } = recordingProbe(200);
    assert.deepEqual(await validateModelCredential({ pool, privateKeys: [PAIR.privateKey], probe }, orgB, theirs.id), { status: "invalid" });
    assert.equal(calls.length, 0, "a value that does not open is never sent anywhere");
    const row = await getModelCredential(pool, orgB, theirs.id);
    assert.match(row.statusReason, /could not be opened/);

    // Sealed to a pair this deployment does not hold: named by id.
    const other = generateSecretKeyPair();
    await validateModelCredential({ pool, privateKeys: [other.privateKey], probe }, orgA, mine.id);
    assert.match((await getModelCredential(pool, orgA, mine.id)).statusReason, new RegExp(keypairIdOf(PAIR.publicKey)));
  });
});

test("no private key: the credential stays unverified and says why", { skip }, async () => {
  await withSchema(async ({ pool, orgA }) => {
    const stored = await put(pool, orgA);
    const { probe, calls } = recordingProbe(200);
    assert.deepEqual(await validateModelCredential({ pool, privateKeys: [], probe }, orgA, stored.id), { status: "unverified" });
    assert.equal(calls.length, 0);
    assert.match((await getModelCredential(pool, orgA, stored.id)).statusReason, /WINDKEEL_SECRET_PRIVATE_KEY/);
  });
});

test("a check that races a rotation does not mark the new value with the old value's result", { skip }, async () => {
  await withSchema(async ({ pool, orgA }) => {
    const stored = await put(pool, orgA);
    const probe = async () => {
      // The person rotates while the provider is being asked about the old value.
      await rotateModelCredential(pool, { organizationId: orgA, credentialId: stored.id, value: "sk-proj-Rotated00001234", publicKey: PAIR.publicKey });
      return { status: 200 };
    };
    await validateModelCredential({ pool, privateKeys: [PAIR.privateKey], probe }, orgA, stored.id);
    const row = await getModelCredential(pool, orgA, stored.id);
    assert.equal(row.status, "unverified", "the rotation's own check decides, not this one");
  });
});

test("revoked or missing credentials are skipped, and a revoked one is never sent", { skip }, async () => {
  await withSchema(async ({ pool, orgA, orgB }) => {
    const stored = await put(pool, orgA);
    await revokeModelCredential(pool, orgA, stored.id);
    const { probe, calls } = recordingProbe(200);
    assert.deepEqual(await validateModelCredential({ pool, privateKeys: [PAIR.privateKey], probe }, orgA, stored.id), { status: "skipped" });
    assert.deepEqual(await validateModelCredential({ pool, privateKeys: [PAIR.privateKey], probe }, orgB, stored.id), { status: "skipped" });
    assert.equal(calls.length, 0);
    assert.equal((await getModelCredential(pool, orgA, stored.id)).status, "revoked");
  });
});

test("a stored base URL that now resolves privately is refused at the check, not sent the key", { skip }, async () => {
  await withSchema(async ({ pool, orgA }) => {
    const stored = await put(pool, orgA, { provider: "openai-compatible", label: "rebinder", baseUrl: "https://llm.example.com/v1" });
    // A row whose base URL no longer passes the guard (written behind the API's back, or by an older
    // rule) is re-checked before anything is sent. The connect-time half is the real-probe test below.
    await pool.query("update model_credential set base_url = 'https://localhost:9/v1' where id = $1", [stored.id]);
    await validateModelCredential({ pool, privateKeys: [PAIR.privateKey] }, orgA, stored.id);
    const row = await getModelCredential(pool, orgA, stored.id);
    assert.equal(row.status, "invalid");
    assert.match(row.statusReason, /loopback/);
  });
});

// --- the real probe, against a loopback server (no provider) ----------------------------------

test("the real probe sends one GET with the key, reads only the status, and never follows a redirect", async () => {
  const seen = [];
  let answer = { status: 200, headers: {}, body: "" };
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://localhost:${server.address().port}/v1/models`;
  const request = { url, headers: { authorization: `Bearer ${KEY}` }, allowLocalhostHttp: true, timeoutMs: 5_000 };
  try {
    assert.deepEqual(await httpProbe(request), { status: 200 });
    assert.deepEqual(seen[0], { method: "GET", url: "/v1/models", authorization: `Bearer ${KEY}` });

    answer = { status: 302, headers: { location: "https://elsewhere.example.com/steal" }, body: "" };
    assert.deepEqual(await httpProbe(request), { status: 302 });
    assert.equal(seen.length, 2, "the redirect was not followed, so the key went nowhere else");

    answer = { status: 401, headers: {}, body: JSON.stringify({ error: `invalid key ${KEY}` }) };
    assert.deepEqual(await httpProbe(request), { status: 401 }, "a body that echoes the key is never read");

    // Without the dev flag the same loopback target is refused at connect time.
    await assert.rejects(() => httpProbe({ ...request, allowLocalhostHttp: false }), /loopback/);
    assert.equal(seen.length, 3);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

// --- redaction (#320 item 8) -----------------------------------------------------------------

test("redactSecrets removes OpenAI, Anthropic and OpenRouter keys from a log line", () => {
  for (const key of [
    "sk-Zx9QqRt7vB2mN4pL8sW1yH6jD3",
    "sk-proj-Zx9QqRt7vB2mN4pL8sW1yH6jD3fA5gC0_x-y",
    "sk-ant-api03-Zx9QqRt7vB2mN4pL8sW1yH6jD3fA5gC0-AbCdEf",
    "sk-or-v1-0123456789abcdef0123456789abcdef",
  ]) {
    const line = redactSecrets(`provider said: invalid key "${key}", status 401`);
    assert.ok(!line.includes(key.slice(3)), `${key.slice(0, 7)}… survived redaction: ${line}`);
    assert.match(line, /\[redacted\]/);
  }
  // Ordinary words with an sk- prefix that are not keys survive.
  assert.equal(redactSecrets("use sk-learn for this"), "use sk-learn for this");
});
