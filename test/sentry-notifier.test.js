/**
 * #389 (C): the Sentry post-back — a comment on the Sentry issue for `started`, one `progress` per
 * run, the hand-off (verdict + draft PR) and terminal states; idempotent on its claims; 429/5xx
 * retried within a bound; registered only when WINDKEEL_CONNECT_SENTRY is set; the token opened from
 * its sealed row (ADR-0034) and never logged. Sentry is `FakeSentry`; no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { registerDeploymentNotifiers } from "../dist/factory/workflow/deployment-notifiers.js";
import { createTaskFromIntake } from "../dist/intake/create-task.js";
import { getSourceNotifier, unregisterSourceNotifier } from "../dist/intake/notifiers.js";
import { getEngineeringRun, getEngineeringTask } from "../dist/factory/repositories.js";
import { createConnection } from "../dist/integrations/connections.js";
import { createSentryNotifier, sentryCommentText, SENTRY_RETRIES } from "../dist/integrations/sentry.js";
import { openSentryToken, putSentryCredential, sentryCredentialContext } from "../dist/integrations/sentry-credential.js";
import { FakeSentry } from "./sentry-fake.js";
import { FIXTURE_REPOSITORY_ID, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const UUID = "7a485448-a9e2-4c85-8a3c-4f44175783c9";
const TOKEN = "sntrys_fake_token_0123456789";
const ISSUE = "4100000001";
const CONSOLE = "https://console.windkeel.test";
const PR = (n) => `https://github.com/jyothepro/windkeel-fixture-11111111/pull/${n}`;
const T = (n) => `cccccccc-0000-4000-8000-00000000000${n}`;

const VERDICT_PASS = { result: "pass", passed: 2, failed: 0, total: 2, blocking: 0, summary: "2/2 criteria met" };
const VERDICT_PARTIAL = { result: "fail", passed: 1, failed: 1, total: 2, blocking: 0, summary: "1 of 2 criteria failed" };

const started = (n = 1) => ({ kind: "started", transitionId: T(n), state: "CLASSIFYING", reason: "started", terminal: false });
const progress = (n) => ({ kind: "progress", transitionId: T(n), state: "VERIFYING", reason: null, terminal: false });
const state = (n, s, extra = {}) => ({ kind: "state", transitionId: T(n), state: s, reason: null, terminal: false, ...extra });

// ---------------------------------------------------------------------------
// Pure wording
// ---------------------------------------------------------------------------

test("wording: 'Verified ✓' only on a pass; partial and missing verdicts say so; never 'fixed'", () => {
  const run = { id: "run-1" };
  const facts = { consoleUrl: CONSOLE, pullRequestUrl: PR(7) };
  const say = (outcome, f = facts) => sentryCommentText(run, outcome, f);
  assert.equal(say(started()), `Windkeel picked up this alert and started a run · ${CONSOLE}/runs/run-1`);
  assert.equal(say(progress(2)), `Verifying in an independent sandbox… · ${CONSOLE}/runs/run-1`);
  assert.equal(say(state(3, "WAITING_FOR_HUMAN", { verdict: VERDICT_PASS })), `Verified ✓ 2/2 criteria · draft PR ${PR(7)} · ${CONSOLE}/runs/run-1`);
  const partial = say(state(3, "WAITING_FOR_HUMAN", { verdict: VERDICT_PARTIAL }));
  assert.match(partial, /^Windkeel needs a human — Not verified: 1 of 2 criteria failed · draft PR/);
  const none = say(state(3, "WAITING_FOR_HUMAN", { verdict: null }));
  assert.match(none, /^Windkeel needs a human — No verification result/);
  const failed = say(state(4, "MAX_REPAIR_ATTEMPTS_REACHED", { terminal: true, verdict: VERDICT_PARTIAL, reason: "verification failed (details are in the run's record)" }));
  assert.match(failed, /^Not verified: 1 of 2 criteria failed — Windkeel could not finish: verification failed/);
  const failedEarly = say(state(5, "FAILED", { terminal: true, verdict: null, reason: "worker session failed (details are in the run's record)" }));
  assert.match(failedEarly, /^No verification result — Windkeel could not finish/);
  assert.match(say(state(6, "WAITING_FOR_APPROVAL")), /approve them before it continues/);
  for (const text of [partial, none, failed, failedEarly, say(state(7, "COMPLETED", { terminal: true }))]) {
    assert.doesNotMatch(text, /Verified ✓/);
    assert.doesNotMatch(text, /\bfixed\b|resolved/i);
  }
  assert.equal(say(state(8, "PR_CREATING")), null, "per-attempt chatter is not a comment");
});

test("registration is gated on WINDKEEL_CONNECT_SENTRY; blank is unset", () => {
  const pool = { query: async () => ({ rows: [] }) };
  try {
    assert.deepEqual(registerDeploymentNotifiers({ pool, env: {}, log: () => {} }), []);
    assert.equal(getSourceNotifier("sentry"), undefined);
    assert.deepEqual(registerDeploymentNotifiers({ pool, env: { WINDKEEL_CONNECT_SENTRY: "sealed" }, log: () => {} }), ["sentry"]);
    assert.equal(getSourceNotifier("sentry")?.sourceType, "sentry");
    registerDeploymentNotifiers({ pool, env: { WINDKEEL_CONNECT_SENTRY: "  " }, log: () => {} });
    assert.equal(getSourceNotifier("sentry"), undefined, "blank is unset: integration off, no error");
  } finally {
    unregisterSourceNotifier("sentry");
  }
});

// ---------------------------------------------------------------------------
// Against Postgres
// ---------------------------------------------------------------------------

let serial = 0;
async function withNotifier(fn, { token = TOKEN, issueId = ISSUE } = {}) {
  const schema = `windkeel_sentry_notifier_test_${Date.now()}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const organizationId = (await pool.query("select id from organization where is_default")).rows[0].id;
    const { connection } = await createConnection(pool, {
      organizationId,
      provider: "sentry",
      installationId: UUID,
      externalTenantId: UUID,
      externalTenantName: "acme-shop",
      createdByPrincipalId: null,
    });
    const keys = generateSecretKeyPair();
    if (token) await putSentryCredential(pool, { organizationId, connectionId: connection.id, publicKey: keys.publicKey, token, createdByPrincipalId: null });
    const created = await createTaskFromIntake(
      pool,
      {
        organizationId,
        repositoryId: FIXTURE_REPOSITORY_ID,
        sourceType: "sentry",
        sourceReference: `sentry:${UUID}/${issueId ?? "metric"}`,
        sourceContext: { installationUuid: UUID, orgSlug: "acme-shop", projectSlug: "checkout-web", issueId, shortId: "CHECKOUT-WEB-1A", issueUrl: null },
        title: "Fix Sentry issue CHECKOUT-WEB-1A: TypeError",
        description: "quoted alert",
      },
      { startRun: async () => ({ enqueued: true }) },
    );
    await pool.query("update engineering_run set pr_number = 7 where id = $1", [created.runId]);
    const sentry = new FakeSentry();
    const logs = [];
    const waits = [];
    const notifier = createSentryNotifier({
      pool,
      fetch: sentry.fetch,
      privateKeys: () => [keys.privateKey],
      consoleUrl: () => CONSOLE,
      sleep: async (ms) => {
        waits.push(ms);
      },
      log: (message, fields) => logs.push({ message, ...fields }),
    });
    const load = async () => ({ task: await getEngineeringTask(pool, created.taskId), run: await getEngineeringRun(pool, created.runId) });
    await fn({ pool, organizationId, connection, keys, created, sentry, logs, waits, notifier, load });
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

test("comments on started, once per run on progress, on the hand-off and on terminal states — each once", { skip }, async () => {
  await withNotifier(async ({ sentry, notifier, load, logs }) => {
    const { task, run } = await load();
    await notifier.notify(task, run, started(1));
    await notifier.notify(task, run, started(1)); // replay
    await notifier.notify(task, run, progress(2));
    await notifier.notify(task, run, progress(2)); // replay
    await notifier.notify(task, run, progress(3)); // a repair loop's second VERIFYING
    await notifier.notify(task, run, state(4, "WAITING_FOR_HUMAN", { verdict: VERDICT_PASS }));
    await notifier.notify(task, run, state(4, "WAITING_FOR_HUMAN", { verdict: VERDICT_PASS })); // replay
    await notifier.notify(task, run, state(5, "COMPLETED", { terminal: true }));
    const comments = sentry.commentsOn(ISSUE);
    assert.deepEqual(comments, [
      `Windkeel picked up this alert and started a run · ${CONSOLE}/runs/${run.id}`,
      `Verifying in an independent sandbox… · ${CONSOLE}/runs/${run.id}`,
      `Verified ✓ 2/2 criteria · draft PR ${PR(7)} · ${CONSOLE}/runs/${run.id}`,
      `Windkeel's run completed · draft PR ${PR(7)} · ${CONSOLE}/runs/${run.id}`,
    ]);
    assert.ok(sentry.comments.every((c) => c.authorization === `Bearer ${TOKEN}`));
    assert.ok(!JSON.stringify(logs).includes(TOKEN), "the token is never logged");
    const { notified } = (await load()).task.sourceContext;
    assert.deepEqual(notified, [`started:${run.id}`, `verifying:${run.id}`, T(4), T(5)]);
  });
});

test("429 and 5xx are retried within a bound; past it the claim is released so a replay posts", { skip }, async () => {
  await withNotifier(async ({ sentry, notifier, load, logs, waits }) => {
    const { task, run } = await load();
    sentry.failNext(429, 503);
    await notifier.notify(task, run, started(1));
    assert.equal(sentry.commentsOn(ISSUE).length, 1, "posted on the third attempt");
    assert.equal(waits.length, 2);

    sentry.failNext(...Array(SENTRY_RETRIES + 1).fill(502));
    await notifier.notify(task, run, progress(2));
    assert.equal(sentry.commentsOn(ISSUE).length, 1);
    assert.equal(sentry.requests.length, 3 + SENTRY_RETRIES + 1, "bounded: never more than the retries");
    const failed = logs.find((l) => l.message === "sentry notification failed");
    assert.equal(failed.claim, "released");
    assert.equal(failed.status, 502);
    await notifier.notify(task, run, progress(2)); // the replayed step
    assert.equal(sentry.commentsOn(ISSUE).length, 2);
  });
});

test("a rejected token is final (no retry) and keeps the claim; an abort posts nothing and never throws", { skip }, async () => {
  await withNotifier(async ({ sentry, notifier, load, logs }) => {
    const { task, run } = await load();
    sentry.tokens.clear();
    await notifier.notify(task, run, started(1));
    assert.equal(sentry.requests.length, 1, "401 is not retried");
    assert.equal(logs.at(-1).claim, "kept");
    assert.equal(logs.at(-1).status, 401);

    sentry.tokens.add(TOKEN);
    const controller = new AbortController();
    controller.abort(new Error("time is up"));
    await notifier.notify(task, run, progress(2), controller.signal);
    assert.equal(sentry.commentsOn(ISSUE).length, 0);
    assert.equal(logs.at(-1).claim, "kept", "an abort mid-request may have posted: a duplicate is worse than a gap");
  });
});

test("no credential, no Sentry issue, another organization: skipped with a reason, nothing posted", { skip }, async () => {
  await withNotifier(
    async ({ sentry, notifier, load, logs }) => {
      const { task, run } = await load();
      await notifier.notify(task, run, started(1));
      assert.equal(logs.at(-1).reason, "no_credential");
      assert.equal(sentry.requests.length, 0);
    },
    { token: null },
  );
  await withNotifier(
    async ({ sentry, notifier, load, logs }) => {
      const { task, run } = await load();
      await notifier.notify(task, run, started(1));
      assert.equal(logs.at(-1).reason, "no_sentry_issue");
      await notifier.notify({ ...task, sourceContext: { ...task.sourceContext, issueId: ISSUE }, organizationId: "00000000-0000-0000-0000-000000000000" }, run, started(2));
      assert.equal(logs.at(-1).reason, "not_connected");
      assert.equal(sentry.requests.length, 0);
    },
    { issueId: null },
  );
});

test("the sealed token is bound to its connection: copied to another, it does not open", { skip }, async () => {
  await withNotifier(async ({ pool, organizationId, connection, keys }) => {
    assert.equal(await openSentryToken(pool, [keys.privateKey], organizationId, connection.id), TOKEN);
    const { rows } = await pool.query("select sealed_value, last4 from sentry_credential where connection_id = $1", [connection.id]);
    assert.equal(rows[0].last4, TOKEN.slice(-4));
    assert.ok(!rows[0].sealed_value.includes(TOKEN), "stored sealed, never in the clear");
    const { connection: other } = await createConnection(pool, {
      organizationId,
      provider: "sentry",
      installationId: "11111111-2222-4333-8444-555555555555",
      externalTenantId: "11111111-2222-4333-8444-555555555555",
      externalTenantName: null,
      createdByPrincipalId: null,
    });
    await pool.query(
      "insert into sentry_credential (connection_id, organization_id, sealed_value, last4) values ($1, $2, $3, 'xxxx')",
      [other.id, organizationId, rows[0].sealed_value],
    );
    await assert.rejects(openSentryToken(pool, [keys.privateKey], organizationId, other.id), { name: "SealedSecretError" });
    assert.equal(sentryCredentialContext(organizationId, connection.id), `sentry_credential:${organizationId}:${connection.id}`);
  });
});
