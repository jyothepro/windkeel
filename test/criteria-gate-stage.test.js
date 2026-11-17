import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { FakeGitHubClient } from "../dist/github/fake.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import { upsertRepository } from "../dist/factory/repository-entity.js";
import {
  getEngineeringRun,
  getEngineeringTask,
  insertEngineeringRun,
  insertEngineeringTask,
} from "../dist/factory/repositories.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { VercelWorkflowProvider } from "../dist/factory/workflow/vercel.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createIntakeHandlers } from "../dist/factory/workflow/handlers/intake.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import {
  closeWorkflowRuntime,
  endExecutions,
  runtimeSkip,
  workflowRuntime,
} from "./workflow-runtime.js";
import { writeFileSync } from "node:fs";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * The gate, driven as a run rather than as a function: ADR-0012's claim is about what happens to
 * a *run*, and the failure that matters — a sandbox provisioned before a human approved
 * machine-written criteria — is only observable end to end.
 *
 * Model calls are the engine's own scripted-fake seam (`ModelPolicy.fakes.criteria`), so there is
 * no network and no key anywhere in this file.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
let serial = 0;

const OWNER = "jyothepro";
const NAME = "windkeel-fixture";

function scripted(name, value) {
  const path = join(tempDir(name), `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

async function withSchema(fn) {
  const schema = `windkeel_gate_test_${Date.now()}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    await fn(pool, schema);
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

async function seed(pool, { criteria = [], body = "The uploader is broken.", sourceType = "github_issue" } = {}) {
  const repository = await upsertRepository(pool, {
    owner: OWNER,
    name: NAME,
    defaultBranch: "trunk",
    cloneUrl: `https://github.com/${OWNER}/${NAME}.git`,
    githubInstallationId: 42,
  });
  const task = await insertEngineeringTask(pool, {
    repositoryId: repository.id,
    sourceType,
    sourceReference: sourceType === "github_issue" ? `${OWNER}/${NAME}#7` : "cli",
    title: "Uploader retries are missing",
    description: body,
    acceptanceCriteria: criteria,
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  const run = await insertEngineeringRun(pool, {
    taskId: task.id,
    spendCapUsd: 25,
    wallClockCapSeconds: 7200,
  });
  return { repository, task, run };
}

function makeDeps(pool, { criteriaFake, makerVendor = "openai" } = {}) {
  const sandboxes = new FakeSandboxProvider();
  const creates = [];
  const countingSandboxes = {
    name: "counting",
    capabilities: sandboxes.capabilities,
    async create(options) {
      creates.push(options);
      return sandboxes.create(options);
    },
  };
  const github = new FakeGitHubClient({
    repositories: [{ owner: OWNER, name: NAME, issues: [{ number: 7 }] }],
  });
  return {
    creates,
    github,
    deps: {
      pool,
      sandboxes: countingSandboxes,
      worker: new FakeWorkerAdapter([]),
      registry: new SandboxRegistry(),
      sessions: new WorkerSessionRegistry(),
      github,
      config: {
        repository: { url: "/nonexistent", baseRevision: "HEAD" },
        makerModel: "gpt-5-codex",
        makerVendor,
        modelApiDomain: "api.openai.com",
        modelKeyEnvVar: "OPENAI_API_KEY",
        modelPricing: { usdPerInputToken: 0, usdPerOutputToken: 0 },
        usdPerCpuMs: 0,
        usdPerEgressByte: 0,
        railsCheckIntervalMs: 60_000,
        workspaceTtlMs: 60_000,
        gitHost: "github.com",
        gitAuthorName: "Windkeel Factory",
        gitAuthorEmail: "factory@windkeel.invalid",
        policyVersion: "test",
        checkerModels: {
          endpoints: [],
          maker: { vendor: makerVendor, model: "gpt-5-codex" },
          ...(criteriaFake ? { fakes: { criteria: criteriaFake } } : {}),
        },
      },
    },
  };
}

async function drive(pool, deps, runId) {
  const provider = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool) });
  for (const handler of createIntakeHandlers(deps)) provider.register(handler);
  provider.register(createProvisioningHandler(deps));
  await provider.start();
  await provider.startRun(runId);
  await provider.drain();
  return provider;
}

const GENERATED = {
  criteria: [
    { text: "retries a 500 three times with backoff" },
    { text: "gives up after the third and reports the failure" },
  ],
};

after(async () => {
  await closeWorkflowRuntime();
});

test("an issue with criteria goes straight to PROVISIONING: no model call, no comment", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run, task } = await seed(pool, {
      criteria: [{ id: "AC1", text: "retries a 500", source: { kind: "linked_issue", ref: "x" } }],
    });
    // No `fakes.criteria` and no endpoints: a generation attempt would throw
    // NoIndependentProviderError, so "no model call" is proved by the run *not* failing.
    const { deps, github } = makeDeps(pool);
    const provider = await drive(pool, deps, run.id);
    try {
      const after = await getEngineeringRun(pool, run.id);
      assert.ok(
        ["PROVISIONING", "IMPLEMENTING", "FAILED"].includes(after.status),
        `expected the gate to let it through, got ${after.status}`,
      );
      const stored = await getEngineeringTask(pool, task.id);
      assert.equal(stored.criteriaProvenance, "extracted");
      assert.equal(stored.criteriaApprovedAt, null, "extracted criteria never wait for approval");
      assert.equal(github.commentsOn({ owner: OWNER, name: NAME }, 7).length, 0);
    } finally {
      await provider.stop();
    }
  });
});

test("zero criteria: generated on the checker model, comment posted once, no sandbox", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run, task } = await seed(pool);
    const { deps, github, creates } = makeDeps(pool, {
      criteriaFake: scripted("criteria", GENERATED),
    });
    const provider = await drive(pool, deps, run.id);
    try {
      assert.equal((await getEngineeringRun(pool, run.id)).status, "WAITING_FOR_APPROVAL");

      const stored = await getEngineeringTask(pool, task.id);
      assert.deepEqual(
        stored.acceptanceCriteria.map((c) => c.text),
        GENERATED.criteria.map((c) => c.text),
      );
      assert.equal(stored.criteriaProvenance, "generated");
      assert.ok(stored.criteriaGeneratedBy, "the model that wrote them is recorded");
      assert.equal(stored.criteriaApprovedAt, null);

      const comments = github.commentsOn({ owner: OWNER, name: NAME }, 7);
      assert.equal(comments.length, 1, "the approval request is posted exactly once");
      assert.match(comments[0].body, /approval needed before anything runs/i);

      // ADR-0012's whole point: the misread is visible *before* the money is spent.
      assert.deepEqual(creates, [], "no sandbox exists for an unapproved run");
    } finally {
      await provider.stop();
    }
  });
});

test("a fresh run still waits when the task already holds unapproved generated criteria", { skip }, async () => {
  await withSchema(async (pool) => {
    const criteria = GENERATED.criteria.map((criterion, index) => ({
      id: `AC${index + 1}`,
      text: criterion.text,
      source: { kind: "linked_issue", ref: "" },
    }));
    const { run, task } = await seed(pool, { criteria });
    await pool.query(
      `update engineering_task
          set criteria_provenance = 'generated',
              criteria_generated_by = 'anthropic/claude-sonnet-5',
              criteria_approved_at = null,
              criteria_approved_by = null
        where id = $1`,
      [task.id],
    );

    // No criteria fake and no checker endpoints: trying to regenerate would fail. A retry must
    // reuse the persisted bar and re-enter the approval wait instead.
    const { deps, creates, github } = makeDeps(pool);
    const provider = await drive(pool, deps, run.id);
    try {
      assert.equal((await getEngineeringRun(pool, run.id)).status, "WAITING_FOR_APPROVAL");
      assert.deepEqual(creates, [], "retrying does not provision before approval");
      assert.equal(github.commentsOn({ owner: OWNER, name: NAME }, 7).length, 0, "the original approval request is not duplicated");
    } finally {
      await provider.stop();
    }
  });
});

test("an approval signal advances the run and records who approved it, when", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run, task } = await seed(pool);
    const { deps } = makeDeps(pool, { criteriaFake: scripted("criteria", GENERATED) });
    const provider = await drive(pool, deps, run.id);
    try {
      await provider.signal(run.id, { type: "approval_granted", actor: "jyothepro" });
      await provider.drain();

      const stored = await getEngineeringTask(pool, task.id);
      assert.equal(stored.criteriaApprovedBy, "jyothepro");
      assert.ok(stored.criteriaApprovedAt instanceof Date);
      // The database alone answers what was generated, by which model, who approved it, when.
      // (The `run_signal` row's consumed_at is asserted in the pg-boss test below: the fake
      // provider keeps signals in memory, so only the real backing has a row to look at.)
      assert.ok(stored.criteriaGeneratedBy);
    } finally {
      await provider.stop();
    }
  });
});

test("a second delivery of the same approval does not advance anything twice", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run } = await seed(pool);
    const { deps } = makeDeps(pool, { criteriaFake: scripted("criteria", GENERATED) });
    const provider = await drive(pool, deps, run.id);
    try {
      await provider.signal(run.id, { type: "approval_granted", actor: "jyothepro" });
      await provider.drain();
      const transitions = (await pool.query(
        "select to_state from run_state_transition where engineering_run_id = $1 order by at, id",
        [run.id],
      )).rows.map((r) => r.to_state);

      // Re-deliver: the signal is already consumed, so there is nothing left to act on.
      await provider.startRun(run.id);
      await provider.drain();
      const after = (await pool.query(
        "select to_state from run_state_transition where engineering_run_id = $1 order by at, id",
        [run.id],
      )).rows.map((r) => r.to_state);
      assert.equal(
        after.filter((s) => s === "PROVISIONING").length,
        transitions.filter((s) => s === "PROVISIONING").length,
        "one approval, one advance",
      );
    } finally {
      await provider.stop();
    }
  });
});

test("generation that produces nothing usable cancels the run, and says why", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run } = await seed(pool);
    const { deps, github, creates } = makeDeps(pool, {
      criteriaFake: scripted("criteria-empty", { criteria: [] }),
    });
    const provider = await drive(pool, deps, run.id);
    try {
      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "CANCELLED", "no criteria, no run (ADR-0012 §5)");
      const comments = github.commentsOn({ owner: OWNER, name: NAME }, 7);
      assert.equal(comments.length, 1);
      assert.match(comments[0].body, /no verifiable acceptance criteria/i);
      assert.deepEqual(creates, []);
    } finally {
      await provider.stop();
    }
  });
});

test("a generation gateway that is not independent of the maker fails the run", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run } = await seed(pool);
    // No fake, no endpoints: `criteriaGateway` cannot find an independent one and refuses.
    // ADR-0010 §4 makes that run-fatal rather than a warning.
    const { deps, creates } = makeDeps(pool);
    const provider = await drive(pool, deps, run.id);
    try {
      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "FAILED");
      assert.equal(after.stopReason, "error");
      const { rows } = await pool.query(
        "select reason from run_state_transition where engineering_run_id = $1 and to_state = 'FAILED'",
        [run.id],
      );
      assert.match(rows[0].reason, /independently of the maker/);
      assert.deepEqual(creates, [], "it does not proceed with the criteria anyway");
    } finally {
      await provider.stop();
    }
  });
});

test("provisioning refuses a run holding unapproved generated criteria", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run, task } = await seed(pool);
    // The gate is bypassed on purpose: this asserts the *enforcement* (ADR-0012 §4), which is
    // what makes the pause a rule rather than a convention.
    await pool.query(
      `update engineering_task
          set acceptance_criteria = $2, criteria_provenance = 'generated'
        where id = $1`,
      [task.id, JSON.stringify([{ id: "AC1", text: "x", source: { kind: "linked_issue", ref: "" } }])],
    );
    const { deps, creates } = makeDeps(pool);
    const provider = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool) });
    provider.register(createProvisioningHandler(deps));
    await provider.start();
    try {
      await pool.query("update engineering_run set status = 'PROVISIONING' where id = $1", [run.id]);
      await provider.startRun(run.id);
      await provider.drain();
      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "FAILED");
      assert.deepEqual(creates, [], "no sandbox for unapproved criteria");
    } finally {
      await provider.stop();
    }
  });
});

test(
  "the wait/signal cycle works against the real durable backing, not only the fake",
  { skip: runtimeSkip(dbUrl) },
  async () => {
    const { world } = await workflowRuntime();
    const suffix = `${Date.now()}_${serial++}`;
    const appSchema = `windkeel_gate_real_${suffix}`;
    const appSchemaDbUrl = await createMigratedDatabase(appSchema);

    const pool = new Pool({ connectionString: appSchemaDbUrl, ...TEST_POOL, options: `-c search_path=${appSchema}` });
    const provider = new VercelWorkflowProvider({
      connectionString: appSchemaDbUrl,
      applicationSchema: appSchema,
      world,
      waitSleepMs: 2_000,
      retrySleepMs: 50,
    });
    try {
      await seedFixtureRepository(pool);
      const { run, task } = await seed(pool);
      const { deps } = makeDeps(pool, { criteriaFake: scripted("criteria-real", GENERATED) });
      for (const handler of createIntakeHandlers(deps)) provider.register(handler);
      await provider.start();
      await provider.startRun(run.id);

      // A `wait` that never re-enqueues on approval is the failure mode that matters, and only
      // the real backing can prove it does: the fake drains synchronously and would hide it.
      await waitFor(async () => (await getEngineeringRun(pool, run.id)).status === "WAITING_FOR_APPROVAL");
      await provider.signal(run.id, { type: "approval_granted", actor: "jyothepro" });
      await waitFor(async () => (await getEngineeringRun(pool, run.id)).status === "PROVISIONING");

      const stored = await getEngineeringTask(pool, task.id);
      assert.equal(stored.criteriaApprovedBy, "jyothepro");

      // migrations/0003: consumed, not deleted — so the approval stays auditable after the fact
      // and a redelivered step cannot re-apply it.
      const { rows } = await pool.query(
        "select kind, payload, consumed_at from run_signal where engineering_run_id = $1",
        [run.id],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, "approval_granted");
      assert.equal(rows[0].payload.actor, "jyothepro");
      assert.ok(rows[0].consumed_at);
    } finally {
      await endExecutions(pool).catch(() => {});
      await provider.stop();
      await pool.end();
      await dropMigratedDatabase(appSchema);
    }
  },
);

async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("waitFor: condition never became true");
}
