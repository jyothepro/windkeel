/**
 * M8-8: the Jira intake source through the real pipeline (`runIntake`). Postgres-gated; Jira is
 * `FakeJira`, tokens are `FakeProviderTokenSource`, and the run enqueuer is a recording stub.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { runIntake } from "../dist/intake/pipeline.js";
import { addRoute, createConnection } from "../dist/integrations/connections.js";
import { createJiraIntakeSource, labelArrived } from "../dist/integrations/jira-intake.js";
import { signJiraWebhookJwt, verifyJiraWebhookJwt } from "../dist/integrations/jira.js";
import { adfToText } from "../dist/integrations/adf.js";
import { FakeProviderTokenSource } from "../dist/integrations/token-source.js";
import { FakeJira } from "./jira-fake.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const SECRET = "atlassian-client-secret";
const REPO_DEFAULT = "11111111-1111-1111-1111-111111111111";
const REPO_ENG = "22222222-2222-2222-2222-222222222222";

const fixture = (name) => JSON.parse(readFileSync(join(repoRoot, "test", "fixtures", "jira", `${name}.json`), "utf8"));

function bearer(secret = SECRET, claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  return `Bearer ${signJiraWebhookJwt({ iss: "client-id", iat: now, exp: now + 180, ...claims }, secret)}`;
}

function request(payload, { id = "wh-1", authorization = bearer() } = {}) {
  const headers = { "content-type": "application/json", "x-atlassian-webhook-identifier": id };
  if (authorization !== null) headers.authorization = authorization;
  return { headers, rawBody: Buffer.from(JSON.stringify(payload)) };
}

let serial = 0;
async function withIntake(fn, { secret = SECRET } = {}) {
  const schema = `windkeel_jira_intake_test_${Date.now()}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool, REPO_DEFAULT);
    await seedFixtureRepository(pool, REPO_ENG);
    const organizationId = (await pool.query("select id from organization where is_default")).rows[0].id;
    const { connection } = await createConnection(pool, {
      organizationId,
      provider: "jira",
      installationId: "inst_acme",
      externalTenantId: "cloud-acme",
      externalTenantName: "Acme",
      createdByPrincipalId: null,
    });
    await pool.query(
      `insert into jira_webhook (connection_id, cloud_id, site_url, webhook_ids, jql, expires_at)
       values ($1, 'cloud-acme', 'https://acme.atlassian.net', '{1001}', 'project IN ("ENG", "OPS")', now() + interval '30 days')`,
      [connection.id],
    );
    const jira = new FakeJira().site("cloud-acme", { siteUrl: "https://acme.atlassian.net" });
    const tokens = new FakeProviderTokenSource().install("jira", "inst_acme", { tenantId: "cloud-acme", name: "Acme" });
    const started = [];
    const logs = [];
    const source = createJiraIntakeSource({
      startRun: async (runId) => {
        started.push(runId);
        return { enqueued: true };
      },
      tokens,
      fetch: jira.fetch,
      secret: () => secret ?? undefined,
      consoleUrl: () => "https://console.example",
      log: (message, fields) => logs.push({ message, fields }),
    });
    const intake = (payload, options) => runIntake(source, request(payload, options), { pool, log: () => {} });
    await fn({ pool, organizationId, connection, jira, started, logs, intake, source });
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

const deliveries = async (pool) =>
  (await pool.query("select * from intake_delivery where source = 'jira' order by received_at")).rows;

test("the JWT verifier accepts only HS256 under the secret, unexpired", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifyJiraWebhookJwt(bearer(), SECRET, now).ok, true);
  assert.equal(verifyJiraWebhookJwt(bearer().replace("Bearer", "JWT"), SECRET, now).ok, true);
  assert.equal(verifyJiraWebhookJwt(bearer("wrong-secret"), SECRET, now).ok, false);
  assert.equal(verifyJiraWebhookJwt(bearer(SECRET, { exp: now - 3600 }), SECRET, now).ok, false);
  assert.equal(verifyJiraWebhookJwt(bearer(SECRET, { iat: now + 3600 }), SECRET, now).ok, false);
  assert.equal(verifyJiraWebhookJwt(undefined, SECRET, now).ok, false);
  const [, payload] = bearer().split(".");
  const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${payload}.x`;
  assert.equal(verifyJiraWebhookJwt(`Bearer ${none}`, SECRET, now).ok, false);
  const [, p2, sig] = bearer().slice(7).split(".");
  const hs512 = `${Buffer.from(JSON.stringify({ alg: "HS512" })).toString("base64url")}.${p2}.${sig}`;
  assert.equal(verifyJiraWebhookJwt(`Bearer ${hs512}`, SECRET, now).ok, false);
});

test("labelArrived reads created issues and label changelogs", () => {
  assert.equal(labelArrived(fixture("issue_created"), "windkeel"), true);
  assert.equal(labelArrived(fixture("issue_updated_label_added"), "windkeel"), true);
  assert.equal(labelArrived(fixture("issue_updated_unrelated"), "windkeel"), false);
  assert.equal(labelArrived(fixture("issue_created"), "other"), false);
});

test("a valid, authenticated issue_created ⇒ task + ledger + comment", { skip }, async () => {
  await withIntake(async ({ pool, organizationId, connection, jira, started, intake }) => {
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_DEFAULT });
    const response = await intake(fixture("issue_created"));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, intent: "create_task" });

    const { rows: tasks } = await pool.query("select * from engineering_task where source_type = 'jira'");
    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.equal(task.organization_id, organizationId);
    assert.equal(task.repository_id, REPO_DEFAULT);
    assert.equal(task.source_reference, "jira:cloud-acme/10042");
    assert.equal(task.title, "ENG-42: Add a health endpoint");
    assert.equal(task.risk_level, "medium");
    assert.deepEqual(task.source_context, {
      cloudId: "cloud-acme",
      issueKey: "ENG-42",
      issueId: "10042",
      siteUrl: "https://acme.atlassian.net",
    });
    assert.match(task.description, /## Acceptance criteria/);
    assert.match(task.description, /https:\/\/acme\.atlassian\.net\/browse\/ENG-42/);
    assert.equal(task.acceptance_criteria.length, 2);
    const actor = (await pool.query("select * from principal where id = $1", [task.created_by_principal_id])).rows[0];
    assert.equal(actor.system_purpose, "jira");

    const [delivery] = await deliveries(pool);
    assert.equal(delivery.delivery_key, "acme.atlassian.net/wh-1");
    assert.equal(delivery.intent, "create_task");
    assert.equal(delivery.engineering_task_id, task.id);
    assert.equal(delivery.organization_id, organizationId);
    assert.equal(delivery.event, "jira:issue_created");

    const { rows: runs } = await pool.query("select id from engineering_run where task_id = $1", [task.id]);
    assert.deepEqual(started, [runs[0].id]);
    const comments = jira.commentsOn("cloud-acme", "ENG-42");
    assert.equal(comments.length, 1);
    assert.equal(comments[0].type, "doc");
    const text = adfToText(comments[0]);
    assert.match(text, new RegExp(`https://console\\.example/runs/${runs[0].id}`));
    assert.match(text, new RegExp(`windkeel-run ${runs[0].id} started`));
  });
});

test("bad auth ⇒ 401 and no rows; no secret configured ⇒ 503", { skip }, async () => {
  await withIntake(async ({ pool, organizationId, connection, intake }) => {
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_DEFAULT });
    for (const authorization of [bearer("not-the-secret"), null, "Bearer garbage", "Basic dXNlcjpwYXNz"]) {
      const response = await intake(fixture("issue_created"), { authorization });
      assert.equal(response.status, 401);
    }
    assert.equal((await deliveries(pool)).length, 0);
    assert.equal((await pool.query("select count(*)::int as n from engineering_task")).rows[0].n, 0);
  });
  await withIntake(
    async ({ pool, intake }) => {
      const response = await intake(fixture("issue_created"));
      assert.equal(response.status, 503);
      assert.equal((await deliveries(pool)).length, 0);
    },
    { secret: null },
  );
});

test("a changelog adding the label ⇒ task; an unrelated update ⇒ ignored with a reason", { skip }, async () => {
  await withIntake(async ({ pool, organizationId, connection, intake }) => {
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_DEFAULT });
    const added = await intake(fixture("issue_updated_label_added"), { id: "wh-2" });
    assert.deepEqual(added.body, { ok: true, intent: "create_task" });
    const { rows } = await pool.query("select source_reference from engineering_task where source_type = 'jira'");
    assert.deepEqual(rows.map((r) => r.source_reference), ["jira:cloud-acme/10043"]);

    const unrelated = await intake(fixture("issue_updated_unrelated"), { id: "wh-3" });
    assert.deepEqual(unrelated.body, { ok: true, intent: "ignore", reason: "label_not_added" });
    const ledger = await deliveries(pool);
    assert.equal(ledger.find((d) => d.delivery_key.endsWith("wh-3")).reason, "label_not_added");

    const noLabel = fixture("issue_created");
    noLabel.issue.fields.labels = ["backend"];
    const response = await intake(noLabel, { id: "wh-4" });
    assert.equal(response.body.reason, "no_trigger_label");

    const comment = { webhookEvent: "comment_created", issue: fixture("issue_created").issue };
    assert.equal((await intake(comment, { id: "wh-5" })).body.reason, "unsupported_event");
  });
});

test("an unknown cloud ⇒ unknown_tenant", { skip }, async () => {
  await withIntake(async ({ pool, organizationId, connection, intake }) => {
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_DEFAULT });
    const payload = fixture("issue_created");
    payload.matchedWebhookIds = [9999];
    payload.issue.self = "https://other.atlassian.net/rest/api/3/issue/10042";
    const response = await intake(payload);
    assert.deepEqual(response.body, { ok: true, intent: "ignore", reason: "unknown_tenant" });
    const [row] = await deliveries(pool);
    assert.equal(row.reason, "unknown_tenant");
    assert.equal(row.organization_id, null);

    // An api.atlassian.com self URL names the cloud directly.
    const direct = fixture("issue_created");
    direct.matchedWebhookIds = [];
    direct.issue.self = "https://api.atlassian.com/ex/jira/cloud-nobody/rest/api/3/issue/10042";
    assert.equal((await intake(direct, { id: "wh-9" })).body.reason, "unknown_tenant");
  });
});

test("a project route beats the default; a disabled one is not fallen through; no route ⇒ no_route", { skip }, async () => {
  await withIntake(async ({ pool, organizationId, connection, intake }) => {
    const none = await intake(fixture("issue_created"), { id: "wh-0" });
    assert.equal(none.body.reason, "no_route");

    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_DEFAULT });
    const eng = await addRoute(pool, organizationId, connection.id, {
      scopeKind: "jira_project",
      scopeValue: "ENG",
      repositoryId: REPO_ENG,
    });
    await intake(fixture("issue_created"), { id: "wh-1" });
    const { rows } = await pool.query("select repository_id from engineering_task where source_type = 'jira'");
    assert.deepEqual(rows.map((r) => r.repository_id), [REPO_ENG]);

    await pool.query("update integration_route set enabled = false where id = $1", [eng.id]);
    const other = fixture("issue_created");
    other.issue.id = "10099";
    other.issue.key = "ENG-99";
    assert.equal((await intake(other, { id: "wh-2" })).body.reason, "route_disabled");
  });
});

test("a duplicate delivery ⇒ duplicate, one task, one comment", { skip }, async () => {
  await withIntake(async ({ pool, organizationId, connection, jira, intake }) => {
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_DEFAULT });
    const first = await intake(fixture("issue_created"), { id: "wh-dup" });
    assert.equal(first.body.intent, "create_task");
    const second = await intake(fixture("issue_created"), { id: "wh-dup" });
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal((await pool.query("select count(*)::int as n from engineering_task")).rows[0].n, 1);
    assert.equal(jira.commentsOn("cloud-acme", "ENG-42").length, 1);

    // A different delivery about the same issue returns the same task (keyed on the issue id).
    await intake(fixture("issue_created"), { id: "wh-other" });
    assert.equal((await pool.query("select count(*)::int as n from engineering_task")).rows[0].n, 1);
  });
});

test("a failed acknowledgement comment is logged, not a failed delivery", { skip }, async () => {
  await withIntake(async ({ pool, organizationId, connection, jira, started, logs, intake }) => {
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_DEFAULT });
    jira.failAll = 500;
    const response = await intake(fixture("issue_created"));
    assert.equal(response.status, 200);
    assert.equal(started.length, 1);
    assert.equal((await deliveries(pool)).length, 1);
    const line = logs.find((l) => l.message === "jira acknowledgement comment failed");
    assert.ok(line);
    assert.doesNotMatch(JSON.stringify(line), /fake-jira-inst/);
  });
});

// ---------------------------------------------------------------------------
// Tech-lead review of #310
// ---------------------------------------------------------------------------

/** A second tenant (another organization's Jira site) whose webhook id collides with acme's. */
async function connectBeta(pool, { webhookIds = "{1001}", siteUrl = "https://beta.atlassian.net" } = {}) {
  const { rows } = await pool.query(
    `insert into organization (account_id, name) select account_id, 'beta' from organization where is_default
     returning id`,
  );
  const betaOrg = rows[0].id;
  await pool.query(
    // A repository takes intake for one organization: hand REPO_ENG to Beta.
    `update repository_grant set organization_id = $1 where repository_id = $2`,
    [betaOrg, REPO_ENG],
  );
  const { connection } = await createConnection(pool, {
    organizationId: betaOrg,
    provider: "jira",
    installationId: "inst_beta",
    externalTenantId: "cloud-beta",
    externalTenantName: "Beta",
    createdByPrincipalId: null,
  });
  await addRoute(pool, betaOrg, connection.id, { repositoryId: REPO_ENG });
  if (webhookIds !== null) {
    await pool.query(
      `insert into jira_webhook (connection_id, cloud_id, site_url, webhook_ids, jql, expires_at)
       values ($1, 'cloud-beta', $2, $3::bigint[], 'project IN ("ENG")', now() + interval '30 days')`,
      [connection.id, siteUrl, webhookIds],
    );
  }
  return { betaOrg, connection };
}

function fromBeta() {
  const payload = fixture("issue_created");
  payload.issue.self = "https://beta.atlassian.net/rest/api/3/issue/10042";
  return payload;
}

test("MF1: an orphaned webhook id that collides with another tenant's is not attributed to it", { skip }, async () => {
  await withIntake(async ({ pool, organizationId, connection, intake }) => {
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_DEFAULT });
    // Beta's site sends with id 1001 — which only acme's row holds (beta's registration was never
    // recorded). The site does not match acme's, so it is nobody's.
    await connectBeta(pool, { webhookIds: null });
    const response = await intake(fromBeta(), { id: "wh-orphan" });
    assert.deepEqual(response.body, { ok: true, intent: "ignore", reason: "unknown_tenant" });
    assert.equal((await pool.query("select count(*)::int as n from engineering_task")).rows[0].n, 0);
  });
});

test("MF1: colliding webhook ids across two sites go to the site that sent them", { skip }, async () => {
  await withIntake(async ({ pool, organizationId, connection, intake }) => {
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_DEFAULT });
    const { betaOrg } = await connectBeta(pool);

    await intake(fromBeta(), { id: "wh-b" });
    await intake(fixture("issue_created"), { id: "wh-a" });
    const { rows } = await pool.query(
      "select organization_id, source_reference from engineering_task order by source_reference",
    );
    assert.deepEqual(
      rows.map((r) => [r.organization_id, r.source_reference]),
      [
        [organizationId, "jira:cloud-acme/10042"],
        [betaOrg, "jira:cloud-beta/10042"],
      ],
    );
    // No self at all: ids alone cannot say which site, so it is ignored.
    const bare = fixture("issue_created");
    delete bare.issue.self;
    assert.equal((await intake(bare, { id: "wh-bare" })).body.reason, "unknown_tenant");
  });
});

test("#313: a row whose site is unknown is never a candidate, even as the only one", { skip }, async () => {
  await withIntake(async ({ pool, organizationId, connection, intake }) => {
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_DEFAULT });
    // The only row holding id 1001, with no recorded site: nothing can check the event's origin.
    await pool.query("update jira_webhook set site_url = null where connection_id = $1", [connection.id]);
    const response = await intake(fixture("issue_created"), { id: "wh-nosite" });
    assert.deepEqual(response.body, { ok: true, intent: "ignore", reason: "unknown_tenant" });
    assert.equal((await pool.query("select count(*)::int as n from engineering_task")).rows[0].n, 0);
  });
});

test("MF3: a hanging Jira cannot hold the delivery open past the acknowledgement bound", { skip, timeout: 20_000 }, async () => {
  await withIntake(async ({ pool, organizationId, connection, jira, started, logs, intake }) => {
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_DEFAULT });
    jira.hang = true;
    const t0 = Date.now();
    const response = await intake(fixture("issue_created"));
    assert.equal(response.status, 200);
    assert.equal(started.length, 1, "the run was enqueued first");
    assert.ok(Date.now() - t0 < 10_000, "bounded by the 5 s acknowledgement timeout");
    assert.ok(logs.find((l) => l.message === "jira acknowledgement comment failed"));
  });
});

/** A doc nested `depth` blockquotes deep, as JSON text (JSON.stringify itself cannot build it). */
function nestedJson(depth, leaf = "deep leaf") {
  const open = '{"type":"blockquote","content":['.repeat(depth);
  const close = "]}".repeat(depth);
  return `{"type":"doc","version":1,"content":[${open}{"type":"paragraph","content":[{"type":"text","text":"${leaf}"}]}${close}]}`;
}

test("MF4: pathologically nested ADF is a 2xx with a task, never a 5xx", { skip, timeout: 30_000 }, async () => {
  await withIntake(async ({ pool, organizationId, connection, source }) => {
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_DEFAULT });
    const payload = fixture("issue_created");
    payload.issue.fields.description = "__DEEP__";
    const req = request(payload, { id: "wh-deep" });
    req.rawBody = Buffer.from(req.rawBody.toString("utf8").replace('"__DEEP__"', nestedJson(20_000)));
    const response = await runIntake(source, req, { pool, log: () => {} });
    assert.equal(response.status, 200);
    assert.equal(response.body.intent, "create_task");
    const [task] = (await pool.query("select description from engineering_task")).rows;
    assert.match(task.description, /deep leaf/, "the subtree past the cap is rendered flat, not lost");
  });
});

test("MF4: a huge description is truncated with a marker", { skip }, async () => {
  await withIntake(async ({ pool, organizationId, connection, intake }) => {
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_DEFAULT });
    const payload = fixture("issue_created");
    payload.issue.fields.description = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(200_000) }] }],
    };
    const response = await intake(payload, { id: "wh-huge" });
    assert.equal(response.status, 200);
    const [task] = (await pool.query("select description from engineering_task")).rows;
    assert.ok(task.description.length < 21_000, `description is ${task.description.length} chars`);
    assert.match(task.description, /\[… description truncated by Windkeel\]/);
    assert.match(task.description, /Jira issue: https:\/\/acme\.atlassian\.net\/browse\/ENG-42/);
  });
});

test("SF: the delivery key falls back to the cloud id for an api.atlassian.com self", () => {
  const source = createJiraIntakeSource({ startRun: async () => ({ enqueued: true }), secret: () => SECRET });
  const api = fixture("issue_created");
  api.issue.self = "https://api.atlassian.com/ex/jira/cloud-acme/rest/api/3/issue/10042";
  const req = request(api, { id: "wh-7" });
  assert.equal(source.deliveryKey(req, api), "cloud-acme/wh-7");
  const site = fixture("issue_created");
  assert.equal(source.deliveryKey(request(site, { id: "wh-7" }), site), "acme.atlassian.net/wh-7");
});

test("SF: the JWT lifetime is capped at an hour", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifyJiraWebhookJwt(bearer(SECRET, { iat: now, exp: now + 3600 }), SECRET, now).ok, true);
  const long = verifyJiraWebhookJwt(bearer(SECRET, { iat: now, exp: now + 7200 }), SECRET, now);
  assert.deepEqual(long, { ok: false, reason: "lifetime too long" });
  const noIat = verifyJiraWebhookJwt(bearer(SECRET, { iat: undefined, exp: now + 86_400 }), SECRET, now);
  assert.equal(noIat.ok, false);
});

test("SF: re-labelling follows the shared rules — already_tasked, then a fresh run", { skip }, async () => {
  await withIntake(async ({ pool, organizationId, connection, jira, started, intake }) => {
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_DEFAULT });
    await intake(fixture("issue_created"), { id: "wh-1" });
    const [first] = (await pool.query("select id from engineering_run")).rows;
    // ENG-42 has the label removed and added again.
    const relabelled = () => ({ ...fixture("issue_updated_label_added"), issue: fixture("issue_created").issue });
    const intentOf = async (key) => (await deliveries(pool)).find((d) => d.delivery_key.endsWith(key));

    // Still CREATED: re-enqueued (the heal for a lost enqueue); no second acknowledgement.
    await intake(relabelled(), { id: "wh-2" });
    assert.equal((await intentOf("wh-2")).intent, "create_task:restarted");
    assert.deepEqual(started, [first.id, first.id]);
    assert.equal(jira.commentsOn("cloud-acme", "ENG-42").length, 1);

    await pool.query("update engineering_run set status = 'IMPLEMENTING' where id = $1", [first.id]);
    await intake(relabelled(), { id: "wh-3" });
    assert.equal((await intentOf("wh-3")).reason, "already_tasked");

    await pool.query("update engineering_run set status = 'FAILED' where id = $1", [first.id]);
    await intake(relabelled(), { id: "wh-4" });
    assert.equal((await intentOf("wh-4")).intent, "create_task:rerun");
    const runs = (await pool.query("select id from engineering_run order by created_at")).rows;
    assert.equal(runs.length, 2);
    assert.equal(started.at(-1), runs[1].id);
    assert.equal((await pool.query("select count(*)::int as n from engineering_task")).rows[0].n, 1);
    // One acknowledgement per run.
    assert.equal(jira.commentsOn("cloud-acme", "ENG-42").length, 2);
  });
});
