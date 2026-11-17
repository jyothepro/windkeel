/**
 * The schedule tick (M8-4, #296) against real Postgres, with a fake clock and a fake enqueuer.
 * Every slot must become at most one task, recorded once in `intake_delivery`.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../dist/factory/migrate.js";
import { createSchedule } from "../dist/schedules/store.js";
import {
  fireDueSchedules,
  MAX_COALESCED_PER_TICK,
  MAX_SLOT_ATTEMPTS,
  SLOT_ABANDONED_TAG,
  slotKey,
} from "../dist/schedules/tick.js";
import { repoRoot, seedFixtureRepository } from "./helpers.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const REPO_ID = "11111111-1111-1111-1111-111111111111";

let serial = 0;
async function withSchema(fn) {
  const schema = `windkeel_schedules_tick_test_${Date.now()}_${serial++}`;
  const setup = new Pool({ connectionString: dbUrl, max: 1 });
  await setup.query(`create schema ${schema}`);
  await setup.end();
  // Lock + claimed rows + one intake transaction at a time, and a spare for the second tick.
  const pool = new Pool({ connectionString: dbUrl, max: 8, idleTimeoutMillis: 1_000, options: `-c search_path=${schema}` });
  try {
    await runMigrations(pool, join(repoRoot, "migrations"));
    await seedFixtureRepository(pool, REPO_ID);
    const org = (await pool.query("select id from organization where is_default")).rows[0].id;
    const operator = (await pool.query("select id from principal where is_bootstrap")).rows[0].id;
    await fn({ pool, org, operator });
  } finally {
    await pool.end();
    const teardown = new Pool({ connectionString: dbUrl, max: 1 });
    await teardown.query(`drop schema ${schema} cascade`);
    await teardown.end();
  }
}

/**
 * Records each enqueue and, like `VercelWorkflowProvider.startRun`, writes the run's
 * `workflow_run_binding` — which is what tells an in-flight run from one whose enqueue failed.
 * `onStart` runs first, to observe what the tick holds while it enqueues.
 */
function fakeEnqueuer(pool) {
  const fake = {
    started: [],
    fail: false,
    onStart: null,
    // A closure, not `this`: the tick passes the function on unbound.
    startRun: async (runId) => {
      if (fake.onStart) await fake.onStart(runId);
      if (fake.fail) throw new Error("queue unavailable");
      fake.started.push(runId);
      await pool.query(
        `insert into workflow_run_binding (engineering_run_id, provider, execution_handle)
         values ($1, 'fake', $2) on conflict do nothing`,
        [runId, `wrun_${runId}`],
      );
      return { enqueued: true };
    },
  };
  return fake;
}

const at = (s) => new Date(s);

async function hourly(pool, org, operator, overrides = {}) {
  return createSchedule(
    pool,
    org,
    {
      repositoryId: REPO_ID,
      name: "deps",
      cron: "0 * * * *",
      timezone: "UTC",
      title: "Dependency upgrades {{date}}",
      description: "Upgrade {{schedule}} for {{date}}.\n\n- [ ] npm outdated reports nothing",
      ...overrides,
    },
    operator,
    at("2026-09-25T09:30:00Z"),
  );
}

async function tasks(pool) {
  return (await pool.query("select * from engineering_task where source_type = 'schedule' order by created_at")).rows;
}

async function deliveries(pool) {
  return (await pool.query("select * from intake_delivery where source = 'schedule' order by delivery_key")).rows;
}

test("a due schedule becomes one task and one delivery, as the system actor", { skip }, async () => {
  await withSchema(async ({ pool, org, operator }) => {
    const schedule = await hourly(pool, org, operator);
    assert.equal(schedule.nextFireAt.toISOString(), "2026-09-25T10:00:00.000Z");
    const q = fakeEnqueuer(pool);

    // Not yet due: nothing.
    const early = await fireDueSchedules(pool, at("2026-09-25T09:59:00Z"), q);
    assert.deepEqual(early, { kind: "ran", result: { fired: [], stoppedEarly: null } });

    const tick = await fireDueSchedules(pool, at("2026-09-25T10:02:00Z"), q);
    assert.equal(tick.kind, "ran");
    assert.equal(tick.result.fired.length, 1);
    assert.equal(tick.result.fired[0].outcome.kind, "created");

    const [task] = await tasks(pool);
    assert.equal(task.source_reference, slotKey(schedule.id, "2026-09-25T10:00:00.000Z"));
    assert.equal(task.title, "Dependency upgrades 2026-09-25");
    assert.match(task.description, /Upgrade deps for 2026-09-25/);
    assert.equal(task.organization_id, org);

    // The creator is the organization's schedules system actor, not the person who wrote it.
    assert.notEqual(task.created_by_principal_id, operator);
    const actor = (await pool.query("select * from principal where id = $1", [task.created_by_principal_id])).rows[0];
    assert.equal(actor.system_purpose, "schedules");
    assert.equal(actor.organization_id, org);

    const [delivery] = await deliveries(pool);
    assert.equal(delivery.delivery_key, task.source_reference);
    assert.equal(delivery.intent, "create_task");
    assert.equal(delivery.engineering_task_id, task.id);
    assert.equal(q.started.length, 1);

    const row = (await pool.query("select * from schedule where id = $1", [schedule.id])).rows[0];
    assert.equal(row.next_fire_at.toISOString(), "2026-09-25T11:00:00.000Z");
    assert.equal(row.last_fired_at.toISOString(), "2026-09-25T10:00:00.000Z");
    assert.equal(row.last_outcome, "created");

    // The same instant again: nothing more is due.
    await fireDueSchedules(pool, at("2026-09-25T10:03:00Z"), q);
    assert.equal((await tasks(pool)).length, 1);
  });
});

test("two concurrent ticks still make one task", { skip }, async () => {
  await withSchema(async ({ pool, org, operator }) => {
    await hourly(pool, org, operator);
    const q = fakeEnqueuer(pool);
    const now = at("2026-09-25T10:01:00Z");
    const results = await Promise.all([fireDueSchedules(pool, now, q), fireDueSchedules(pool, now, q)]);
    const fired = results.flatMap((r) => (r.kind === "ran" ? r.result.fired : []));
    assert.equal(fired.filter((f) => f.outcome.kind === "created").length, 1);
    assert.equal((await tasks(pool)).length, 1);
    assert.equal((await deliveries(pool)).length, 1);
    assert.equal(q.started.length, 1);
  });
});

test("three missed slots after downtime: one task for the latest, two coalesced ignores", { skip }, async () => {
  await withSchema(async ({ pool, org, operator }) => {
    const schedule = await hourly(pool, org, operator);
    const q = fakeEnqueuer(pool);
    // Slots 10:00, 11:00, 12:00 all missed; the tick arrives at 12:20.
    const tick = await fireDueSchedules(pool, at("2026-09-25T12:20:00Z"), q);
    assert.equal(tick.result.fired[0].coalesced, 2);
    assert.equal(tick.result.fired[0].slot, "2026-09-25T12:00:00.000Z");

    const all = await tasks(pool);
    assert.equal(all.length, 1);
    assert.equal(all[0].source_reference, slotKey(schedule.id, "2026-09-25T12:00:00.000Z"));

    const ledger = await deliveries(pool);
    assert.deepEqual(
      ledger.map((d) => [d.delivery_key, d.intent, d.reason]),
      [
        [slotKey(schedule.id, "2026-09-25T10:00:00.000Z"), "ignore", "coalesced"],
        [slotKey(schedule.id, "2026-09-25T11:00:00.000Z"), "ignore", "coalesced"],
        [slotKey(schedule.id, "2026-09-25T12:00:00.000Z"), "create_task", null],
      ],
    );
    const row = (await pool.query("select next_fire_at from schedule where id = $1", [schedule.id])).rows[0];
    assert.equal(row.next_fire_at.toISOString(), "2026-09-25T13:00:00.000Z");
  });
});

test("a previous run still in flight: the slot is ignored with a reason, and the schedule advances", { skip }, async () => {
  await withSchema(async ({ pool, org, operator }) => {
    const schedule = await hourly(pool, org, operator);
    const q = fakeEnqueuer(pool);
    await fireDueSchedules(pool, at("2026-09-25T10:01:00Z"), q);
    // The 10:00 task's run is still CREATED (non-terminal) at 11:00.
    const second = await fireDueSchedules(pool, at("2026-09-25T11:01:00Z"), q);
    assert.deepEqual(second.result.fired[0].outcome, { kind: "ignored", reason: "previous_run_in_flight" });
    assert.equal((await tasks(pool)).length, 1);
    const eleven = (await deliveries(pool)).find((d) => d.delivery_key === slotKey(schedule.id, "2026-09-25T11:00:00.000Z"));
    assert.equal(eleven.intent, "ignore");
    assert.equal(eleven.reason, "previous_run_in_flight");
    let row = (await pool.query("select * from schedule where id = $1", [schedule.id])).rows[0];
    assert.equal(row.next_fire_at.toISOString(), "2026-09-25T12:00:00.000Z");
    assert.equal(row.last_outcome, "ignored:previous_run_in_flight");

    // Once that run ends, the next slot fires.
    await pool.query("update engineering_run set status = 'COMPLETED'");
    const third = await fireDueSchedules(pool, at("2026-09-25T12:01:00Z"), q);
    assert.equal(third.result.fired[0].outcome.kind, "created");
    assert.equal((await tasks(pool)).length, 2);
    row = (await pool.query("select * from schedule where id = $1", [schedule.id])).rows[0];
    assert.equal(row.last_fired_at.toISOString(), "2026-09-25T12:00:00.000Z");
  });
});

test("a disabled schedule does nothing", { skip }, async () => {
  await withSchema(async ({ pool, org, operator }) => {
    await hourly(pool, org, operator, { enabled: false });
    const q = fakeEnqueuer(pool);
    const tick = await fireDueSchedules(pool, at("2026-09-26T10:01:00Z"), q);
    assert.deepEqual(tick.result.fired, []);
    assert.equal((await tasks(pool)).length, 0);
    assert.equal((await deliveries(pool)).length, 0);
  });
});

test("an enqueue failure keeps the slot due, and the next tick finishes it without a second task", { skip }, async () => {
  await withSchema(async ({ pool, org, operator }) => {
    const schedule = await hourly(pool, org, operator);
    const q = fakeEnqueuer(pool);
    q.fail = true;
    const failed = await fireDueSchedules(pool, at("2026-09-25T10:01:00Z"), q);
    assert.equal(failed.result.fired[0].outcome.kind, "failed");
    let row = (await pool.query("select * from schedule where id = $1", [schedule.id])).rows[0];
    assert.equal(row.next_fire_at.toISOString(), "2026-09-25T10:00:00.000Z");
    assert.equal((await deliveries(pool)).length, 0, "the delivery row is released so the retry can finish");

    q.fail = false;
    const healed = await fireDueSchedules(pool, at("2026-09-25T10:06:00Z"), q);
    assert.equal(healed.result.fired[0].outcome.kind, "existing");
    assert.equal((await tasks(pool)).length, 1);
    assert.equal(q.started.length, 1);
    row = (await pool.query("select * from schedule where id = $1", [schedule.id])).rows[0];
    assert.equal(row.next_fire_at.toISOString(), "2026-09-25T11:00:00.000Z");
  });
});

test("a repository whose grant was removed is ignored with a reason, not retried forever", { skip }, async () => {
  await withSchema(async ({ pool, org, operator }) => {
    await hourly(pool, org, operator);
    await pool.query("delete from repository_grant where repository_id = $1", [REPO_ID]);
    const tick = await fireDueSchedules(pool, at("2026-09-25T10:01:00Z"), fakeEnqueuer(pool));
    assert.deepEqual(tick.result.fired[0].outcome, { kind: "ignored", reason: "repository_not_granted" });
    assert.equal((await tasks(pool)).length, 0);
  });
});

test("@weekly produces exactly one task per slot across several weeks of ticks", { skip }, async () => {
  await withSchema(async ({ pool, org, operator }) => {
    await hourly(pool, org, operator, { cron: "@weekly", timezone: "Europe/London" });
    const q = fakeEnqueuer(pool);
    // Tick every 5 minutes... sampled: every 6 hours for 3 weeks is enough to cross 3 slots.
    for (let t = at("2026-09-25T10:00:00Z").getTime(); t < at("2026-10-16T00:00:00Z").getTime(); t += 6 * 3_600_000) {
      await pool.query("update engineering_run set status = 'COMPLETED'");
      await fireDueSchedules(pool, new Date(t), q);
    }
    const refs = (await tasks(pool)).map((t) => t.source_reference.split(":").slice(2).join(":"));
    // Sunday midnight in London (BST until 25 Oct) is 23:00Z on Saturday.
    assert.deepEqual(refs, ["2026-09-26T23:00:00.000Z", "2026-10-03T23:00:00.000Z", "2026-10-10T23:00:00.000Z"]);
  });
});

// --- tech-lead review on #309 ---------------------------------------------------------------

/**
 * Must-fix 1. The enqueue for 10:00 fails and the slot stays due; by the next tick 11:00 has
 * passed, so 10:00 is coalesced and its task's run is `CREATED` with no binding — never started.
 * Waiting on it as "in flight" would stall the schedule for good; it is re-enqueued instead.
 */
test("a failed enqueue, then a newer slot: the stranded run is re-enqueued and the schedule moves on", { skip }, async () => {
  await withSchema(async ({ pool, org, operator }) => {
    const schedule = await hourly(pool, org, operator);
    const q = fakeEnqueuer(pool);
    q.fail = true;
    await fireDueSchedules(pool, at("2026-09-25T10:01:00Z"), q);
    const [stranded] = await tasks(pool);
    const strandedRun = (await pool.query("select id, status from engineering_run where task_id = $1", [stranded.id])).rows[0];
    assert.equal(strandedRun.status, "CREATED");

    // The queue is back; 11:00 has passed.
    q.fail = false;
    const next = await fireDueSchedules(pool, at("2026-09-25T11:02:00Z"), q);
    const fired = next.result.fired[0];
    assert.equal(fired.coalesced, 1);
    assert.deepEqual(fired.outcome, { kind: "ignored", reason: "previous_run_requeued" });
    assert.deepEqual(q.started, [strandedRun.id], "the stranded run was handed to the workflow");
    const eleven = (await deliveries(pool)).find((d) => d.delivery_key === slotKey(schedule.id, "2026-09-25T11:00:00.000Z"));
    assert.deepEqual([eleven.intent, eleven.reason], ["ignore", "previous_run_requeued"]);
    let row = (await pool.query("select * from schedule where id = $1", [schedule.id])).rows[0];
    assert.equal(row.next_fire_at.toISOString(), "2026-09-25T12:00:00.000Z");

    // Now it is genuinely in flight (it has a binding): the next slot waits on it, as it should.
    const waiting = await fireDueSchedules(pool, at("2026-09-25T12:01:00Z"), q);
    assert.deepEqual(waiting.result.fired[0].outcome, { kind: "ignored", reason: "previous_run_in_flight" });

    // And once it ends, the schedule fires again.
    await pool.query("update engineering_run set status = 'COMPLETED'");
    const resumed = await fireDueSchedules(pool, at("2026-09-25T13:01:00Z"), q);
    assert.equal(resumed.result.fired[0].outcome.kind, "created");
    assert.equal((await tasks(pool)).length, 2);
    row = (await pool.query("select * from schedule where id = $1", [schedule.id])).rows[0];
    assert.equal(row.next_fire_at.toISOString(), "2026-09-25T14:00:00.000Z");
  });
});

/**
 * Must-fix 2. Twelve minutely schedules and a day's outage need 1,200 coalesced rows: one tick
 * writes at most `MAX_COALESCED_PER_TICK`, stops claiming, leaves the rest due, and the following
 * ticks finish the job — each schedule firing exactly once.
 */
test("many schedules after a long outage: bounded per tick, and progress across ticks", { skip }, async () => {
  await withSchema(async ({ pool, org, operator }) => {
    const count = 12;
    for (let i = 0; i < count; i++) await hourly(pool, org, operator, { name: `m${i}`, cron: "* * * * *" });
    const q = fakeEnqueuer(pool);
    const now = at("2026-09-26T09:30:00Z");
    const coalescedRows = async () =>
      Number((await pool.query("select count(*) from intake_delivery where reason = 'coalesced'")).rows[0].count);
    const due = async () =>
      Number((await pool.query("select count(*) from schedule where next_fire_at <= $1", [now])).rows[0].count);

    const started = Date.now();
    const first = await fireDueSchedules(pool, now, q);
    assert.ok(Date.now() - started < 40_000, "one tick finishes inside the budget");
    assert.equal(first.result.stoppedEarly, "coalesced_budget");
    assert.ok(first.result.fired.length < count, "the tick stopped claiming");
    assert.ok((await coalescedRows()) <= MAX_COALESCED_PER_TICK);
    assert.equal(await due(), count - first.result.fired.length, "the rest stay due");

    let ticks = 1;
    while ((await due()) > 0) {
      const before = await due();
      const tick = await fireDueSchedules(pool, now, q);
      assert.ok(tick.result.fired.length > 0 && (await due()) < before, "each tick makes progress");
      ticks++;
      assert.ok(ticks < 10);
    }
    assert.equal(await coalescedRows(), count * 100, "every schedule's coalesced slots, capped per schedule");
    assert.equal((await tasks(pool)).length, count, "one task per schedule, for its latest slot");
  });
});

test("the time budget stops claiming and leaves the rest due", { skip }, async () => {
  await withSchema(async ({ pool, org, operator }) => {
    for (let i = 0; i < 5; i++) await hourly(pool, org, operator, { name: `h${i}` });
    const q = fakeEnqueuer(pool);
    // Every read of this clock is 15 s later: two schedules fit in 40 s, then it is out of time.
    let t = 0;
    const tick = await fireDueSchedules(pool, at("2026-09-25T10:01:00Z"), { ...q, clock: () => (t += 15_000) });
    assert.equal(tick.result.stoppedEarly, "time_budget");
    assert.equal(tick.result.fired.length, 2);
    const due = (await pool.query("select count(*) from schedule where next_fire_at <= $1", [at("2026-09-25T10:01:00Z")])).rows[0];
    assert.equal(Number(due.count), 3);
  });
});

test("no schedule row is locked while a run is being enqueued", { skip }, async () => {
  await withSchema(async ({ pool, org, operator }) => {
    await hourly(pool, org, operator, { name: "a" });
    await hourly(pool, org, operator, { name: "b" });
    const q = fakeEnqueuer(pool);
    const probes = [];
    q.onStart = async () => {
      // `nowait` fails at once if anything — the tick included — holds a schedule row.
      try {
        await pool.query("select id from schedule for update nowait");
        probes.push("free");
      } catch (error) {
        probes.push(error.code);
      }
    };
    await fireDueSchedules(pool, at("2026-09-25T10:01:00Z"), q);
    assert.deepEqual(probes, ["free", "free"]);
  });
});

/** Should-fix: a slot that keeps failing is abandoned after a bounded number of attempts. */
test("a permanently failing slot is abandoned after MAX_SLOT_ATTEMPTS, loudly, and the schedule advances", { skip }, async () => {
  await withSchema(async ({ pool, org, operator }) => {
    const schedule = await hourly(pool, org, operator);
    const logs = [];
    const q = {
      startRun: async () => {
        throw new Error("queue unavailable");
      },
      log: (message, fields) => logs.push({ message, ...fields }),
    };
    const row = async () => (await pool.query("select * from schedule where id = $1", [schedule.id])).rows[0];
    for (let i = 1; i < MAX_SLOT_ATTEMPTS; i++) {
      await fireDueSchedules(pool, new Date(at("2026-09-25T10:01:00Z").getTime() + i * 300_000), q);
      assert.equal((await row()).next_fire_at.toISOString(), "2026-09-25T10:00:00.000Z", `attempt ${i} retries`);
      assert.equal((await row()).consecutive_failures, i);
    }
    await fireDueSchedules(pool, at("2026-09-25T10:40:00Z"), q);
    const after = await row();
    assert.equal(after.next_fire_at.toISOString(), "2026-09-25T11:00:00.000Z");
    assert.equal(after.last_outcome, "failed:500");
    assert.equal(after.consecutive_failures, 0);
    assert.ok(logs.some((l) => l.tag === SLOT_ABANDONED_TAG && l.scheduleId === schedule.id));
  });
});

/** Must-fix 4 (the tick's catch): a thrown error is logged through the shared redaction. */
test("a schedule that throws is logged through describeError and does not stop the others", { skip }, async () => {
  await withSchema(async ({ pool, org, operator }) => {
    const broken = await hourly(pool, org, operator, { name: "broken" });
    await hourly(pool, org, operator, { name: "fine" });
    // Written behind validation's back; the parse error quotes it, credential and all.
    await pool.query("update schedule set cron = '@orq_leakedsecret' where id = $1", [broken.id]);
    const logs = [];
    const q = { ...fakeEnqueuer(pool), log: (message, fields) => logs.push({ message, ...fields }) };
    const tick = await fireDueSchedules(pool, at("2026-09-25T10:01:00Z"), q);
    assert.equal(tick.result.fired.length, 2);
    const line = logs.find((l) => l.message === "schedule tick failed");
    assert.ok(line, "the failure is logged");
    assert.equal(line.scheduleId, broken.id);
    assert.equal(line.errorName, "CronError");
    assert.doesNotMatch(JSON.stringify(logs), /orq_leakedsecret/);
    assert.equal((await tasks(pool)).length, 1, "the other schedule still fired");
  });
});
