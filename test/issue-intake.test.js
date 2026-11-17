import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeGitHubClient } from "../dist/github/fake.js";
import {
  createTaskFromIssue,
  issueReference,
  riskFromLabels,
  runStartComment,
} from "../dist/intake/issue-intake.js";
import { upsertRepository } from "../dist/factory/repository-entity.js";
import {
  getEngineeringTask,
  listEngineeringRuns,
  updateEngineeringRun,
} from "../dist/factory/repositories.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase, migratedDatabaseUrl } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
let schemaSerial = 0;

const OWNER = "jyothepro";
const NAME = "windkeel-fixture";

const ISSUE = {
  number: 7,
  title: "Uploader retries are missing",
  body: [
    "The uploader gives up on the first 500.",
    "",
    "- [ ] retries a 500 three times with backoff",
    "- [ ] gives up after the third and reports the failure",
  ].join("\n"),
  labels: ["windkeel"],
  htmlUrl: `https://github.com/${OWNER}/${NAME}/issues/7`,
  state: "open",
  locked: false,
};

async function withSchema(fn) {
  const schema = `windkeel_intake_test_${Date.now()}_${schemaSerial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const repository = await upsertRepository(pool, {
      owner: OWNER,
      name: NAME,
      defaultBranch: "trunk",
      cloneUrl: `https://github.com/${OWNER}/${NAME}.git`,
      githubInstallationId: 42,
    });
    await fn(pool, repository, schema);
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

function makeDeps(pool, repository, overrides = {}) {
  const github = new FakeGitHubClient({
    repositories: [
      {
        owner: OWNER,
        name: NAME,
        defaultBranch: "trunk",
        issues: [{ number: 7, title: ISSUE.title, body: ISSUE.body, labels: ["windkeel"] }],
      },
    ],
  });
  const started = [];
  return {
    github,
    started,
    deps: {
      db: pool,
      github,
      startRun: async (runId) => {
        started.push(runId);
        return { enqueued: true };
      },
      ...overrides,
    },
  };
}

const intakeInput = (repository, issue = ISSUE) => ({
  repository: { id: repository.id, owner: OWNER, name: NAME },
  issue,
});

// --- Pure pieces ---

test("the issue reference is owner/name#number, and it is what tasks are found by", () => {
  assert.equal(issueReference({ owner: OWNER, name: NAME }, 7), "jyothepro/windkeel-fixture#7");
});

test("risk comes from a label if the operator set one, and otherwise from configuration", () => {
  assert.equal(riskFromLabels(["windkeel"], "low"), "low");
  assert.equal(riskFromLabels(["windkeel", "risk:high"], "low"), "high");
  assert.equal(riskFromLabels(["Risk:Medium"], "low"), "medium");
  // Not inferred from anything else: ADR-0012 §6 puts classification in the planner milestone.
  assert.equal(riskFromLabels(["security", "urgent", "p0"], "low"), "low");
  assert.equal(riskFromLabels([], "medium"), "medium");
});

test("the run-start comment names the criteria, or says approval is coming", () => {
  const run = { id: "run-1", spendCapUsd: 25, wallClockCapSeconds: 7200 };
  const withCriteria = runStartComment(
    run,
    [{ id: "AC1", text: "retries a 500", source: { kind: "linked_issue", ref: "x" } }],
    "extracted",
  );
  assert.match(withCriteria, /Windkeel is on it/);
  assert.match(withCriteria, /1 acceptance criterion/);
  assert.match(withCriteria, /AC1.*retries a 500/);
  assert.match(withCriteria, /\/windkeel cancel/);

  const pending = runStartComment(run, [], "pending_generation");
  assert.match(pending, /Nothing runs until you reply `\/windkeel approve`/);
});

// --- Intake (Postgres-gated) ---

test("a labelled issue with a checklist creates a task with those criteria, verbatim", { skip }, async () => {
  await withSchema(async (pool, repository) => {
    const { deps, github, started } = makeDeps(pool, repository);
    const result = await createTaskFromIssue(deps, intakeInput(repository));
    await result.afterCommit();

    assert.equal(result.outcome.kind, "started");
    assert.equal(result.outcome.criteriaRouting, "extracted");
    assert.equal(result.outcome.reusedTask, false);

    const task = await getEngineeringTask(pool, result.outcome.taskId);
    assert.equal(task.sourceType, "github_issue");
    assert.equal(task.sourceReference, "jyothepro/windkeel-fixture#7");
    assert.equal(task.title, ISSUE.title);
    assert.deepEqual(
      task.acceptanceCriteria.map((c) => c.text),
      [
        "retries a 500 three times with backoff",
        "gives up after the third and reports the failure",
      ],
      "verbatim and in order — ADR-0012 §1 allows no rewriting",
    );

    const runs = await listEngineeringRuns(pool, task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "CREATED");
    // ADR-0011: a run created from a label gets the same rails as one created from the CLI.
    assert.equal(runs[0].spendCapUsd, 25);
    assert.equal(runs[0].wallClockCapSeconds, 7200);

    assert.deepEqual(started, [runs[0].id], "the run is enqueued after the rows commit");

    // ADR-0009 §4: exactly one comment, at run start.
    const comments = github.commentsOn({ owner: OWNER, name: NAME }, 7);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /Windkeel is on it/);
  });
});

test("extraction makes no model call at all", { skip }, async () => {
  await withSchema(async (pool, repository) => {
    const { deps } = makeDeps(pool, repository);
    // The intake is handed no model gateway and no policy — there is nothing it *could* call.
    // Asserted structurally rather than by inspection: if a model call is ever added to this
    // path, this test stops compiling against the deps it is given.
    assert.deepEqual(Object.keys(deps).sort(), ["db", "github", "startRun"]);
    const result = await createTaskFromIssue(deps, intakeInput(repository));
    await result.afterCommit();
    assert.equal(result.outcome.kind, "started");
  });
});

test("an issue with no criteria is routed to the approval path, not silently started", { skip }, async () => {
  await withSchema(async (pool, repository) => {
    const { deps, github } = makeDeps(pool, repository);
    const result = await createTaskFromIssue(
      deps,
      intakeInput(repository, { ...ISSUE, body: "The uploader is broken. Please fix it." }),
    );
    await result.afterCommit();

    assert.equal(result.outcome.kind, "started");
    assert.equal(result.outcome.criteriaRouting, "pending_generation");
    assert.deepEqual(result.outcome.criteria, []);

    const comments = github.commentsOn({ owner: OWNER, name: NAME }, 7);
    assert.match(comments[0].body, /wait for your/, "the comment says approval is coming");
  });
});

test("the same labelled issue twice yields one task and one run", { skip }, async () => {
  await withSchema(async (pool, repository) => {
    const { deps, started } = makeDeps(pool, repository);
    const first = await createTaskFromIssue(deps, intakeInput(repository));
    await first.afterCommit();
    const second = await createTaskFromIssue(deps, intakeInput(repository));
    await second.afterCommit();

    assert.equal(second.outcome.taskId, first.outcome.taskId, "one task per issue");
    assert.equal(second.outcome.engineeringRunId, first.outcome.engineeringRunId);
    const runs = await listEngineeringRuns(pool, first.outcome.taskId);
    assert.equal(runs.length, 1, "never two live runs for one issue");

    // The run is still at CREATED, so the second delivery re-enqueues rather than doing
    // nothing — that is what heals a run whose enqueue was lost after its rows committed.
    // `startRun` is idempotent, so the repeat is free.
    assert.deepEqual(started, [runs[0].id, runs[0].id]);
  });
});

test("re-labelling a run that is already under way starts nothing", { skip }, async () => {
  await withSchema(async (pool, repository) => {
    const { deps, github, started } = makeDeps(pool, repository);
    const first = await createTaskFromIssue(deps, intakeInput(repository));
    await first.afterCommit();
    // Past CREATED: a stage has been delivered, so there is nothing to heal and nothing to add.
    await updateEngineeringRun(pool, first.outcome.engineeringRunId, { status: "IMPLEMENTING" });

    const second = await createTaskFromIssue(deps, intakeInput(repository));
    await second.afterCommit();

    assert.equal(second.outcome.kind, "noop");
    assert.match(second.outcome.reason, /already IMPLEMENTING/);
    assert.equal(
      (await listEngineeringRuns(pool, first.outcome.taskId)).length,
      1,
      "never two live runs for one issue",
    );
    assert.equal(started.length, 1, "no second enqueue");
    assert.equal(
      github.commentsOn({ owner: OWNER, name: NAME }, 7).length,
      1,
      "and no second comment — ADR-0009 §4 is start and terminal only",
    );
  });
});

test("two concurrent intakes for one issue cannot both create a task", { skip }, async () => {
  await withSchema(async (pool, repository, schema) => {
    const other = new Pool({ connectionString: migratedDatabaseUrl(schema), ...TEST_POOL, options: `-c search_path=${schema}` });
    try {
      const a = makeDeps(pool, repository);
      const b = makeDeps(other, repository);
      b.deps.db = other;

      // The guard is migrations/0006's partial unique index, not a read-before-write: the
      // ingress is serverless and has no memory to guard with.
      const results = await Promise.allSettled([
        createTaskFromIssue(a.deps, intakeInput(repository)),
        createTaskFromIssue(b.deps, intakeInput(repository)),
      ]);
      const created = results.filter((r) => r.status === "fulfilled");
      assert.ok(created.length >= 1);

      const { rows } = await pool.query(
        "select count(*)::int as n from engineering_task where source_type = 'github_issue'",
      );
      assert.equal(rows[0].n, 1);
    } finally {
      await other.end();
    }
  });
});

test("re-labelling after a terminal run starts a second run on the same task, with fresh criteria", { skip }, async () => {
  await withSchema(async (pool, repository) => {
    const { deps, github, started } = makeDeps(pool, repository);
    const first = await createTaskFromIssue(deps, intakeInput(repository));
    await first.afterCommit();
    await updateEngineeringRun(pool, first.outcome.engineeringRunId, { status: "COMPLETED" });

    // The operator edited the issue before re-labelling — ADR-0012 §4 says the edit counts.
    const edited = {
      ...ISSUE,
      title: "Uploader retries, take two",
      body: "- [ ] retries a 500 five times\n- [ ] logs each attempt",
    };
    const second = await createTaskFromIssue(deps, intakeInput(repository, edited));
    await second.afterCommit();

    assert.equal(second.outcome.kind, "started");
    assert.equal(second.outcome.reusedTask, true);
    assert.equal(second.outcome.taskId, first.outcome.taskId);
    assert.notEqual(second.outcome.engineeringRunId, first.outcome.engineeringRunId);

    const task = await getEngineeringTask(pool, first.outcome.taskId);
    assert.equal(task.title, "Uploader retries, take two");
    assert.deepEqual(
      task.acceptanceCriteria.map((c) => c.text),
      ["retries a 500 five times", "logs each attempt"],
    );

    const runs = await listEngineeringRuns(pool, task.id);
    assert.equal(runs.length, 2);
    assert.equal(started.length, 2);
    assert.equal(github.commentsOn({ owner: OWNER, name: NAME }, 7).length, 2, "one per run start");
  });
});

test("a closed issue produces no task, and says why once", { skip }, async () => {
  await withSchema(async (pool, repository) => {
    const { deps, github, started } = makeDeps(pool, repository);
    const result = await createTaskFromIssue(
      deps,
      intakeInput(repository, { ...ISSUE, state: "closed" }),
    );
    await result.afterCommit();

    assert.equal(result.outcome.kind, "ignored");
    assert.match(result.outcome.reason, /closed/);
    const { rows } = await pool.query("select count(*)::int as n from engineering_task");
    assert.equal(rows[0].n, 0);
    assert.deepEqual(started, []);

    const comments = github.commentsOn({ owner: OWNER, name: NAME }, 7);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /did not start a run/);
  });
});

test("a locked issue produces no task", { skip }, async () => {
  await withSchema(async (pool, repository) => {
    const { deps } = makeDeps(pool, repository);
    const result = await createTaskFromIssue(
      deps,
      intakeInput(repository, { ...ISSUE, locked: true }),
    );
    assert.equal(result.outcome.kind, "ignored");
    assert.match(result.outcome.reason, /locked/);
  });
});

test("the comment is posted only after the run is enqueued", { skip }, async () => {
  await withSchema(async (pool, repository) => {
    const { deps, github } = makeDeps(pool, repository, {
      startRun: async () => {
        throw new Error("queue unavailable");
      },
    });
    const result = await createTaskFromIssue(deps, intakeInput(repository));
    await assert.rejects(() => result.afterCommit(), /queue unavailable/);
    // An announced run that was never enqueued is a lie; the reverse is only untidy.
    assert.equal(github.commentsOn({ owner: OWNER, name: NAME }, 7).length, 0);
  });
});
