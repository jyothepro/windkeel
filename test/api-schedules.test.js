/**
 * `/v1/schedules` (M8-4, #296): CRUD, permissions, 422s, `fire`, `preview`, and the CLI over the
 * real router. The enqueuer is a fake; nothing reaches a workflow.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { WindkeelApi } from "../packages/cli/dist/client/api.js";
import { capFlag, scheduleCommand } from "../packages/cli/dist/commands/schedule.js";
import { fireDueSchedules } from "../dist/schedules/tick.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const BOOTSTRAP = "test-bootstrap-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_REPO = "33333333-3333-3333-3333-333333333333";

let serial = 0;
async function withApi(fn) {
  const schema = `windkeel_api_schedules_test_${Date.now()}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, max: 6, idleTimeoutMillis: 1_000, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool, REPO_ID);
    await seedFixtureRepository(pool, OTHER_REPO);
    await pool.query("delete from repository_grant where repository_id = $1", [OTHER_REPO]);

    const enqueued = [];
    const deps = {
      pool,
      control: {
        enqueue: async (runId) => {
          enqueued.push(runId);
          // As `startRun` does: the binding is what marks the run as started.
          await pool.query(
            `insert into workflow_run_binding (engineering_run_id, provider, execution_handle)
             values ($1, 'fake', $2) on conflict do nothing`,
            [runId, `wrun_${runId}`],
          );
          return { enqueued: true };
        },
      },
    };
    const auth = { token: BOOTSTRAP, subject: "operator" };
    const call = (method, path, bearer = BOOTSTRAP, body, query = {}) =>
      handleApiRequest(deps, auth, {
        method,
        path,
        query: { get: (name) => query[name] },
        headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
        body,
      });
    await fn({ pool, deps, call, enqueued, auth });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

const NIGHTLY = {
  repositoryId: REPO_ID,
  name: "flaky-tests",
  cron: "0 3 * * *",
  timezone: "America/New_York",
  title: "Repair flaky tests ({{date}})",
  description: "Find and fix the flakiest test.\n\n- [ ] the suite passes 20 times in a row",
};

test("create, read, list, update, delete", { skip }, async () => {
  await withApi(async ({ call, pool }) => {
    assert.deepEqual((await call("GET", "/v1/schedules")).body.items, []);

    const created = await call("POST", "/v1/schedules", BOOTSTRAP, NIGHTLY);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const s = created.body.schedule;
    assert.equal(s.cron, "0 3 * * *");
    assert.equal(s.timezone, "America/New_York");
    assert.equal(s.enabled, true);
    assert.equal(s.riskLevel, "low");
    assert.equal(s.nextFireTimes.length, 3);
    // 03:00 in New York, a day apart.
    for (const t of s.nextFireTimes) assert.match(t, /T0[78]:00:00\.000Z$/);
    assert.equal(s.nextFireAt, s.nextFireTimes[0]);

    const operator = (await pool.query("select id from principal where is_bootstrap")).rows[0].id;
    const stored = (await pool.query("select created_by_principal_id from schedule where id = $1", [s.id])).rows[0];
    assert.equal(stored.created_by_principal_id, operator);

    const got = await call("GET", `/v1/schedules/${s.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.schedule.name, "flaky-tests");
    assert.equal((await call("GET", "/v1/schedules")).body.items.length, 1);

    const patched = await call("PATCH", `/v1/schedules/${s.id}`, BOOTSTRAP, { cron: "@weekly", timezone: "UTC", spendCapUsd: 5 });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.schedule.cron, "@weekly");
    assert.equal(patched.body.schedule.spendCapUsd, 5);
    assert.equal(patched.body.schedule.title, NIGHTLY.title);
    for (const t of patched.body.schedule.nextFireTimes) {
      assert.equal(new Date(t).getUTCDay(), 0);
      assert.match(t, /T00:00:00\.000Z$/);
    }

    const disabled = await call("PATCH", `/v1/schedules/${s.id}`, BOOTSTRAP, { enabled: false });
    assert.equal(disabled.body.schedule.enabled, false);
    assert.deepEqual(disabled.body.schedule.nextFireTimes, []);

    assert.equal((await call("DELETE", `/v1/schedules/${s.id}`)).status, 200);
    assert.equal((await call("DELETE", `/v1/schedules/${s.id}`)).status, 404);
    assert.equal((await call("GET", `/v1/schedules/${s.id}`)).status, 404);
    assert.equal((await call("GET", "/v1/schedules/not-a-uuid")).status, 404);
  });
});

test("an invalid cron, an unknown zone, or an ungranted repository is a 422 with a reason", { skip }, async () => {
  await withApi(async ({ call }) => {
    const badCron = await call("POST", "/v1/schedules", BOOTSTRAP, { ...NIGHTLY, cron: "61 * * * *" });
    assert.equal(badCron.status, 422);
    assert.equal(badCron.body.code, "invalid_cron");
    assert.match(badCron.body.error, /out of range/);

    const never = await call("POST", "/v1/schedules", BOOTSTRAP, { ...NIGHTLY, cron: "0 0 31 4 *" });
    assert.equal(never.status, 422);
    assert.match(never.body.error, /never fires/);

    const badZone = await call("POST", "/v1/schedules", BOOTSTRAP, { ...NIGHTLY, timezone: "Mars/Olympus" });
    assert.equal(badZone.status, 422);
    assert.equal(badZone.body.code, "invalid_timezone");

    const ungranted = await call("POST", "/v1/schedules", BOOTSTRAP, { ...NIGHTLY, repositoryId: OTHER_REPO });
    assert.equal(ungranted.status, 422);
    assert.equal(ungranted.body.code, "repository_not_granted");

    const missing = await call("POST", "/v1/schedules", BOOTSTRAP, { name: "x" });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, "missing_field");

    const risky = await call("POST", "/v1/schedules", BOOTSTRAP, { ...NIGHTLY, riskLevel: "extreme" });
    assert.equal(risky.status, 400);

    const s = (await call("POST", "/v1/schedules", BOOTSTRAP, NIGHTLY)).body.schedule;
    const badPatch = await call("PATCH", `/v1/schedules/${s.id}`, BOOTSTRAP, { cron: "* * *" });
    assert.equal(badPatch.status, 422);
    assert.equal(badPatch.body.code, "invalid_cron");
  });
});

test("writes need schedules.manage; reads need runs.read", { skip }, async () => {
  await withApi(async ({ call }) => {
    const narrow = (await call("POST", "/v1/tokens", BOOTSTRAP, { name: "ci", preset: "execute" })).body.secret;
    assert.equal((await call("GET", "/v1/schedules", narrow)).status, 200);
    const refused = await call("POST", "/v1/schedules", narrow, NIGHTLY);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.missing, "schedules.manage");

    const s = (await call("POST", "/v1/schedules", BOOTSTRAP, NIGHTLY)).body.schedule;
    assert.equal((await call("GET", `/v1/schedules/${s.id}`, narrow)).status, 200);
    for (const [method, path] of [
      ["PATCH", `/v1/schedules/${s.id}`],
      ["DELETE", `/v1/schedules/${s.id}`],
      ["POST", `/v1/schedules/${s.id}/fire`],
    ]) {
      const answer = await call(method, path, narrow, { enabled: false });
      assert.equal(answer.status, 403, `${method} ${path}`);
      assert.equal(answer.body.missing, "schedules.manage");
    }

    const admin = (await call("POST", "/v1/tokens", BOOTSTRAP, { name: "admin", preset: "admin" })).body;
    assert.equal((await call("PATCH", `/v1/schedules/${s.id}`, admin.secret, { enabled: false })).status, 200);
    assert.equal((await call("GET", "/v1/schedules", null)).status, 401);
  });
});

test("fire creates one task now, as the system actor, and refuses while that run is in flight", { skip }, async () => {
  await withApi(async ({ call, pool, enqueued }) => {
    const s = (await call("POST", "/v1/schedules", BOOTSTRAP, NIGHTLY)).body.schedule;
    const fired = await call("POST", `/v1/schedules/${s.id}/fire`);
    assert.equal(fired.status, 202, JSON.stringify(fired.body));
    assert.equal(fired.body.accepted, true);
    assert.equal(fired.body.enqueued, true);
    assert.deepEqual(enqueued, [fired.body.engineeringRunId]);

    const task = (await pool.query("select * from engineering_task where id = $1", [fired.body.taskId])).rows[0];
    assert.equal(task.source_type, "schedule");
    assert.match(task.source_reference, new RegExp(`^schedule:${s.id}:manual:`));
    assert.match(task.title, /^Repair flaky tests \(\d{4}-\d{2}-\d{2}\)$/);
    const actor = (await pool.query("select system_purpose from principal where id = $1", [task.created_by_principal_id])).rows[0];
    assert.equal(actor.system_purpose, "schedules");

    const delivery = (await pool.query("select * from intake_delivery where engineering_task_id = $1", [task.id])).rows[0];
    assert.equal(delivery.source, "schedule");
    assert.equal(delivery.action, "manual");

    // Fire does not move the cron's own slot.
    const after = (await call("GET", `/v1/schedules/${s.id}`)).body.schedule;
    assert.equal(after.nextFireAt, s.nextFireAt);

    const again = await call("POST", `/v1/schedules/${s.id}/fire`);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "run_in_flight");

    assert.equal((await call("POST", "/v1/schedules/00000000-0000-0000-0000-000000000000/fire")).status, 404);
  });
});

test("preview reads a cron in a zone without storing anything", { skip }, async () => {
  await withApi(async ({ call }) => {
    const preview = await call("GET", "/v1/schedules/preview", BOOTSTRAP, undefined, { cron: "@daily", timezone: "Europe/London" });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.nextFireTimes.length, 5);
    const bad = await call("GET", "/v1/schedules/preview", BOOTSTRAP, undefined, { cron: "nope" });
    assert.equal(bad.status, 422);
    assert.equal((await call("GET", "/v1/schedules/preview")).status, 400);
  });
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

test("windkeel schedule create @weekly shows its next fire times, and each slot makes exactly one task", { skip }, async () => {
  await withApi(async ({ deps, auth, pool }) => {
    const api = new WindkeelApi({ baseUrl: "https://windkeel.test", token: BOOTSTRAP, fetch: fetchInto(deps, auth) });
    const lines = [];
    const io = { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) };

    const code = await scheduleCommand(api, io, {
      kind: "create",
      input: {
        repositoryId: REPO_ID,
        name: "deps",
        cron: "@weekly",
        title: "Dependency upgrades {{date}}",
        description: "- [ ] npm outdated reports nothing",
      },
    });
    assert.equal(code, 0, lines.join("\n"));
    const nextLine = lines.join("\n").split("\n").find((l) => l.includes("next:"));
    const times = nextLine.replace(/^\s*next: /, "").split(", ");
    assert.equal(times.length, 3);
    for (let i = 0; i < times.length; i++) {
      const d = new Date(times[i]);
      assert.equal(d.getUTCDay(), 0, "Sunday");
      assert.equal(d.toISOString().slice(11), "00:00:00.000Z");
      if (i > 0) assert.equal(d - new Date(times[i - 1]), 7 * 86_400_000);
    }

    // Tick through each of the three slots twice over; one task per slot.
    const q = { startRun: async () => ({ enqueued: true }) };
    for (const t of times) {
      for (const offset of [60_000, 5 * 60_000]) {
        await pool.query("update engineering_run set status = 'COMPLETED'");
        await fireDueSchedules(pool, new Date(new Date(t).getTime() + offset), q);
      }
    }
    const refs = (await pool.query("select source_reference from engineering_task where source_type = 'schedule' order by created_at")).rows;
    assert.deepEqual(refs.map((r) => r.source_reference.split(":").slice(2).join(":")), times);

    lines.length = 0;
    assert.equal(await scheduleCommand(api, io, { kind: "preview", cron: "0 9 * * mon-fri", timezone: "Europe/London" }), 0);
    assert.equal(lines.length, 6);
    assert.match(lines[0], /Europe\/London/);
  });
});

// --- tech-lead review on #309 ---------------------------------------------------------------

/** Must-fix 3: two fires at once serialise on the schedule row — one task, one 409. */
test("two concurrent fires make one task: one 202 and one 409", { skip }, async () => {
  await withApi(async ({ call, pool }) => {
    for (let i = 0; i < 3; i++) {
      const s = (await call("POST", "/v1/schedules", BOOTSTRAP, { ...NIGHTLY, name: `race-${i}` })).body.schedule;
      const answers = await Promise.all([
        call("POST", `/v1/schedules/${s.id}/fire`),
        call("POST", `/v1/schedules/${s.id}/fire`),
      ]);
      assert.deepEqual(answers.map((a) => a.status).sort(), [202, 409], JSON.stringify(answers.map((a) => a.body)));
      const made = await pool.query(
        "select count(*) from engineering_task where starts_with(source_reference, $1)",
        [`schedule:${s.id}:`],
      );
      assert.equal(Number(made.rows[0].count), 1);
    }
  });
});

/** Should-fix: a malformed id is a 404 on every route, never a uuid cast error surfacing as a 500. */
test("a malformed schedule id is a 404, not a 500", { skip }, async () => {
  await withApi(async ({ call }) => {
    for (const id of ["-".repeat(36), "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz", "not-a-uuid"]) {
      for (const [method, path, body] of [
        ["GET", `/v1/schedules/${id}`],
        ["PATCH", `/v1/schedules/${id}`, { name: "x" }],
        ["DELETE", `/v1/schedules/${id}`],
        ["POST", `/v1/schedules/${id}/fire`],
      ]) {
        assert.equal((await call(method, path, BOOTSTRAP, body)).status, 404, `${method} ${path}`);
      }
    }
  });
});

/** Should-fix: the list pages like `/v1/tasks`, and a cap can be cleared. */
test("the schedule list is paginated, and a cap can be cleared with null", { skip }, async () => {
  await withApi(async ({ call }) => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await call("POST", "/v1/schedules", BOOTSTRAP, { ...NIGHTLY, name: `p${i}`, spendCapUsd: 5 })).body.schedule.id);
    }
    const first = await call("GET", "/v1/schedules", BOOTSTRAP, undefined, { limit: "2" });
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 2);
    assert.equal(first.body.hasNextPage, true);
    const second = await call("GET", "/v1/schedules", BOOTSTRAP, undefined, { limit: "2", cursor: first.body.endCursor });
    assert.equal(second.body.items.length, 1);
    assert.equal(second.body.hasNextPage, false);
    assert.deepEqual(
      [...first.body.items, ...second.body.items].map((s) => s.id).sort(),
      [...ids].sort(),
    );
    assert.equal((await call("GET", "/v1/schedules", BOOTSTRAP, undefined, { cursor: "garbage" })).status, 400);

    const cleared = await call("PATCH", `/v1/schedules/${ids[0]}`, BOOTSTRAP, { spendCapUsd: null });
    assert.equal(cleared.body.schedule.spendCapUsd, null);
    assert.equal(capFlag("none"), null);
    assert.equal(capFlag("NONE"), null);
    assert.equal(capFlag("7.5"), 7.5);
    assert.equal(capFlag(undefined), undefined);
  });
});

/** Should-fix: a rename leaves `next_fire_at` alone; only cron/zone/enable re-slot. */
test("an update that does not touch the cron, zone or enabled leaves next_fire_at alone", { skip }, async () => {
  await withApi(async ({ call, pool }) => {
    const s = (await call("POST", "/v1/schedules", BOOTSTRAP, NIGHTLY)).body.schedule;
    // As if a tick advanced it after the API read it.
    await pool.query("update schedule set next_fire_at = '2030-01-01T08:00:00Z' where id = $1", [s.id]);
    const renamed = await call("PATCH", `/v1/schedules/${s.id}`, BOOTSTRAP, { name: "renamed", cron: NIGHTLY.cron });
    assert.equal(renamed.body.schedule.name, "renamed");
    assert.equal(renamed.body.schedule.nextFireAt, "2030-01-01T08:00:00.000Z");
  });
});

/**
 * Must-fix 4: the tick route answers a fixed body and logs through the shared redaction — even
 * when the failure is its configuration, which used to be read outside the try.
 */
test("the tick route's failure is a fixed 500 body, never the error's message", async () => {
  const { default: handler, TICK_FAILED_BODY } = await import("../apps/ingress/dist/api/schedules.js");
  const saved = { ...process.env };
  const written = [];
  const write = process.stdout.write;
  try {
    process.env.CRON_SECRET = "the-cron-secret";
    delete process.env.DATABASE_URL;
    process.stdout.write = (chunk, ...rest) => {
      written.push(String(chunk));
      return true;
    };
    const out = {};
    const res = {
      status(code) {
        out.code = code;
        return res;
      },
      json(body) {
        out.body = body;
      },
    };
    await handler({ headers: { authorization: "Bearer the-cron-secret" } }, res);
    process.stdout.write = write;
    assert.equal(out.code, 500);
    assert.deepEqual(out.body, { ok: false, error: "schedule tick failed" });
    assert.deepEqual(out.body, { ...TICK_FAILED_BODY });
    const line = written.map((l) => JSON.parse(l)).find((l) => l.message === "schedule tick failed");
    assert.ok(line, "the failure is logged");
    assert.equal(typeof line.errorName, "string");
    assert.match(line.error, /DATABASE_URL/);
  } finally {
    process.stdout.write = write;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
