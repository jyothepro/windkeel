/**
 * The organization's run-change stream (`GET /v1/events`, gap G5) and the run feed read backwards
 * (`?last=` / `?before=` / `?kind=`), which together let the console paint first and stay live.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { changeFrame, resyncFrame } from "../apps/ingress/dist/src/api/sse.js";
import { streamRunChanges } from "../apps/ingress/dist/src/api/stream.js";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { recordCost } from "../dist/factory/cost-ledger.js";
import { listRunChanges, runChangesHead, SETTLE_SECONDS } from "../dist/factory/run-changes.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const TOKEN = "test-operator-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";

const fakeSessions = {
  async verify(jwt) {
    const [kind, subject, id, login] = jwt.split(":");
    if (kind !== "session") return null;
    return { provider: "supabase", subject, githubUserId: Number(id), githubLogin: login, displayName: login };
  },
};
const fakeGithubUsers = { lookup: async (login) => (login === "mona" ? { id: 9919, login } : null) };

function parse(wire) {
  return wire
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const out = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) return { comment: line.slice(1).trim() };
        const at = line.indexOf(": ");
        out[line.slice(0, at)] = line.slice(at + 2);
      }
      return out;
    });
}

async function newRun(pool, title = "Make the gauge read zero when empty") {
  const task = await insertEngineeringTask(pool, {
    repositoryId: REPO_ID,
    sourceType: "api",
    sourceReference: `api:operator:${Math.random()}`,
    title,
    description: "- [ ] the gauge reads zero",
    acceptanceCriteria: [],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
  return { task, run };
}

/** Ages every transition so far past the settle window, as if it had committed a minute ago. */
async function settleAll(pool) {
  await pool.query(`update run_state_transition set at = at - make_interval(secs => $1)`, [SETTLE_SECONDS * 2]);
}

async function withApi(fn) {
  const schema = `windkeel_changes_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const deps = {
      pool,
      control: { approve: async () => ({}), cancel: async () => ({}), message: async () => ({}), listMessages: async () => [], startRun: async () => ({}), enqueue: async () => ({}) },
      githubUsers: fakeGithubUsers,
    };
    const auth = { token: TOKEN, subject: "operator", sessions: fakeSessions };
    const call = (path, params = {}, bearer = TOKEN) =>
      handleApiRequest(deps, auth, {
        method: "GET",
        path,
        query: { get: (name) => params[name] },
        headers: { authorization: `Bearer ${bearer}` },
      });
    const defaultOrg = (await pool.query("select id from organization where is_default")).rows[0].id;
    await fn({ pool, deps, auth, call, defaultOrg });
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

/** A second organization with a granted repository and one run of its own; mona belongs only to it. */
async function secondOrganization(pool, call) {
  const { rows } = await pool.query(
    `insert into organization (account_id, name) select account_id, 'platform' from organization where is_default returning id`,
  );
  const orgId = rows[0].id;
  const invite = await call.post(`/v1/orgs/${orgId}/invitations`, { githubLogin: "mona", role: "admin" });
  assert.equal(invite.status, 201);
  const { rows: repo } = await pool.query(
    `insert into repository (owner, name, default_branch, clone_url) values ('platform', 'infra', 'main', 'https://github.com/platform/infra.git') returning id`,
  );
  const task = await insertEngineeringTask(pool, {
    repositoryId: repo[0].id,
    sourceType: "api",
    sourceReference: "api:mona:1",
    title: "Another organization's secret work",
    description: "- [ ] nobody else sees this",
    acceptanceCriteria: [],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  await pool.query("update engineering_task set organization_id = $1 where id = $2", [orgId, task.id]);
  const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
  return { orgId, run, monaSession: "session:sub-mona:9919:mona" };
}

/** `call` reads; inviting someone is a POST through the same router. */
function withPost(deps, auth, call) {
  call.post = (path, body) =>
    handleApiRequest(deps, auth, { method: "POST", path, query: { get: () => undefined }, headers: { authorization: `Bearer ${TOKEN}` }, body });
  return call;
}

const clockOptions = (budgetMs) => {
  let clock = 0;
  return {
    budgetMs,
    pollMs: 5,
    keepAliveMs: 1_000_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
};

// --- frames ------------------------------------------------------------------

test("a change frame carries the resume position as its id, not the change's own", () => {
  const change = { kind: "run.changed", changeId: "41", runId: "r", taskId: "t", from: "PLANNING", state: "IMPLEMENTING", at: new Date(0) };
  const [parsed] = parse(changeFrame(change, "37"));
  assert.equal(parsed.event, "run.changed");
  assert.equal(parsed.id, "37", "resuming from the change's own id could skip one not yet visible");
  assert.equal(JSON.parse(parsed.data).changeId, "41");

  const [resync] = parse(resyncFrame("99"));
  assert.equal(resync.event, "resync");
  assert.deepEqual(JSON.parse(resync.data), { cursor: "99" });
});

// --- the change feed ---------------------------------------------------------

test("a change is answered until it settles, and the cursor never moves past an unsettled one", { skip }, async () => {
  await withApi(async ({ pool, defaultOrg }) => {
    const { run } = await newRun(pool);
    await advanceRun(pool, run.id, "CLASSIFYING");

    const fresh = await listRunChanges(pool, defaultOrg, "0");
    assert.equal(fresh.items.length, 1);
    assert.equal(fresh.items[0].runId, run.id);
    assert.equal(fresh.items[0].state, "CLASSIFYING");
    assert.equal(fresh.endCursor, "0", "an unsettled change holds the cursor where it was");

    const again = await listRunChanges(pool, defaultOrg, fresh.endCursor);
    assert.deepEqual(again.items.map((c) => c.changeId), fresh.items.map((c) => c.changeId), "answered again: at-least-once");

    await settleAll(pool);
    const settled = await listRunChanges(pool, defaultOrg, "0");
    assert.equal(settled.endCursor, settled.items[0].changeId, "a settled change moves the cursor past itself");
    assert.deepEqual((await listRunChanges(pool, defaultOrg, settled.endCursor)).items, []);
  });
});

test("another organization's run changes never appear, in a page or a stream", { skip }, async () => {
  await withApi(async ({ pool, deps, auth, call, defaultOrg }) => {
    withPost(deps, auth, call);
    const ours = await newRun(pool);
    const theirs = await secondOrganization(pool, call);
    await advanceRun(pool, ours.run.id, "CLASSIFYING");
    await advanceRun(pool, theirs.run.id, "CLASSIFYING");
    await advanceRun(pool, theirs.run.id, "PLANNING");

    const mine = await call(`/v1/orgs/${defaultOrg}/events`, { after: "0" });
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.items.map((c) => c.runId), [ours.run.id]);
    assert.equal(mine.body.organizationId, defaultOrg);

    const monas = await call("/v1/events", { after: "0" }, theirs.monaSession);
    assert.equal(monas.status, 200);
    assert.deepEqual([...new Set(monas.body.items.map((c) => c.runId))], [theirs.run.id]);
    assert.equal(monas.body.organizationId, theirs.orgId);

    const refused = await call(`/v1/orgs/${defaultOrg}/events`, { after: "0" }, theirs.monaSession);
    assert.equal(refused.status, 404, "an organization you are not in does not exist");

    const chunks = [];
    await streamRunChanges(pool, theirs.orgId, { write: (c) => chunks.push(c), writable: () => true }, "0", clockOptions(10));
    const frames = parse(chunks.join("")).filter((f) => f.event === "run.changed");
    assert.equal(frames.length, 2);
    for (const f of frames) assert.equal(JSON.parse(f.data).runId, theirs.run.id);
  });
});

test("a stream sends each change once, ends on its budget with a cursor, and resumes from it", { skip }, async () => {
  await withApi(async ({ pool, defaultOrg }) => {
    const { run } = await newRun(pool);
    await advanceRun(pool, run.id, "CLASSIFYING");
    await advanceRun(pool, run.id, "PLANNING");

    const chunks = [];
    const first = await streamRunChanges(pool, defaultOrg, { write: (c) => chunks.push(c), writable: () => true }, "0", clockOptions(20));
    const frames = parse(chunks.join(""));
    const changes = frames.filter((f) => f.event === "run.changed");
    assert.equal(changes.length, 2, "several polls re-read the unsettled changes, and each is still sent once");
    assert.deepEqual(changes.map((f) => JSON.parse(f.data).state), ["CLASSIFYING", "PLANNING"]);
    const closing = frames.at(-1);
    assert.equal(closing.event, "cursor");
    assert.deepEqual(JSON.parse(closing.data), { cursor: first.cursor, reason: "budget_exhausted", reconnect: true });
    assert.equal(first.cursor, "0", "nothing settled, so nothing was passed");

    // Settled, the next stream resumes past them and sends only what is new.
    await settleAll(pool);
    const settled = await listRunChanges(pool, defaultOrg, "0");
    await advanceRun(pool, run.id, "WAITING_FOR_APPROVAL");
    const resumed = [];
    await streamRunChanges(pool, defaultOrg, { write: (c) => resumed.push(c), writable: () => true }, settled.endCursor, clockOptions(10));
    const states = parse(resumed.join("")).filter((f) => f.event === "run.changed").map((f) => JSON.parse(f.data).state);
    assert.deepEqual(states, ["WAITING_FOR_APPROVAL"]);
  });
});

test("a stream with no cursor starts at the head and treats what is already there as known", { skip }, async () => {
  await withApi(async ({ pool, defaultOrg }) => {
    const { run } = await newRun(pool);
    await advanceRun(pool, run.id, "CLASSIFYING");

    const chunks = [];
    let polls = 0;
    const options = clockOptions(30);
    const sleep = options.sleep;
    options.sleep = async (ms) => {
      polls += 1;
      // A change that lands while the stream is open is news.
      if (polls === 1) await advanceRun(pool, run.id, "PLANNING");
      await sleep(ms);
    };
    await streamRunChanges(pool, defaultOrg, { write: (c) => chunks.push(c), writable: () => true }, undefined, options);
    const states = parse(chunks.join("")).filter((f) => f.event === "run.changed").map((f) => JSON.parse(f.data).state);
    assert.deepEqual(states, ["PLANNING"], "the transition from before it asked is not replayed");

    assert.equal(await runChangesHead(pool), "0", "nothing settled yet, so the head is the start");
    await settleAll(pool);
    assert.notEqual(await runChangesHead(pool), "0", "settled, the head moves to the newest transition");
  });
});

test("a reader further behind than one window is told to resync, not replayed the log", { skip }, async () => {
  await withApi(async ({ pool, defaultOrg }) => {
    const { run } = await newRun(pool);
    await advanceRun(pool, run.id, "CLASSIFYING");
    await advanceRun(pool, run.id, "PLANNING");
    await advanceRun(pool, run.id, "WAITING_FOR_APPROVAL");
    await settleAll(pool);

    const page = await listRunChanges(pool, defaultOrg, "0", 2);
    assert.equal(page.hasNextPage, true);
    assert.equal(page.items.length, 2, "a window bounds what one read looks at");
    assert.equal(page.endCursor, page.items[1].changeId);

    // A long history: more transitions than one window, all settled. (Written directly — the log is
    // append-only history, and the stream reads nothing but `seq`, `at` and the run they belong to.)
    await pool.query(
      `insert into run_state_transition (engineering_run_id, from_state, to_state, reason, at)
       select $1, 'PLANNING', 'WAITING_FOR_APPROVAL', 'history', now() - interval '1 hour' from generate_series(1, 600)`,
      [run.id],
    );
    const chunks = [];
    await streamRunChanges(pool, defaultOrg, { write: (c) => chunks.push(c), writable: () => true }, "0", clockOptions(10));
    const frames = parse(chunks.join(""));
    assert.equal(frames.filter((f) => f.event === "resync").length, 1);
    assert.equal(frames.filter((f) => f.event === "run.changed").length, 0, "the history is not replayed");
    const resync = JSON.parse(frames.find((f) => f.event === "resync").data);
    assert.equal(resync.cursor, await runChangesHead(pool));
  });
});

test("the change feed refuses a cursor it did not issue", { skip }, async () => {
  await withApi(async ({ call }) => {
    const bad = await call("/v1/events", { after: "yesterday" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "invalid_cursor");
    const head = await call("/v1/events");
    assert.equal(head.status, 200);
    assert.deepEqual(head.body.items, []);
    assert.match(head.body.endCursor, /^\d+$/);
  });
});

