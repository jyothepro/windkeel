import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { AGENT_EVENT_TEXT_LIMIT, recordAgentEvents } from "../dist/factory/agent-events.js";
import { recordCost } from "../dist/factory/cost-ledger.js";
import { insertAgentRun, insertEngineeringRun, insertEngineeringTask, listEngineeringRuns } from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { FEED_START, InvalidCursorError, listRunEvents } from "../dist/factory/run-events.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

async function withRun(fn) {
  const schema = `windkeel_run_feed_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "github_issue",
      sourceReference: "1",
      title: "t",
      description: "d",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: 25,
      wallClockCapSeconds: 7200,
    });
    await fn(pool, run, task);
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

test("the feed interleaves transitions and cost in the order they happened", { skip }, async () => {
  await withRun(async (pool, run) => {
    await advanceRun(pool, run.id, "CLASSIFYING");
    await recordCost(pool, {
      engineeringRunId: run.id,
      stageType: "agent_run",
      stageId: "22222222-2222-2222-2222-222222222222",
      kind: "model",
      usd: 0.01,
      tokensIn: 10,
      tokensOut: 20,
    });
    await advanceRun(pool, run.id, "PLANNING");

    const page = await listRunEvents(pool, run.id);
    assert.deepEqual(
      page.items.map((e) => e.kind),
      ["transition", "cost", "transition"],
      "a cost event written between two transitions must sort between them, not after both",
    );
    assert.equal(page.items[0].to, "CLASSIFYING");
    assert.equal(page.items[1].usd, 0.01);
    assert.equal(page.items[2].to, "PLANNING");
    assert.equal(page.hasNextPage, false);
  });
});

test("a cursor resumes exactly where it left off, losing and repeating nothing", { skip }, async () => {
  await withRun(async (pool, run) => {
    await advanceRun(pool, run.id, "CLASSIFYING");
    await advanceRun(pool, run.id, "PLANNING");

    const first = await listRunEvents(pool, run.id, FEED_START, 1);
    assert.equal(first.items.length, 1);
    assert.equal(first.hasNextPage, true, "one more event is waiting");

    await advanceRun(pool, run.id, "PROVISIONING");

    // The client was cut after the first event. Everything since must arrive, once each.
    const rest = await listRunEvents(pool, run.id, first.endCursor);
    assert.deepEqual(
      rest.items.map((e) => e.to),
      ["PLANNING", "PROVISIONING"],
      "resume must deliver the event that existed at cut time AND the one written since",
    );
    assert.equal(rest.hasNextPage, false);
  });
});

test("an idle run returns the caller's own cursor, not null", { skip }, async () => {
  await withRun(async (pool, run) => {
    await advanceRun(pool, run.id, "CLASSIFYING");
    const page = await listRunEvents(pool, run.id);

    const idle = await listRunEvents(pool, run.id, page.endCursor);
    assert.deepEqual(idle.items, []);
    assert.equal(
      idle.endCursor,
      page.endCursor,
      "a client polling an idle run must keep a usable cursor rather than having to remember its last non-empty one",
    );
    assert.equal(idle.hasNextPage, false);
  });
});

test("the feed carries only its own run's events", { skip }, async () => {
  await withRun(async (pool, run, task) => {
    const other = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: 25,
      wallClockCapSeconds: 7200,
    });
    await advanceRun(pool, other.id, "CLASSIFYING");
    await advanceRun(pool, run.id, "CLASSIFYING");

    const page = await listRunEvents(pool, run.id);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].to, "CLASSIFYING");
  });
});

test("sequence order is commit order, because both writers lock the run first", { skip }, async () => {
  await withRun(async (pool, run) => {
    // Cost writes racing for one run. recordCost takes the run's row lock before its insert,
    // so the sequence values it hands out cannot interleave against commit order. Were the
    // insert first, a reader could advance past a row still in flight and never see it.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        recordCost(pool, {
          engineeringRunId: run.id,
          stageType: "agent_run",
          stageId: "22222222-2222-2222-2222-222222222222",
          kind: "model",
          usd: 0.001 * (i + 1),
        }),
      ),
    );

    // Walk the feed one page at a time, exactly as a reconnecting client does.
    const seen = [];
    let cursor = FEED_START;
    for (;;) {
      const page = await listRunEvents(pool, run.id, cursor, 1);
      if (page.items.length === 0) break;
      seen.push(...page.items);
      cursor = page.endCursor;
    }

    assert.equal(seen.length, 8, "every concurrent write must be reachable by walking the cursor");
    const cursors = seen.map((e) => Number(e.cursor));
    assert.deepEqual(cursors, [...cursors].sort((a, b) => a - b), "cursors must be strictly increasing");
    assert.equal(new Set(cursors).size, 8, "no event may be delivered twice");
  });
});

test("a cursor that is not a sequence value is refused, not silently restarted", { skip }, async () => {
  await withRun(async (pool, run) => {
    for (const bad of ["2026-09-23T00:00:00Z", "abc", "", "-1", "12.5"]) {
      await assert.rejects(
        () => listRunEvents(pool, run.id, bad),
        InvalidCursorError,
        `${JSON.stringify(bad)} must be refused — restarting at zero would replay the whole run as new`,
      );
    }
  });
});

test("runs order by creation time, not by a random uuid", { skip }, async () => {
  await withRun(async (pool, run, task) => {
    const second = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: 25,
      wallClockCapSeconds: 7200,
    });
    const third = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: 25,
      wallClockCapSeconds: 7200,
    });

    const listed = await listEngineeringRuns(pool, task.id);
    assert.deepEqual(
      listed.map((r) => r.id),
      [third.id, second.id, run.id],
      "newest first — ordering by id would return these in uuid order, which is arbitrary",
    );
    for (const r of listed) assert.ok(r.createdAt instanceof Date, "every run carries a creation time");
  });
});

test("the agent's steps join the feed on the same cursor, in the order they happened (G1)", { skip }, async () => {
  await withRun(async (pool, run) => {
    await advanceRun(pool, run.id, "CLASSIFYING");
    const agent = await insertAgentRun(pool, { engineeringRunId: run.id, workerType: "fake", model: "m", role: "implementer" });
    await recordAgentEvents(pool, run.id, agent.id, 0, [
      { type: "command_started", command: "npm test" },
      { type: "command_finished", command: "npm test", exitCode: 0 },
    ]);
    await advanceRun(pool, run.id, "PLANNING");

    const page = await listRunEvents(pool, run.id);
    assert.deepEqual(page.items.map((e) => e.kind), ["transition", "agent", "agent", "transition"]);
    const [, started, finished] = page.items;
    assert.equal(started.agentRunId, agent.id);
    assert.equal(started.role, "implementer");
    assert.deepEqual(started.event, { type: "command_started", command: "npm test" });
    assert.deepEqual(finished.event, { type: "command_finished", command: "npm test", exitCode: 0 });

    const after = await listRunEvents(pool, run.id, started.cursor);
    assert.deepEqual(after.items.map((e) => e.kind), ["agent", "transition"], "the cursor resumes past an agent event like any other");
  });
});

test("a redelivered poll records its agent events once, not twice", { skip }, async () => {
  await withRun(async (pool, run) => {
    const agent = await insertAgentRun(pool, { engineeringRunId: run.id, workerType: "fake", model: "m", role: "implementer" });
    const events = [{ type: "file_changed", path: "src/a.ts", kind: "update" }, { type: "message", text: "done" }];
    await recordAgentEvents(pool, run.id, agent.id, 0, events);
    await recordAgentEvents(pool, run.id, agent.id, 0, events);
    await recordAgentEvents(pool, run.id, agent.id, 2, [{ type: "completed" }]);
    const page = await listRunEvents(pool, run.id);
    assert.deepEqual(page.items.map((e) => e.event.type), ["file_changed", "message", "completed"]);
  });
});

test("a long reasoning item is capped, and says so", { skip }, async () => {
  await withRun(async (pool, run) => {
    const agent = await insertAgentRun(pool, { engineeringRunId: run.id, workerType: "fake", model: "m", role: "implementer" });
    await recordAgentEvents(pool, run.id, agent.id, 0, [{ type: "thinking", text: "x".repeat(AGENT_EVENT_TEXT_LIMIT * 3) }]);
    const [event] = (await listRunEvents(pool, run.id)).items;
    assert.equal(event.event.text.length, AGENT_EVENT_TEXT_LIMIT);
    assert.match(event.event.text, /\(truncated\)$/);
  });
});
