/**
 * `/v1/batches` (#391, ADR-0036) over the real router and real Postgres: create (fanout and
 * multi_repo), the refusals, permissions, Idempotency-Key replay, pause/resume/cancel, the runs
 * filter, and the CLI round trip. The enqueuer is a recording fake; nothing reaches a workflow.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { ROUTES } from "../apps/ingress/dist/src/api/route.js";
import { WindkeelApi } from "../packages/cli/dist/client/api.js";
import { batchCommand, parseCriteria } from "../packages/cli/dist/commands/batch.js";
import { REPOS, settleRun, skip, withBatchDb } from "./batch-helpers.js";
import { tempDir } from "./helpers.js";

const BOOTSTRAP = "test-bootstrap-token";

async function withApi(fn) {
  await withBatchDb(async (ctx) => {
    const cancels = [];
    const deps = {
      pool: ctx.pool,
      control: {
        enqueue: ctx.enqueuer.startRun,
        cancel: async (runId, reason, actor) => {
          cancels.push({ runId, reason, actor });
          await ctx.pool.query("update engineering_run set status = 'CANCELLED' where id = $1", [runId]);
          return { outcome: "cancelled" };
        },
        listMessages: async () => [],
      },
    };
    const auth = { token: BOOTSTRAP, subject: "operator" };
    const call = (method, path, bearer = BOOTSTRAP, body, query = {}, headers = {}) =>
      handleApiRequest(deps, auth, {
        method,
        path,
        query: { get: (name) => query[name] },
        headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...headers },
        body,
      });
    await fn({ ...ctx, deps, auth, call, cancels });
  });
}

const MULTI = {
  kind: "multi_repo",
  title: "Bump the linter",
  description: "Upgrade eslint and fix what it reports.",
  criteria: ["npm run lint passes"],
  repositories: REPOS.slice(0, 3),
  maxConcurrency: 2,
};

test("POST /v1/batches with 3 repositories and maxConcurrency 2: one batch, three items, exactly two runs now", { skip }, async () => {
  await withApi(async ({ call, pool, enqueued }) => {
    const created = await call("POST", "/v1/batches", BOOTSTRAP, MULTI);
    assert.equal(created.status, 202, JSON.stringify(created.body));
    assert.equal(created.body.accepted, true);
    assert.equal(created.body.started, 2);
    const { batch, items } = created.body;
    assert.equal(batch.status, "RUNNING");
    assert.equal(batch.batchSpendCapUsd, 100, "capped by default");
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((i) => i.state), ["dispatched", "dispatched", "pending"]);
    assert.equal(enqueued.length, 2);
    assert.equal((await pool.query("select count(*)::int as n from batch")).rows[0].n, 1);
    assert.equal((await pool.query("select count(*)::int as n from engineering_run")).rows[0].n, 2);

    // GET /v1/runs?batch= lists exactly the children; a malformed id matches nothing.
    const runs = await call("GET", "/v1/runs", BOOTSTRAP, undefined, { batch: batch.id });
    assert.deepEqual(runs.body.items.map((r) => r.id).sort(), items.slice(0, 2).map((i) => i.runId).sort());
    assert.equal((await call("GET", "/v1/runs", BOOTSTRAP, undefined, { batch_id: batch.id })).body.items.length, 2);
    assert.equal((await call("GET", "/v1/runs", BOOTSTRAP, undefined, { batch: "nope" })).body.items.length, 0);

    // The run page names its batch.
    const run = await call("GET", `/v1/runs/${items[0].runId}`);
    assert.deepEqual(run.body.batch, { id: batch.id, title: "Bump the linter" });

    // One child settles; the third starts on the next dispatch (here: resume is not needed, the
    // notifier or the cron does it — simulated by a pause/resume round trip, which dispatches).
    await settleRun(pool, items[0].runId, "FAILED", { cost: 1.5 });
    assert.equal((await call("POST", `/v1/batches/${batch.id}/pause`)).body.batch.status, "PAUSED");
    const resumed = await call("POST", `/v1/batches/${batch.id}/resume`);
    assert.equal(resumed.status, 202);
    assert.equal(resumed.body.started, 1);
    const detail = await call("GET", `/v1/batches/${batch.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.batch.progress.totalCostUsd, 1.5);
    assert.equal(detail.body.batch.progress.failed, 1);
    assert.equal(detail.body.items[2].state, "dispatched");

    const list = await call("GET", "/v1/batches");
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].progress.items, 3);
  });
});

test("a fanout batch: one repository, caller-supplied sub-tasks with their own criteria", { skip }, async () => {
  await withApi(async ({ call, pool }) => {
    const created = await call("POST", "/v1/batches", BOOTSTRAP, {
      kind: "fanout",
      title: "Split the API module",
      description: "unused for fanout children",
      repositoryId: REPOS[0],
      criteria: ["npm test passes"],
      items: [
        { title: "Extract the router", description: "Move routing to router.ts.", criteria: ["router.ts exists"] },
        { title: "Extract the handlers", description: "Move handlers to handlers.ts." },
      ],
      maxConcurrency: 5,
      spendCapUsd: 10,
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    assert.equal(created.body.started, 2);
    const tasks = (await pool.query("select title, repository_id, acceptance_criteria from engineering_task order by source_reference")).rows;
    assert.deepEqual(tasks.map((t) => t.title), ["Extract the router", "Extract the handlers"]);
    assert.ok(tasks.every((t) => t.repository_id === REPOS[0]));
    assert.deepEqual(tasks[0].acceptance_criteria.map((c) => c.text), ["npm test passes", "router.ts exists"]);
    assert.deepEqual(tasks[1].acceptance_criteria.map((c) => c.text), ["npm test passes"]);
    const caps = (await pool.query("select spend_cap_usd from engineering_run")).rows.map((r) => Number(r.spend_cap_usd));
    assert.deepEqual(caps, [10, 10]);
  });
});

test("refusals: no items, too many, ungranted, uncapped without confirmation, bad concurrency", { skip }, async () => {
  await withApi(async ({ call, pool }) => {
    const refused = async (body, status, code) => {
      const answer = await call("POST", "/v1/batches", BOOTSTRAP, body);
      assert.equal(answer.status, status, `${code}: ${JSON.stringify(answer.body)}`);
      assert.equal(answer.body.code, code);
      return answer;
    };
    await refused({ ...MULTI, repositories: [] }, 422, "no_items");
    await refused({ kind: "fanout", title: "t", description: "d", repositoryId: REPOS[0], items: [] }, 422, "no_items");
    process.env.WINDKEEL_BATCH_MAX_ITEMS = "2";
    try {
      const tooMany = await refused(MULTI, 422, "too_many_items");
      assert.equal(tooMany.body.maxItems, 2);
    } finally {
      delete process.env.WINDKEEL_BATCH_MAX_ITEMS;
    }
    await pool.query("delete from repository_grant where repository_id = $1", [REPOS[2]]);
    const ungranted = await refused(MULTI, 422, "repository_not_granted");
    assert.deepEqual(ungranted.body.ungranted, [REPOS[2]]);
    await refused({ ...MULTI, repositories: REPOS.slice(0, 2), batchSpendCapUsd: null }, 422, "uncapped_batch");
    await refused({ ...MULTI, repositories: REPOS.slice(0, 2), maxConcurrency: 0 }, 422, "invalid_concurrency");
    await refused({ ...MULTI, repositories: REPOS.slice(0, 2), maxConcurrency: 2.5 }, 422, "invalid_concurrency");
    await refused({ ...MULTI, kind: undefined }, 400, "missing_field");
    assert.equal((await pool.query("select count(*)::int as n from batch")).rows[0].n, 0, "nothing half-written");

    const confirmed = await call("POST", "/v1/batches", BOOTSTRAP, { ...MULTI, repositories: REPOS.slice(0, 2), batchSpendCapUsd: null, uncappedConfirmed: true });
    assert.equal(confirmed.status, 202);
    assert.equal(confirmed.body.batch.batchSpendCapUsd, null);
    // An uncapped batch still caps every child (ADR-0011).
    const caps = (await pool.query("select spend_cap_usd from engineering_run")).rows.map((r) => Number(r.spend_cap_usd));
    assert.deepEqual(caps, [25, 25]);
  });
});

test("writes need batches.manage; reads need runs.read", { skip }, async () => {
  await withApi(async ({ call }) => {
    const reader = (await call("POST", "/v1/tokens", BOOTSTRAP, { name: "ro", preset: "read" })).body.secret;
    const executor = (await call("POST", "/v1/tokens", BOOTSTRAP, { name: "ci", preset: "execute" })).body.secret;
    const created = (await call("POST", "/v1/batches", BOOTSTRAP, MULTI)).body.batch;
    assert.equal((await call("GET", "/v1/batches", reader)).status, 200);
    assert.equal((await call("GET", `/v1/batches/${created.id}`, reader)).status, 200);
    for (const token of [reader, executor]) {
      const refused = await call("POST", "/v1/batches", token, MULTI);
      assert.equal(refused.status, 403);
      assert.equal(refused.body.missing, "batches.manage");
      for (const action of ["pause", "resume", "cancel"]) {
        const answer = await call("POST", `/v1/batches/${created.id}/${action}`, token);
        assert.equal(answer.status, 403, action);
      }
    }
    const admin = (await call("POST", "/v1/tokens", BOOTSTRAP, { name: "admin", preset: "admin" })).body.secret;
    assert.equal((await call("POST", `/v1/batches/${created.id}/pause`, admin)).status, 202);
    assert.equal((await call("GET", "/v1/batches", null)).status, 401);
    assert.equal((await call("GET", "/v1/batches/00000000-0000-0000-0000-000000000000")).status, 404);
    assert.equal((await call("GET", "/v1/batches/not-a-uuid")).status, 404);
  });
});

test("an Idempotency-Key replays the first answer, and a different body under it is refused", { skip }, async () => {
  await withApi(async ({ call, pool }) => {
    const key = { "idempotency-key": "batch-once-1" };
    const first = await call("POST", "/v1/batches", BOOTSTRAP, MULTI, {}, key);
    assert.equal(first.status, 202);
    const again = await call("POST", "/v1/batches", BOOTSTRAP, MULTI, {}, key);
    assert.equal(again.status, 202);
    assert.equal(again.headers["idempotent-replayed"], "true");
    assert.equal(again.body.batchId, first.body.batchId);
    assert.equal((await pool.query("select count(*)::int as n from batch")).rows[0].n, 1);
    assert.equal((await pool.query("select count(*)::int as n from engineering_task")).rows[0].n, 2);
    const reused = await call("POST", "/v1/batches", BOOTSTRAP, { ...MULTI, title: "other" }, {}, key);
    assert.equal(reused.status, 422);
    assert.equal(reused.body.code, "idempotency_key_reused");
  });
});

test("cancel stops dispatch and cancels every child still going through the run-cancel path", { skip }, async () => {
  await withApi(async ({ call, cancels, pool }) => {
    const { batch, items } = (await call("POST", "/v1/batches", BOOTSTRAP, MULTI)).body;
    await settleRun(pool, items[0].runId, "COMPLETED", { verdict: "pass" });
    const cancelled = await call("POST", `/v1/batches/${batch.id}/cancel`);
    assert.equal(cancelled.status, 202, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.batch.status, "CANCELLED");
    assert.equal(cancelled.body.batch.stopReason, "cancelled");
    assert.deepEqual(cancels.map((c) => c.runId), [items[1].runId], "the completed child is left alone");
    assert.match(cancels[0].reason, /^batch .* cancelled by operator$/);
    assert.equal(cancelled.body.items[2].state, "skipped");
    assert.equal(cancelled.body.items[2].skipReason, "batch_cancelled");
    assert.equal((await call("POST", `/v1/batches/${batch.id}/cancel`)).status, 409);
    assert.equal((await call("POST", `/v1/batches/${batch.id}/resume`)).status, 409);
  });
});

test("a batch has no route that merges, approves, readies or verifies anything", () => {
  const batchRoutes = ROUTES.filter((r) => r.pattern.startsWith("/v1/batches"));
  assert.deepEqual(
    batchRoutes.map((r) => `${r.method} ${r.pattern}`).sort(),
    [
      "GET /v1/batches",
      "GET /v1/batches/:batchId",
      "POST /v1/batches",
      "POST /v1/batches/:batchId/cancel",
      "POST /v1/batches/:batchId/pause",
      "POST /v1/batches/:batchId/resume",
    ],
  );
  for (const r of batchRoutes) assert.doesNotMatch(r.pattern, /merge|approve|ready|verif/);
});

/** The CLI through the real router, over an in-process fetch. */
function fetchInto(deps, auth) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    const result = await handleApiRequest(deps, auth, {
      method: init.method ?? "GET",
      path: parsed.pathname,
      query: { get: (name) => parsed.searchParams.get(name) ?? undefined },
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json", ...(result.headers ?? {}) },
    });
  };
}

test("windkeel batch create / status --watch / pause / resume / cancel against the router", { skip }, async () => {
  await withApi(async ({ deps, auth, pool }) => {
    const api = new WindkeelApi({ baseUrl: "https://windkeel.test", token: BOOTSTRAP, fetch: fetchInto(deps, auth) });
    const lines = [];
    const io = { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) };
    const criteriaFile = join(tempDir("batch-criteria"), "criteria.md");
    writeFileSync(criteriaFile, "- [ ] npm run lint passes\n- [ ] npm test passes\n");
    assert.deepEqual(parseCriteria("- [ ] a\n\n* b\n"), ["a", "b"]);
    assert.deepEqual(parseCriteria('["x", "y"]'), ["x", "y"]);

    assert.equal(
      await batchCommand(api, io, {
        kind: "create",
        input: { kind: "multi_repo", title: "Lint", description: "Fix lint.", repositories: REPOS.slice(0, 3), maxConcurrency: 1, batchSpendCapUsd: 75, criteria: parseCriteria((await import("node:fs")).readFileSync(criteriaFile, "utf8")) },
      }),
      0,
      lines.join("\n"),
    );
    const id = lines[0].match(/created batch (\S+): started 1 of 3/)[1];
    assert.match(lines.join("\n"), /spent \$0\.00 of \$75\.00/);

    for (const action of ["pause", "resume"]) {
      lines.length = 0;
      assert.equal(await batchCommand(api, io, { kind: action, batchId: id }), 0);
      assert.match(lines[0], action === "pause" ? /paused batch .*: PAUSED/ : /resumed batch .*: RUNNING/);
    }

    // --watch polls until the batch settles: settle every child between polls. A child awaiting
    // review keeps its unspent cap reserved (ADR-0036 §4), so the $75 cap is sized to hold all
    // three $25 children at once; a smaller one would wait on reviewers, as it should.
    lines.length = 0;
    let polls = 0;
    const code = await batchCommand(api, io, {
      kind: "status",
      batchId: id,
      watch: true,
      intervalMs: 0,
      sleep: async () => {
        polls += 1;
        const live = (await pool.query("select r.id from engineering_run r join engineering_task t on t.id = r.task_id where t.batch_id = $1 and r.status = 'CREATED'", [id])).rows;
        for (const r of live) await settleRun(pool, r.id, "WAITING_FOR_HUMAN", { verdict: "pass" });
        const { dispatchOrganization } = await import("../dist/batches/dispatch.js");
        const org = (await pool.query("select organization_id from batch where id = $1", [id])).rows[0].organization_id;
        await dispatchOrganization(pool, org, { startRun: deps.control.enqueue });
      },
    });
    assert.equal(code, 0);
    assert.ok(polls >= 3, `polled ${polls} times`);
    assert.match(lines.at(-1), /COMPLETED/);
    assert.match(lines.at(-1), /verdicts: pass 3/);

    lines.length = 0;
    assert.equal(await batchCommand(api, io, { kind: "list" }), 0);
    assert.match(lines[0], new RegExp(`^${id}  COMPLETED  multi_repo  Lint`));
    await assert.rejects(batchCommand(api, io, { kind: "cancel", batchId: id }), (e) => e.code === "invalid_batch_state");
  });
});
