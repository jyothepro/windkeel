/**
 * The Linear outcome notifier (M8-7, #299): the GraphQL request it sends for each outcome, its
 * idempotency key, and that an error never escapes it (a notification never fails a run).
 * The database is faked at the query level; Linear is a fake `fetch`. No network.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  createLinearNotifier,
  deterministicUuid,
  isDuplicateError,
  LINEAR_GRAPHQL_URL,
  LinearGraphQLError,
  linearCommentCreate,
} from "../dist/integrations/linear.js";
import { FakeProviderTokenSource } from "../dist/integrations/token-source.js";
import { registerDeploymentNotifiers } from "../dist/factory/workflow/deployment-notifiers.js";
import { getSourceNotifier, notifiableOutcomeKind, unregisterSourceNotifier } from "../dist/intake/notifiers.js";

const RUN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ISSUE = "4b8c2a1d-6e5f-4a3b-9c8d-7e6f5a4b3c2d";
const LINEAR_ORG = "7c3a1f0e-2b4d-4e6f-9a8b-1c2d3e4f5a6b";

/** A `pg.Pool` stand-in answering the two queries the notifier makes (and no others). */
function fakePool({ connected = true, cloneUrl = "https://github.com/acme/uploads.git" } = {}) {
  return {
    async query(sql) {
      if (/from integration_connection/.test(sql)) {
        return {
          rows: connected
            ? [
                {
                  id: "c1",
                  organization_id: "org",
                  provider: "linear",
                  installation_id: "inst_linear_1",
                  external_tenant_id: LINEAR_ORG,
                  status: "active",
                },
              ]
            : [],
        };
      }
      if (/from repository/.test(sql)) {
        return {
          rows: [
            {
              id: "r1",
              owner: "acme",
              name: "uploads",
              default_branch: "main",
              clone_url: cloneUrl,
              github_installation_id: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function recordingFetch(respond) {
  const requests = [];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return respond
        ? respond(requests.length)
        : new Response(JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "c" } } } }), { status: 200 });
    },
  };
}

const task = {
  id: "t1",
  repositoryId: "r1",
  sourceType: "linear",
  sourceContext: { organizationId: LINEAR_ORG, issueId: ISSUE, identifier: "ENG-42" },
};
const run = (overrides = {}) => ({ id: RUN_ID, prNumber: null, ...overrides });
const tokens = () => new FakeProviderTokenSource().install("linear", "inst_linear_1", { tenantId: LINEAR_ORG, name: "Acme" });

/** Verdicts as `verdictForRun` builds them (src/intake/verdict.ts): counts only. */
const VERDICT_PASS = { result: "pass", passed: 3, failed: 0, total: 3, blocking: 0, summary: "3/3 criteria met" };
const VERDICT_PARTIAL = { result: "fail", passed: 2, failed: 1, total: 3, blocking: 0, summary: "1 of 3 criteria failed" };

const T1 = "11111111-aaaa-4aaa-8aaa-000000000001";
const T2 = "11111111-aaaa-4aaa-8aaa-000000000002";

async function notify(partial, { runOverrides, pool, respond, logs = [] } = {}) {
  const outcome = { transitionId: T1, ...partial };
  const http = recordingFetch(respond);
  const notifier = createLinearNotifier({
    pool: pool ?? fakePool(),
    tokenSource: tokens(),
    fetch: http.fetch,
    consoleUrl: () => "https://console.example/",
    log: (message, fields) => logs.push({ message, ...fields }),
  });
  assert.equal(notifier.sourceType, "linear");
  await notifier.notify(task, run(runOverrides), outcome);
  return { requests: http.requests, logs };
}

test("draft PR ready: the comment links the pull request and the run", async () => {
  const { requests } = await notify(
    { state: "WAITING_FOR_HUMAN", reason: "draft PR opened", terminal: false, verdict: VERDICT_PASS },
    { runOverrides: { prNumber: 17 } },
  );
  assert.equal(requests.length, 1);
  const [call] = requests;
  assert.equal(call.url, LINEAR_GRAPHQL_URL);
  assert.match(call.headers.authorization, /^Bearer fake-linear-inst_linear_1-\d+$/);
  assert.match(call.body.query, /mutation \w+\(\$input: CommentCreateInput!\)/);
  assert.match(call.body.query, /commentCreate\(input: \$input\)/);
  const input = call.body.variables.input;
  assert.equal(input.issueId, ISSUE);
  assert.equal(
    input.body,
    `Verified ✓ 3/3 criteria · draft PR https://github.com/acme/uploads/pull/17 · https://console.example/runs/${RUN_ID}`,
  );
  assert.equal(input.id, deterministicUuid("linear-comment", T1));
});

// --- #389: verifier-aware status ---

test("verdict wording: pass, partial fail, and no verdict at all — never 'verified' without a pass", async () => {
  const body = async (partial, prNumber = 17) =>
    (await notify(partial, { runOverrides: { prNumber } })).requests[0].body.variables.input.body;
  const partial = await body({ state: "WAITING_FOR_HUMAN", reason: "review", terminal: false, verdict: VERDICT_PARTIAL });
  assert.match(partial, /^Windkeel is waiting for a human — Not verified: 1 of 3 criteria failed · draft PR https:/);
  const none = await body({ state: "WAITING_FOR_HUMAN", reason: "review", terminal: false, verdict: null });
  assert.match(none, /^Windkeel is waiting for a human — No verification result · draft PR/);
  const failed = await body({ state: "MAX_REPAIR_ATTEMPTS_REACHED", reason: "verification failed", terminal: true, verdict: VERDICT_PARTIAL });
  assert.match(failed, /^Windkeel stopped after its repair attempts ran out — Not verified: 1 of 3 criteria failed: verification failed/);
  for (const text of [partial, none, failed]) assert.doesNotMatch(text, /Verified ✓/);
});

test("progress: 'Verifying…' keyed on the run, so every re-entry and every replay is one comment", async () => {
  const first = await notify({ kind: "progress", transitionId: T1, state: "VERIFYING", reason: null, terminal: false });
  const again = await notify({ kind: "progress", transitionId: T2, state: "VERIFYING", reason: null, terminal: false });
  const a = first.requests[0].body.variables.input;
  const b = again.requests[0].body.variables.input;
  assert.equal(a.body, `Verifying in an independent sandbox… · https://console.example/runs/${RUN_ID}`);
  assert.equal(a.id, deterministicUuid("linear-comment", RUN_ID, "verifying"));
  assert.equal(b.id, a.id, "Linear's idempotent id makes the second a no-op");
  assert.equal(notifiableOutcomeKind({ fromState: "IMPLEMENTING", toState: "VERIFYING" }), "progress");
  assert.equal(notifiableOutcomeKind({ fromState: "REPAIRING", toState: "VERIFYING" }), "progress");
  assert.equal(notifiableOutcomeKind({ fromState: "VERIFYING", toState: "PR_CREATING" }), null);
});

test("an aborted signal reaches the request; the notifier logs and never throws", async () => {
  const controller = new AbortController();
  controller.abort(new Error("time is up"));
  const logs = [];
  const http = recordingFetch();
  const notifier = createLinearNotifier({
    pool: fakePool(),
    tokenSource: tokens(),
    fetch: async (url, init) => {
      if (init.signal?.aborted) throw init.signal.reason;
      return http.fetch(url, init);
    },
    consoleUrl: () => "https://console.example/",
    log: (message, fields) => logs.push({ message, ...fields }),
  });
  await notifier.notify(task, run(), { kind: "progress", transitionId: T1, state: "VERIFYING", reason: null, terminal: false }, controller.signal);
  assert.equal(http.requests.length, 0);
  assert.ok(logs.some((l) => /linear notification failed/.test(l.message)));
});

test("failure: the comment carries the (redacted) reason", async () => {
  const { requests } = await notify({ state: "FAILED", reason: "tests failed; token lin_api_abc123 rejected", terminal: true });
  const body = requests[0].body.variables.input.body;
  assert.match(body, /^Windkeel run failed: tests failed; token \[redacted\] rejected · /);
  assert.doesNotMatch(body, /lin_api_abc123/);
});

test("max repair attempts, cancellation and completion each get their own wording", async () => {
  const bodies = {};
  for (const state of ["MAX_REPAIR_ATTEMPTS_REACHED", "CANCELLED", "COMPLETED"]) {
    const { requests } = await notify({ state, reason: "why", terminal: true }, { runOverrides: { prNumber: 3 } });
    bodies[state] = requests[0].body.variables.input.body;
  }
  assert.match(bodies.MAX_REPAIR_ATTEMPTS_REACHED, /^Windkeel stopped after its repair attempts ran out: why/);
  assert.match(bodies.CANCELLED, /^Windkeel run cancelled: why/);
  assert.match(bodies.COMPLETED, /^Windkeel finished: https:\/\/github.com\/acme\/uploads\/pull\/3/);
});

test("criteria approval: the comment asks for approval", async () => {
  const { requests } = await notify({ state: "WAITING_FOR_APPROVAL", reason: null, terminal: false });
  assert.match(requests[0].body.variables.input.body, /needs them approved/);
});

test("the seam's `started` outcome posts nothing on Linear (the intake owns the start comment) (#307)", async () => {
  const { requests, logs } = await notify({ kind: "started", state: "CLASSIFYING", reason: "started", terminal: false });
  assert.equal(requests.length, 0);
  assert.deepEqual(logs, []);
});

test("notifiableOutcomeKind: leaving CREATED is `started`, a notifiable state is `state`, chatter is null", () => {
  assert.equal(notifiableOutcomeKind({ fromState: "CREATED", toState: "CLASSIFYING" }), "started");
  assert.equal(notifiableOutcomeKind({ fromState: "CREATED", toState: "CANCELLED" }), "state", "a notifiable state wins");
  assert.equal(notifiableOutcomeKind({ fromState: "CLASSIFYING", toState: "PLANNING" }), null);
  assert.equal(notifiableOutcomeKind({ toState: "PLANNING" }), null, "no fromState, not started");
  assert.equal(notifiableOutcomeKind({ fromState: "PR_READY", toState: "WAITING_FOR_HUMAN" }), "state");
});

test("idempotent on the committed transition: a replay of entry #1 after entry #2 still reuses #1's id", async () => {
  const outcome = { state: "WAITING_FOR_HUMAN", reason: "x", terminal: false };
  const id = (r) => r.requests[0].body.variables.input.id;
  const first = await notify({ ...outcome, transitionId: T1 });
  const second = await notify({ ...outcome, transitionId: T2 }); // a genuine second entry
  const lateReplayOfFirst = await notify({ ...outcome, transitionId: T1 }); // step retried late
  assert.notEqual(id(first), id(second), "a second entry into the state is a new comment");
  assert.equal(id(lateReplayOfFirst), id(first), "the replay is keyed on its own transition, not a count");
  assert.equal(id(first), deterministicUuid("linear-comment", T1));
});

test("only the one documented duplicate shape is 'already posted'; any other refusal is a logged failure", async () => {
  assert.equal(isDuplicateError({ message: "Entity already exists", extensions: { code: "INVALID_INPUT" } }), true);
  for (const shape of [
    { message: "duplicate key value violates unique constraint", extensions: { code: "INVALID_INPUT" } },
    { message: "Entity already exists", extensions: { code: "CONFLICT" } },
    { message: "Something failed", extensions: { code: "DUPLICATE" } },
    { message: "Entity already exists" },
  ]) {
    assert.equal(isDuplicateError(shape), false, JSON.stringify(shape));
    const logs = [];
    await notify(
      { state: "FAILED", reason: "x", terminal: true },
      { logs, respond: () => new Response(JSON.stringify({ errors: [shape] }), { status: 200 }) },
    );
    assert.deepEqual(logs.map((l) => l.message), ["linear notification failed"], JSON.stringify(shape));
  }
  // Two errors, even if one is the duplicate shape, is a failure too.
  const logs = [];
  await notify(
    { state: "FAILED", reason: "x", terminal: true },
    {
      logs,
      respond: () =>
        new Response(
          JSON.stringify({
            errors: [
              { message: "Entity already exists", extensions: { code: "INVALID_INPUT" } },
              { message: "other", extensions: { code: "INTERNAL" } },
            ],
          }),
          { status: 200 },
        ),
    },
  );
  assert.deepEqual(logs.map((l) => l.message), ["linear notification failed"]);
});

test("a duplicate-id refusal from Linear is 'already posted', not an error", async () => {
  const logs = [];
  await notify(
    { state: "FAILED", reason: "x", terminal: true },
    {
      logs,
      respond: () =>
        new Response(JSON.stringify({ errors: [{ message: "Entity already exists", extensions: { code: "INVALID_INPUT" } }] }), {
          status: 200,
        }),
    },
  );
  assert.deepEqual(logs.map((l) => l.message), ["linear notification already posted"]);
});

test("the error path never throws and never logs the token or the body", async () => {
  const logs = [];
  await notify(
    { state: "FAILED", reason: "x", terminal: true },
    {
      logs,
      respond: () =>
        new Response(JSON.stringify({ errors: [{ message: "internal: Bearer fake-linear-inst", extensions: { code: "INTERNAL_ERROR" } }] }), {
          status: 500,
        }),
    },
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, "linear notification failed");
  assert.equal(logs[0].errorName, "LinearGraphQLError");
  assert.equal(logs[0].error, "linear commentCreate failed (status 500): INTERNAL_ERROR", "codes only, no message text");
  assert.doesNotMatch(JSON.stringify(logs), /fake-linear-inst|Bearer/);

  // A network failure, and the token source failing, are swallowed too.
  const thrown = [];
  await notify({ state: "FAILED", reason: "x", terminal: true }, { logs: thrown, respond: () => { throw new TypeError("fetch failed"); } });
  assert.equal(thrown[0].message, "linear notification failed");
});

test("a disconnected workspace or a task without Linear context is skipped quietly", async () => {
  const skipped = await notify({ state: "FAILED", reason: "x", terminal: true }, { pool: fakePool({ connected: false }) });
  assert.equal(skipped.requests.length, 0);
  assert.equal(skipped.logs[0].reason, "not_connected");
});

test("a 401 gets one fresh token and one retry", async () => {
  const source = tokens();
  const http = recordingFetch((n) =>
    n === 1
      ? new Response("{}", { status: 401 })
      : new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), { status: 200 }),
  );
  const result = await linearCommentCreate(
    { tokenSource: source, fetch: http.fetch },
    { installationId: "inst_linear_1", issueId: ISSUE, body: "hi", commentId: deterministicUuid("x") },
  );
  assert.deepEqual(result, { posted: true });
  assert.equal(http.requests.length, 2);
  assert.notEqual(http.requests[0].headers.authorization, http.requests[1].headers.authorization);
  assert.ok(source.calls.some((c) => c.method === "invalidate"));
});

test("LinearGraphQLError's message is built from the status and codes only", () => {
  const error = new LinearGraphQLError(["INVALID_INPUT", "RATELIMITED"], 400);
  assert.equal(error.message, "linear commentCreate failed (status 400): INVALID_INPUT, RATELIMITED");
  assert.equal(new LinearGraphQLError([], 502).message, "linear commentCreate failed (status 502)");
});

test("the pull request link comes from the repository's stored clone_url and the run's pr_number", async () => {
  const ghe = await notify(
    { state: "COMPLETED", reason: null, terminal: true },
    { runOverrides: { prNumber: 9 }, pool: fakePool({ cloneUrl: "https://ghe.acme.internal/platform/uploads.git" }) },
  );
  assert.match(ghe.requests[0].body.variables.input.body, /^Windkeel finished: https:\/\/ghe\.acme\.internal\/platform\/uploads\/pull\/9 · /);
  const unusable = await notify(
    { state: "COMPLETED", reason: null, terminal: true },
    { runOverrides: { prNumber: 9 }, pool: fakePool({ cloneUrl: "/tmp/fixture-repo" }) },
  );
  assert.match(unusable.requests[0].body.variables.input.body, /^Windkeel finished · /, "no invented github.com link");
});

test("the deployment registers the Linear notifier only when WINDKEEL_CONNECT_LINEAR is set", () => {
  const pool = fakePool();
  try {
    assert.deepEqual(registerDeploymentNotifiers({ pool, env: {}, tokenSource: tokens(), log: () => {} }), []);
    assert.equal(getSourceNotifier("linear"), undefined, "GitHub-only deployment: no notifier, no query");
    assert.deepEqual(
      registerDeploymentNotifiers({ pool, env: { WINDKEEL_CONNECT_LINEAR: "linear/windkeel" }, tokenSource: tokens(), log: () => {} }),
      ["linear"],
    );
    assert.equal(getSourceNotifier("linear")?.sourceType, "linear");
    registerDeploymentNotifiers({ pool, env: { WINDKEEL_CONNECT_LINEAR: "  " }, tokenSource: tokens(), log: () => {} });
    assert.equal(getSourceNotifier("linear"), undefined, "blank is unset");
  } finally {
    unregisterSourceNotifier("linear");
  }
});

test("a signal that aborts bounds the whole call, token fetch included", async () => {
  const hangingTokens = {
    getToken: () => new Promise(() => {}),
    describeInstallation: async () => ({ tenantId: null, name: null }),
    invalidate() {},
  };
  const started = Date.now();
  // AbortSignal.timeout's timer is unref'd; keep the loop alive the way a live request would.
  const keepAlive = setTimeout(() => {}, 5_000);
  after(() => clearTimeout(keepAlive));
  await assert.rejects(
    () =>
      linearCommentCreate(
        { tokenSource: hangingTokens, fetch: async () => { throw new Error("unreachable"); } },
        { installationId: "i", issueId: ISSUE, body: "b", commentId: deterministicUuid("y"), signal: AbortSignal.timeout(30) },
      ),
    { name: "LinearTimeoutError" },
  );
  assert.ok(Date.now() - started < 2_000);
});
