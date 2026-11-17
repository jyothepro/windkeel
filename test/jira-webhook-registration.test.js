/**
 * M8-8: Windkeel registers, refreshes and re-registers its own Jira webhook (Connect has no Jira
 * triggers). Postgres-gated; Jira is `FakeJira` behind an injected fetch, tokens are
 * `FakeProviderTokenSource`. Nothing reaches the network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { addRoute, createConnection, deleteRoute, disconnectConnection } from "../dist/integrations/connections.js";
import {
  ensureJiraWebhook,
  getJiraWebhook,
  JiraClient,
  projectJql,
  projectJqlFilters,
  refreshJiraWebhooks,
  removeJiraWebhook,
} from "../dist/integrations/jira.js";
import { refreshJiraWebhooksLocked } from "../dist/factory/sweeps/jira-webhook-refresh.js";
import { FakeProviderTokenSource } from "../dist/integrations/token-source.js";
import { FakeJira, DAY } from "./jira-fake.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const REPO_ID = "11111111-1111-1111-1111-111111111111";
const BOOTSTRAP = "test-bootstrap-token";
const PUBLIC_URL = "https://ingress.example";

let serial = 0;
async function withDb(fn) {
  const schema = `windkeel_jira_webhook_test_${Date.now()}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool, REPO_ID);
    const { rows } = await pool.query("select id from organization where is_default");
    let clock = Date.parse("2026-09-25T12:00:00Z");
    const now = () => clock;
    const jira = new FakeJira({ now }).site("cloud-acme").site("cloud-beta", { projects: ["BETA"] });
    const tokens = new FakeProviderTokenSource()
      .install("jira", "inst_acme", { tenantId: "cloud-acme", name: "Acme" })
      .install("jira", "inst_beta", { tenantId: "cloud-beta", name: "Beta" });
    const deps = { tokens, fetch: jira.fetch, publicUrl: PUBLIC_URL, now: () => new Date(clock) };
    await fn({
      pool,
      organizationId: rows[0].id,
      jira,
      tokens,
      deps,
      advance: (ms) => {
        clock += ms;
      },
    });
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

async function connect(pool, organizationId, installationId, cloudId) {
  const { connection } = await createConnection(pool, {
    organizationId,
    provider: "jira",
    installationId,
    externalTenantId: cloudId,
    externalTenantName: cloudId,
    createdByPrincipalId: null,
  });
  return connection;
}

test("projectJql quotes, dedupes and sorts; labels are never in the JQL (unsupported by Jira)", () => {
  assert.equal(projectJql(["OPS", "ENG", "OPS", " "]), 'project IN ("ENG", "OPS")');
  assert.equal(projectJql(['A"B']), 'project IN ("A\\"B")');
  assert.equal(projectJql([]), null);
});

test("connecting through the API and adding a route registers the webhook", { skip }, async () => {
  await withDb(async ({ pool, jira, tokens, deps }) => {
    const apiDeps = {
      pool,
      control: {},
      integrationTokens: tokens,
      jiraWebhooks: { ensure: (connection) => ensureJiraWebhook(pool, connection, deps) },
    };
    const call = (method, path, body) =>
      handleApiRequest(apiDeps, { token: BOOTSTRAP, subject: "operator" }, {
        method,
        path,
        query: { get: () => undefined },
        headers: { authorization: `Bearer ${BOOTSTRAP}` },
        body,
      });

    const created = await call("POST", "/v1/integrations", { provider: "jira", installationId: "inst_acme" });
    assert.equal(created.status, 201);
    const id = created.body.connection.id;
    // No route yet: nothing would be acted on, so nothing is registered.
    assert.equal(await getJiraWebhook(pool, id), null);
    assert.equal(jira.webhooksOf("cloud-acme").length, 0);

    const route = await call("POST", `/v1/integrations/${id}/routes`, { scopeKind: "jira_project", scopeValue: "ENG", repositoryId: REPO_ID });
    assert.equal(route.status, 201);
    const row = await getJiraWebhook(pool, id);
    assert.equal(row.cloudId, "cloud-acme");
    assert.equal(row.jql, 'project IN ("ENG")');
    assert.equal(row.siteUrl, "https://cloud-acme.atlassian.net");
    assert.equal(row.lastError, null);
    const [hook] = jira.webhooksOf("cloud-acme");
    assert.deepEqual(row.webhookIds, [hook.id]);
    assert.equal(hook.url, `${PUBLIC_URL}/api/intake/jira`);
    assert.deepEqual(hook.events, ["jira:issue_created", "jira:issue_updated"]);
    assert.deepEqual(hook.fieldIdsFilter, ["labels"]);

    // A default route widens the filter to every visible project: the old webhook is replaced.
    await call("POST", `/v1/integrations/${id}/routes`, { repositoryId: REPO_ID });
    const widened = await getJiraWebhook(pool, id);
    assert.equal(widened.jql, 'project IN ("ENG", "OPS")');
    assert.equal(jira.webhooksOf("cloud-acme").length, 1);
    assert.notDeepEqual(widened.webhookIds, row.webhookIds);

    // No Jira token ever reaches the response.
    assert.doesNotMatch(JSON.stringify(created.body), /fake-jira/);
  });
});

test("refresh happens only within 7 days of expiry", { skip }, async () => {
  await withDb(async ({ pool, organizationId, jira, deps, advance }) => {
    const connection = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_ID });
    assert.equal((await ensureJiraWebhook(pool, connection, deps)).kind, "registered");
    const registered = await getJiraWebhook(pool, connection.id);

    advance(20 * DAY);
    jira.calls.length = 0;
    assert.equal((await ensureJiraWebhook(pool, connection, deps)).kind, "unchanged");
    assert.equal(jira.calls.filter((c) => c.method === "PUT").length, 0);

    advance(4 * DAY); // 6 days left
    const refreshed = await ensureJiraWebhook(pool, connection, deps);
    assert.equal(refreshed.kind, "refreshed");
    const put = jira.calls.filter((c) => c.method === "PUT");
    assert.equal(put.length, 1);
    assert.deepEqual(put[0].body, { webhookIds: registered.webhookIds });
    const row = await getJiraWebhook(pool, connection.id);
    assert.ok(row.expiresAt.getTime() > registered.expiresAt.getTime());
    assert.ok(row.lastRefreshedAt);
    assert.deepEqual(row.webhookIds, registered.webhookIds);
  });
});

test("a webhook Jira dropped is re-registered", { skip }, async () => {
  await withDb(async ({ pool, organizationId, jira, deps }) => {
    const connection = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_ID });
    await ensureJiraWebhook(pool, connection, deps);
    const before = await getJiraWebhook(pool, connection.id);
    jira.drop("cloud-acme", before.webhookIds[0]);

    const result = await refreshJiraWebhooks(pool, deps);
    assert.equal(result.registered, 1);
    const after = await getJiraWebhook(pool, connection.id);
    assert.notDeepEqual(after.webhookIds, before.webhookIds);
    assert.deepEqual(jira.webhooksOf("cloud-acme").map((w) => w.id), after.webhookIds);
  });
});

test("errors land in last_error and the sweep continues with the next connection", { skip }, async () => {
  await withDb(async ({ pool, organizationId, jira, deps }) => {
    const acme = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    const beta = await connect(pool, organizationId, "inst_beta", "cloud-beta");
    await addRoute(pool, organizationId, acme.id, { repositoryId: REPO_ID });
    await addRoute(pool, organizationId, beta.id, { repositoryId: REPO_ID });

    // Acme's registration fails (Jira 500); Beta's succeeds in the same sweep.
    jira.failOnce.set("POST webhook", 500);
    const outcome = await refreshJiraWebhooksLocked(pool, deps);
    assert.equal(outcome.kind, "ran");
    assert.equal(outcome.result.connections, 2);
    assert.equal(outcome.result.failed, 1);
    assert.equal(outcome.result.registered, 1);

    const failed = await getJiraWebhook(pool, acme.id);
    assert.match(failed.lastError, /HTTP 500/);
    assert.doesNotMatch(failed.lastError, /boom/, "Jira's error body is never recorded");
    assert.deepEqual(failed.webhookIds, []);
    assert.equal((await getJiraWebhook(pool, beta.id)).lastError, null);

    // The next sweep heals it and clears the error.
    const healed = await refreshJiraWebhooks(pool, deps);
    assert.equal(healed.registered, 1);
    const row = await getJiraWebhook(pool, acme.id);
    assert.equal(row.lastError, null);
    assert.equal(row.webhookIds.length, 1);

    // A refresh failure on a registered webhook keeps its ids and records the error.
    jira.failAll = 503;
    const down = await refreshJiraWebhooks(pool, deps);
    assert.equal(down.failed, 2);
    const kept = await getJiraWebhook(pool, acme.id);
    assert.deepEqual(kept.webhookIds, row.webhookIds);
    assert.match(kept.lastError, /HTTP 503/);
  });
});

test("without WINDKEEL_PUBLIC_URL the failure is recorded, not thrown", { skip }, async () => {
  await withDb(async ({ pool, organizationId, deps }) => {
    const connection = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_ID });
    const saved = process.env.WINDKEEL_PUBLIC_URL;
    delete process.env.WINDKEEL_PUBLIC_URL;
    try {
      const outcome = await ensureJiraWebhook(pool, connection, { ...deps, publicUrl: undefined });
      assert.equal(outcome.kind, "failed");
      assert.match((await getJiraWebhook(pool, connection.id)).lastError, /WINDKEEL_PUBLIC_URL/);
    } finally {
      if (saved !== undefined) process.env.WINDKEEL_PUBLIC_URL = saved;
    }
  });
});

test("removing the last route deletes the webhook at Jira and the row", { skip }, async () => {
  await withDb(async ({ pool, organizationId, jira, deps }) => {
    const connection = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    const route = await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_ID });
    await ensureJiraWebhook(pool, connection, deps);
    assert.equal(jira.webhooksOf("cloud-acme").length, 1);
    await deleteRoute(pool, organizationId, connection.id, route.id);
    assert.equal((await ensureJiraWebhook(pool, connection, deps)).kind, "removed");
    assert.equal(jira.webhooksOf("cloud-acme").length, 0);
    assert.equal(await getJiraWebhook(pool, connection.id), null);
  });
});

// ---------------------------------------------------------------------------
// Tech-lead review of #310
// ---------------------------------------------------------------------------

function apiCaller(pool, tokens, deps) {
  const apiDeps = {
    pool,
    control: {},
    integrationTokens: tokens,
    jiraWebhooks: {
      ensure: (connection) => ensureJiraWebhook(pool, connection, deps),
      remove: (connection) => removeJiraWebhook(pool, connection, deps),
    },
  };
  return (method, path, body) =>
    handleApiRequest(apiDeps, { token: BOOTSTRAP, subject: "operator" }, {
      method,
      path,
      query: { get: () => undefined },
      headers: { authorization: `Bearer ${BOOTSTRAP}` },
      body,
    });
}

test("MF1: concurrent ensures for one connection register one webhook", { skip }, async () => {
  await withDb(async ({ pool, organizationId, jira, deps }) => {
    const connection = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_ID });
    const outcomes = await Promise.all([
      ensureJiraWebhook(pool, connection, deps),
      ensureJiraWebhook(pool, connection, deps),
      ensureJiraWebhook(pool, connection, deps),
    ]);
    assert.deepEqual(outcomes.map((o) => o.kind).sort(), ["registered", "unchanged", "unchanged"]);
    assert.equal(jira.webhooksOf("cloud-acme").length, 1, "one webhook at Jira, no orphan");
    const row = await getJiraWebhook(pool, connection.id);
    assert.deepEqual(row.webhookIds, jira.webhooksOf("cloud-acme").map((w) => w.id));
  });
});

test("MF1: a re-registration registers the new webhook before deleting the stale one", { skip }, async () => {
  await withDb(async ({ pool, organizationId, jira, deps }) => {
    const connection = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    await addRoute(pool, organizationId, connection.id, { scopeKind: "jira_project", scopeValue: "ENG", repositoryId: REPO_ID });
    await ensureJiraWebhook(pool, connection, deps);
    const before = await getJiraWebhook(pool, connection.id);

    // The routes change, and Jira refuses the new registration: the old webhook must survive.
    await addRoute(pool, organizationId, connection.id, { scopeKind: "jira_project", scopeValue: "OPS", repositoryId: REPO_ID });
    jira.failOnce.set("POST webhook", 500);
    assert.equal((await ensureJiraWebhook(pool, connection, deps)).kind, "failed");
    assert.deepEqual(jira.webhooksOf("cloud-acme").map((w) => w.id), before.webhookIds, "still watching");
    assert.deepEqual((await getJiraWebhook(pool, connection.id)).webhookIds, before.webhookIds);

    // Once Jira accepts, the order of calls is register, then delete.
    jira.calls.length = 0;
    assert.equal((await ensureJiraWebhook(pool, connection, deps)).kind, "registered");
    const writes = jira.calls.filter((c) => c.method === "POST" || c.method === "DELETE").map((c) => c.method);
    assert.deepEqual(writes, ["POST", "DELETE"]);
    assert.equal(jira.webhooksOf("cloud-acme").length, 1);
  });
});

test("MF2: disconnecting a Jira integration deletes its webhooks at Jira and its row", { skip }, async () => {
  await withDb(async ({ pool, jira, tokens, deps }) => {
    const call = apiCaller(pool, tokens, deps);
    const created = await call("POST", "/v1/integrations", { provider: "jira", installationId: "inst_acme" });
    const id = created.body.connection.id;
    await call("POST", `/v1/integrations/${id}/routes`, { repositoryId: REPO_ID });
    assert.equal(jira.webhooksOf("cloud-acme").length, 1);

    const deleted = await call("DELETE", `/v1/integrations/${id}`);
    assert.equal(deleted.status, 200);
    assert.equal(jira.webhooksOf("cloud-acme").length, 0, "no orphan left at Jira");
    assert.equal(await getJiraWebhook(pool, id), null);
  });
});

test("MF2: disconnect with Jira down still answers 200 and drops the row", { skip }, async () => {
  await withDb(async ({ pool, jira, tokens, deps }) => {
    const call = apiCaller(pool, tokens, deps);
    const created = await call("POST", "/v1/integrations", { provider: "jira", installationId: "inst_beta" });
    const id = created.body.connection.id;
    await call("POST", `/v1/integrations/${id}/routes`, { repositoryId: REPO_ID });
    assert.ok(await getJiraWebhook(pool, id));
    jira.failAll = 503;
    const deleted = await call("DELETE", `/v1/integrations/${id}`);
    assert.equal(deleted.status, 200);
    assert.equal(await getJiraWebhook(pool, id), null);
  });
});

test("MF3: a hanging Jira bounds ensure, the API request and the sweep", { skip, timeout: 20_000 }, async () => {
  await withDb(async ({ pool, organizationId, jira, tokens, deps }) => {
    const connection = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_ID });
    jira.hang = true;
    const bounded = { ...deps, timeoutMs: 100 };

    let started = Date.now();
    const outcome = await ensureJiraWebhook(pool, connection, bounded);
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.reason, /timed out/);
    assert.ok(Date.now() - started < 5_000);
    assert.match((await getJiraWebhook(pool, connection.id)).lastError, /timed out/);

    // Through the API: the route is written and answered; the failure is recorded, not returned.
    const call = apiCaller(pool, tokens, bounded);
    started = Date.now();
    const route = await call("POST", `/v1/integrations/${connection.id}/routes`, {
      scopeKind: "jira_project",
      scopeValue: "ENG",
      repositoryId: REPO_ID,
    });
    assert.equal(route.status, 201);
    assert.ok(Date.now() - started < 5_000);

    // The sweep: per-request bound, and the time budget stops it starting another connection.
    const beta = await connect(pool, organizationId, "inst_beta", "cloud-beta");
    await addRoute(pool, organizationId, beta.id, { repositoryId: REPO_ID });
    const sweep = await refreshJiraWebhooks(pool, { ...bounded, budgetMs: 0 });
    assert.equal(sweep.connections, 2);
    assert.equal(sweep.failed, 1);
    assert.equal(sweep.skipped, 1);
    const capped = await refreshJiraWebhooks(pool, { ...bounded, maxConnections: 1 });
    assert.equal(capped.skipped, 1);
  });
});

test("SF: a default route over many projects is chunked and capped, with a warning", { skip }, async () => {
  await withDb(async ({ pool, organizationId, jira, deps }) => {
    const many = Array.from({ length: 250 }, (_, i) => `P${String(i).padStart(3, "0")}`);
    jira.site("cloud-acme", { projects: many });
    const connection = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    await addRoute(pool, organizationId, connection.id, { repositoryId: REPO_ID });
    assert.equal((await ensureJiraWebhook(pool, connection, deps)).kind, "registered");
    const hooks = jira.webhooksOf("cloud-acme");
    assert.equal(hooks.length, 2);
    for (const hook of hooks) assert.equal(hook.jqlFilter.match(/"P\d+"/g).length, 100);
    const row = await getJiraWebhook(pool, connection.id);
    assert.equal(row.webhookIds.length, 2);
    assert.match(row.lastError, /50 more are not watched/);
    // Unchanged on the next pass: the chunked filters compare equal.
    assert.equal((await ensureJiraWebhook(pool, connection, deps)).kind, "unchanged");
  });
});

test("SF: projectJqlFilters chunks at 100 keys and caps at 2 webhooks", () => {
  const keys = Array.from({ length: 205 }, (_, i) => `K${i}`);
  const { filters, dropped } = projectJqlFilters(keys);
  assert.equal(filters.length, 2);
  assert.equal(dropped, 5);
  assert.deepEqual(projectJqlFilters(["B", "A"]), { filters: ['project IN ("A", "B")'], dropped: 0 });
});

// ---------------------------------------------------------------------------
// #313: reap orphaned and leaked webhooks
// ---------------------------------------------------------------------------

const ids = (jira, cloudId) => jira.webhooksOf(cloudId).map((w) => w.id).sort();
const dirtyMarks = async (pool) => (await pool.query("select connection_id from jira_webhook_dirty")).rows;

test("#313-1: a registration whose record fails is deleted at Jira again — no orphan", { skip }, async () => {
  await withDb(async ({ pool, organizationId, jira, deps }) => {
    const connection = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    await addRoute(pool, organizationId, connection.id, { scopeKind: "jira_project", scopeValue: "ENG", repositoryId: REPO_ID });
    // The record of a registration (a row that gains ids) is refused.
    await pool.query(`create function refuse_record() returns trigger language plpgsql as $$
      begin
        if cardinality(new.webhook_ids) > 0 and (tg_op = 'INSERT' or new.webhook_ids is distinct from old.webhook_ids) then
          raise exception 'record refused';
        end if;
        return new;
      end $$`);
    await pool.query("create trigger refuse_record before insert or update on jira_webhook for each row execute function refuse_record()");

    const failed = await ensureJiraWebhook(pool, connection, deps);
    assert.equal(failed.kind, "failed");
    assert.equal(jira.webhooksOf("cloud-acme").length, 0, "the unrecorded webhook was deleted at Jira");
    const errorRow = await getJiraWebhook(pool, connection.id);
    assert.deepEqual(errorRow.webhookIds, []);
    assert.match(errorRow.lastError, /record refused/);

    // A re-registration whose record is refused keeps the old webhook, and only it.
    await pool.query("alter table jira_webhook disable trigger refuse_record");
    assert.equal((await ensureJiraWebhook(pool, connection, deps)).kind, "registered");
    const before = await getJiraWebhook(pool, connection.id);
    await pool.query("alter table jira_webhook enable trigger refuse_record");
    await addRoute(pool, organizationId, connection.id, { scopeKind: "jira_project", scopeValue: "OPS", repositoryId: REPO_ID });
    assert.equal((await ensureJiraWebhook(pool, connection, deps)).kind, "failed");
    assert.deepEqual(ids(jira, "cloud-acme"), before.webhookIds, "still watching, nothing leaked");
    assert.deepEqual((await getJiraWebhook(pool, connection.id)).webhookIds, before.webhookIds);
  });
});

test("#313-1: a registration whose commit fails is deleted at Jira again — no orphan", { skip }, async () => {
  await withDb(async ({ pool, organizationId, jira, deps }) => {
    const connection = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    await addRoute(pool, organizationId, connection.id, { scopeKind: "jira_project", scopeValue: "ENG", repositoryId: REPO_ID });
    assert.equal((await ensureJiraWebhook(pool, connection, deps)).kind, "registered");
    const before = await getJiraWebhook(pool, connection.id);

    // Every write to jira_webhook now fails at COMMIT (a deferred constraint trigger).
    await pool.query(`create function refuse_commit() returns trigger language plpgsql as $$
      begin raise exception 'commit refused'; end $$`);
    await pool.query(`create constraint trigger refuse_commit after insert or update on jira_webhook
      deferrable initially deferred for each row execute function refuse_commit()`);
    await addRoute(pool, organizationId, connection.id, { scopeKind: "jira_project", scopeValue: "OPS", repositoryId: REPO_ID });
    const outcome = await ensureJiraWebhook(pool, connection, deps);
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.reason, /commit refused/);
    assert.deepEqual(ids(jira, "cloud-acme"), before.webhookIds, "the new webhook was deleted again");
    const row = await getJiraWebhook(pool, connection.id);
    assert.deepEqual(row.webhookIds, before.webhookIds);
    assert.equal(row.jql, before.jql);

    // Once commits work, the next pass re-registers cleanly: one webhook, recorded.
    await pool.query("drop trigger refuse_commit on jira_webhook");
    assert.equal((await ensureJiraWebhook(pool, connection, deps)).kind, "registered");
    assert.deepEqual(ids(jira, "cloud-acme"), (await getJiraWebhook(pool, connection.id)).webhookIds);
  });
});

test("#313-1: a replaced webhook whose delete fails is recorded as retired and deleted next pass", { skip }, async () => {
  await withDb(async ({ pool, organizationId, jira, deps }) => {
    const connection = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    await addRoute(pool, organizationId, connection.id, { scopeKind: "jira_project", scopeValue: "ENG", repositoryId: REPO_ID });
    await ensureJiraWebhook(pool, connection, deps);
    const before = await getJiraWebhook(pool, connection.id);

    await addRoute(pool, organizationId, connection.id, { scopeKind: "jira_project", scopeValue: "OPS", repositoryId: REPO_ID });
    jira.failOnce.set("DELETE webhook", 500);
    assert.equal((await ensureJiraWebhook(pool, connection, deps)).kind, "registered");
    const after = await getJiraWebhook(pool, connection.id);
    assert.deepEqual(after.retiredWebhookIds, before.webhookIds, "the replaced id is not forgotten");
    assert.match(after.lastError, /could not be deleted yet/);
    assert.equal(jira.webhooksOf("cloud-acme").length, 2);

    assert.equal((await ensureJiraWebhook(pool, connection, deps)).kind, "unchanged");
    assert.deepEqual(ids(jira, "cloud-acme"), after.webhookIds);
    const healed = await getJiraWebhook(pool, connection.id);
    assert.deepEqual(healed.retiredWebhookIds, []);
    assert.equal(healed.lastError, null);
  });
});

test("#313-2: a disconnect during a long sweep is completed by the holder", { skip }, async () => {
  await withDb(async ({ pool, jira, tokens, deps }) => {
    const call = apiCaller(pool, tokens, { ...deps, lockTimeoutMs: 100 });
    const created = await call("POST", "/v1/integrations", { provider: "jira", installationId: "inst_acme" });
    const id = created.body.connection.id;
    await call("POST", `/v1/integrations/${id}/routes`, { repositoryId: REPO_ID });
    assert.equal(jira.webhooksOf("cloud-acme").length, 1);

    // The sweep's ensure holds the connection, stuck on a slow Jira; the disconnect finds it busy.
    const gate = jira.pause("GET webhook");
    const sweep = refreshJiraWebhooks(pool, deps);
    await gate.arrived;
    const deleted = await call("DELETE", `/v1/integrations/${id}`);
    assert.equal(deleted.status, 200);
    assert.equal(jira.webhooksOf("cloud-acme").length, 1, "busy: the disconnect deleted nothing");
    assert.equal((await dirtyMarks(pool)).length, 1);

    gate.release();
    await sweep;
    assert.equal(jira.webhooksOf("cloud-acme").length, 0, "the holder removed it on finishing");
    assert.equal(await getJiraWebhook(pool, id), null);
    assert.equal((await dirtyMarks(pool)).length, 0);
  });
});

test("#313-2: the sweep reaps the rows and webhooks of disconnected connections", { skip }, async () => {
  await withDb(async ({ pool, organizationId, jira, deps }) => {
    const acme = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    const beta = await connect(pool, organizationId, "inst_beta", "cloud-beta");
    await addRoute(pool, organizationId, acme.id, { repositoryId: REPO_ID });
    await addRoute(pool, organizationId, beta.id, { repositoryId: REPO_ID });
    await ensureJiraWebhook(pool, acme, deps);
    await ensureJiraWebhook(pool, beta, deps);
    // Acme was disconnected and its webhook never deleted (the disconnect found it busy, and the
    // holder died); its row also holds a retired id never deleted.
    const extra = (
      await new JiraClient("cloud-acme", "t", { fetch: jira.fetch }).registerWebhooks(`${PUBLIC_URL}/api/intake/jira`, [
        'project IN ("OPS")',
      ])
    )[0];
    await pool.query("update jira_webhook set retired_webhook_ids = $2::bigint[] where connection_id = $1", [acme.id, [extra]]);
    await disconnectConnection(pool, organizationId, acme.id);
    assert.equal(jira.webhooksOf("cloud-acme").length, 2);

    const result = await refreshJiraWebhooks(pool, deps);
    assert.equal(result.reaped, 1);
    assert.equal(result.connections, 1, "only beta is ensured");
    assert.equal(jira.webhooksOf("cloud-acme").length, 0, "the recorded and the retired webhook are deleted");
    assert.equal(await getJiraWebhook(pool, acme.id), null);
    assert.equal(jira.webhooksOf("cloud-beta").length, 1, "the active connection is untouched");
    assert.equal((await refreshJiraWebhooks(pool, deps)).reaped, 0, "nothing left to reap");
  });
});

test("#313-3: a route change that finds the connection busy is applied when the holder finishes", { skip }, async () => {
  await withDb(async ({ pool, organizationId, jira, tokens, deps }) => {
    const connection = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    await addRoute(pool, organizationId, connection.id, { scopeKind: "jira_project", scopeValue: "ENG", repositoryId: REPO_ID });
    await ensureJiraWebhook(pool, connection, deps);

    const gate = jira.pause("GET webhook");
    const sweep = refreshJiraWebhooks(pool, deps);
    await gate.arrived;
    // The API's ensure waits 100 ms for the lock, gives up "busy", and marks the connection.
    const call = apiCaller(pool, tokens, { ...deps, lockTimeoutMs: 100 });
    const route = await call("POST", `/v1/integrations/${connection.id}/routes`, {
      scopeKind: "jira_project",
      scopeValue: "OPS",
      repositoryId: REPO_ID,
    });
    assert.equal(route.status, 201);
    assert.equal((await getJiraWebhook(pool, connection.id)).jql, 'project IN ("ENG")', "busy: nothing written");
    assert.equal((await dirtyMarks(pool)).length, 1);

    gate.release();
    const result = await sweep;
    assert.equal(result.registered, 1, "the holder re-ran for the change it could not see");
    const row = await getJiraWebhook(pool, connection.id);
    assert.equal(row.jql, 'project IN ("ENG", "OPS")');
    assert.deepEqual(ids(jira, "cloud-acme"), row.webhookIds);
    assert.equal(jira.webhooksOf("cloud-acme")[0].jqlFilter, 'project IN ("ENG", "OPS")');
    assert.equal((await dirtyMarks(pool)).length, 0);
  });
});

test("#313-3: a standing dirty mark goes first in the next sweep, and is cleared by it", { skip }, async () => {
  await withDb(async ({ pool, organizationId, jira, deps }) => {
    const acme = await connect(pool, organizationId, "inst_acme", "cloud-acme");
    const beta = await connect(pool, organizationId, "inst_beta", "cloud-beta");
    await addRoute(pool, organizationId, acme.id, { repositoryId: REPO_ID });
    await addRoute(pool, organizationId, beta.id, { repositoryId: REPO_ID });
    // Beta was marked, and whoever held it never re-ran (it died).
    await pool.query("insert into jira_webhook_dirty (connection_id) values ($1)", [beta.id]);
    const result = await refreshJiraWebhooks(pool, { ...deps, maxConnections: 1 });
    assert.equal(result.registered, 1);
    assert.equal(result.skipped, 1);
    assert.equal(jira.webhooksOf("cloud-beta").length, 1, "the marked connection went first");
    assert.equal(jira.webhooksOf("cloud-acme").length, 0);
    assert.equal((await dirtyMarks(pool)).length, 0);
  });
});

test("#313-6: a default route's project listing stops paging once the sweep budget is spent", async () => {
  const jira = new FakeJira().site("cloud-acme", { projects: Array.from({ length: 120 }, (_, i) => `P${i}`) });
  const pages = [];
  const slow = async (input, init) => {
    pages.push(input);
    await new Promise((resolve) => setTimeout(resolve, 40));
    return jira.fetch(input, init);
  };
  const client = new JiraClient("cloud-acme", "t", { fetch: slow });
  assert.equal((await client.listProjectKeys()).length, 120, "three pages of 50, unbounded");
  pages.length = 0;
  await assert.rejects(client.listProjectKeys(performance.now() + 20), /time budget is spent/);
  assert.equal(pages.length, 1, "the second page is never asked for");
  await assert.rejects(client.listProjectKeys(performance.now() - 1), /time budget is spent/);
});
