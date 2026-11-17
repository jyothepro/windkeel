/**
 * The source-agnostic intake pipeline (#293, ADR-0025 §4–§5), driven through a fake source.
 *
 * Every M8 source — Slack, Linear, Jira, signed webhooks, schedules — gets its ordering and
 * failure semantics from `runIntake`, so these are the tests that make those semantics true for
 * all of them at once: verify before parse, parse before database, the delivery row in the same
 * transaction as the work, ignored events recorded, 5xx only when a retry can help.
 */

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { Readable } from "node:stream";
import {
  dispatchIntake,
  ignore,
  INTAKE_SOURCE_NAME_PATTERN,
  INTAKE_TARGET_PATTERN,
  redactSecrets,
  registerIntakeSource,
  RELEASE_FAILED_TAG,
  runIntake,
  unregisterIntakeSource,
  wireResponse,
} from "../dist/intake/pipeline.js";
import { IllegalTransitionError } from "../dist/factory/run-state-machine.js";
import { signHmacSha256, verifyHmacSha256 } from "../dist/intake/hmac.js";
import { createTaskFromIntake } from "../dist/intake/create-task.js";
import { registerSourceNotifier, unregisterSourceNotifier } from "../dist/intake/notifiers.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { pruneIgnoredDeliveriesLocked } from "../dist/factory/sweeps/intake-delivery-retention.js";
import { runMigrations } from "../dist/factory/migrate.js";
import { handleWebhook } from "../apps/ingress/dist/src/handler.js";
import { signWebhookBody } from "../apps/ingress/dist/src/signature.js";
import { recordingActions } from "../apps/ingress/dist/src/actions.js";
import { FIXTURE_REPOSITORY_ID, repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";

const SECRET = "fake-source-secret";
const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
let schemaSerial = 0;

/**
 * A fake `IntakeSource`: HMAC-signed JSON, keyed by `id`. `{kind: "ignore"}` is ignored with a
 * reason; `{kind: "create"}` creates a task through `createTaskFromIntake`, and `failAfterInsert`
 * throws after the task row is written, inside the transaction.
 */
function fakeSource({ startRun, organizationId }) {
  return {
    name: "test",
    async verify(req) {
      return verifyHmacSha256({
        secret: SECRET,
        body: req.rawBody,
        signature: req.headers["x-test-signature"],
        encoding: "hex",
      })
        ? { ok: true }
        : { ok: false, error: "signature verification failed" };
    },
    parse(req) {
      return JSON.parse(String(req.rawBody));
    },
    deliveryKey(_req, payload) {
      return payload.id;
    },
    async interpret(payload) {
      if (payload.kind !== "create") return ignore(`kind ${payload.kind} is not acted on`, { event: payload.kind });
      return {
        kind: "act",
        intent: "create_task",
        event: "create",
        organizationId,
        async act(tx) {
          const created = await createTaskFromIntake(
            tx.db,
            {
              organizationId,
              repositoryId: FIXTURE_REPOSITORY_ID,
              sourceType: "test",
              sourceReference: payload.ref,
              sourceContext: { channel: "C123", thread: "1700000000.0001" },
              title: "Retry uploads",
              description: "- [ ] retries a 500 three times",
            },
            { startRun },
          );
          if (payload.failAfterInsert) throw new Error("forced failure after the task insert");
          await tx.record({
            intent: `create_task:${created.created ? "started" : "existing"}`,
            engineeringTaskId: created.taskId,
          });
          if (payload.reply) tx.reply(payload.reply.status, { ...payload.reply.body, taskId: created.taskId });
          if (payload.ignoreAfterReply) await tx.ignore("changed its mind after replying");
          return created.afterCommit;
        },
      };
    },
  };
}

function request(payload, { signature, raw } = {}) {
  const rawBody = raw ?? JSON.stringify(payload);
  return {
    headers: {
      "x-test-signature":
        signature === undefined ? signHmacSha256({ secret: SECRET, body: rawBody, encoding: "hex" }) : signature,
    },
    rawBody,
  };
}

function recordingEnqueuer({ failFirst = 0 } = {}) {
  const started = [];
  let failures = failFirst;
  return {
    started,
    async startRun(runId) {
      if (failures > 0) {
        failures--;
        throw new Error("queue unavailable");
      }
      started.push(runId);
      return { enqueued: true };
    },
  };
}

async function withSchema(fn, { migrationsDir = join(repoRoot, "migrations"), seed = true } = {}) {
  const schema = `windkeel_intake_test_${Date.now()}_${schemaSerial++}`;
  const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await setup.query(`create schema ${schema}`);
  await setup.end();

  const pool = new Pool({ connectionString: dbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await runMigrations(pool, migrationsDir);
    if (seed) await seedFixtureRepository(pool);
    await fn(pool, schema);
  } finally {
    const teardown = new Pool({ connectionString: dbUrl, ...TEST_POOL });
    await teardown.query(`drop schema ${schema} cascade`);
    await teardown.end();
    await pool.end();
  }
}

async function defaultOrganization(pool) {
  const { rows } = await pool.query("select id from organization where is_default");
  return rows[0].id;
}

async function counts(pool) {
  const { rows } = await pool.query(
    `select (select count(*)::int from intake_delivery) as deliveries,
            (select count(*)::int from engineering_task) as tasks,
            (select count(*)::int from engineering_run) as runs`,
  );
  return rows[0];
}

// --- Rejections: before anything reaches the database ---

test("a bad signature is a 401 and writes no row", { skip }, async () => {
  await withSchema(async (pool) => {
    const organizationId = await defaultOrganization(pool);
    const source = fakeSource({ startRun: recordingEnqueuer().startRun, organizationId });
    for (const signature of ["", "00", signHmacSha256({ secret: "wrong", body: "{}", encoding: "hex" })]) {
      const response = await runIntake(source, request({ id: "d1", kind: "create", ref: "r" }, { signature }), { pool });
      assert.equal(response.status, 401);
      assert.equal(response.body.ok, false);
    }
    assert.deepEqual(await counts(pool), { deliveries: 0, tasks: 0, runs: 0 });
  });
});

test("a body that does not parse is a 400, writes no row, and does not echo the body", { skip }, async () => {
  await withSchema(async (pool) => {
    const organizationId = await defaultOrganization(pool);
    const source = fakeSource({ startRun: recordingEnqueuer().startRun, organizationId });
    const response = await runIntake(source, request(null, { raw: "{private repo contents" }), { pool });
    assert.equal(response.status, 400);
    assert.ok(!JSON.stringify(response.body).includes("private repo contents"));
    assert.deepEqual(await counts(pool), { deliveries: 0, tasks: 0, runs: 0 });
  });
});

test("verification runs before parse and before any connection", async () => {
  let parsed = false;
  const source = {
    name: "test",
    async verify() {
      return { ok: false, error: "nope" };
    },
    parse() {
      parsed = true;
      return {};
    },
    deliveryKey: () => "k",
    interpret: async () => ignore("x"),
  };
  const forbidden = {
    connect() {
      throw new Error("connected before rejecting");
    },
  };
  const response = await runIntake(source, request({}), { pool: forbidden });
  assert.equal(response.status, 401);
  assert.equal(parsed, false);
});

// --- Ignored events are recorded ---

test("an ignored event is recorded with its reason and answered 200; a redelivery is a duplicate", { skip }, async () => {
  await withSchema(async (pool) => {
    const organizationId = await defaultOrganization(pool);
    const source = fakeSource({ startRun: recordingEnqueuer().startRun, organizationId });
    const req = request({ id: "ign-1", kind: "reaction" });

    const first = await runIntake(source, req, { pool });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true, intent: "ignore", reason: "kind reaction is not acted on" });

    const { rows } = await pool.query("select source, delivery_key, event, intent, reason, engineering_task_id from intake_delivery");
    assert.deepEqual(rows, [
      {
        source: "test",
        delivery_key: "ign-1",
        event: "reaction",
        intent: "ignore",
        reason: "kind reaction is not acted on",
        engineering_task_id: null,
      },
    ]);

    const again = await runIntake(source, req, { pool });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal((await counts(pool)).deliveries, 1);
  });
});

// --- Acting: one transaction ---

test("a create writes the task, the run and the delivery row together, then enqueues", { skip }, async () => {
  await withSchema(async (pool) => {
    const organizationId = await defaultOrganization(pool);
    const enqueuer = recordingEnqueuer();
    const source = fakeSource({ startRun: enqueuer.startRun, organizationId });

    const response = await runIntake(source, request({ id: "c-1", kind: "create", ref: "LIN-1" }), { pool });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, intent: "create_task" });

    const task = (await pool.query("select * from engineering_task")).rows[0];
    assert.equal(task.source_type, "test");
    assert.equal(task.source_reference, "LIN-1");
    assert.equal(task.organization_id, organizationId);
    assert.deepEqual(task.source_context, { channel: "C123", thread: "1700000000.0001" });
    assert.deepEqual(task.acceptance_criteria.map((c) => c.text), ["retries a 500 three times"]);
    assert.deepEqual(task.acceptance_criteria[0].source, { kind: "explicit", ref: "LIN-1" });

    const runs = (await pool.query("select id from engineering_run")).rows;
    assert.equal(runs.length, 1);
    assert.deepEqual(enqueuer.started, [runs[0].id], "enqueued after commit");

    const delivery = (await pool.query("select * from intake_delivery")).rows[0];
    assert.equal(delivery.intent, "create_task:started");
    assert.equal(delivery.engineering_task_id, task.id);
    assert.equal(delivery.organization_id, organizationId);
  });
});

test("tx.reply is the one response seam: sent instead of the body, dropped on ignore, failure and duplicate", { skip }, async () => {
  await withSchema(async (pool) => {
    const organizationId = await defaultOrganization(pool);
    const enqueuer = recordingEnqueuer({ failFirst: 1 });
    const source = fakeSource({ startRun: enqueuer.startRun, organizationId });
    const reply = { status: 202, body: { hello: "sender" } };

    // The after-commit fails: the reply describes work that was not handed on, so it is dropped.
    const failed = await runIntake(source, request({ id: "r-1", kind: "create", ref: "R-1", reply }), { pool });
    assert.equal(failed.status, 500);
    assert.equal(failed.reply, undefined);
    assert.deepEqual(wireResponse(failed), { status: 500, body: failed.body });

    // Succeeds: the pipeline's own body stays fixed-shape, and the wire carries the reply instead.
    const answered = await runIntake(source, request({ id: "r-1", kind: "create", ref: "R-1", reply }), { pool });
    assert.equal(answered.status, 200);
    assert.deepEqual(answered.body, { ok: true, intent: "create_task" }, "no reply fields merged into the body");
    const taskId = (await pool.query("select id from engineering_task")).rows[0].id;
    assert.deepEqual(answered.reply, { status: 202, body: { hello: "sender", taskId } });
    assert.deepEqual(wireResponse(answered), answered.reply);

    // A duplicate never reaches act, so it never replies.
    const duplicate = await runIntake(source, request({ id: "r-1", kind: "create", ref: "R-1", reply }), { pool });
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.reply, undefined);

    // An act that replies and then ignores is answered as an ignore.
    const ignored = await runIntake(
      source,
      request({ id: "r-2", kind: "create", ref: "R-2", reply, ignoreAfterReply: true }),
      { pool },
    );
    assert.equal(ignored.reply, undefined);
    assert.deepEqual(wireResponse(ignored), {
      status: 200,
      body: { ok: true, intent: "ignore", reason: "changed its mind after replying" },
    });
  });
});

test("IntakeSource.respond writes the same reply channel: an act's tx.reply wins, and a throwing respond is logged (#307)", { skip }, async () => {
  await withSchema(async (pool) => {
    const organizationId = await defaultOrganization(pool);
    const enqueuer = recordingEnqueuer();
    const base = fakeSource({ startRun: enqueuer.startRun, organizationId });
    const lines = [];
    const log = (message, fields) => lines.push({ message, ...fields });

    const shaping = { ...base, respond: (response) => ({ status: 200, body: { shaped: response.body.intent } }) };
    const ignored = await runIntake(shaping, request({ id: "s-1", kind: "noop" }), { pool, log });
    assert.deepEqual(wireResponse(ignored), { status: 200, body: { shaped: "ignore" } });
    const reply = { status: 202, body: { from: "act" } };
    const acted = await runIntake(shaping, request({ id: "s-2", kind: "create", ref: "S-2", reply }), { pool, log });
    assert.equal(acted.reply.status, 202, "the act's own reply is not overwritten by respond");

    const throwing = {
      ...base,
      respond: () => {
        throw new Error("respond broke with Bearer xoxb-9-secret");
      },
    };
    const answered = await runIntake(throwing, request({ id: "s-3", kind: "noop" }), { pool, log });
    assert.equal(answered.reply, undefined, "the pipeline's own answer goes out");
    assert.equal(answered.status, 200);
    const line = lines.find((l) => l.message === "intake respond failed");
    assert.ok(line, "the throw is logged, not swallowed");
    assert.equal(line.deliveryKey, "s-3");
    assert.doesNotMatch(JSON.stringify(line), /xoxb-9-secret/);
  });
});

test("a failure after the task insert persists nothing: no task, no run, no delivery", { skip }, async () => {
  await withSchema(async (pool) => {
    const organizationId = await defaultOrganization(pool);
    const enqueuer = recordingEnqueuer();
    const source = fakeSource({ startRun: enqueuer.startRun, organizationId });
    const response = await runIntake(
      source,
      request({ id: "c-2", kind: "create", ref: "LIN-2", failAfterInsert: true }),
      { pool },
    );
    assert.equal(response.status, 500, "not a transient database fault");
    assert.deepEqual(await counts(pool), { deliveries: 0, tasks: 0, runs: 0 });
    assert.deepEqual(enqueuer.started, []);
  });
});

test("an after-commit failure is a 500 that releases the delivery row; the retry finishes the job", { skip }, async () => {
  await withSchema(async (pool) => {
    const organizationId = await defaultOrganization(pool);
    const enqueuer = recordingEnqueuer({ failFirst: 1 });
    const source = fakeSource({ startRun: enqueuer.startRun, organizationId });
    const req = request({ id: "c-3", kind: "create", ref: "LIN-3" });

    const first = await runIntake(source, req, { pool });
    assert.equal(first.status, 500);
    const afterFailure = await counts(pool);
    assert.equal(afterFailure.deliveries, 0, "the delivery row was released");
    assert.equal(afterFailure.tasks, 1, "the committed task stays");

    const retry = await runIntake(source, req, { pool });
    assert.equal(retry.status, 200);
    const after = await counts(pool);
    assert.deepEqual(after, { deliveries: 1, tasks: 1, runs: 1 }, "the retry found the task, not a second one");
    const runId = (await pool.query("select id from engineering_run")).rows[0].id;
    assert.deepEqual(enqueuer.started, [runId], "the still-CREATED run was enqueued by the retry");
    assert.equal((await pool.query("select intent from intake_delivery")).rows[0].intent, "create_task:existing");
  });
});

test("an unavailable database is a 503, so the sender retries", async () => {
  const unreachable = new Pool({ connectionString: "postgresql://localhost:1/nothing", connectionTimeoutMillis: 2_000 });
  try {
    const source = fakeSource({ startRun: recordingEnqueuer().startRun, organizationId: "00000000-0000-0000-0000-000000000000" });
    const response = await runIntake(source, request({ id: "d", kind: "create", ref: "r" }), { pool: unreachable });
    assert.equal(response.status, 503);
    assert.equal(response.body.ok, false);
    const ignored = await runIntake(source, request({ id: "d2", kind: "noise" }), { pool: unreachable });
    assert.equal(ignored.status, 503, "recording an ignore needs the database too");
  } finally {
    await unreachable.end();
  }
});

test("the same (organization, source, reference) via two delivery keys is one task", { skip }, async () => {
  await withSchema(async (pool) => {
    const organizationId = await defaultOrganization(pool);
    const enqueuer = recordingEnqueuer();
    const source = fakeSource({ startRun: enqueuer.startRun, organizationId });

    const a = await runIntake(source, request({ id: "k-1", kind: "create", ref: "LIN-9" }), { pool });
    const b = await runIntake(source, request({ id: "k-2", kind: "create", ref: "LIN-9" }), { pool });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const c = await counts(pool);
    assert.equal(c.tasks, 1);
    assert.equal(c.runs, 1);
    assert.equal(c.deliveries, 2, "both deliveries are recorded");
  });
});

test("two concurrent deliveries about one reference still make one task", { skip }, async () => {
  await withSchema(async (pool, schema) => {
    const organizationId = await defaultOrganization(pool);
    const other = new Pool({ connectionString: dbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
    try {
      const source = fakeSource({ startRun: recordingEnqueuer().startRun, organizationId });
      const [a, b] = await Promise.all([
        runIntake(source, request({ id: "p-1", kind: "create", ref: "LIN-10" }), { pool }),
        runIntake(source, request({ id: "p-2", kind: "create", ref: "LIN-10" }), { pool: other }),
      ]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal((await counts(pool)).tasks, 1);
    } finally {
      await other.end();
    }
  });
});

// --- The registry behind /api/intake/:source ---

test("an unregistered source is a 404; a registered one is dispatched", async () => {
  const unknown = await dispatchIntake("nope", request({}), { pool: {} });
  assert.equal(unknown.status, 404);

  registerIntakeSource({
    name: "registered",
    verify: async () => ({ ok: false, error: "signature verification failed" }),
    parse: () => ({}),
    deliveryKey: () => "k",
    interpret: async () => ignore("x"),
  });
  try {
    const known = await dispatchIntake("registered", request({}), { pool: {} });
    assert.equal(known.status, 401, "reached the source's own verify");
  } finally {
    unregisterIntakeSource("registered");
  }
});

test("the /api/intake route answers 404 for an unknown source without a database", async () => {
  const { default: intake, sourceNameOf } = await import("../apps/ingress/dist/api/intake.js");
  assert.equal(sourceNameOf("/api/intake/slack"), "slack");
  assert.equal(sourceNameOf("/api/intake?source=linear"), "linear");
  assert.equal(sourceNameOf("/api/intake/Bad%20Name"), null);
  const { intakePathOf } = await import("../apps/ingress/dist/api/intake.js");
  assert.deepEqual(intakePathOf("/api/intake/webhook/abc-123"), { source: "webhook", target: "abc-123" });
  assert.deepEqual(intakePathOf("/api/intake?source=webhook&target=abc"), { source: "webhook", target: "abc" });
  assert.deepEqual(intakePathOf("/api/intake?source=slack&target="), { source: "slack" });
  assert.equal(intakePathOf("/api/intake/webhook/a%20b"), null);
  assert.equal(intakePathOf("/api/intake/webhook/a/b"), null);

  const out = {};
  const res = {
    statusCode: 0,
    setHeader() {},
    end(body) {
      out.status = res.statusCode;
      out.body = JSON.parse(body);
    },
  };
  await intake({ method: "POST", url: "/api/intake/not-registered", headers: {} }, res);
  assert.equal(out.status, 404);
});

// --- The migration: GitHub deliveries recorded before 0023 still deduplicate ---

test("a webhook_delivery row from before 0023 still deduplicates its GitHub redelivery", { skip }, async () => {
  const all = readdirSync(join(repoRoot, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const before = mkdtempSync(join(tmpdir(), "windkeel-0022-"));
  for (const file of all.filter((f) => f < "0023")) copyFileSync(join(repoRoot, "migrations", file), join(before, file));
  try {
    await withSchema(
      async (pool) => {
        await pool.query(
          `insert into webhook_delivery (delivery_id, event, action, intent)
           values ('gh-before-0023', 'issues', 'labeled', 'create_task:started')`,
        );
        await runMigrations(pool, join(repoRoot, "migrations"));

        const { rows } = await pool.query("select source, delivery_key, intent from intake_delivery");
        assert.deepEqual(rows, [{ source: "github", delivery_key: "gh-before-0023", intent: "create_task:started" }]);
        const legacy = await pool.query("select to_regclass('webhook_delivery') as t");
        assert.equal(legacy.rows[0].t, null, "the old table is gone");

        const payload = {
          action: "labeled",
          label: { name: "windkeel" },
          repository: {
            owner: { login: "jyothepro" },
            name: "windkeel-fixture",
            default_branch: "main",
            clone_url: "https://github.com/jyothepro/windkeel-fixture.git",
            fork: false,
          },
          issue: { number: 7, title: "t", body: "b", labels: [{ name: "windkeel" }], html_url: "u", user: { login: "x" } },
        };
        const rawBody = JSON.stringify(payload);
        const actions = recordingActions();
        const replay = await handleWebhook(
          {
            headers: {
              "x-github-event": "issues",
              "x-github-delivery": "gh-before-0023",
              "x-hub-signature-256": signWebhookBody("s", rawBody),
            },
            rawBody,
          },
          { secret: "s", pool, actions },
        );
        assert.equal(replay.status, 200);
        assert.equal(replay.body.duplicate, true);
        assert.deepEqual(actions.recorded, [], "nothing acted on the replay");
      },
      { migrationsDir: before, seed: false },
    );
  } finally {
    rmSync(before, { recursive: true, force: true });
  }
});

// --- Retention ---

test("the sweep prunes ignored rows older than 30 days and keeps acted rows and recent ignores", { skip }, async () => {
  await withSchema(async (pool) => {
    await pool.query(
      `insert into intake_delivery (source, delivery_key, intent, reason, received_at) values
         ('test', 'old-ignore',    'ignore',              'noise', now() - interval '31 days'),
         ('test', 'recent-ignore', 'ignore',              'noise', now() - interval '29 days'),
         ('test', 'old-acted',     'create_task:started', null,    now() - interval '90 days')`,
    );
    const outcome = await pruneIgnoredDeliveriesLocked({ pool });
    assert.equal(outcome.kind, "ran");
    assert.equal(outcome.result.deleted, 1);
    const { rows } = await pool.query("select delivery_key from intake_delivery order by delivery_key");
    assert.deepEqual(rows.map((r) => r.delivery_key), ["old-acted", "recent-ignore"]);
  });
});

// --- The outcome notifier seam ---

test("a registered notifier hears a terminal state with the task's source context; its failure never fails the run", { skip }, async () => {
  await withSchema(async (pool) => {
    const organizationId = await defaultOrganization(pool);
    const heard = [];
    registerSourceNotifier({
      sourceType: "test",
      async notify(task, run, outcome) {
        heard.push({ kind: outcome.kind, context: task.sourceContext, runId: run.id, state: outcome.state, terminal: outcome.terminal });
        throw new Error("slack is down");
      },
    });
    try {
      const created = await createTaskFromIntake(
        pool,
        {
          organizationId,
          repositoryId: FIXTURE_REPOSITORY_ID,
          sourceType: "test",
          sourceReference: "N-1",
          sourceContext: { channel: "C9" },
          title: "t",
          description: "- [ ] a",
        },
        { startRun: async () => ({ enqueued: true }) },
      );
      await advanceRun(pool, created.runId, "CLASSIFYING", "started");
      assert.deepEqual(
        heard,
        [{ kind: "started", context: { channel: "C9" }, runId: created.runId, state: "CLASSIFYING", terminal: false }],
        "leaving CREATED is the `started` outcome",
      );
      await advanceRun(pool, created.runId, "PLANNING", "classified");
      assert.equal(heard.length, 1, "per-attempt chatter is not notified");
      const moved = await advanceRun(pool, created.runId, "CANCELLED", "operator cancelled");
      assert.equal(moved.run.status, "CANCELLED", "the transition stands despite the notifier throwing");
      assert.deepEqual(heard.at(-1), { kind: "state", context: { channel: "C9" }, runId: created.runId, state: "CANCELLED", terminal: true });
    } finally {
      unregisterSourceNotifier("test");
    }
  });
});

test("the notifier is handed the committed transition's id: same on a replay, new on a genuine re-entry (#306)", { skip }, async () => {
  await withSchema(async (pool) => {
    const organizationId = await defaultOrganization(pool);
    const heard = [];
    registerSourceNotifier({
      sourceType: "test",
      async notify(_task, _run, outcome) {
        heard.push({ state: outcome.state, transitionId: outcome.transitionId });
      },
    });
    try {
      const created = await createTaskFromIntake(
        pool,
        {
          organizationId,
          repositoryId: FIXTURE_REPOSITORY_ID,
          sourceType: "test",
          sourceReference: "T-ID-1",
          title: "t",
          description: "- [ ] a",
        },
        { startRun: async () => ({ enqueued: true }) },
      );
      await advanceRun(pool, created.runId, "CLASSIFYING", "started");
      await advanceRun(pool, created.runId, "PLANNING", "classified");
      const first = await advanceRun(pool, created.runId, "WAITING_FOR_APPROVAL", "criteria need approval");
      await advanceRun(pool, created.runId, "BLOCKED", "paused");
      await advanceRun(pool, created.runId, "WAITING_FOR_APPROVAL", "criteria need approval");
      // A late replay of the second entry, then the ids as heard.
      const second = await advanceRun(pool, created.runId, "WAITING_FOR_APPROVAL", "criteria need approval");
      const waits = heard.filter((h) => h.state === "WAITING_FOR_APPROVAL");
      assert.equal(waits.length, 3);
      assert.ok(waits.every((h) => typeof h.transitionId === "string" && h.transitionId.length > 0));
      assert.notEqual(waits[0].transitionId, waits[1].transitionId, "a genuine second entry is a new id");
      assert.equal(waits[2].transitionId, waits[1].transitionId, "a replay carries the committed row's id");
      assert.equal(waits[2].transitionId, second.transition.id);
      assert.notEqual(first.transition.id, second.transition.id);
    } finally {
      unregisterSourceNotifier("test");
    }
  });
});

// --- Review fixes (#305) ---

test("0023 applied after 0024/0025 (a database that ran the base branch first) succeeds with one FK", { skip }, async () => {
  const all = readdirSync(join(repoRoot, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const dir = mkdtempSync(join(tmpdir(), "windkeel-0024-first-"));
  for (const file of all.filter((f) => !f.startsWith("0023") && f < "0026")) {
    copyFileSync(join(repoRoot, "migrations", file), join(dir, file));
  }
  try {
    await withSchema(
      async (pool) => {
        const first = await pool.query("select filename from schema_migrations where filename like '0023%'");
        assert.equal(first.rowCount, 0, "0023 not applied yet");

        copyFileSync(
          join(repoRoot, "migrations", all.find((f) => f.startsWith("0023"))),
          join(dir, all.find((f) => f.startsWith("0023"))),
        );
        const { applied } = await runMigrations(pool, dir);
        assert.deepEqual(applied, [all.find((f) => f.startsWith("0023"))]);

        const { rows } = await pool.query(
          `select c.conname, c.confdeltype, r.relname as referenced
             from pg_constraint c
             join pg_class t on t.oid = c.conrelid
             join pg_namespace n on n.oid = t.relnamespace
             join pg_class r on r.oid = c.confrelid
             join pg_attribute a on a.attrelid = t.oid and a.attnum = any (c.conkey)
            where t.relname = 'engineering_task' and c.contype = 'f'
              and n.nspname = current_schema() and a.attname = 'created_by_principal_id'`,
        );
        assert.deepEqual(rows, [
          { conname: "engineering_task_created_by_principal_id_fkey", confdeltype: "n", referenced: "principal" },
        ]);
      },
      { migrationsDir: dir, seed: false },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an after-commit failure whose release also fails is logged with source, key and a stable tag", { skip }, async () => {
  await withSchema(async (pool) => {
    const organizationId = await defaultOrganization(pool);
    const source = fakeSource({ startRun: recordingEnqueuer({ failFirst: 1 }).startRun, organizationId });
    // Connections work (the delivery commits); the pool-level release query does not.
    const releaseFails = {
      connect: () => pool.connect(),
      query: async () => {
        throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P01" });
      },
    };
    const lines = [];
    const response = await runIntake(source, request({ id: "rel-1", kind: "create", ref: "LIN-REL" }), {
      pool: releaseFails,
      log: (message, fields) => lines.push({ message, ...fields }),
    });
    assert.equal(response.status, 500, "after-commit failure is a 500, not the transient status");
    const released = lines.find((l) => l.tag === RELEASE_FAILED_TAG);
    assert.ok(released, `a release-failed line was logged: ${JSON.stringify(lines)}`);
    assert.equal(released.source, "test");
    assert.equal(released.deliveryKey, "rel-1");
    assert.equal(released.errorCode, "57P01");
    assert.ok(!JSON.stringify(lines).includes("retries a 500"), "no payload in the log");
  });
});

test("a thrown error quoting tokens never reaches the response body or the log", { skip }, async () => {
  const leaky =
    "slack said invalid_auth for xoxb-1234-5678-abcdef; Authorization: Bearer sk-live-verysecret; " +
    "linear lin_api_0123456789abcdef; windkeel orq_0123456789abcdef; github ghs_abcdef0123456789";
  const secrets = ["xoxb-1234-5678-abcdef", "sk-live-verysecret", "lin_api_0123456789abcdef", "orq_0123456789abcdef", "ghs_abcdef0123456789"];
  const noLeak = (value, where) => {
    const text = JSON.stringify(value);
    for (const secret of secrets) assert.ok(!text.includes(secret), `${where} leaked ${secret}: ${text}`);
  };

  // Thrown from interpret (no database) …
  const lines = [];
  const throwing = {
    name: "test",
    verify: async () => ({ ok: true }),
    parse: () => ({}),
    deliveryKey: () => "leak-1",
    interpret: async () => {
      throw new Error(leaky);
    },
  };
  const fromInterpret = await runIntake(throwing, request({}), {
    pool: {},
    log: (message, fields) => lines.push({ message, ...fields }),
  });
  assert.equal(fromInterpret.status, 500);
  assert.deepEqual(fromInterpret.body, { ok: false, error: "internal error" });
  noLeak(fromInterpret.body, "body");
  assert.ok(lines.length > 0, "the failure is logged");
  assert.equal(lines[0].errorName, "Error");
  assert.ok(lines[0].error.includes("invalid_auth"), "the redacted message keeps its non-secret text");
  noLeak(lines, "log");

  // … and from act, inside the delivery's transaction.
  await withSchema(async (pool) => {
    const actLines = [];
    const acting = {
      ...throwing,
      deliveryKey: () => "leak-2",
      interpret: async () => ({
        kind: "act",
        intent: "create_task",
        act: async () => {
          throw new Error(leaky);
        },
      }),
    };
    const fromAct = await runIntake(acting, request({}), {
      pool,
      log: (message, fields) => actLines.push({ message, ...fields }),
    });
    assert.equal(fromAct.status, 500);
    assert.deepEqual(fromAct.body, { ok: false, error: "internal error" });
    noLeak(actLines, "log");
    assert.equal((await counts(pool)).deliveries, 0, "rolled back");
  });

  assert.equal(redactSecrets("token abc123 and basic dXNlcjpwYXNz"), "token [redacted] and basic [redacted]");
});

test("a hung notifier is bounded, and a step retry after the committed transition does not fail", { skip }, async () => {
  await withSchema(async (pool) => {
    const organizationId = await defaultOrganization(pool);
    let calls = 0;
    let aborted = 0;
    registerSourceNotifier({
      sourceType: "test",
      timeoutMs: 50,
      notify(_task, _run, _outcome, signal) {
        calls++;
        signal?.addEventListener("abort", () => aborted++);
        return new Promise(() => {}); // never settles
      },
    });
    try {
      const created = await createTaskFromIntake(
        pool,
        {
          organizationId,
          repositoryId: FIXTURE_REPOSITORY_ID,
          sourceType: "test",
          sourceReference: "HANG-1",
          title: "t",
          description: "- [ ] a",
        },
        { startRun: async () => ({ enqueued: true }) },
      );
      await advanceRun(pool, created.runId, "CLASSIFYING", "started");
      assert.equal(calls, 1, "leaving CREATED is notified (`started`), and bounded too");
      calls = 0;
      aborted = 0;

      const started = Date.now();
      const moved = await advanceRun(pool, created.runId, "CANCELLED", "operator cancelled");
      assert.ok(Date.now() - started < 5_000, "the notifier did not stall the step");
      assert.equal(moved.run.status, "CANCELLED");
      assert.equal(calls, 1);
      assert.equal(aborted, 1, "the notifier was told its time was up");

      // The workflow step is retried after its transition committed: the same call again.
      const replay = await advanceRun(pool, created.runId, "CANCELLED", "operator cancelled");
      assert.equal(replay.run.status, "CANCELLED");
      assert.equal(replay.transition.id, moved.transition.id, "the committed transition, not a new one");
      const { rows } = await pool.query(
        "select count(*)::int as n from run_state_transition where engineering_run_id = $1 and to_state = 'CANCELLED'",
        [created.runId],
      );
      assert.equal(rows[0].n, 1, "a replay writes nothing");
      assert.equal(calls, 2, "the retry re-notifies (notifiers are idempotent)");

      // A self-move that is not a replay is still illegal.
      await assert.rejects(
        () => advanceRun(pool, created.runId, "CANCELLED", "a different reason"),
        IllegalTransitionError,
      );
    } finally {
      unregisterSourceNotifier("test");
    }
  });
});

// --- /api/intake/:source: the raw body ---

function streamRequest(url, chunks, { headers = {}, fail } = {}) {
  const stream = fail
    ? new Readable({
        read() {
          this.destroy(new Error("socket hang up"));
        },
      })
    : Readable.from(chunks);
  return Object.assign(stream, { method: "POST", url, headers });
}

function capture() {
  const out = {};
  const res = {
    statusCode: 0,
    setHeader() {},
    end(body) {
      out.status = res.statusCode;
      out.body = JSON.parse(body);
    },
  };
  return { out, res };
}

test("the intake route answers 400 for a broken body stream and 413 past 1 MiB, before any database", async () => {
  const { default: intake, MAX_INTAKE_BODY_BYTES } = await import("../apps/ingress/dist/api/intake.js");
  assert.equal(MAX_INTAKE_BODY_BYTES, 1024 * 1024);
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL; // any attempt to reach a database would answer 500
  registerIntakeSource({
    name: "bodytest",
    verify: async () => ({ ok: false, error: "signature verification failed" }),
    parse: () => ({}),
    deliveryKey: () => "k",
    interpret: async () => ignore("x"),
  });
  try {
    const broken = capture();
    await intake(streamRequest("/api/intake/bodytest", [], { fail: true }), broken.res);
    assert.deepEqual(broken.out, { status: 400, body: { ok: false, error: "request body could not be read" } });

    const streamed = capture();
    const big = Buffer.alloc(64 * 1024, 0x61);
    const chunks = Array.from({ length: 17 }, () => big); // 1 MiB + 64 KiB, no content-length
    await intake(streamRequest("/api/intake/bodytest", chunks), streamed.res);
    assert.deepEqual(streamed.out, { status: 413, body: { ok: false, error: "request body too large" } });

    const declared = capture();
    await intake(
      streamRequest("/api/intake/bodytest", [Buffer.from("{}")], {
        headers: { "content-length": String(MAX_INTAKE_BODY_BYTES + 1) },
      }),
      declared.res,
    );
    assert.equal(declared.out.status, 413, "a declared oversize body is refused before reading");

    const exact = capture();
    await intake(streamRequest("/api/intake/bodytest", [Buffer.alloc(MAX_INTAKE_BODY_BYTES, 0x61)]), exact.res);
    assert.equal(exact.out.status, 500, "exactly 1 MiB is read; it then needs the (absent) database");
    assert.deepEqual(exact.out.body, { ok: false, error: "internal error" }, "no configuration detail echoed");
  } finally {
    unregisterIntakeSource("bodytest");
    if (previous !== undefined) process.env.DATABASE_URL = previous;
  }
});

// --- One source-name rule ---

test("the build script's intake route uses the pipeline's source-name pattern", async () => {
  const { readFileSync } = await import("node:fs");
  const script = readFileSync(join(repoRoot, "apps/ingress/build-vercel-output.mjs"), "utf8");
  const route = /const INTAKE_ROUTE_SOURCE = "([^"]+)";/.exec(script)?.[1];
  assert.ok(route, "INTAKE_ROUTE_SOURCE is declared");
  const inner = INTAKE_SOURCE_NAME_PATTERN.source.replace(/^\^/, "").replace(/\$$/, "");
  const target = INTAKE_TARGET_PATTERN.source.replace(/^\^/, "").replace(/\$$/, "");
  assert.equal(route, `^/api/intake/(${inner})(?:/(${target}))?/?$`);
  // The same paths the handler's own parser accepts, and no others.
  const pattern = new RegExp(route);
  assert.ok(pattern.test("/api/intake/slack"));
  assert.ok(pattern.test("/api/intake/webhook/0b4e3c1e-9a0f-4a4e-8d1f-7c2b5f0e6a11"));
  assert.ok(!pattern.test("/api/intake/webhook/a/b"));
  assert.ok(!pattern.test("/api/intake/Bad"));
});

// --- The sweep: intake retention in its own try ---

test("intake retention runs in its own try: a failing prune reports, never throws", async () => {
  const { pruneIntakeDeliveries } = await import("../apps/ingress/dist/api/sweep.js");
  const broken = {
    connect: async () => {
      throw new Error("connection refused");
    },
    query: async () => {
      throw new Error("connection refused");
    },
  };
  const outcome = await pruneIntakeDeliveries(broken);
  assert.equal(outcome.kind, "failed");
});
