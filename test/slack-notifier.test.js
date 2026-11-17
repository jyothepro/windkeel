/**
 * The Slack outcome notifier (#298, #307 review): the thread root is created by the notifier
 * (`ensureThread`, on the seam's `started` outcome or before any other), each outcome is claimed on
 * its committed transition, transient failures are retried in-process, `not_in_channel` joins the
 * channel once, and Slack's refusals never reach the run or leak a token.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTaskFromIntake } from "../dist/intake/create-task.js";
import { getSourceNotifier, notifyRunOutcome, unregisterSourceNotifier } from "../dist/intake/notifiers.js";
import { createSlackNotifier, registerSlackNotifier } from "../dist/intake/slack.js";
import { registerDeploymentNotifiers } from "../dist/factory/workflow/deployment-notifiers.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { getEngineeringRun, getEngineeringTask } from "../dist/factory/repositories.js";
import { SLACK_SCOPES } from "../dist/integrations/slack.js";
import { CHANNEL, TEAM, capturedLog, fakeSlack, seedSlack, skip, tokenSource, withSchema } from "./slack-fakes.js";
import { FIXTURE_REPOSITORY_ID, repoRoot } from "./helpers.js";

const THREAD = "1700000000.000100";
const T1 = "11111111-aaaa-4aaa-8aaa-000000000001";
const T2 = "11111111-aaaa-4aaa-8aaa-000000000002";
const T3 = "11111111-aaaa-4aaa-8aaa-000000000003";

/** A task as a slash command leaves it (`threadTs: null`), or as a mention does (`threadTs` set). */
async function slackTask(pool, organizationId, { reference = "slack:T:1", threadTs = null } = {}) {
  return createTaskFromIntake(
    pool,
    {
      organizationId,
      repositoryId: FIXTURE_REPOSITORY_ID,
      sourceType: "slack",
      sourceReference: reference,
      sourceContext: { teamId: TEAM, channelId: CHANNEL, threadTs, requestedBySlackUser: "U0ALICE1" },
      title: "Retry <uploads>",
      description: "- [ ] retries a 500 three times",
    },
    { startRun: async () => ({ enqueued: true }) },
  );
}

function notifierHarness(pool, script, { poolOverride } = {}) {
  const slack = fakeSlack(script);
  const tokens = tokenSource();
  const { lines, log } = capturedLog();
  const waits = [];
  const notifier = createSlackNotifier({
    pool: poolOverride ?? pool,
    tokenSource: tokens,
    fetch: slack.fetch,
    consoleUrl: () => "https://console.windkeel.test",
    log,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { notifier, slack, tokens, lines, log, waits };
}

async function load(pool, created) {
  return {
    task: await getEngineeringTask(pool, created.taskId),
    run: await getEngineeringRun(pool, created.runId),
  };
}

/** Verdicts as `verdictForRun` builds them (src/intake/verdict.ts): counts only. */
const VERDICT_PASS = { result: "pass", passed: 2, failed: 0, total: 2, blocking: 0, summary: "2/2 criteria met" };
const VERDICT_PARTIAL = { result: "fail", passed: 2, failed: 1, total: 3, blocking: 1, summary: "1 of 3 criteria failed, 1 blocking finding" };

const started = (transitionId = T1) => ({ kind: "started", transitionId, state: "CLASSIFYING", reason: "started", terminal: false });
const failed = (transitionId = T2, reason = "x") => ({ kind: "state", transitionId, state: "FAILED", reason, terminal: true });

async function context(pool, taskId) {
  return (await getEngineeringTask(pool, taskId)).sourceContext;
}

// --- Must-fix 1: the thread root is the notifier's, created once, in order ---

test("started: the notifier posts the thread root once and stores its ts as threadTs", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId);
    const h = notifierHarness(pool);
    const { task, run } = await load(pool, created);

    await h.notifier.notify(task, run, started());
    assert.equal(h.slack.posts().length, 1);
    const [root] = h.slack.posts();
    assert.equal(root.body.channel, CHANNEL);
    assert.equal(root.body.thread_ts, undefined, "a slash command's start message is a channel root");
    assert.match(root.body.text, /^Task \*Retry &lt;uploads&gt;\* started · <https:\/\/console\.windkeel\.test\/runs\/[0-9a-f-]+\|run /);
    const ctx = await context(pool, created.taskId);
    assert.equal(ctx.threadTs, "1700000200.000001");
    assert.equal(ctx.announce.ts, "1700000200.000001");

    // A replayed `started` posts nothing; the next outcome goes into the thread.
    await h.notifier.notify(task, run, started());
    await h.notifier.notify(task, run, failed());
    assert.equal(h.slack.posts().length, 2);
    assert.equal(h.slack.posts()[1].body.thread_ts, "1700000200.000001");
  });
});

test("an outcome with no thread yet creates the root first, then posts into it — never two roots", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId);
    const h = notifierHarness(pool);
    const { task, run } = await load(pool, created);
    const approval = { kind: "state", transitionId: T2, state: "WAITING_FOR_APPROVAL", reason: "criteria", terminal: false };
    // The run paused for approval, racing a (late) started: one root, the approval inside it.
    await Promise.all([h.notifier.notify(task, run, approval), h.notifier.notify(task, run, started())]);
    const posts = h.slack.posts();
    const roots = posts.filter((p) => p.body.thread_ts === undefined);
    assert.equal(roots.length, 1, "exactly one thread root");
    assert.match(roots[0].body.text, /started/);
    const approvalPost = posts.find((p) => /approve/.test(p.body.text));
    assert.ok(approvalPost, "the approval request was posted");
    assert.equal(approvalPost.body.thread_ts, (await context(pool, created.taskId)).threadTs, "inside the thread");
  });
});

test("a mention's task: the start message goes into the mention's thread, which is kept", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId, { threadTs: THREAD });
    const h = notifierHarness(pool);
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started());
    assert.equal(h.slack.posts()[0].body.thread_ts, THREAD);
    assert.equal((await context(pool, created.taskId)).threadTs, THREAD);
  });
});

test("through the seam: CREATED → CLASSIFYING is `started` and posts the root from advanceRun", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId);
    const slack = fakeSlack();
    registerSlackNotifier({ pool, tokenSource: tokenSource(), fetch: slack.fetch, log: () => {} });
    try {
      await advanceRun(pool, created.runId, "CLASSIFYING", "started");
      assert.equal(slack.posts().length, 1);
      assert.match(slack.posts()[0].body.text, /started/);
      await advanceRun(pool, created.runId, "PLANNING", "classified");
      assert.equal(slack.posts().length, 1, "per-attempt chatter is not notified");
      await advanceRun(pool, created.runId, "CANCELLED", "operator cancelled");
      assert.equal(slack.posts().length, 2);
      assert.equal(slack.posts()[1].body.thread_ts, "1700000200.000001", "the outcome is in the root's thread");
    } finally {
      unregisterSourceNotifier("slack");
    }
  });
});

// --- Outcome wording (should-fix: PR link from the records) ---

test("each outcome posts its message into the task's thread", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId, { threadTs: THREAD });
    await pool.query("update engineering_run set pr_number = 42 where id = $1", [created.runId]);
    const h = notifierHarness(pool);
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started(T3));

    const cases = [
      // #389: "Verified" only on the verifier's passing verdict, with its counts.
      [
        { state: "WAITING_FOR_HUMAN", reason: "pr ready", terminal: false, verdict: VERDICT_PASS },
        /: Verified ✓ 2\/2 criteria · <https:\/\/github\.com\/jyothepro\/windkeel-fixture-11111111\/pull\/42\|draft PR #42>/,
      ],
      [
        { state: "WAITING_FOR_HUMAN", reason: "pr ready", terminal: false, verdict: null },
        /needs a human — No verification result: pr ready · <https:\/\/github\.com\/.*\/pull\/42\|draft PR #42>/,
      ],
      [{ state: "WAITING_FOR_APPROVAL", reason: "criteria generated", terminal: false }, new RegExp(`windkeel approve ${run.id}\`.*console`)],
      [{ state: "FAILED", reason: "sandbox exploded", terminal: true }, /failed: sandbox exploded/],
      [
        { state: "FAILED", reason: "verification failed (details are in the run's record)", terminal: true, verdict: VERDICT_PARTIAL },
        /failed — Not verified: 1 of 3 criteria failed, 1 blocking finding: verification failed/,
      ],
      [{ state: "MAX_REPAIR_ATTEMPTS_REACHED", reason: null, terminal: true }, /maximum repair attempts/],
      [{ state: "CANCELLED", reason: "operator cancelled", terminal: true }, /was cancelled: operator cancelled/],
      [{ state: "COMPLETED", reason: "merged", terminal: true }, /is done: <https:\/\/github\.com\/.*\/pull\/42/],
    ];
    let i = 0;
    for (const [partial, pattern] of cases) {
      await h.notifier.notify(task, run, { kind: "state", transitionId: `00000000-0000-4000-8000-00000000000${i++}`, ...partial });
      const post = h.slack.posts().at(-1);
      assert.equal(post.body.channel, CHANNEL);
      assert.equal(post.body.thread_ts, THREAD);
      assert.match(post.body.text, pattern, partial.state);
      assert.match(post.body.text, /\*Retry &lt;uploads&gt;\*/, "the title is escaped");
    }
    assert.equal(h.slack.posts().length, cases.length + 1);

    // A verified run without a PR is a hand-off to a human, with its reason.
    await pool.query("update engineering_run set pr_number = null where id = $1", [created.runId]);
    const other = await slackTask(pool, organizationId, { reference: "slack:T:2", threadTs: THREAD });
    const loaded = await load(pool, other);
    await h.notifier.notify(loaded.task, loaded.run, { kind: "state", transitionId: T1, state: "WAITING_FOR_HUMAN", reason: "blocked on secrets", terminal: false });
    assert.match(h.slack.posts().at(-1).body.text, /needs a human: blocked on secrets/);
  });
});

// --- Must-fix 3: the claim is the committed transition ---

test("idempotent on outcome.transitionId: a replay posts nothing, a genuine second entry posts again", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId, { threadTs: THREAD });
    const h = notifierHarness(pool);
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started(T3));
    const human = (transitionId) => ({ kind: "state", transitionId, state: "WAITING_FOR_HUMAN", reason: "review", terminal: false });
    await Promise.all([h.notifier.notify(task, run, human(T1)), h.notifier.notify(task, run, human(T1))]);
    await h.notifier.notify(task, run, human(T1));
    assert.equal(h.slack.posts().length, 2, "start + one WAITING_FOR_HUMAN");
    await h.notifier.notify(task, run, human(T2));
    assert.equal(h.slack.posts().length, 3, "a second entry into the same state is a new transition, so a new post");
    assert.deepEqual((await context(pool, created.taskId)).notified, [T1, T2]);
  });
});

// --- Must-fix 2: not_in_channel joins once; ok:true without ts is a failure ---

test("not_in_channel: joins the (public) channel once and retries the post", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId);
    const h = notifierHarness(pool, [{ ok: false, error: "not_in_channel" }]);
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started());
    assert.deepEqual(h.slack.calls.map((c) => c.method), ["chat.postMessage", "conversations.join", "chat.postMessage"]);
    assert.equal(h.slack.calls[1].body.channel, CHANNEL);
    assert.equal((await context(pool, created.taskId)).threadTs, "1700000200.000002", "the retried post's ts (the join took .000001)");
    assert.ok(SLACK_SCOPES.includes("channels:join"));
  });
});

test("not_in_channel in a private channel: the join is refused, logged with the invite hint, never thrown", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId);
    const h = notifierHarness(pool, [
      { ok: false, error: "not_in_channel" },
      { ok: false, error: "method_not_supported_for_channel_type" },
    ]);
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started());
    assert.deepEqual(h.slack.calls.map((c) => c.method), ["chat.postMessage", "conversations.join"], "joined once, no loop");
    assert.ok(h.lines.some((l) => l.includes("invite @Windkeel")), "the log says what to do");
    assert.equal((await context(pool, created.taskId)).threadTs, null);
  });
});

test("ok:true without a ts is a failure: nothing stored, the claim kept (Slack may have posted)", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId);
    const h = notifierHarness(pool, [{ ok: true }]);
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started());
    const ctx = await context(pool, created.taskId);
    assert.equal(ctx.threadTs, null, "never stores an empty ts");
    assert.ok(ctx.announce && !ctx.announce.ts, "the announce claim is kept");
    assert.ok(h.lines.some((l) => l.includes("missing_ts")));
    await h.notifier.notify(task, run, started());
    assert.equal(h.slack.posts().length, 1, "no second root");
  });
});

// --- Must-fix 4: retries that actually retry ---

test("a transient failure is retried in-process with bounded backoff and posts once", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId, { threadTs: THREAD });
    const h = notifierHarness(pool, [{ status: 503 }, { ok: false, error: "ratelimited" }]);
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started());
    assert.equal(h.slack.posts().length, 3, "two retries, then posted");
    assert.equal(h.waits.length, 2);
    assert.ok(h.waits.reduce((a, b) => a + b, 0) <= 10_000, "total backoff within 10 s");
    assert.ok((await context(pool, created.taskId)).announce.ts);
  });
});

test("transient failures past the retries release the claim (logged), so a replayed step posts", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId, { threadTs: THREAD });
    const h = notifierHarness(pool, [{ status: 503 }, { status: 503 }, { status: 503 }]);
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started());
    assert.equal(h.slack.posts().length, 3);
    assert.ok(h.lines.some((l) => l.includes("http_503")), "the failure is logged");
    assert.equal((await context(pool, created.taskId)).announce, undefined, "claim released");
    await h.notifier.notify(task, run, started());
    assert.equal(h.slack.posts().length, 4, "the replay posted");
    await h.notifier.notify(task, run, started());
    assert.equal(h.slack.posts().length, 4, "and then it is claimed");
  });
});

test("a Retry-After beyond the budget is not waited out: the claim is released at once", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId, { threadTs: THREAD });
    const h = notifierHarness(pool, [{ status: 429, retryAfter: 60 }]);
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started());
    assert.equal(h.slack.posts().length, 1);
    assert.deepEqual(h.waits, []);
    assert.equal((await context(pool, created.taskId)).announce, undefined);
  });
});

test("a post-accept timeout keeps the claim: a duplicate is worse than a gap", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId, { threadTs: THREAD });
    const h = notifierHarness(pool, [null, { hang: true }]);
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started(T3));
    const controller = new AbortController();
    const pending = h.notifier.notify(task, run, failed(T1), controller.signal);
    setTimeout(() => controller.abort(new Error("time is up")), 20);
    await pending;
    assert.equal(h.slack.posts().length, 2);
    assert.deepEqual((await context(pool, created.taskId)).notified, [T1], "kept");
    assert.ok(h.lines.some((l) => l.includes("timeout")));
    await h.notifier.notify(task, run, failed(T1));
    assert.equal(h.slack.posts().length, 2, "no second post for the same transition");
  });
});

// --- Re-review (fd6935e) ---

test("once Slack accepted the start post, a failed ts write never releases the claim: no second root", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId);
    let tsWrites = 0;
    const failingTsWrite = {
      query(sql, params) {
        if (/jsonb_build_object\('ts', \$2::text\)/.test(sql)) {
          tsWrites++;
          return Promise.reject(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
        }
        return pool.query(sql, params);
      },
    };
    const h = notifierHarness(pool, [], { poolOverride: failingTsWrite });
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started());
    assert.equal(tsWrites, 3, "the ts write was retried briefly");
    assert.ok(h.lines.some((l) => l.includes("ts was not stored") && l.includes("ECONNRESET")), "and the give-up logged");
    const ctx = await context(pool, created.taskId);
    assert.equal(ctx.announce.failed, "ts_not_stored", "the claim is kept, marked failed");

    await h.notifier.notify(task, run, failed());
    const roots = h.slack.posts().filter((p) => /started/.test(p.body.text));
    assert.equal(roots.length, 1, "no second root on the next notify");
    assert.equal(h.slack.posts().length, 2, "the outcome still posted");
  });
});

test("a stale start claim (no ts, not failed, older than 30 s) is reclaimed and posted", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId);
    await pool.query(
      `update engineering_task set source_context = source_context
         || jsonb_build_object('announce', jsonb_build_object('runId', 'dead', 'claimedAt', now() - interval '31 seconds'))
       where id = $1`,
      [created.taskId],
    );
    const h = notifierHarness(pool);
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started());
    assert.equal(h.slack.posts().length, 1, "reclaimed");
    const ctx = await context(pool, created.taskId);
    assert.equal(ctx.announce.runId, run.id);
    assert.equal(ctx.threadTs, "1700000200.000001");
  });
});

test("a fresh in-flight start claim is waited on, and the wait honours the abort signal", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId);
    await pool.query(
      `update engineering_task set source_context = source_context
         || jsonb_build_object('announce', jsonb_build_object('runId', 'other', 'claimedAt', now() - interval '5 seconds'))
       where id = $1`,
      [created.taskId],
    );
    const h = notifierHarness(pool);
    const { task, run } = await load(pool, created);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("time is up")), 50);
    const began = Date.now();
    await h.notifier.notify(task, run, failed(), controller.signal);
    assert.ok(Date.now() - began < 2_000, "stopped at the abort, not the 5 s wait");
    assert.equal(h.slack.posts().length, 0, "not reclaimed, nothing posted out of order");
    assert.ok(h.lines.some((l) => l.includes("abandoned while waiting")));
    assert.equal((await context(pool, created.taskId)).notified, undefined, "the outcome was never claimed");
  });
});

test("network failures: before the connection is made they are retried; after, the claim is kept", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const refused = await slackTask(pool, organizationId, { reference: "slack:T:net1", threadTs: THREAD });
    const a = notifierHarness(pool, [{ throwCode: "ECONNREFUSED" }]);
    let loaded = await load(pool, refused);
    await a.notifier.notify(loaded.task, loaded.run, started());
    assert.equal(a.slack.posts().length, 2, "connect refused ⇒ nothing sent ⇒ retried and posted");
    assert.ok((await context(pool, refused.taskId)).announce.ts);

    const reset = await slackTask(pool, organizationId, { reference: "slack:T:net2", threadTs: THREAD });
    const b = notifierHarness(pool, [{ throwCode: "ECONNRESET" }]);
    loaded = await load(pool, reset);
    await b.notifier.notify(loaded.task, loaded.run, started());
    assert.equal(b.slack.posts().length, 1, "a reset may follow delivery ⇒ not retried");
    assert.equal((await context(pool, reset.taskId)).announce.failed, "network_error", "claim kept");
    await b.notifier.notify(loaded.task, loaded.run, started());
    assert.equal(b.slack.posts().length, 1, "no second root");
  });
});

// --- Must-fix 5: nothing swallowed ---

test("a failed claim release is logged, not swallowed", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId, { threadTs: THREAD });
    const failingRelease = {
      query(sql, params) {
        if (/- \$2::text|#- '\{announce\}'|- 'announce'/.test(sql)) return Promise.reject(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
        return pool.query(sql, params);
      },
    };
    const h = notifierHarness(pool, [{ status: 503 }, { status: 503 }, { status: 503 }], { poolOverride: failingRelease });
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started());
    assert.ok(h.lines.some((l) => l.includes("slack claim release failed") && l.includes("ECONNRESET")), h.lines.join("\n"));
  });
});

// --- Refusals and tokens ---

test("invalid_auth triggers exactly one token refresh; no token in any log line", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId, { threadTs: THREAD });
    const { task, run } = await load(pool, created);

    const ok = notifierHarness(pool, [{ ok: false, error: "invalid_auth" }]);
    await ok.notifier.notify(task, run, started());
    assert.equal(ok.tokens.calls.filter((c) => c.method === "invalidate").length, 1);
    assert.equal(ok.slack.calls.length, 2);
    assert.notEqual(ok.slack.calls[0].authorization, ok.slack.calls[1].authorization, "the retry used a fresh token");

    const other = await slackTask(pool, organizationId, { reference: "slack:T:9", threadTs: THREAD });
    const loaded = await load(pool, other);
    const bad = notifierHarness(pool, [{ ok: false, error: "invalid_auth" }, { ok: false, error: "invalid_auth" }]);
    await bad.notifier.notify(loaded.task, loaded.run, started());
    assert.equal(bad.tokens.calls.filter((c) => c.method === "invalidate").length, 1);
    assert.equal(bad.slack.calls.length, 2, "one refresh, no loop");
    assert.ok(bad.lines.length > 0);
    assert.ok(!bad.lines.some((l) => l.includes("fake-slack-")), "no token in any log line");
  });
});

test("a refusal through the real seam never fails the run, and the seam's log carries no token", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId);
    const seam = capturedLog();
    const notifierLog = capturedLog();
    registerSlackNotifier({
      pool,
      tokenSource: tokenSource(),
      fetch: fakeSlack([{ ok: false, error: "channel_not_found" }, { ok: false, error: "invalid_auth" }, { ok: false, error: "invalid_auth" }]).fetch,
      log: notifierLog.log,
    });
    try {
      const moved = await advanceRun(pool, created.runId, "CLASSIFYING", "started");
      assert.equal(moved.run.status, "CLASSIFYING");
      await notifyRunOutcome(pool, moved.run, { ...moved.transition, id: moved.transition.id }, seam.log);
      const lines = [...seam.lines, ...notifierLog.lines];
      assert.ok(notifierLog.lines.some((l) => l.includes("channel_not_found")));
      assert.ok(!lines.some((l) => l.includes("fake-slack-")), "no token in the notifier's or the seam's log");
    } finally {
      unregisterSourceNotifier("slack");
    }
  });
});

// --- Must-fix 6: registration ---

test("the deployment registers the Slack notifier only when WINDKEEL_CONNECT_SLACK is set; stage-wiring never imports it", () => {
  const pool = { query: async () => ({ rows: [] }) };
  try {
    assert.deepEqual(registerDeploymentNotifiers({ pool, env: {}, tokenSource: tokenSource(), log: () => {} }), []);
    assert.equal(getSourceNotifier("slack"), undefined);
    assert.deepEqual(
      registerDeploymentNotifiers({ pool, env: { WINDKEEL_CONNECT_SLACK: "slack/windkeel" }, tokenSource: tokenSource(), log: () => {} }),
      ["slack"],
    );
    assert.equal(getSourceNotifier("slack")?.sourceType, "slack");
    assert.equal(getSourceNotifier("github"), undefined, "GitHub answers from its stage handlers, never a notifier");
    registerDeploymentNotifiers({ pool, env: { WINDKEEL_CONNECT_SLACK: " " }, tokenSource: tokenSource(), log: () => {} });
    assert.equal(getSourceNotifier("slack"), undefined, "blank is unset");
  } finally {
    unregisterSourceNotifier("slack");
  }
  const wiring = readFileSync(join(repoRoot, "src", "factory", "stage-wiring.ts"), "utf8");
  assert.doesNotMatch(wiring, /intake\/slack|registerSlackNotifier/);
});

// --- #389: verifier-aware status — one "Verifying…" per run, verdicts in numbers ---

const progress = (transitionId) => ({ kind: "progress", transitionId, state: "VERIFYING", reason: "candidate captured", terminal: false });

test("progress: one 'Verifying…' post per run across a repair loop; a replay posts nothing", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId, { threadTs: THREAD });
    const h = notifierHarness(pool);
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started(T3));
    await h.notifier.notify(task, run, progress(T1));
    await h.notifier.notify(task, run, progress(T1)); // replayed step
    await h.notifier.notify(task, run, progress(T2)); // the repair loop re-entered VERIFYING
    const posts = h.slack.posts();
    assert.equal(posts.length, 2, "root + one Verifying");
    assert.match(posts[1].body.text, /^\*Retry &lt;uploads&gt;\*: Verifying in an independent sandbox… · </);
    assert.equal(posts[1].body.thread_ts, THREAD);
    assert.deepEqual((await context(pool, created.taskId)).notified, [`verifying:${run.id}`]);
    // Never "verified" or "ready" before the verdict.
    assert.doesNotMatch(posts[1].body.text, /verified|ready/i);
  });
});

test("progress through the seam: entering VERIFYING is `progress`; a run's later entries post nothing new", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId, { threadTs: THREAD });
    const h = notifierHarness(pool);
    registerSlackNotifier({ pool, tokenSource: h.tokens, fetch: h.slack.fetch, consoleUrl: () => "https://console.windkeel.test", log: h.log });
    try {
      for (const [to, reason] of [
        ["CLASSIFYING", "started"],
        ["PLANNING", "classified"],
        ["PROVISIONING", "planned"],
        ["IMPLEMENTING", "provisioned"],
        ["VERIFYING", "candidate captured"],
        ["REPAIRING", "verification failed"],
        ["VERIFYING", "repaired"],
      ]) {
        await advanceRun(pool, created.runId, to, reason);
      }
      const texts = h.slack.posts().map((p) => p.body.text);
      assert.equal(texts.length, 2, texts.join("\n"));
      assert.match(texts[1], /Verifying in an independent sandbox/);
    } finally {
      unregisterSourceNotifier("slack");
    }
  });
});

test("an abort signal stops a post, and the claim is left for a replay to settle", { skip }, async () => {
  await withSchema(async (pool) => {
    const { organizationId } = await seedSlack(pool);
    const created = await slackTask(pool, organizationId, { threadTs: THREAD });
    const h = notifierHarness(pool);
    const { task, run } = await load(pool, created);
    await h.notifier.notify(task, run, started(T3));
    const controller = new AbortController();
    controller.abort(new Error("time is up"));
    await h.notifier.notify(task, run, progress(T1), controller.signal); // must not throw
    assert.equal(h.slack.posts().length, 1, "nothing posted once the signal had fired");
  });
});
