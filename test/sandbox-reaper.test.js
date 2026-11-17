import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../dist/factory/migrate.js";
import {
  getWorkspace,
  insertEngineeringRun,
  insertEngineeringTask,
  insertWorkspace,
} from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { TERMINAL_STATES } from "../dist/factory/run-state-machine.js";
import { SandboxGoneError } from "../dist/sandbox/provider.js";
import {
  MAX_REAP_ATTEMPTS,
  listReapableWorkspaces,
  reapSandboxes,
  reapSandboxesLocked,
} from "../dist/factory/sweeps/sandbox-reaper.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";

/**
 * #198's single question: **after a run is killed at its worst possible moment, is anything
 * still billing?**
 *
 * The dangerous half of this feature is the predicate, in one specific direction: an over-eager
 * one destroys a live sandbox mid-run, which is worse than the leak it is chasing. So the
 * negative case is asserted across **every** non-terminal ADR-0003 state rather than sampled —
 * a test that checked one state would pass against a predicate that got the other ten wrong.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let counter = 0;

async function makeSchema() {
  const schema = `windkeel_reap_${Date.now()}_${process.pid}_${counter++}`;
  const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await setup.query(`create schema ${schema}`);
  await setup.end();
  const pool = new Pool({
    connectionString: dbUrl,
    ...TEST_POOL,
    options: `-c search_path=${schema}`,
  });
  await runMigrations(pool, join(repoRoot, "migrations"));
  await seedFixtureRepository(pool);
  return { schema, pool };
}

async function dropSchema(schema) {
  const teardown = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await teardown.query(`drop schema if exists ${schema} cascade`);
  await teardown.end();
}

/** The legal path from CREATED to any state a test wants a run to sit in (ADR-0003). */
const PATHS = {
  CREATED: [],
  CLASSIFYING: ["CLASSIFYING"],
  PLANNING: ["CLASSIFYING", "PLANNING"],
  WAITING_FOR_APPROVAL: ["CLASSIFYING", "PLANNING", "WAITING_FOR_APPROVAL"],
  PROVISIONING: ["CLASSIFYING", "PLANNING", "PROVISIONING"],
  IMPLEMENTING: ["CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING"],
  VERIFYING: ["CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "VERIFYING"],
  REPAIRING: ["CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "VERIFYING", "REPAIRING"],
  PR_CREATING: ["CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "VERIFYING", "PR_CREATING"],
  PR_READY: [
    "CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "VERIFYING", "PR_CREATING", "PR_READY",
  ],
  WAITING_FOR_HUMAN: [
    "CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "VERIFYING", "PR_CREATING",
    "PR_READY", "WAITING_FOR_HUMAN",
  ],
  BLOCKED: ["CLASSIFYING", "PLANNING", "BLOCKED"],
  COMPLETED: [
    "CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "VERIFYING", "PR_CREATING",
    "PR_READY", "WAITING_FOR_HUMAN", "COMPLETED",
  ],
  CANCELLED: ["CLASSIFYING", "CANCELLED"],
  FAILED: ["CLASSIFYING", "FAILED"],
  MAX_REPAIR_ATTEMPTS_REACHED: [
    "CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "VERIFYING",
    "MAX_REPAIR_ATTEMPTS_REACHED",
  ],
};

/** Every state in the ADR-0003 table, so nothing is left out by forgetting to list it. */
const ALL_STATES = Object.keys(PATHS);
const NON_TERMINAL = ALL_STATES.filter((s) => !TERMINAL_STATES.has(s));

async function seedRunAt(pool, state) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "local",
    sourceReference: `reap-${state}`,
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
  for (const next of PATHS[state]) await advanceRun(pool, run.id, next, "seed");
  return run.id;
}

async function seedWorkspace(pool, engineeringRunId, overrides = {}) {
  return insertWorkspace(pool, {
    engineeringRunId,
    role: "maker",
    sandboxProvider: "fake",
    providerHandle: `sbx-${Math.random().toString(36).slice(2, 10)}`,
    repository: "r",
    baseSha: "a".repeat(40),
    workingBranch: null,
    status: "ready",
    // Far in the future unless a test says otherwise, so "expired" is never accidental.
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  });
}

/** A provider whose sandboxes record destruction, and can be told to misbehave. */
function fakeProvider({ gone = false, throws = null } = {}) {
  const destroyed = [];
  return {
    destroyed,
    name: "fake",
    capabilities: { credentialBrokering: false, phasedEgress: false, reattachable: true },
    async create() {
      throw new Error("unused");
    },
    async attach({ handleId }) {
      if (gone) throw new SandboxGoneError(handleId);
      if (throws) throw new Error(throws);
      return {
        id: handleId,
        async destroy() {
          destroyed.push(handleId);
        },
      };
    },
  };
}

// --- the predicate ---------------------------------------------------------------------------

test(
  "a live sandbox on a running run is never selected — checked for every non-terminal state",
  { skip },
  async () => {
    const { schema, pool } = await makeSchema();
    try {
      const seeded = [];
      for (const state of NON_TERMINAL) {
        const runId = await seedRunAt(pool, state);
        const workspace = await seedWorkspace(pool, runId);
        seeded.push({ state, workspaceId: workspace.id });
      }
      assert.ok(seeded.length >= 11, `every non-terminal state is covered (${seeded.length})`);

      const reapable = await listReapableWorkspaces(pool, new Date());
      assert.deepEqual(
        reapable.map((r) => r.id).sort(),
        [],
        "not one live workspace on a non-terminal run was selected. States checked: " +
          NON_TERMINAL.join(", "),
      );
    } finally {
      await pool.end();
      await dropSchema(schema);
    }
  },
);

test("a terminal run's sandbox is selected, for every terminal state", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const expected = [];
    for (const state of [...TERMINAL_STATES]) {
      const runId = await seedRunAt(pool, state);
      const workspace = await seedWorkspace(pool, runId);
      expected.push(workspace.id);
    }
    const reapable = await listReapableWorkspaces(pool, new Date());
    assert.deepEqual(reapable.map((r) => r.id).sort(), expected.sort());
    assert.deepEqual(
      [...new Set(reapable.map((r) => r.because))],
      ["run_terminal"],
      "and the sweep can say *why* it selected each one",
    );
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("a workspace past expires_at is selected even though its run is not terminal", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    // The case that matters most: a run whose process died mid-stage is *not* terminal and
    // never will be, so `run_terminal` alone would leave it billing until nothing at all.
    const runId = await seedRunAt(pool, "IMPLEMENTING");
    const workspace = await seedWorkspace(pool, runId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const reapable = await listReapableWorkspaces(pool, new Date());
    assert.deepEqual(reapable.map((r) => r.id), [workspace.id]);
    assert.equal(reapable[0].because, "expired");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("an orphaned workspace is selected on a live run", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRunAt(pool, "VERIFYING");
    const workspace = await seedWorkspace(pool, runId, { status: "orphaned" });
    const reapable = await listReapableWorkspaces(pool, new Date());
    assert.deepEqual(reapable.map((r) => r.id), [workspace.id]);
    assert.equal(reapable[0].because, "orphaned");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("an already-destroyed workspace is never re-selected", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRunAt(pool, "FAILED");
    await seedWorkspace(pool, runId, { status: "destroyed" });
    assert.deepEqual(await listReapableWorkspaces(pool, new Date()), []);
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("a workspace with no provider handle is never selected", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    // A provisioning attempt that never created anything: there is nothing to reattach to, and
    // selecting it would produce a provider call that can only fail.
    const runId = await seedRunAt(pool, "FAILED");
    await seedWorkspace(pool, runId, { providerHandle: null });
    assert.deepEqual(await listReapableWorkspaces(pool, new Date()), []);
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

// --- the sweep -------------------------------------------------------------------------------

test("the sweep destroys a terminal run's sandbox and marks the row", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRunAt(pool, "CANCELLED");
    const workspace = await seedWorkspace(pool, runId);
    const provider = fakeProvider();

    const result = await reapSandboxes({ pool, providers: { fake: provider } });
    assert.equal(result.considered, 1);
    assert.deepEqual(result.outcomes.map((o) => o.kind), ["destroyed"]);
    assert.deepEqual(provider.destroyed, [workspace.providerHandle]);
    assert.equal((await getWorkspace(pool, workspace.id)).status, "destroyed");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("running the sweep twice destroys once and reports the second as nothing to do", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRunAt(pool, "FAILED");
    await seedWorkspace(pool, runId);
    const provider = fakeProvider();

    const first = await reapSandboxes({ pool, providers: { fake: provider } });
    const second = await reapSandboxes({ pool, providers: { fake: provider } });

    assert.deepEqual(first.outcomes.map((o) => o.kind), ["destroyed"]);
    assert.equal(second.considered, 0, "the destroyed row is no longer a candidate");
    assert.equal(provider.destroyed.length, 1, "the sandbox was destroyed exactly once");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("a provider that says the sandbox is gone is treated as success", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRunAt(pool, "COMPLETED");
    const workspace = await seedWorkspace(pool, runId);
    // Two sweeps racing, a TTL that lapsed first, an operator who tidied up by hand: all normal.
    const provider = fakeProvider({ gone: true });

    const result = await reapSandboxes({ pool, providers: { fake: provider } });
    assert.deepEqual(result.outcomes.map((o) => o.kind), ["already_gone"]);
    assert.equal((await getWorkspace(pool, workspace.id)).status, "destroyed");
    const { rows } = await pool.query("select reap_attempts from workspace where id = $1", [
      workspace.id,
    ]);
    assert.equal(rows[0].reap_attempts, 0, "the healthiest outcome does not burn the budget");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("a genuinely failing destroy is counted, and eventually given up on", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const runId = await seedRunAt(pool, "FAILED");
    const workspace = await seedWorkspace(pool, runId);
    const provider = fakeProvider({ throws: "the provider is unreachable" });

    for (let i = 1; i <= MAX_REAP_ATTEMPTS; i++) {
      const result = await reapSandboxes({ pool, providers: { fake: provider } });
      assert.equal(result.considered, 1, `attempt ${i} still selects the row`);
      assert.equal(result.outcomes[0].kind, "failed");
      assert.equal(result.outcomes[0].attempts, i);
    }

    // The bound: a permanently unreachable sandbox must not produce a failed provider call on
    // every tick forever. The row stays findable (`reap_attempts >= 3`) rather than silently
    // looking healthy.
    const after = await reapSandboxes({ pool, providers: { fake: provider } });
    assert.equal(after.considered, 0, "the sweep gives up rather than retrying forever");
    assert.equal((await getWorkspace(pool, workspace.id)).status, "teardown_failed");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("one unreachable sandbox does not stop the sweep reaching the others", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const bad = await seedWorkspace(pool, await seedRunAt(pool, "FAILED"), {
      providerHandle: "sbx-broken",
    });
    const good = await seedWorkspace(pool, await seedRunAt(pool, "FAILED"), {
      providerHandle: "sbx-fine",
    });
    const destroyed = [];
    const provider = {
      name: "fake",
      capabilities: { credentialBrokering: false, phasedEgress: false, reattachable: true },
      async create() {
        throw new Error("unused");
      },
      async attach({ handleId }) {
        if (handleId === "sbx-broken") throw new Error("boom");
        return {
          id: handleId,
          async destroy() {
            destroyed.push(handleId);
          },
        };
      },
    };

    const result = await reapSandboxes({ pool, providers: { fake: provider } });
    assert.equal(result.considered, 2);
    assert.deepEqual(destroyed, ["sbx-fine"], "the healthy sandbox was still reaped");
    assert.equal((await getWorkspace(pool, good.id)).status, "destroyed");
    assert.equal((await getWorkspace(pool, bad.id)).status, "teardown_failed");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("a provider that cannot reattach is reported, not retried into the ground", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const workspace = await seedWorkspace(pool, await seedRunAt(pool, "FAILED"));
    const provider = {
      name: "fake",
      capabilities: { credentialBrokering: false, phasedEgress: false, reattachable: false },
      async create() {
        throw new Error("unused");
      },
      async attach() {
        throw new Error("must not be called");
      },
    };

    const result = await reapSandboxes({ pool, providers: { fake: provider } });
    assert.deepEqual(result.outcomes.map((o) => o.kind), ["unreattachable"]);
    const { rows } = await pool.query("select status, reap_attempts from workspace where id = $1", [
      workspace.id,
    ]);
    // No number of retries changes this condition, so it must not burn the budget — and the row
    // keeps its status so `expires_at` remains the backstop.
    assert.equal(rows[0].reap_attempts, 0);
    assert.equal(rows[0].status, "ready");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

test("the sweep never throws, whatever the provider does", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    await seedWorkspace(pool, await seedRunAt(pool, "FAILED"));
    const provider = {
      name: "fake",
      capabilities: { credentialBrokering: false, phasedEgress: false, reattachable: true },
      async create() {
        throw new Error("unused");
      },
      async attach() {
        // Not an Error instance: a sweep must survive a provider that throws anything at all.
        throw "a string, thrown";
      },
    };
    // It is a sweep, not a stage. It must not be able to fail a run.
    const result = await reapSandboxes({ pool, providers: { fake: provider } });
    assert.equal(result.outcomes[0].kind, "failed");
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

// --- mutual exclusion ------------------------------------------------------------------------

test("two sweeps cannot run at once — the advisory lock holds", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  // A second pool on the same schema, standing in for a second container.
  const other = new Pool({
    connectionString: dbUrl,
    ...TEST_POOL,
    options: `-c search_path=${schema}`,
  });
  try {
    await seedWorkspace(pool, await seedRunAt(pool, "FAILED"));

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const slowProvider = {
      name: "fake",
      capabilities: { credentialBrokering: false, phasedEgress: false, reattachable: true },
      async create() {
        throw new Error("unused");
      },
      async attach({ handleId }) {
        await gate;
        return { id: handleId, async destroy() {} };
      },
    };

    const first = reapSandboxesLocked({ pool, providers: { fake: slowProvider } });
    // Wait until the first sweep is genuinely inside the provider call, holding the lock.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const second = await reapSandboxesLocked({ pool: other, providers: { fake: slowProvider } });
    assert.equal(second.kind, "contended", "the second container did nothing, deliberately");
    assert.match(second.reason, /sandbox-reaper/);

    release();
    const firstResult = await first;
    assert.equal(firstResult.kind, "ran");
  } finally {
    await other.end();
    await pool.end();
    await dropSchema(schema);
  }
});

test("the reaper's lock is its own — it does not block the retention sweep", { skip }, async () => {
  const { schema, pool } = await makeSchema();
  try {
    const { sweepLockKey } = await import("../dist/factory/sweeps/advisory-lock.js");
    // Two jobs with different cadences must not serialise against each other: a reaper tick
    // blocked behind a long evidence prune is a sandbox billing for no reason.
    assert.notEqual(
      sweepLockKey("sandbox-reaper", schema),
      sweepLockKey("evidence-retention", schema),
    );
    // And two deployments sharing a Postgres instance must not contend either.
    assert.notEqual(
      sweepLockKey("sandbox-reaper", schema),
      sweepLockKey("sandbox-reaper", `${schema}_other`),
    );
  } finally {
    await pool.end();
    await dropSchema(schema);
  }
});

// --- the cap-trip integration ----------------------------------------------------------------

test(
  "after a run is killed at its worst moment, the sweep leaves nothing billing",
  { skip },
  async () => {
    const { schema, pool } = await makeSchema();
    try {
      /**
       * The worst moment: a run holding a live maker sandbox, stopped by the spend rail, whose
       * process then died before it could tear anything down — #197's normal path never ran.
       * This is exactly the case the reaper exists for, and the assertion is the one the issue
       * names: *is anything still billing?*
       */
      const runId = await seedRunAt(pool, "IMPLEMENTING");
      const workspace = await seedWorkspace(pool, runId);
      await advanceRun(pool, runId, "FAILED", "spend cap reached", { stopReason: "spend_cap" });

      const provider = fakeProvider();
      const before = await listReapableWorkspaces(pool, new Date());
      assert.equal(before.length, 1, "the abandoned sandbox is visible to the sweep");

      await reapSandboxes({ pool, providers: { fake: provider } });

      assert.deepEqual(provider.destroyed, [workspace.providerHandle]);
      assert.equal((await getWorkspace(pool, workspace.id)).status, "destroyed");
      assert.deepEqual(
        await listReapableWorkspaces(pool, new Date()),
        [],
        "nothing is left billing",
      );
    } finally {
      await pool.end();
      await dropSchema(schema);
    }
  },
);

// `windkeel reap` and `--dry-run` are API routes now; test/api-endpoints.test.js covers them.
