/**
 * Signed inbound webhooks (M8-5, #297): endpoints through the API, deliveries through the M8-1
 * pipeline, the CLI's `webhook send`, and the documented signing algorithm — all against the real
 * receiver, with a fake enqueuer and no network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { intakePathOf } from "../apps/ingress/dist/api/intake.js";
import { runIntake, wireResponse } from "../dist/intake/pipeline.js";
import { createWebhookIntakeSource, signWebhookPayload } from "../dist/intake/webhook.js";
import { deriveWebhookSecret, MIN_WEBHOOK_SIGNING_KEY_BYTES } from "../dist/intake/webhook-endpoints.js";
import { signWebhookRequest, webhookSend } from "../packages/cli/dist/commands/webhook.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const BOOTSTRAP = "test-bootstrap-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";
const SIGNING_KEY = "test-signing-key-0123456789abcdef0123456789abcdef";
const NOW = 1_790_000_000;

let serial = 0;
async function withWebhooks(fn, { signingKey = SIGNING_KEY } = {}) {
  const schema = `windkeel_webhook_test_${Date.now()}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool, REPO_ID);
    const key = { value: signingKey };
    const started = [];
    const logs = [];
    const deps = { pool, control: {}, webhookSigningKey: () => key.value };
    const auth = { token: BOOTSTRAP, subject: "operator" };
    const call = (method, path, body, bearer = BOOTSTRAP) =>
      handleApiRequest(deps, auth, {
        method,
        path,
        query: { get: () => undefined },
        headers: { authorization: `Bearer ${bearer}` },
        body,
      });
    const source = createWebhookIntakeSource({
      signingKey: () => key.value,
      now: () => NOW,
      async startRun(runId) {
        started.push(runId);
        return { enqueued: true };
      },
    });
    // What the route puts on the wire: the source's reply when it made one (pipeline.ts `wireResponse`).
    const deliver = (req) =>
      runIntake(source, req, { pool, log: (message, fields) => logs.push(JSON.stringify({ message, ...fields })) }).then(
        wireResponse,
      );
    await fn({ pool, call, deliver, source, key, started, logs });
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

const TASK = { title: "Fix flaky upload test", description: "- [ ] upload retries a 500 three times" };

/** A signed request as a sender builds it. */
function signed(endpointId, secret, payload, { delivery = "d-1", timestamp = NOW, raw, signature } = {}) {
  const rawBody = raw ?? JSON.stringify(payload);
  return {
    target: endpointId,
    rawBody,
    headers: {
      "x-windkeel-timestamp": String(timestamp),
      "x-windkeel-signature": signature ?? signWebhookPayload(secret, timestamp, rawBody),
      ...(delivery === null ? {} : { "x-windkeel-delivery": delivery }),
    },
  };
}

async function counts(pool) {
  const { rows } = await pool.query(
    `select (select count(*)::int from engineering_task) as tasks,
            (select count(*)::int from intake_delivery where source = 'webhook') as deliveries`,
  );
  return rows[0];
}

async function makeEndpoint(call, body = {}) {
  const created = await call("POST", "/v1/webhook-endpoints", { name: "pagerduty", repositoryId: REPO_ID, ...body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

test("a valid delivery is 202 with the task, created by the webhook system actor, with a ledger row", { skip }, async () => {
  await withWebhooks(async ({ pool, call, deliver, started }) => {
    const { endpoint, secret } = await makeEndpoint(call, { defaultRiskLevel: "medium" });
    assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
    assert.equal(secret, deriveWebhookSecret(SIGNING_KEY, endpoint.id, 1));
    assert.equal(endpoint.path, `/api/intake/webhook/${endpoint.id}`);

    const answer = await deliver(signed(endpoint.id, secret, TASK));
    assert.equal(answer.status, 202, JSON.stringify(answer.body));
    assert.ok(answer.body.taskId);
    assert.ok(answer.body.engineeringRunId);
    // Exactly the contract's body, sent through the pipeline's `reply` seam — nothing merged in.
    assert.deepEqual(Object.keys(answer.body).sort(), ["engineeringRunId", "taskId"]);
    assert.deepEqual(started, [answer.body.engineeringRunId]);

    const { rows: tasks } = await pool.query(
      `select t.source_type, t.source_reference, t.risk_level, t.source_context, p.system_purpose
         from engineering_task t join principal p on p.id = t.created_by_principal_id`,
    );
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].source_type, "webhook");
    assert.equal(tasks[0].source_reference, `webhook:${endpoint.id}:d-1`);
    assert.equal(tasks[0].risk_level, "medium");
    assert.deepEqual(tasks[0].source_context, { endpointId: endpoint.id });
    assert.equal(tasks[0].system_purpose, "webhook");

    const { rows: ledger } = await pool.query("select * from intake_delivery where source = 'webhook'");
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].delivery_key, `${endpoint.id}:d-1`);
    assert.equal(ledger[0].intent, "create_task:started");
    assert.equal(ledger[0].engineering_task_id, answer.body.taskId);
  });
});

test("tampered body, stale timestamp, and the old secret after a rotate are 401 and write nothing", { skip }, async () => {
  await withWebhooks(async ({ pool, call, deliver }) => {
    const { endpoint, secret } = await makeEndpoint(call);

    const good = signed(endpoint.id, secret, TASK);
    const tampered = { ...good, rawBody: JSON.stringify({ ...TASK, title: "Something else" }) };
    assert.equal((await deliver(tampered)).status, 401);

    const stale = await deliver(signed(endpoint.id, secret, TASK, { timestamp: NOW - 301 }));
    assert.equal(stale.status, 401);
    const future = await deliver(signed(endpoint.id, secret, TASK, { timestamp: NOW + 301 }));
    assert.equal(future.status, 401);
    assert.match(future.body.error, /300 s window/, "the refusal names the tolerance in force");
    // The tampered and ±301 s deliveries wrote nothing — checked before anything below writes.
    assert.deepEqual(await counts(pool), { tasks: 0, deliveries: 0 });
    // The edge of the window is inside it.
    assert.equal((await deliver(signed(endpoint.id, secret, TASK, { timestamp: NOW - 300, delivery: "edge" }))).status, 202);
    await pool.query("delete from intake_delivery; delete from engineering_run; delete from engineering_task");

    const rotated = await call("POST", `/v1/webhook-endpoints/${endpoint.id}/rotate`);
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.endpoint.secretVersion, 2);
    assert.notEqual(rotated.body.secret, secret);
    assert.equal((await deliver(signed(endpoint.id, secret, TASK, { delivery: "old" }))).status, 401);
    assert.deepEqual(await counts(pool), { tasks: 0, deliveries: 0 });

    assert.equal((await deliver(signed(endpoint.id, rotated.body.secret, TASK, { delivery: "new" }))).status, 202);
  });
});

test("the 401 names the injected tolerance, not a hard-coded one", { skip }, async () => {
  await withWebhooks(async ({ pool, call }) => {
    const { endpoint, secret } = await makeEndpoint(call);
    const source = createWebhookIntakeSource({
      signingKey: () => SIGNING_KEY,
      now: () => NOW,
      toleranceSeconds: 60,
      startRun: async () => ({ enqueued: true }),
    });
    const answer = await runIntake(source, signed(endpoint.id, secret, TASK, { timestamp: NOW - 61 }), { pool });
    assert.equal(answer.status, 401);
    assert.equal(answer.body.error, "timestamp missing or outside the 60 s window");
  });
});

test("a delivery to an upper-cased endpoint URL shares the canonical ledger key", { skip }, async () => {
  await withWebhooks(async ({ pool, call, deliver }) => {
    const { endpoint, secret } = await makeEndpoint(call);
    const upper = endpoint.id.toUpperCase();
    assert.notEqual(upper, endpoint.id);

    const first = await deliver(signed(endpoint.id, secret, TASK, { delivery: "case" }));
    assert.equal(first.status, 202);
    // The same delivery id at /webhook/{ID}: one endpoint, so one ledger key, so a duplicate.
    const again = await deliver(signed(upper, secret, TASK, { delivery: "case" }));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.duplicate, true);

    // And a first delivery through the upper-cased URL is recorded under the lower-case id.
    assert.equal((await deliver(signed(upper, secret, TASK, { delivery: "upper-first" }))).status, 202);
    const { rows } = await pool.query("select delivery_key from intake_delivery where source = 'webhook' order by delivery_key");
    assert.deepEqual(
      rows.map((r) => r.delivery_key),
      [`${endpoint.id}:case`, `${endpoint.id}:upper-first`],
    );
  });
});

test("a signing key shorter than 32 bytes counts as unconfigured, logged once and never echoed", { skip }, async () => {
  const short = "k".repeat(MIN_WEBHOOK_SIGNING_KEY_BYTES - 1);
  const exact = "k".repeat(MIN_WEBHOOK_SIGNING_KEY_BYTES);
  const writes = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };
  try {
    await withWebhooks(
      async ({ pool, call, deliver, key }) => {
        const create = await call("POST", "/v1/webhook-endpoints", { name: "weak", repositoryId: REPO_ID });
        assert.equal(create.status, 503);
        assert.equal(create.body.code, "webhook_signing_unconfigured");

        key.value = exact;
        const { endpoint, secret } = await makeEndpoint(call);
        key.value = short;
        const delivery = await deliver(signed(endpoint.id, secret, TASK));
        assert.equal(delivery.status, 503);
        assert.equal(delivery.body.error, "webhook_signing_unconfigured");
        assert.equal((await call("POST", `/v1/webhook-endpoints/${endpoint.id}/rotate`)).status, 503);
        assert.deepEqual(await counts(pool), { tasks: 0, deliveries: 0 });

        // At exactly 32 bytes the same endpoint works.
        key.value = exact;
        assert.equal((await deliver(signed(endpoint.id, secret, TASK))).status, 202);
      },
      { signingKey: short },
    );
  } finally {
    process.stdout.write = originalWrite;
  }
  const warnings = writes.filter((w) => w.includes("webhook_signing_key_too_short"));
  assert.equal(warnings.length, 1, "the reason is logged once per process");
  assert.match(warnings[0], /31 bytes; at least 32/);
  assert.ok(!writes.join("").includes(short), "the key itself is never logged");
});

test("a missing X-Windkeel-Delivery is 400; a bad body is 400 with the reason", { skip }, async () => {
  await withWebhooks(async ({ pool, call, deliver }) => {
    const { endpoint, secret } = await makeEndpoint(call);
    const missing = await deliver(signed(endpoint.id, secret, TASK, { delivery: null }));
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /X-Windkeel-Delivery/);
    assert.equal((await deliver(signed(endpoint.id, secret, TASK, { delivery: "x".repeat(201) }))).status, 400);

    const noTitle = await deliver(signed(endpoint.id, secret, { description: "d" }, { delivery: "b1" }));
    assert.equal(noTitle.status, 400);
    assert.equal(noTitle.body.error, "title is required");
    const badRisk = await deliver(signed(endpoint.id, secret, { ...TASK, riskLevel: "extreme" }, { delivery: "b2" }));
    assert.equal(badRisk.status, 400);
    assert.match(badRisk.body.error, /riskLevel/);
    const notJson = await deliver(signed(endpoint.id, secret, null, { raw: "{nope", delivery: "b3" }));
    assert.equal(notJson.status, 400);
    assert.ok(!notJson.body.error.includes("nope"));
    assert.deepEqual(await counts(pool), { tasks: 0, deliveries: 0 });
  });
});

test("the same delivery twice is a duplicate; the same externalId under a new delivery is one task", { skip }, async () => {
  await withWebhooks(async ({ pool, call, deliver }) => {
    const { endpoint, secret } = await makeEndpoint(call);
    const first = await deliver(signed(endpoint.id, secret, TASK, { delivery: "same" }));
    assert.equal(first.status, 202);
    const again = await deliver(signed(endpoint.id, secret, TASK, { delivery: "same" }));
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);

    const item = { ...TASK, externalId: "INC-1234" };
    const a = await deliver(signed(endpoint.id, secret, item, { delivery: "inc-a" }));
    const b = await deliver(signed(endpoint.id, secret, item, { delivery: "inc-b" }));
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.equal(a.body.taskId, b.body.taskId);
    const { rows } = await pool.query("select source_reference from engineering_task where source_reference like '%INC-1234'");
    assert.deepEqual(rows, [{ source_reference: `webhook:${endpoint.id}:INC-1234` }]);
    assert.deepEqual(await counts(pool), { tasks: 2, deliveries: 3 });
  });
});

test("a disabled or unknown endpoint is 404; a withdrawn grant is ignored with a reason", { skip }, async () => {
  await withWebhooks(async ({ pool, call, deliver }) => {
    const { endpoint, secret } = await makeEndpoint(call);
    const patched = await call("PATCH", `/v1/webhook-endpoints/${endpoint.id}`, { enabled: false });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.endpoint.enabled, false);
    const disabled = await deliver(signed(endpoint.id, secret, TASK));
    assert.equal(disabled.status, 404);

    const unknownId = "22222222-2222-4222-8222-222222222222";
    const unknown = await deliver(signed(unknownId, deriveWebhookSecret(SIGNING_KEY, unknownId, 1), TASK));
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, disabled.body, "unknown and disabled are indistinguishable");
    assert.equal((await deliver(signed("not-a-uuid", secret, TASK))).status, 404);
    assert.deepEqual(await counts(pool), { tasks: 0, deliveries: 0 });

    await call("PATCH", `/v1/webhook-endpoints/${endpoint.id}`, { enabled: true });
    await pool.query("delete from repository_grant where repository_id = $1", [REPO_ID]);
    const ungranted = await deliver(signed(endpoint.id, secret, TASK, { delivery: "ug" }));
    assert.equal(ungranted.status, 200);
    assert.equal(ungranted.body.intent, "ignore");
    assert.match(ungranted.body.reason, /no longer granted/);
    assert.deepEqual(await counts(pool), { tasks: 0, deliveries: 1 });
  });
});

test("without WINDKEEL_WEBHOOK_SIGNING_KEY, delivery, create and rotate are 503 webhook_signing_unconfigured", { skip }, async () => {
  await withWebhooks(async ({ pool, call, deliver, key }) => {
    const { endpoint, secret } = await makeEndpoint(call);
    key.value = undefined;
    const delivery = await deliver(signed(endpoint.id, secret, TASK));
    assert.equal(delivery.status, 503);
    assert.equal(delivery.body.error, "webhook_signing_unconfigured");
    const create = await call("POST", "/v1/webhook-endpoints", { name: "x", repositoryId: REPO_ID });
    assert.equal(create.status, 503);
    assert.equal(create.body.code, "webhook_signing_unconfigured");
    const rotate = await call("POST", `/v1/webhook-endpoints/${endpoint.id}/rotate`);
    assert.equal(rotate.status, 503);
    // Reads and the non-secret writes still work.
    assert.equal((await call("GET", "/v1/webhook-endpoints")).status, 200);
    assert.equal((await call("PATCH", `/v1/webhook-endpoints/${endpoint.id}`, { name: "renamed" })).status, 200);
    assert.deepEqual(await counts(pool), { tasks: 0, deliveries: 0 });
  });
});

test("the secret appears only in create and rotate answers — never another response, a row, or a log", { skip }, async () => {
  await withWebhooks(async ({ pool, call, deliver, logs }) => {
    const writes = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      writes.push(String(chunk));
      return originalWrite(chunk, ...rest);
    };
    try {
      const { endpoint, secret } = await makeEndpoint(call);
      const rotated = (await call("POST", `/v1/webhook-endpoints/${endpoint.id}/rotate`)).body.secret;
      const answers = [
        await call("GET", "/v1/webhook-endpoints"),
        await call("PATCH", `/v1/webhook-endpoints/${endpoint.id}`, { name: "renamed" }),
        await deliver(signed(endpoint.id, rotated, TASK)),
        await deliver(signed(endpoint.id, secret, TASK, { delivery: "bad" })),
        await deliver(signed(endpoint.id, rotated, TASK, { delivery: null })),
        await call("DELETE", `/v1/webhook-endpoints/${endpoint.id}`),
      ];
      const { rows } = await pool.query(
        `select (select json_agg(w) from webhook_endpoint w) as endpoints,
                (select json_agg(d) from intake_delivery d) as deliveries,
                (select json_agg(t) from engineering_task t) as tasks`,
      );
      const everything = JSON.stringify({ answers, rows, logs, writes });
      for (const value of [secret, rotated, SIGNING_KEY]) {
        assert.ok(!everything.includes(value), "a secret leaked outside create/rotate");
      }
      assert.equal(answers[0].body.items.length, 1);
      assert.ok(!("secret" in answers[0].body.items[0]));
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});

test("endpoint management needs integrations.manage and a granted repository", { skip }, async () => {
  await withWebhooks(async ({ call }) => {
    const narrow = (await call("POST", "/v1/tokens", { name: "ci", preset: "execute" })).body.secret;
    for (const [method, path] of [
      ["GET", "/v1/webhook-endpoints"],
      ["POST", "/v1/webhook-endpoints"],
      ["PATCH", `/v1/webhook-endpoints/${REPO_ID}`],
      ["DELETE", `/v1/webhook-endpoints/${REPO_ID}`],
      ["POST", `/v1/webhook-endpoints/${REPO_ID}/rotate`],
    ]) {
      const answer = await call(method, path, { name: "x", repositoryId: REPO_ID }, narrow);
      assert.equal(answer.status, 403, `${method} ${path}`);
      assert.equal(answer.body.missing, "integrations.manage");
    }
    const ungranted = await call("POST", "/v1/webhook-endpoints", {
      name: "x",
      repositoryId: "33333333-3333-3333-3333-333333333333",
    });
    assert.equal(ungranted.status, 422);
    assert.equal(ungranted.body.code, "repository_not_granted");
    const noName = await call("POST", "/v1/webhook-endpoints", { repositoryId: REPO_ID });
    assert.equal(noName.status, 400);
    assert.equal((await call("DELETE", `/v1/webhook-endpoints/${REPO_ID}`)).status, 404);
  });
});

/** A fetch that hands the request to the receiver in-process: the intake route's parsing, then the pipeline. */
function fetchIntoReceiver(deliver) {
  return async (url, init = {}) => {
    const path = intakePathOf(new URL(url).pathname);
    assert.equal(path?.source, "webhook");
    const headers = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
    const answer = await deliver({ target: path.target, headers, rawBody: Buffer.from(init.body) });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
}

test("`windkeel webhook send` round-trips against the receiver", { skip }, async () => {
  await withWebhooks(async ({ call, deliver }) => {
    const { endpoint, secret } = await makeEndpoint(call);
    assert.equal(signWebhookRequest(secret, NOW, "{}"), signWebhookPayload(secret, NOW, "{}"));
    const fetch = fetchIntoReceiver(deliver);
    const sent = await webhookSend({
      baseUrl: "https://ingress.example/",
      endpointId: endpoint.id,
      secret,
      title: "From the CLI",
      description: "- [ ] it arrives",
      externalId: "cli-1",
      fetch,
      now: NOW,
    });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    assert.ok(sent.body.taskId);
    const wrong = await webhookSend({
      baseUrl: "https://ingress.example",
      endpointId: endpoint.id,
      secret: `${secret}x`,
      title: "t",
      description: "d",
      fetch,
      now: NOW,
    });
    assert.equal(wrong.status, 401);
  });
});

test("the documented Node example is accepted by the receiver", { skip }, async () => {
  const doc = readFileSync(join(repoRoot, "docs", "webhook-intake.md"), "utf8");
  const marker = doc.indexOf("runs this block against the real receiver");
  assert.notEqual(marker, -1, "the verified block's marker is missing from docs/webhook-intake.md");
  const block = /```js\n([\s\S]*?)```/.exec(doc.slice(marker))?.[1];
  assert.ok(block, "no js block after the marker");
  assert.ok(block.trim().split("\n").length <= 10, "the Node example is promised as ten lines");

  const dir = mkdtempSync(join(tmpdir(), "windkeel-webhook-doc-"));
  const file = join(dir, "example.mjs");
  writeFileSync(file, block);
  const { sendTask } = await import(pathToFileURL(file).href);
  rmSync(dir, { recursive: true, force: true });

  await withWebhooks(
    async ({ call, pool }) => {
      const { endpoint, secret } = await makeEndpoint(call);
      // The example signs with the wall clock, so the receiver here does too.
      const source = createWebhookIntakeSource({ signingKey: () => SIGNING_KEY, startRun: async () => ({ enqueued: true }) });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchIntoReceiver((req) => runIntake(source, req, { pool }).then(wireResponse));
      try {
        const answer = await sendTask(`https://ingress.example${endpoint.path}`, secret, TASK);
        assert.equal(answer.status, 202, JSON.stringify(answer.body));
        assert.ok(answer.body.taskId);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test("the documented openssl pipeline computes the same signature", () => {
  if (spawnSync("openssl", ["version"]).status !== 0) return;
  const doc = readFileSync(join(repoRoot, "docs", "webhook-intake.md"), "utf8");
  const line = doc.split("\n").find((l) => l.startsWith("SIG=$("));
  assert.ok(line, "the SIG= line is missing from docs/webhook-intake.md");
  const secret = "whsec_example";
  const body = '{"title":"t","description":"- [ ] d"}';
  const result = spawnSync("bash", ["-c", `${line}; printf '%s' "$SIG"`], {
    env: { PATH: process.env.PATH, SECRET: secret, BODY: body, TS: String(NOW) },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(`v1=${result.stdout.trim()}`, signWebhookPayload(secret, NOW, body));
});
