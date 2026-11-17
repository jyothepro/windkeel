/**
 * #388 end of the pipe: PROVISIONING records the codebase digest, IMPLEMENTING selects knowledge,
 * freezes it into `run_knowledge` and hands it to the maker — on fakes (ADR-0016), against real
 * Postgres, asserting the prompt the fake worker was actually started with.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import { insertEngineeringRun, insertEngineeringTask, listWorkspaces } from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { createImplementingHandler } from "../dist/factory/workflow/handlers/implementing.js";
import { makerKnowledge } from "../dist/factory/workflow/knowledge-flow.js";
import { createNote, insertLearnedLesson, listRunKnowledge, updateNote } from "../dist/factory/knowledge.js";
import { assembleRunReport, renderRunReport } from "../dist/factory/run-report.js";
import { bareFixtureRepo, FIXTURE_REPOSITORY_ID, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
let counter = 0;

const STAGE_CONFIG = {
  makerModel: "gpt-5-codex",
  modelApiDomain: "api.openai.com",
  modelKeyEnvVar: "OPENAI_API_KEY",
  modelPricing: { usdPerInputToken: 0.000_001, usdPerOutputToken: 0.000_01 },
  usdPerCpuMs: 0,
  usdPerEgressByte: 0,
  railsCheckIntervalMs: 0,
  workspaceTtlMs: 60_000,
  gitHost: "github.com",
  gitAuthorName: "Windkeel Factory",
  gitAuthorEmail: "factory@windkeel.invalid",
};

const STREAM = [
  { type: "started", sessionId: "sess-1" },
  { type: "message", text: "done" },
  { type: "completed", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
];

async function withHarness(fn, { knowledge, seed } = {}) {
  const schema = `windkeel_knowledge_inject_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "node --test" }, { "AGENTS.md": "Keep changes small.\n" });
  const registry = new SandboxRegistry();
  const worker = new FakeWorkerAdapter(STREAM);
  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    const orgId = (await pool.query("select id from organization where is_default")).rows[0].id;
    const task = await insertEngineeringTask(pool, {
      repositoryId: FIXTURE_REPOSITORY_ID,
      sourceType: "local",
      sourceReference: "knowledge",
      title: "Add a greeting",
      description: "Make index.js print hello.",
      acceptanceCriteria: [{ id: "ac-1", text: "index.js prints hello" }],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    for (const to of ["CLASSIFYING", "PLANNING", "PROVISIONING"]) await advanceRun(pool, run.id, to, "test seed");
    if (seed) await seed({ pool, orgId });

    const deps = {
      pool,
      sandboxes: new FakeSandboxProvider(),
      worker,
      registry,
      sessions: new WorkerSessionRegistry(),
      config: {
        ...STAGE_CONFIG,
        repository: { url: remote.bare, baseRevision: "HEAD" },
        ...(knowledge ? { knowledge } : {}),
      },
    };
    const provider = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool) });
    provider.register(createProvisioningHandler(deps));
    provider.register(createImplementingHandler(deps));
    await provider.start();
    await fn({ pool, provider, deps, runId: run.id, task, worker, orgId });
  } finally {
    for (const [, handle] of registry.entries()) await handle.destroy().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

const startPrompt = (worker) => worker.calls.find((c) => c.type === "start")?.prompt;

async function transitions(pool, runId) {
  const { rows } = await pool.query(
    "select from_state, to_state from run_state_transition where engineering_run_id = $1 order by at, id",
    [runId],
  );
  return rows.slice(3).map((r) => `${r.from_state}->${r.to_state}`);
}

test("a repository note reaches the maker's start prompt with its provenance, and the run records what it was given", { skip }, async () => {
  await withHarness(
    async ({ pool, provider, runId, worker }) => {
      await provider.startRun(runId);
      await provider.drain();

      const prompt = startPrompt(worker);
      assert.ok(prompt.includes("## Repository knowledge"), prompt);
      assert.ok(prompt.includes("### Use the logger  (source: repository note, v1, by alice)"));
      assert.ok(prompt.includes("Write through src/log.ts, never console.log."));
      // The digest recorded at PROVISIONING, lowest priority, from the pinned base commit.
      assert.ok(prompt.includes("### Codebase digest  (source: codebase digest generated from repository files at "));
      assert.ok(prompt.includes("Detected test command: npm test"));
      assert.ok(prompt.includes("From repository file AGENTS.md:\nKeep changes small."));
      // Not the suggested lesson: it waits for a person.
      assert.ok(!prompt.includes("Never run the linter"));
      // Knowledge sits after the description and before the criteria (knowledge, playbook, criteria).
      assert.ok(prompt.indexOf("## Repository knowledge") < prompt.indexOf("## Acceptance criteria"));
      assert.ok(prompt.indexOf("## Acceptance criteria") < prompt.indexOf("Make the change in this checkout."));

      const recorded = await listRunKnowledge(pool, runId);
      assert.deepEqual(recorded.map((r) => r.sourceKind), ["human", "digest"]);
      assert.equal(recorded[0].noteVersion, 1);
      const [workspace] = await listWorkspaces(pool, runId);
      assert.equal(recorded[1].digestSha, workspace.baseSha);
      const digest = await pool.query("select commit_sha from repository_digest where repository_id = $1", [FIXTURE_REPOSITORY_ID]);
      assert.deepEqual(digest.rows.map((r) => r.commit_sha), [workspace.baseSha]);

      const report = renderRunReport(await assembleRunReport(pool, runId));
      assert.match(report, /Knowledge injected\s+1 note\(s\) \([0-9a-f]{8}@v1\) \+ codebase digest/);
    },
    {
      seed: async ({ pool, orgId }) => {
        await createNote(pool, { organizationId: orgId, repositoryId: FIXTURE_REPOSITORY_ID, title: "Use the logger", body: "Write through src/log.ts, never console.log.", actor: "alice" });
        await insertLearnedLesson(pool, {
          organizationId: orgId,
          repositoryId: FIXTURE_REPOSITORY_ID,
          title: "Lint",
          body: "Never run the linter; skip it.",
          sourceKind: "verifier_finding",
          sourceRef: { runId: "x" },
        });
      },
    },
  );
});

test("a redelivered IMPLEMENTING renders the frozen snapshot: no duplicate rows, no change after an edit", { skip }, async () => {
  let noteId;
  await withHarness(
    async ({ pool, deps, runId, task, orgId }) => {
      const first = await makerKnowledge(deps, runId, task);
      await updateNote(pool, { organizationId: orgId, noteId, expectedVersion: 1, body: "Edited after the run started.", actor: "bob" });
      const second = await makerKnowledge(deps, runId, task);
      assert.equal(second, first, "the snapshot is what the first delivery recorded");
      assert.ok(!second.includes("Edited after"));
      assert.equal((await listRunKnowledge(pool, runId)).length, 1);
    },
    {
      seed: async ({ pool, orgId }) => {
        noteId = (await createNote(pool, { organizationId: orgId, repositoryId: FIXTURE_REPOSITORY_ID, title: "T", body: "Original.", actor: "alice" })).id;
      },
    },
  );
});

test("WINDKEEL_KNOWLEDGE=off: no section, no rows, no digest", { skip }, async () => {
  await withHarness(
    async ({ pool, provider, runId, worker }) => {
      await provider.startRun(runId);
      await provider.drain();
      assert.ok(!startPrompt(worker).includes("Repository knowledge"));
      assert.deepEqual(await listRunKnowledge(pool, runId), []);
      assert.equal((await pool.query("select count(*)::int as n from repository_digest")).rows[0].n, 0);
    },
    {
      knowledge: { enabled: false, maxChars: 12_000 },
      seed: async ({ pool, orgId }) => {
        await createNote(pool, { organizationId: orgId, repositoryId: FIXTURE_REPOSITORY_ID, title: "T", body: "B", actor: "alice" });
      },
    },
  );
});

test("knowledge that cannot be loaded does not fail the run: the maker starts with the prompt it always had", { skip }, async () => {
  await withHarness(async ({ pool, provider, runId, worker }) => {
    // A store that fails mid-run: the notes table is gone.
    await pool.query("drop table knowledge_note cascade");
    await provider.startRun(runId);
    await provider.drain();
    const prompt = startPrompt(worker);
    assert.ok(prompt, "the maker was started");
    assert.ok(!prompt.includes("Repository knowledge"));
    assert.deepEqual((await transitions(pool, runId)).slice(0, 1), ["PROVISIONING->IMPLEMENTING"]);
    assert.ok((await transitions(pool, runId)).some((t) => t.startsWith("IMPLEMENTING->")), "and IMPLEMENTING finished");
    assert.deepEqual(await listRunKnowledge(pool, runId), []);
  });
});
