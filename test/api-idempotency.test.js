/**
 * `Idempotency-Key` on `POST /v1/tasks` (M8-5, #297): a retried automation gets the original task,
 * a reused key with a different body is refused, and keys are per principal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { canonicalJson, requestHash } from "../dist/intake/idempotency.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const BOOTSTRAP = "test-bootstrap-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";

let serial = 0;
async function withApi(fn) {
  const schema = `windkeel_api_idem_test_${Date.now()}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool, REPO_ID);
    const enqueued = [];
    const queue = { down: false };
    const deps = {
      pool,
      control: {
        async enqueue(runId) {
          if (queue.down) throw new Error("queue unreachable: token orq_leaky");
          enqueued.push(runId);
          return { enqueued: true };
        },
      },
    };
    const auth = { token: BOOTSTRAP, subject: "operator" };
    const call = (method, path, { bearer = BOOTSTRAP, body, key } = {}) =>
      handleApiRequest(deps, auth, {
        method,
        path,
        query: { get: () => undefined },
        headers: { authorization: `Bearer ${bearer}`, ...(key === undefined ? {} : { "idempotency-key": key }) },
        body,
      });
    await fn({ pool, call, enqueued, queue });
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

const TASK = { repositoryId: REPO_ID, title: "Retry uploads", description: "- [ ] retries a 500 three times" };

test("the canonical body ignores key order, not array order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [2, 1] } }), '{"a":{"c":[2,1],"d":2},"b":1}');
  assert.equal(requestHash({ a: 1, b: 2 }), requestHash({ b: 2, a: 1 }));
  assert.notEqual(requestHash({ a: [1, 2] }), requestHash({ a: [2, 1] }));
});

test("a replay with the same key and body answers the original 202; one task, one ledger row", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const first = await call("POST", "/v1/tasks", { body: TASK, key: "deploy-42" });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    // Key order in the body does not make it a different request.
    const reordered = { description: TASK.description, title: TASK.title, repositoryId: REPO_ID };
    const replay = await call("POST", "/v1/tasks", { body: reordered, key: "deploy-42" });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.taskId, first.body.taskId);
    assert.equal(replay.body.engineeringRunId, first.body.engineeringRunId);
    assert.equal(replay.headers["idempotent-replayed"], "true");

    const tasks = await pool.query("select count(*)::int as n from engineering_task");
    assert.equal(tasks.rows[0].n, 1);
    const ledger = await pool.query("select source, delivery_key, engineering_task_id, request_hash from intake_delivery");
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0].source, "api");
    assert.match(ledger.rows[0].delivery_key, /:deploy-42$/);
    assert.equal(ledger.rows[0].engineering_task_id, first.body.taskId);
    assert.equal(ledger.rows[0].request_hash, requestHash(TASK));

    // Without a key, nothing changes from before: every request is a new task.
    const plain = await call("POST", "/v1/tasks", { body: TASK });
    assert.equal(plain.status, 202);
    assert.notEqual(plain.body.taskId, first.body.taskId);
  });
});

test("the same key with a different body is 422 idempotency_key_reused and creates nothing", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    assert.equal((await call("POST", "/v1/tasks", { body: TASK, key: "k1" })).status, 202);
    const reused = await call("POST", "/v1/tasks", { body: { ...TASK, title: "Something else" }, key: "k1" });
    assert.equal(reused.status, 422);
    assert.equal(reused.body.code, "idempotency_key_reused");
    const tasks = await pool.query("select count(*)::int as n from engineering_task");
    assert.equal(tasks.rows[0].n, 1);
  });
});

test("different principals with the same key are independent", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const sp = (await call("POST", "/v1/service-principals", { body: { name: "ci", role: "member" } })).body.servicePrincipal;
    const { secret } = (await call("POST", `/v1/service-principals/${sp.id}/tokens`, { body: { name: "ci" } })).body;

    const mine = await call("POST", "/v1/tasks", { body: TASK, key: "shared" });
    const theirs = await call("POST", "/v1/tasks", { bearer: secret, body: TASK, key: "shared" });
    assert.equal(mine.status, 202);
    assert.equal(theirs.status, 202, JSON.stringify(theirs.body));
    assert.notEqual(mine.body.taskId, theirs.body.taskId);
    // Each principal's replay finds its own task.
    const theirsAgain = await call("POST", "/v1/tasks", { bearer: secret, body: TASK, key: "shared" });
    assert.equal(theirsAgain.body.taskId, theirs.body.taskId);
    const ledger = await pool.query("select count(*)::int as n from intake_delivery where source = 'api'");
    assert.equal(ledger.rows[0].n, 2);
  });
});

test("one principal, one key, two organizations: independent claims", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const home = (await pool.query("select id from organization where is_default")).rows[0].id;
    const { rows } = await pool.query(
      `insert into organization (account_id, name) select account_id, 'platform' from organization where is_default
       returning id`,
    );
    const other = rows[0].id;
    // A second grant (not the intake one — a repository has one of those) is enough for the API.
    await pool.query("insert into repository_grant (organization_id, repository_id, intake) values ($1, $2, false)", [
      other,
      REPO_ID,
    ]);
    // The operator reaches both organizations, so it names which one each time.
    const inHome = await call("POST", `/v1/orgs/${home}/tasks`, { body: TASK, key: "nightly" });
    const inOther = await call("POST", `/v1/orgs/${other}/tasks`, { body: TASK, key: "nightly" });
    assert.equal(inHome.status, 202, JSON.stringify(inHome.body));
    assert.equal(inOther.status, 202, JSON.stringify(inOther.body));
    assert.notEqual(inHome.body.taskId, inOther.body.taskId);
    assert.equal(inOther.headers?.["idempotent-replayed"], undefined, "not a replay of the other organization's");

    const tasks = await pool.query("select organization_id from engineering_task order by organization_id");
    assert.deepEqual(tasks.rows.map((r) => r.organization_id).sort(), [home, other].sort());
    const keys = await pool.query("select delivery_key from intake_delivery where source = 'api'");
    for (const { delivery_key } of keys.rows) assert.match(delivery_key, new RegExp(`^(${home}|${other}):[^:]+:nightly$`));
  });
});

test("a replay answers the original response verbatim — not a 404 after the grant is withdrawn", { skip }, async () => {
  await withApi(async ({ pool, call, enqueued }) => {
    const first = await call("POST", "/v1/tasks", { body: TASK, key: "verbatim" });
    assert.equal(first.status, 202);
    assert.equal(first.body.enqueued, true);

    await pool.query("delete from repository_grant where repository_id = $1", [REPO_ID]);
    const replay = await call("POST", "/v1/tasks", { body: TASK, key: "verbatim" });
    assert.equal(replay.status, 202, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, first.body, "byte-for-byte the first answer");
    assert.equal(replay.headers["idempotent-replayed"], "true");
    // A fresh key on the ungranted repository is still refused, and claims nothing.
    assert.equal((await call("POST", "/v1/tasks", { body: TASK, key: "fresh" })).status, 404);
    const ledger = await pool.query("select count(*)::int as n from intake_delivery");
    assert.equal(ledger.rows[0].n, 1);
    // The fake queue leaves the run CREATED, so the replay re-enqueued it — as a side effect only.
    assert.deepEqual(enqueued, [first.body.engineeringRunId, first.body.engineeringRunId]);
  });
});

test("a replay after a failed hand-over is never a 503; it re-enqueues as a side effect", { skip }, async () => {
  await withApi(async ({ call, enqueued, queue }) => {
    queue.down = true;
    const first = await call("POST", "/v1/tasks", { body: TASK, key: "outage" });
    assert.equal(first.status, 503);
    assert.equal(first.body.code, "enqueue_failed");
    assert.ok(!JSON.stringify(first.body).includes("orq_leaky"), "the queue's error text is not echoed");
    assert.ok(!JSON.stringify(first.body).includes("unreachable"));

    // Still down: the replay answers the stored 202, not the outage.
    const stillDown = await call("POST", "/v1/tasks", { body: TASK, key: "outage" });
    assert.equal(stillDown.status, 202, JSON.stringify(stillDown.body));
    assert.deepEqual(stillDown.body, {
      accepted: true,
      taskId: first.body.taskId,
      engineeringRunId: first.body.engineeringRunId,
      enqueued: false,
    });
    assert.deepEqual(enqueued, []);

    queue.down = false;
    const recovered = await call("POST", "/v1/tasks", { body: TASK, key: "outage" });
    assert.deepEqual(recovered.body, stillDown.body, "the same stored answer");
    assert.deepEqual(enqueued, [first.body.engineeringRunId], "the CREATED run was handed over by the replay");
  });
});

test("concurrent requests with one key make one task", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const answers = await Promise.all([1, 2, 3].map(() => call("POST", "/v1/tasks", { body: TASK, key: "race" })));
    for (const answer of answers) assert.equal(answer.status, 202, JSON.stringify(answer.body));
    assert.equal(new Set(answers.map((a) => a.body.taskId)).size, 1);
    const tasks = await pool.query("select count(*)::int as n from engineering_task");
    assert.equal(tasks.rows[0].n, 1);
  });
});

test("a malformed key is 400 and claims nothing", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    for (const key of ["", "x".repeat(201), "tab\there"]) {
      const answer = await call("POST", "/v1/tasks", { body: TASK, key });
      assert.equal(answer.status, 400, JSON.stringify(key));
      assert.equal(answer.body.code, "invalid_idempotency_key");
    }
    const ledger = await pool.query("select count(*)::int as n from intake_delivery");
    assert.equal(ledger.rows[0].n, 0);
  });
});
