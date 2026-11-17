/**
 * Ephemeral feedback for ignored Slack mentions (#312): the intake records the need and enqueues
 * the delivery key — no Slack call before it answers (#307) — and the flow function's
 * `postIgnoredMentionFeedback` posts exactly one `chat.postEphemeral` per delivery key. Fake Connect
 * verifier, fake token source, fake Slack Web API. No network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runIntake } from "../dist/intake/pipeline.js";
import {
  createSlackIntakeSource,
  postIgnoredMentionFeedback,
  SLACK_IGNORE_TEXT,
} from "../dist/intake/slack.js";
import { fakeConnectForwardVerifier } from "../dist/integrations/vercel-connect.js";
import {
  CHANNEL,
  OIDC,
  TEAM,
  capturedLog,
  eventRequest,
  fakeSlack,
  fixture,
  seedSlack,
  skip,
  slashRequest,
  tokenSource,
  withSchema,
} from "./slack-fakes.js";

const USER = "U0ALICE1";
const THREAD = "1700000000.000100";

/** An `app_mention` callback. `thread: null` ⇒ at the channel root. */
function mention({ text = "<@U0WINDKEELBOT> Fix the flaky login test", eventId = "Ev0MENTION1", team = TEAM, thread = THREAD, user = USER } = {}) {
  const body = JSON.parse(fixture("app-mention.json"));
  body.event_id = eventId;
  body.team_id = team;
  body.event.text = text;
  if (user === null) delete body.event.user;
  else body.event.user = user;
  if (thread === null) delete body.event.thread_ts;
  else body.event.thread_ts = thread;
  return body;
}

/**
 * The intake under test, with a recorded feedback starter. The fake Slack API and token source are
 * shared with the poster, so "no Slack call before the ingress answers" is checked on the same
 * recorder the post later lands on.
 */
function harness({ startFeedback, feedbackEnabled, slackScript } = {}) {
  const slack = fakeSlack(slackScript);
  const tokens = tokenSource();
  const feedbackStarts = [];
  const { lines, log } = capturedLog();
  const source = createSlackIntakeSource({
    verify: fakeConnectForwardVerifier(OIDC),
    startRun: async () => ({ enqueued: true }),
    startFeedback:
      startFeedback ??
      (async (deliveryKey) => {
        // Recorded with what Slack had seen at that moment: the ingress has not answered yet.
        feedbackStarts.push({ deliveryKey, slackCallsSoFar: slack.calls.length, tokenCallsSoFar: tokens.calls.length });
      }),
    ...(feedbackEnabled ? { feedbackEnabled } : {}),
    log,
  });
  const post = (deliveryKey, extra = {}) =>
    postIgnoredMentionFeedback(
      { pool: extra.pool, tokenSource: tokens, fetch: slack.fetch, log, sleep: async () => {}, ...extra },
      deliveryKey,
    );
  const ephemerals = () => slack.calls.filter((c) => c.method === "chat.postEphemeral");
  return { source, slack, tokens, feedbackStarts, lines, log, post, ephemerals };
}

async function ledgerRow(pool, deliveryKey = "Ev0MENTION1") {
  const { rows } = await pool.query(
    "select intent, reason, organization_id, response from intake_delivery where source = 'slack' and delivery_key = $1",
    [deliveryKey],
  );
  return rows[0];
}

const REASONS = [
  { reason: "help", seed: {}, text: "<@U0WINDKEELBOT> help" },
  { reason: "no_route", seed: { route: false }, text: "<@U0WINDKEELBOT> Fix the flaky login test" },
  { reason: "route_disabled", seed: { enabled: false }, text: "<@U0WINDKEELBOT> Fix the flaky login test" },
];

for (const { reason, seed, text } of REASONS) {
  test(`an app_mention ignored ${reason}: recorded, enqueued with no Slack call before the response, then exactly one ephemeral to the mentioning user`, { skip }, async () => {
    await withSchema(async (pool) => {
      const { organizationId } = await seedSlack(pool, seed);
      const h = harness();

      const response = await runIntake(h.source, eventRequest(mention({ text })), { pool });

      // The ingress's answer: the pipeline's ignore body, and nothing sent to Slack or Connect.
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { ok: true, intent: "ignore", reason });
      assert.equal(response.reply, undefined, "an event gets no slash-command body");
      assert.equal(h.slack.calls.length, 0, "no Slack HTTP before the ingress responds");
      assert.equal(h.tokens.calls.length, 0, "nor a Connect token request");
      assert.deepEqual(h.feedbackStarts, [{ deliveryKey: "Ev0MENTION1", slackCallsSoFar: 0, tokenCallsSoFar: 0 }]);

      const row = await ledgerRow(pool);
      assert.equal(row.intent, "ignore");
      assert.equal(row.reason, reason);
      assert.equal(row.organization_id, organizationId);
      assert.deepEqual(row.response, {
        slackFeedback: { state: "pending", reason, teamId: TEAM, channelId: CHANNEL, user: USER, threadTs: THREAD },
      });

      // The flow function's step.
      assert.deepEqual(await h.post("Ev0MENTION1", { pool }), { status: "posted" });
      const posts = h.ephemerals();
      assert.equal(posts.length, 1);
      assert.deepEqual(posts[0].body, { channel: CHANNEL, user: USER, text: SLACK_IGNORE_TEXT[reason], thread_ts: THREAD });
      assert.equal(h.slack.calls.length, 1, "and nothing else");
      assert.equal((await ledgerRow(pool)).response.slackFeedback.state, "posted");

      // A second start (or a replayed step) for the same key posts nothing.
      assert.deepEqual(await h.post("Ev0MENTION1", { pool }), { status: "not_pending" });
      assert.equal(h.ephemerals().length, 1);
    });
  });
}

test("a duplicate delivery of an ignored mention (Slack's retry) starts no second feedback and posts no second ephemeral", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool, { route: false });
    const h = harness();
    await runIntake(h.source, eventRequest(mention()), { pool });
    const retry = await runIntake(
      h.source,
      eventRequest(mention(), { headers: JSON.parse(fixture("retry-headers.json")) }),
      { pool },
    );
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);
    assert.equal(h.feedbackStarts.length, 1, "one delivery key, one feedback start");

    // Even if the step ran for both (a doubled enqueue, a replay): one post.
    const outcomes = await Promise.all([h.post("Ev0MENTION1", { pool }), h.post("Ev0MENTION1", { pool })]);
    assert.deepEqual(outcomes.map((o) => o.status).sort(), ["not_pending", "posted"]);
    assert.equal(h.ephemerals().length, 1);
  });
});

test("unknown_tenant is never answered: no feedback recorded or started, not even for help", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool);
    const h = harness();
    const unknown = await runIntake(h.source, eventRequest(mention({ team: "T0STRANGER" })), { pool });
    assert.equal(unknown.body.reason, "unknown_tenant");
    const help = await runIntake(h.source, eventRequest(mention({ team: "T0STRANGER", text: "<@U0WINDKEELBOT> help", eventId: "Ev0HELP" })), { pool });
    assert.equal(help.body.reason, "help");
    assert.equal(h.feedbackStarts.length, 0);
    assert.equal((await ledgerRow(pool)).response, null);
    assert.equal((await ledgerRow(pool, "Ev0HELP")).response, null);
    assert.equal(h.slack.calls.length, 0);
  });
});

test("a mention at the channel root is answered in the channel, not a thread", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool, { route: false });
    const h = harness();
    await runIntake(h.source, eventRequest(mention({ thread: null })), { pool });
    assert.equal((await ledgerRow(pool)).response.slackFeedback.threadTs, null);
    await h.post("Ev0MENTION1", { pool });
    assert.deepEqual(h.ephemerals()[0].body, { channel: CHANNEL, user: USER, text: SLACK_IGNORE_TEXT.no_route });
  });
});

test("a mention without a user, and a deployment that cannot post, get no feedback", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool);
    const h = harness();
    const noUser = await runIntake(h.source, eventRequest(mention({ user: null, eventId: "Ev0NOUSER", text: "<@U0WINDKEELBOT> help" })), { pool });
    assert.equal(noUser.body.reason, "help");
    assert.equal(h.feedbackStarts.length, 0, "no person to show it to");
    assert.equal((await ledgerRow(pool, "Ev0NOUSER")).response, null);

    const off = harness({ feedbackEnabled: () => false });
    const disabled = await runIntake(off.source, eventRequest(mention({ eventId: "Ev0OFF", text: "<@U0WINDKEELBOT> help" })), { pool });
    assert.equal(disabled.body.reason, "help");
    assert.equal(off.feedbackStarts.length, 0, "WINDKEEL_CONNECT_SLACK unset: nothing to post with");
    assert.equal((await ledgerRow(pool, "Ev0OFF")).response, null);
  });
});

test("a slash command's ignore is answered by its own ephemeral reply and starts no feedback", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool, { route: false });
    const h = harness();
    const response = await runIntake(h.source, slashRequest(), { pool });
    assert.equal(response.body.reason, "no_route");
    assert.equal(response.reply.body.response_type, "ephemeral");
    assert.equal(h.feedbackStarts.length, 0);
  });
});

test("a failed feedback hand-off is logged and the mention still answers 200 ignore", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool, { route: false });
    const h = harness({
      startFeedback: async () => {
        throw new Error("queue unavailable with Bearer xoxb-9999-secret");
      },
    });
    const response = await runIntake(h.source, eventRequest(mention()), { pool });
    assert.equal(response.status, 200);
    assert.equal(response.body.reason, "no_route");
    assert.equal((await ledgerRow(pool)).reason, "no_route", "the delivery row is kept");
    assert.ok(h.lines.some((l) => l.includes("slack mention feedback not started")));
    assert.ok(!h.lines.some((l) => l.includes("xoxb-9999-secret")), "no token in the log");
  });
});

test("a transient failure is retried in-process, then released to pending; the next attempt posts once", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool, { route: false });
    const h = harness({ slackScript: [{ status: 503 }, { status: 503 }, { status: 503 }] });
    await runIntake(h.source, eventRequest(mention()), { pool });

    assert.deepEqual(await h.post("Ev0MENTION1", { pool }), { status: "released" });
    assert.equal(h.ephemerals().length, 3, "the first attempt and two retries");
    assert.equal((await ledgerRow(pool)).response.slackFeedback.state, "pending");
    assert.ok(h.lines.some((l) => l.includes("slack mention feedback failed") && l.includes('"claim":"released"')));

    assert.deepEqual(await h.post("Ev0MENTION1", { pool }), { status: "posted" });
    assert.equal(h.ephemerals().length, 4);
  });
});

test("a refusal, or a post Slack may have accepted, keeps the claim: marked failed, never posted again", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool, { route: false });
    const h = harness({ slackScript: [{ ok: false, error: "channel_not_found" }, { throwCode: "ECONNRESET" }] });
    await runIntake(h.source, eventRequest(mention()), { pool });
    await runIntake(h.source, eventRequest(mention({ eventId: "Ev0SECOND" })), { pool });

    assert.deepEqual(await h.post("Ev0MENTION1", { pool }), { status: "kept" });
    assert.deepEqual(await h.post("Ev0SECOND", { pool }), { status: "kept" });
    assert.equal((await ledgerRow(pool)).response.slackFeedback.state, "failed");
    assert.equal((await ledgerRow(pool)).response.slackFeedback.failed, "channel_not_found");
    assert.equal((await ledgerRow(pool, "Ev0SECOND")).response.slackFeedback.failed, "network_error");

    assert.deepEqual(await h.post("Ev0MENTION1", { pool }), { status: "not_pending" });
    assert.deepEqual(await h.post("Ev0SECOND", { pool }), { status: "not_pending" });
    assert.equal(h.ephemerals().length, 2);
  });
});

test("a workspace disconnected before the step runs is skipped, with no Slack call", { skip }, async () => {
  await withSchema(async (pool) => {
    await seedSlack(pool, { route: false });
    const h = harness();
    await runIntake(h.source, eventRequest(mention()), { pool });
    await pool.query("delete from integration_route; delete from integration_connection");
    assert.deepEqual(await h.post("Ev0MENTION1", { pool }), { status: "not_connected" });
    assert.equal((await ledgerRow(pool)).response.slackFeedback.state, "skipped");
    assert.equal(h.slack.calls.length, 0);
  });
});
