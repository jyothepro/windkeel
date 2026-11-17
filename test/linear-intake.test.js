/**
 * Linear intake (M8-7, #299): a Linear issue carrying the route's trigger label becomes a task,
 * the delivery lands in the ledger, and the issue gets an "Windkeel started" comment after commit.
 * Connect verification, Linear's GraphQL API and the run enqueuer are all fakes: no network.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { runIntake } from "../dist/intake/pipeline.js";
import { createLinearIntakeSource, LINEAR_REPLAY_TOLERANCE_MS } from "../dist/intake/linear.js";
import { addRoute, createConnection } from "../dist/integrations/connections.js";
import { FakeProviderTokenSource } from "../dist/integrations/token-source.js";
import { fakeConnectForwardVerifier } from "../dist/integrations/vercel-connect.js";
import { LINEAR_GRAPHQL_URL } from "../dist/integrations/linear.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const REPO_A = "11111111-1111-1111-1111-111111111111";
const REPO_B = "22222222-2222-2222-2222-222222222222";
const LINEAR_ORG = "7c3a1f0e-2b4d-4e6f-9a8b-1c2d3e4f5a6b";
const TEAM = "0f1e2d3c-4b5a-4968-8776-655443322110";
const ISSUE = "4b8c2a1d-6e5f-4a3b-9c8d-7e6f5a4b3c2d";
const INSTALLATION = "inst_linear_1";
const OIDC = "test-connect-oidc";
const NOW = 1_790_330_400_000;

function fixture(name, overrides = {}) {
  const payload = JSON.parse(readFileSync(join(repoRoot, "test/fixtures/linear", `${name}.json`), "utf8"));
  return { ...payload, webhookTimestamp: NOW, ...overrides };
}

function request(payload, { delivery = `delivery-${Math.random()}`, token = OIDC } = {}) {
  return {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(delivery ? { "linear-delivery": delivery } : {}),
      "content-type": "application/json",
    },
    rawBody: JSON.stringify(payload),
  };
}

function fakeLinear() {
  const requests = [];
  return {
    requests,
    async fetch(url, init) {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "x" } } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

let serial = 0;
async function withSchema(fn) {
  const schema = `windkeel_linear_intake_test_${Date.now()}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool, REPO_A);
    await seedFixtureRepository(pool, REPO_B);
    const org = (await pool.query("select id from organization where is_default")).rows[0].id;
    const { connection } = await createConnection(pool, {
      organizationId: org,
      provider: "linear",
      installationId: INSTALLATION,
      externalTenantId: LINEAR_ORG,
      externalTenantName: "Acme",
      createdByPrincipalId: null,
    });
    const started = [];
    const linear = fakeLinear();
    const tokens = new FakeProviderTokenSource().install("linear", INSTALLATION, { tenantId: LINEAR_ORG, name: "Acme" });
    const source = createLinearIntakeSource({
      startRun: async (runId) => {
        started.push(runId);
        return { enqueued: true };
      },
      tokenSource: tokens,
      verifyForward: fakeConnectForwardVerifier(OIDC),
      fetch: linear.fetch,
      consoleUrl: () => "https://console.example",
      now: () => NOW,
      log: () => {},
    });
    const intake = (payload, opts) => runIntake(source, request(payload, opts), { pool, log: () => {} });
    await fn({ pool, org, connection, started, linear, intake });
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

async function ledger(pool) {
  return (await pool.query("select * from intake_delivery where source = 'linear' order by received_at")).rows;
}

async function tasks(pool) {
  return (await pool.query("select * from engineering_task where source_type = 'linear'")).rows;
}

test("an issue created with the trigger label becomes a task, a ledger row and a start comment after commit", { skip }, async () => {
  await withSchema(async ({ pool, org, connection, started, linear, intake }) => {
    await addRoute(pool, org, connection.id, { repositoryId: REPO_A });
    const response = await intake(fixture("issue-create-with-label"), { delivery: "d-create" });
    assert.equal(response.status, 200);
    assert.equal(response.body.intent, "create_task");

    const [task] = await tasks(pool);
    assert.equal(task.organization_id, org);
    assert.equal(task.repository_id, REPO_A);
    assert.equal(task.source_reference, `linear:${LINEAR_ORG}:${ISSUE}`);
    assert.equal(task.title, "Retry uploads on 5xx");
    assert.equal(task.risk_level, "high", "risk:high label");
    assert.equal(task.acceptance_criteria.length, 2);
    assert.deepEqual(task.source_context, {
      organizationId: LINEAR_ORG,
      issueId: ISSUE,
      identifier: "ENG-42",
      url: "https://linear.app/acme/issue/ENG-42/retry-uploads-on-5xx",
      teamId: TEAM,
    });
    const actor = (await pool.query("select system_purpose from principal where id = $1", [task.created_by_principal_id])).rows[0];
    assert.equal(actor.system_purpose, "linear");

    const [row] = await ledger(pool);
    assert.equal(row.delivery_key, "d-create");
    assert.equal(row.intent, "create_task:started");
    assert.equal(row.engineering_task_id, task.id);
    assert.equal(row.organization_id, org);
    assert.equal(row.event, "Issue");
    assert.equal(row.action, "create");

    const run = (await pool.query("select id from engineering_run where task_id = $1", [task.id])).rows[0];
    assert.deepEqual(started, [run.id]);
    assert.equal(linear.requests.length, 1);
    const [call] = linear.requests;
    assert.equal(call.url, LINEAR_GRAPHQL_URL);
    assert.match(call.headers.authorization, /^Bearer fake-linear-inst_linear_1-/);
    assert.match(call.body.query, /commentCreate/);
    assert.equal(call.body.variables.input.issueId, ISSUE);
    assert.equal(call.body.variables.input.body, `Windkeel started · https://console.example/runs/${run.id}`);
    assert.match(call.body.variables.input.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

test("a label added on update starts a task; an unrelated update is ignored", { skip }, async () => {
  await withSchema(async ({ pool, org, connection, intake }) => {
    await addRoute(pool, org, connection.id, { repositoryId: REPO_A });
    const unrelated = await intake(fixture("issue-update-no-label-change"));
    assert.deepEqual([unrelated.status, unrelated.body.reason], [200, "label_not_newly_added"]);
    assert.equal((await tasks(pool)).length, 0);

    const added = await intake(fixture("issue-update-label-added"));
    assert.equal(added.body.intent, "create_task");
    assert.equal((await tasks(pool)).length, 1);
    assert.equal((await tasks(pool))[0].risk_level, "low");
  });
});

test("comment and remove events, unknown workspaces and missing labels are ignored and recorded", { skip }, async () => {
  await withSchema(async ({ pool, org, connection, intake, linear }) => {
    await addRoute(pool, org, connection.id, { repositoryId: REPO_A });
    const comment = await intake(fixture("comment-create"));
    assert.equal(comment.body.reason, "not_an_issue");
    const removed = await intake(fixture("issue-remove"));
    assert.equal(removed.body.reason, "removed");
    const stranger = await intake(fixture("issue-create-with-label", { organizationId: "someone-else" }));
    assert.equal(stranger.body.reason, "unknown_tenant");
    const unlabelled = fixture("issue-create-with-label");
    unlabelled.data.labels = [];
    unlabelled.data.labelIds = [];
    assert.equal((await intake(unlabelled)).body.reason, "label_absent");

    const rows = await ledger(pool);
    assert.deepEqual(rows.map((r) => r.reason).sort(), ["label_absent", "not_an_issue", "removed", "unknown_tenant"]);
    assert.ok(rows.every((r) => r.intent === "ignore"));
    assert.equal(rows.find((r) => r.reason === "unknown_tenant").organization_id, null);
    assert.equal(rows.find((r) => r.reason === "removed").organization_id, org);
    assert.equal((await tasks(pool)).length, 0);
    assert.equal(linear.requests.length, 0);
  });
});

test("a team route beats the default; no route is ignored", { skip }, async () => {
  await withSchema(async ({ pool, org, connection, intake }) => {
    const none = await intake(fixture("issue-create-with-label"));
    assert.equal(none.body.reason, "no_route");

    await addRoute(pool, org, connection.id, { repositoryId: REPO_A });
    await addRoute(pool, org, connection.id, { scopeKind: "linear_team", scopeValue: TEAM, repositoryId: REPO_B });
    const routed = await intake(fixture("issue-create-with-label"));
    assert.equal(routed.body.intent, "create_task");
    assert.equal((await tasks(pool))[0].repository_id, REPO_B);
  });
});

test("a team route may name the team key, and a disabled one is ignored rather than falling through", { skip }, async () => {
  await withSchema(async ({ pool, org, connection, intake }) => {
    await addRoute(pool, org, connection.id, { repositoryId: REPO_A });
    await addRoute(pool, org, connection.id, {
      scopeKind: "linear_team",
      scopeValue: "ENG",
      repositoryId: REPO_B,
      enabled: false,
    });
    const response = await intake(fixture("issue-create-with-label"));
    assert.equal(response.body.reason, "route_disabled");
    assert.equal((await tasks(pool)).length, 0);
  });
});

test("the route's trigger label is the one that counts", { skip }, async () => {
  await withSchema(async ({ pool, org, connection, intake }) => {
    await addRoute(pool, org, connection.id, { repositoryId: REPO_A, triggerLabel: "build-it" });
    assert.equal((await intake(fixture("issue-create-with-label"))).body.reason, "label_absent");
  });
});

test("a stale or future timestamp is 401 and a failed OIDC check is 401, with no rows", { skip }, async () => {
  await withSchema(async ({ pool, org, connection, intake }) => {
    await addRoute(pool, org, connection.id, { repositoryId: REPO_A });
    const stale = await intake(fixture("issue-create-with-label", { webhookTimestamp: NOW - LINEAR_REPLAY_TOLERANCE_MS - 1 }));
    assert.equal(stale.status, 401);
    const future = await intake(fixture("issue-create-with-label", { webhookTimestamp: NOW + LINEAR_REPLAY_TOLERANCE_MS + 1 }));
    assert.equal(future.status, 401);
    const forged = await intake(fixture("issue-create-with-label"), { token: "not-the-token" });
    assert.equal(forged.status, 401);
    const bare = await intake(fixture("issue-create-with-label"), { token: null });
    assert.equal(bare.status, 401);
    assert.equal((await ledger(pool)).length, 0);
    assert.equal((await tasks(pool)).length, 0);
  });
});

test("a duplicate delivery is answered duplicate; the key falls back to webhookId:issue:timestamp", { skip }, async () => {
  await withSchema(async ({ pool, org, connection, intake, started }) => {
    await addRoute(pool, org, connection.id, { repositoryId: REPO_A });
    await intake(fixture("issue-create-with-label"), { delivery: "d-1" });
    const again = await intake(fixture("issue-create-with-label"), { delivery: "d-1" });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(started.length, 1);

    const noHeader = await intake(fixture("comment-create"), { delivery: null });
    assert.equal(noHeader.status, 200);
    const keys = (await ledger(pool)).map((r) => r.delivery_key);
    assert.ok(keys.includes(`9d8c7b6a-5f4e-4d3c-8b2a-1a0b9c8d7e6f:c0ffee00-1111-4222-8333-444455556666:${NOW}`));
  });
});

test("re-labelling mirrors GitHub: live run ⇒ already_tasked; all runs terminal ⇒ a fresh run on the same task", { skip }, async () => {
  await withSchema(async ({ pool, org, connection, intake, started, linear }) => {
    await addRoute(pool, org, connection.id, { repositoryId: REPO_A });
    await intake(fixture("issue-create-with-label"));
    const [task] = await tasks(pool);
    const firstRun = (await pool.query("select id from engineering_run where task_id = $1", [task.id])).rows[0].id;

    // Still CREATED: the enqueue may never have happened, so a re-label re-enqueues (the heal).
    const healed = await intake(fixture("issue-update-label-added"));
    assert.equal(healed.body.intent, "create_task");
    assert.deepEqual(started, [firstRun, firstRun]);

    await pool.query("update engineering_run set status = 'IMPLEMENTING' where id = $1", [firstRun]);
    const live = await intake(fixture("issue-update-label-added"));
    assert.deepEqual([live.status, live.body.intent, live.body.reason], [200, "ignore", "already_tasked"]);
    const row = (await ledger(pool)).at(-1);
    assert.equal(row.reason, "already_tasked");
    assert.equal(row.engineering_task_id, task.id);
    assert.equal(started.length, 2);

    await pool.query("update engineering_run set status = 'FAILED' where id = $1", [firstRun]);
    const edited = fixture("issue-update-label-added");
    edited.data.title = "Retry uploads, take two";
    const rerun = await intake(edited);
    assert.equal(rerun.body.intent, "create_task");
    const runs = (await pool.query("select id from engineering_run where task_id = $1 order by created_at", [task.id])).rows;
    assert.equal(runs.length, 2);
    assert.equal((await tasks(pool)).length, 1);
    assert.equal((await tasks(pool))[0].title, "Retry uploads, take two");
    assert.equal(started.at(-1), runs[1].id);
    // Each run's start comment has its own id; the healed re-post of the first reused its id.
    const ids = linear.requests.map((r) => r.body.variables.input.id);
    assert.equal(ids[0], ids[1]);
    assert.notEqual(ids.at(-1), ids[0]);
  });
});

test("ORQ-08: after the route's repository grant is removed, neither a new issue nor a re-label of an old one starts a run", { skip }, async () => {
  await withSchema(async ({ pool, org, connection, intake, started }) => {
    await addRoute(pool, org, connection.id, { repositoryId: REPO_A });
    await intake(fixture("issue-create-with-label"));
    const [task] = await tasks(pool);
    const firstRun = (await pool.query("select id from engineering_run where task_id = $1", [task.id])).rows[0].id;
    await pool.query("update engineering_run set status = 'FAILED' where id = $1", [firstRun]);
    assert.equal(started.length, 1);

    await pool.query("delete from repository_grant where organization_id = $1 and repository_id = $2", [org, REPO_A]);

    // The existing task: a re-label would have started a fresh run on it.
    const relabel = await intake(fixture("issue-update-label-added"));
    assert.deepEqual([relabel.status, relabel.body.intent, relabel.body.reason], [200, "ignore", "repository_not_granted"]);
    assert.equal((await ledger(pool)).at(-1).engineering_task_id, task.id);
    assert.equal((await pool.query("select count(*)::int as n from engineering_run")).rows[0].n, 1, "no fresh run");

    // A new issue on the same route.
    const other = fixture("issue-create-with-label");
    other.data = { ...other.data, id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a" };
    const fresh = await intake(other);
    assert.deepEqual([fresh.status, fresh.body.reason], [200, "repository_not_granted"]);
    assert.equal((await tasks(pool)).length, 1, "no new task");
    assert.equal(started.length, 1, "nothing was enqueued");
  });
});

test("a failing Linear comment never fails the delivery; a failing enqueue does (500, row released)", { skip }, async () => {
  await withSchema(async ({ pool, org, connection }) => {
    await addRoute(pool, org, connection.id, { repositoryId: REPO_A });
    const tokens = new FakeProviderTokenSource().install("linear", INSTALLATION, { tenantId: LINEAR_ORG, name: "Acme" });
    const logs = [];
    let failEnqueue = false;
    const source = createLinearIntakeSource({
      startRun: async () => {
        if (failEnqueue) throw new Error("queue unavailable");
        return { enqueued: true };
      },
      tokenSource: tokens,
      verifyForward: fakeConnectForwardVerifier(OIDC),
      fetch: async () => new Response(JSON.stringify({ errors: [{ message: "boom lin_api_SECRET", extensions: { code: "INTERNAL" } }] }), { status: 200 }),
      now: () => NOW,
      log: (message, fields) => logs.push({ message, ...fields }),
    });
    const ok = await runIntake(source, request(fixture("issue-create-with-label")), { pool, log: () => {} });
    assert.equal(ok.status, 200);
    assert.equal(logs[0].message, "linear start comment failed");
    assert.doesNotMatch(JSON.stringify(logs), /lin_api_SECRET|fake-linear/);

    failEnqueue = true;
    const edited = fixture("issue-create-with-label", { organizationId: LINEAR_ORG });
    await pool.query("update engineering_run set status = 'FAILED'");
    const failed = await runIntake(source, request(edited, { delivery: "d-fail" }), { pool, log: () => {} });
    assert.equal(failed.status, 500);
    assert.equal((await pool.query("select 1 from intake_delivery where delivery_key = 'd-fail'")).rowCount, 0);
  });
});

// --- Tech-lead review (#306) ---

function sourceWith(overrides = {}) {
  const tokens = new FakeProviderTokenSource().install("linear", INSTALLATION, { tenantId: LINEAR_ORG, name: "Acme" });
  return createLinearIntakeSource({
    startRun: async () => ({ enqueued: true }),
    tokenSource: tokens,
    verifyForward: fakeConnectForwardVerifier(OIDC),
    fetch: fakeLinear().fetch,
    consoleUrl: () => "https://console.example",
    now: () => NOW,
    log: () => {},
    ...overrides,
  });
}

test("re-label rerun goes through the shared helper: keeps the task's risk, refreshes source_context, applies rails", { skip }, async () => {
  await withSchema(async ({ pool, org, connection, intake }) => {
    await addRoute(pool, org, connection.id, { repositoryId: REPO_A });
    await intake(fixture("issue-create-with-label")); // risk:high
    const [task] = await tasks(pool);
    assert.equal(task.risk_level, "high");
    await pool.query("update engineering_run set status = 'FAILED' where task_id = $1", [task.id]);
    // The failed run's gate had generated criteria and a person approved them (#317's gate reads both).
    await pool.query(
      `update engineering_task set criteria_provenance = 'generated', criteria_generated_by = 'openai/x',
         criteria_approved_at = now(), criteria_approved_by = 'alice' where id = $1`,
      [task.id],
    );

    const moved = fixture("issue-update-label-added"); // no risk: label
    moved.data.identifier = "OPS-7";
    moved.data.url = "https://linear.app/acme/issue/OPS-7/retry-uploads-on-5xx";
    const source = sourceWith({ rails: { spendCapUsd: 3 } });
    const response = await runIntake(source, request(moved), { pool, log: () => {} });
    assert.equal(response.body.intent, "create_task");

    const [after] = await tasks(pool);
    assert.equal(after.risk_level, "high", "no risk label keeps the task's risk, not 'low'");
    assert.equal(after.source_context.identifier, "OPS-7", "source_context re-read from the issue");
    assert.equal(after.source_context.url, "https://linear.app/acme/issue/OPS-7/retry-uploads-on-5xx");
    // The criteria were re-read from the issue, so the old run's provenance and approval go with them.
    assert.equal(after.criteria_provenance, "extracted");
    assert.equal(after.criteria_generated_by, null);
    assert.equal(after.criteria_approved_at, null, "an earlier approval does not carry to re-read criteria");
    assert.equal(after.criteria_approved_by, null);
    const newest = (
      await pool.query("select spend_cap_usd from engineering_run where task_id = $1 order by created_at desc limit 1", [task.id])
    ).rows[0];
    assert.equal(Number(newest.spend_cap_usd), 3, "the source's rails apply to the rerun");
    assert.equal((await ledger(pool)).at(-1).intent, "create_task:rerun");
  });
});

test("the start comment is sent after commit: its rows are visible from a second connection inside fetch", { skip }, async () => {
  await withSchema(async ({ pool, org, connection }) => {
    await addRoute(pool, org, connection.id, { repositoryId: REPO_A });
    const seen = [];
    const source = sourceWith({
      fetch: async () => {
        const other = await pool.connect(); // not the delivery's transaction
        try {
          const t = await other.query("select count(*)::int as n from engineering_task where source_type = 'linear'");
          const d = await other.query("select intent from intake_delivery where delivery_key = 'd-after'");
          seen.push({ tasks: t.rows[0].n, delivery: d.rows[0]?.intent ?? null });
        } finally {
          other.release();
        }
        return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), { status: 200 });
      },
    });
    const response = await runIntake(source, request(fixture("issue-create-with-label"), { delivery: "d-after" }), {
      pool,
      log: () => {},
    });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, [{ tasks: 1, delivery: "create_task:started" }]);
  });
});

test("the start comment is bounded: a hung Linear or Connect call is logged and the delivery still answers", { skip }, async () => {
  await withSchema(async ({ pool, org, connection }) => {
    await addRoute(pool, org, connection.id, { repositoryId: REPO_A });
    const logs = [];
    const hungFetch = sourceWith({
      fetch: () => new Promise(() => {}),
      startCommentTimeoutMs: 50,
      log: (message, fields) => logs.push({ message, ...fields }),
    });
    let started = Date.now();
    const a = await runIntake(hungFetch, request(fixture("issue-create-with-label")), { pool, log: () => {} });
    assert.equal(a.status, 200);
    assert.ok(Date.now() - started < 3_000, "did not wait on the hung request");
    assert.equal(logs[0].message, "linear start comment failed");
    assert.equal(logs[0].errorName, "LinearTimeoutError");

    const hungToken = sourceWith({
      tokenSource: { getToken: () => new Promise(() => {}), describeInstallation: async () => ({}), invalidate() {} },
      startCommentTimeoutMs: 50,
      log: (message, fields) => logs.push({ message, ...fields }),
    });
    await pool.query("update engineering_run set status = 'FAILED'");
    started = Date.now();
    const b = await runIntake(hungToken, request(fixture("issue-update-label-added")), { pool, log: () => {} });
    assert.equal(b.status, 200);
    assert.ok(Date.now() - started < 3_000, "did not wait on the hung token fetch");
    assert.equal(logs[1].errorName, "LinearTimeoutError");
  });
});

test("any newly added label with the trigger name counts, not just the first; labelIds-only is labels_unavailable", { skip }, async () => {
  await withSchema(async ({ pool, org, connection, intake }) => {
    await addRoute(pool, org, connection.id, { repositoryId: REPO_A });
    const idsOnly = fixture("issue-update-label-added");
    delete idsOnly.data.labels;
    assert.equal((await intake(idsOnly)).body.reason, "labels_unavailable");

    const twin = fixture("issue-update-label-added");
    const WORKSPACE_WINDKEEL = "a1b2c3d4-0000-4000-8000-0000000000aa";
    twin.data.labels = [{ id: WORKSPACE_WINDKEEL, name: "windkeel" }, ...twin.data.labels];
    twin.data.labelIds = [WORKSPACE_WINDKEEL, ...twin.data.labelIds];
    twin.updatedFrom.labelIds = [WORKSPACE_WINDKEEL, ...twin.updatedFrom.labelIds];
    const response = await intake(twin);
    assert.equal(response.body.intent, "create_task", "the team 'orqon' label was just added");
    assert.equal((await tasks(pool)).length, 1);
  });
});
