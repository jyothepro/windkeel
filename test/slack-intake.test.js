/**
 * Slack intake (#298, #307 review): slash commands and @mentions through `runIntake`, with a fake
 * Connect verifier and a fake Slack Web API that the intake must never call. No network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runIntake, wireResponse } from "../dist/intake/pipeline.js";
import * as slackModule from "../dist/intake/slack.js";
import { createSlackIntakeSource, parseSlackCommand } from "../dist/intake/slack.js";
import { fakeConnectForwardVerifier } from "../dist/integrations/vercel-connect.js";
import {
  CHANNEL,
  OIDC,
  TEAM,
  capturedLog,
  counts,
  eventRequest,
  fakeSlack,
  fixture,
  seedSlack,
  skip,
  slashRequest,
  tokenSource,
  withSchema,
} from "./slack-fakes.js";
import { FIXTURE_REPOSITORY_ID } from "./helpers.js";

/**
 * The source under test. The fake Slack API, token source and `defer` are offered to prove the
 * intake uses none of them: it makes no Slack call and defers no work (#307 must-fix 1).
 */
function harness({ startRun } = {}) {
  const slack = fakeSlack();
  const tokens = tokenSource();
  const started = [];
  const deferred = [];
  const { lines, log } = capturedLog();
  const source = createSlackIntakeSource({
    verify: fakeConnectForwardVerifier(OIDC),
    tokenSource: tokens,
    fetch: slack.fetch,
    consoleUrl: () => "https://console.windkeel.test",
    startRun:
      startRun ??
      (async (runId) => {
        started.push(runId);
        return { enqueued: true };
      }),
    defer: (work) => {
      deferred.push(work);
    },
    log,
  });
  return { source, slack, tokens, started, deferred, lines, log };
}

async function ledger(pool) {
  const { rows } = await pool.query("select source, delivery_key, intent, reason, engineering_task_id from intake_delivery");
  return rows;
}

async function onlyTask(pool) {
  const { rows } = await pool.query(
    "select id, source_type, source_reference, source_context, repository_id, risk_level, title, created_by_principal_id from engineering_task",
  );
  assert.equal(rows.length, 1);
  return rows[0];
}

const ephemeral = (text) => ({ status: 200, body: { response_type: "ephemeral", text } });

async function grantAcmeApi(pool) {
  await pool.query(
    `insert into repository (id, owner, name, default_branch, clone_url)
     values ('22222222-2222-2222-2222-222222222222', 'stranger', 'secret', 'main', 'https://github.com/stranger/secret.git'),
            ('33333333-3333-3333-3333-333333333333', 'acme', 'api', 'main', 'https://github.com/acme/api.git')`,
  );
  await pool.query(
    `insert into repository_grant (organization_id, repository_id, intake)
     select id, '33333333-3333-3333-3333-333333333333', true from organization where is_default`,
  );
}

// --- Grammar (no database) ---

test("the command grammar: help, a first-word repository candidate, description separators, risk, mention prefix", () => {
  assert.equal(parseSlackCommand("help").help, true);
  assert.equal(parseSlackCommand("  ").help, true);
  assert.deepEqual(parseSlackCommand("acme/api Fix login -- - [ ] logs in"), {
    help: false,
    repository: { owner: "acme", name: "api", rest: "Fix login" },
    title: "acme/api Fix login",
    description: "- [ ] logs in",
    riskLevel: "low",
  });
  const multi = parseSlackCommand("<@U0BOT> Fix login risk:high\n- [ ] a\n- [ ] b");
  assert.equal(multi.title, "Fix login");
  assert.equal(multi.description, "- [ ] a\n- [ ] b");
  assert.equal(multi.riskLevel, "high");
  assert.equal(multi.repository, null);
  assert.equal(parseSlackCommand("risk:medium Tidy the README").riskLevel, "medium");
  assert.equal(parseSlackCommand("risk:medium Tidy the README").title, "Tidy the README");
});

// --- The request path ---

test("slash command in a mapped channel: 200 ephemeral Starting…, task + ledger row, run enqueued — and no Slack call, deferred or not", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const h = harness();
    const response = await runIntake(h.source, slashRequest(), { pool });

    assert.equal(response.status, 200);
    assert.deepEqual(response.reply, ephemeral("Starting…"));
    assert.deepEqual(wireResponse(response), ephemeral("Starting…"));
    assert.equal(h.started.length, 1, "the run was enqueued after commit");
    assert.equal(h.deferred.length, 0, "no work is deferred past the response");
    assert.equal(h.slack.calls.length, 0, "the intake never calls Slack: the thread root is the notifier's");
    assert.equal(h.tokens.calls.length, 0, "nor asks Connect for a token");
    assert.equal(slackModule.vercelWaitUntil, undefined, "the waitUntil fallback is gone");
    assert.equal(slackModule.announceStarted, undefined);

    const task = await onlyTask(pool);
    assert.equal(task.source_type, "slack");
    assert.equal(task.source_reference, `slack:${TEAM}:1234567890.1111.aaaa`);
    assert.equal(task.repository_id, FIXTURE_REPOSITORY_ID);
    assert.equal(task.risk_level, "low");
    assert.equal(task.title, "Retry failed uploads");
    assert.deepEqual(task.source_context, { teamId: TEAM, channelId: CHANNEL, threadTs: null, requestedBySlackUser: "U0ALICE1" });
    const { rows: actor } = await pool.query("select system_purpose, organization_id from principal where id = $1", [task.created_by_principal_id]);
    assert.deepEqual(actor[0], { system_purpose: "slack", organization_id: organizationId });
    assert.deepEqual(await ledger(pool), [
      { source: "slack", delivery_key: "1234567890.1111.aaaa", intent: "create_task:started", reason: null, engineering_task_id: task.id },
    ]);

    const again = await runIntake(h.source, slashRequest(), { pool });
    assert.equal(again.body.duplicate, true);
    assert.deepEqual(again.reply, ephemeral("Already on it."));
    assert.equal(h.slack.calls.length, 0);
  });
});

test("a mention in a thread records that thread; events get the pipeline's own body", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool);
    const h = harness();
    const response = await runIntake(h.source, eventRequest(fixture("app-mention.json")), { pool });
    assert.equal(response.status, 200);
    assert.equal(response.body.intent, "create_task");
    assert.equal(response.reply, undefined, "events are not answered with a slash-command body");
    const task = await onlyTask(pool);
    assert.equal(task.title, "Fix the flaky login test");
    assert.equal(task.source_reference, `slack:${TEAM}:Ev0MENTION1`);
    assert.equal(task.source_context.threadTs, "1700000000.000100");
    assert.equal(h.slack.calls.length, 0);
  });
});

test("a Slack retry of the same event_id is a duplicate", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool);
    const h = harness();
    await runIntake(h.source, eventRequest(fixture("app-mention.json")), { pool });
    const retry = await runIntake(
      h.source,
      eventRequest(fixture("app-mention.json"), { headers: JSON.parse(fixture("retry-headers.json")) }),
      { pool },
    );
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);
    assert.deepEqual(await counts(pool), { deliveries: 1, tasks: 1 });
    assert.equal(h.started.length, 1);
  });
});

test("an unmapped channel is ignored no_route with an ephemeral explanation — a default route does not count", { skip }, async () => {
  await withSchema(async (pool) => {
    const { connectionId } = await seedSlack(pool, { route: false });
    await pool.query(
      "insert into integration_route (connection_id, scope_kind, repository_id) values ($1, 'default', $2)",
      [connectionId, FIXTURE_REPOSITORY_ID],
    );
    const h = harness();
    const response = await runIntake(h.source, slashRequest(), { pool });
    assert.equal(response.status, 200);
    assert.equal(response.body.reason, "no_route");
    assert.equal(response.reply.body.response_type, "ephemeral");
    assert.match(response.reply.body.text, /not mapped to a repository/);
    assert.deepEqual(await counts(pool), { deliveries: 1, tasks: 0 });
    assert.equal((await ledger(pool))[0].reason, "no_route");
  });
});

test("an explicit, granted repository in an unmapped channel is still no_route", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool, { route: false });
    await grantAcmeApi(pool);
    const response = await runIntake(harness().source, slashRequest({ text: "acme/api Add health check" }), { pool });
    assert.equal(response.body.reason, "no_route");
    assert.deepEqual(await counts(pool), { deliveries: 1, tasks: 0 });
  });
});

test("a disabled channel route is ignored route_disabled", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool, { enabled: false });
    const response = await runIntake(harness().source, slashRequest(), { pool });
    assert.equal(response.body.reason, "route_disabled");
    assert.deepEqual(await counts(pool), { deliveries: 1, tasks: 0 });
  });
});

test("ORQ-08: a route whose repository grant was removed afterwards starts nothing: ignored repository_not_granted", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    // The grant goes; the route, written while it existed, stays.
    await pool.query("delete from repository_grant where organization_id = $1 and repository_id = $2", [
      organizationId,
      FIXTURE_REPOSITORY_ID,
    ]);
    const h = harness();
    const response = await runIntake(h.source, slashRequest(), { pool });
    assert.equal(response.status, 200);
    assert.equal(response.body.reason, "repository_not_granted");
    assert.equal(response.reply.body.response_type, "ephemeral");
    assert.match(response.reply.body.text, /no longer granted/);
    assert.deepEqual(h.started, [], "no run was enqueued");
    assert.deepEqual(await counts(pool), { deliveries: 1, tasks: 0 });
  });
});

test("an unknown team is ignored unknown_tenant", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool);
    const response = await runIntake(harness().source, slashRequest({ team: "T0STRANGER" }), { pool });
    assert.equal(response.body.reason, "unknown_tenant");
    assert.match(response.reply.body.text, /not connected/);
    const rows = await ledger(pool);
    assert.equal(rows[0].reason, "unknown_tenant");
    assert.equal((await counts(pool)).tasks, 0);
  });
});

test("a first word is a repository only when it is one granted to the organization; otherwise it stays in the title", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool);
    await grantAcmeApi(pool);
    const h = harness();

    const accepted = await runIntake(h.source, slashRequest({ text: "acme/api Add health check risk:high", trigger: "t-2" }), { pool });
    assert.equal(accepted.body.intent, "create_task");
    const { rows: [granted] } = await pool.query("select repository_id, risk_level, title from engineering_task");
    assert.deepEqual(granted, { repository_id: "33333333-3333-3333-3333-333333333333", risk_level: "high", title: "Add health check" });
    await pool.query("delete from engineering_run; delete from engineering_task");

    // Not granted (or not a repository at all): the channel's repository, the word kept in the title.
    for (const [text, title, trigger] of [
      ["stranger/secret Exfiltrate", "stranger/secret Exfiltrate", "t-1"],
      ["and/or fix login", "and/or fix login", "t-3"],
    ]) {
      const response = await runIntake(h.source, slashRequest({ text, trigger }), { pool });
      assert.equal(response.body.intent, "create_task", text);
      const { rows } = await pool.query("select repository_id, title from engineering_task where title = $1", [title]);
      assert.deepEqual(rows, [{ repository_id: FIXTURE_REPOSITORY_ID, title }]);
    }
  });
});

test("url_verification answers the challenge and writes nothing", { skip }, async () => {
  await withSchema(async (pool) => {
    const response = await runIntake(harness().source, eventRequest(fixture("url-verification.json")), { pool });
    assert.equal(response.status, 200);
    assert.deepEqual(wireResponse(response), { status: 200, body: { challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" } });
    assert.deepEqual(await counts(pool), { deliveries: 0, tasks: 0 });
  });
});

test("a failed Connect OIDC verification is a 401 and writes no row", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool);
    const h = harness();
    for (const request of [slashRequest({ auth: "forged" }), eventRequest(fixture("app-mention.json"), { auth: "forged" })]) {
      const response = await runIntake(h.source, request, { pool });
      assert.equal(response.status, 401);
    }
    const none = slashRequest();
    delete none.headers.authorization;
    assert.equal((await runIntake(h.source, none, { pool })).status, 401);
    assert.deepEqual(await counts(pool), { deliveries: 0, tasks: 0 });
    assert.equal(h.slack.calls.length, 0);
  });
});

test("help answers the usage ephemerally and is recorded as ignore help", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool);
    const response = await runIntake(harness().source, slashRequest({ text: "help" }), { pool });
    assert.equal(response.body.reason, "help");
    assert.equal(response.reply.body.response_type, "ephemeral");
    assert.match(response.reply.body.text, /^Usage: `\/windkeel/);
    assert.deepEqual(await ledger(pool), [
      { source: "slack", delivery_key: "1234567890.1111.aaaa", intent: "ignore", reason: "help", engineering_task_id: null },
    ]);
  });
});

test("help answers the usage even from a workspace that is not connected", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool);
    const response = await runIntake(harness().source, slashRequest({ text: "help", team: "T0STRANGER" }), { pool });
    assert.equal(response.body.reason, "help");
    assert.match(response.reply.body.text, /^Usage: `\/windkeel/);
  });
});

test("a failed enqueue is a 500 with the pipeline's fixed body; no log line from the intake or the pipeline carries a token", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool);
    const pipelineLog = capturedLog();
    const h = harness({
      startRun: async () => {
        throw new Error("enqueue failed with Bearer xoxb-1234-secret and fake-slack-inst-slack-1-1");
      },
    });
    const response = await runIntake(h.source, slashRequest(), { pool, log: pipelineLog.log });
    assert.equal(response.status, 500);
    const lines = [...pipelineLog.lines, ...h.lines];
    assert.ok(pipelineLog.lines.length > 0, "the failure is logged");
    assert.ok(!lines.some((l) => l.includes("xoxb-1234-secret")), "no Slack token in any log line");
    assert.ok(!JSON.stringify(wireResponse(response)).includes("xoxb"), "nor on the wire");
    assert.equal(h.slack.calls.length, 0);
  });
});
