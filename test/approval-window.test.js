import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeGitHubClient } from "../dist/github/fake.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import { upsertRepository } from "../dist/factory/repository-entity.js";
import {
  getEngineeringRun,
  insertEngineeringRun,
  insertEngineeringTask,
} from "../dist/factory/repositories.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createIntakeHandlers } from "../dist/factory/workflow/handlers/intake.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import {
  approvalDeadlineAt,
  checkApprovalDeadline,
  checkCaps,
  DEFAULT_APPROVAL_DEADLINE_SECONDS,
  DEFAULT_WALL_CLOCK_CAP_SECONDS,
  parkedSeconds,
  terminalStateFor,
} from "../dist/factory/rails.js";
import {
  approvalExpiredComment,
  criteriaApprovalComment,
} from "../dist/factory/criteria-gate.js";
import { applyIssueCommand } from "../dist/factory/issue-commands.js";
import { seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { writeFileSync } from "node:fs";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * #262: how long a human has to approve, and where it says so.
 *
 * Before this, the answer was "under two hours" and "nowhere" — and the two-hour figure was not
 * a policy anybody chose, it was ADR-0011's wall-clock cap measured from `started_at` and
 * re-checked every 300 s by the flow loop on a run that was consuming nothing.
 *
 * The two halves of the fix are tested as two different failures, because they are: a run parked
 * past its wall clock is still approvable (the cap no longer bounds the human), and a gate that
 * has genuinely gone stale ends `CANCELLED` with `approval_expired` (something else does).
 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
let serial = 0;

const OWNER = "jyothepro";
const NAME = "windkeel-fixture";
const GENERATED = { criteria: [{ text: "retries a 500 three times with backoff" }] };

test("parked seconds come from the transition log, and an open interval is closed at now", () => {
  const at = (ms) => new Date(Date.UTC(2026, 8, 22, 0, 0, 0) + ms);
  const now = at(10 * HOUR);

  // Parked for two hours, then released: only the closed interval counts.
  assert.equal(
    parkedSeconds(
      [
        { toState: "CREATED", at: at(0) },
        { toState: "WAITING_FOR_APPROVAL", at: at(1 * HOUR) },
        { toState: "PROVISIONING", at: at(3 * HOUR) },
        { toState: "IMPLEMENTING", at: at(4 * HOUR) },
      ],
      now,
    ),
    2 * 3600,
  );

  // Still parked: the interval is open, so it runs to `now`. This is what makes the exemption
  // apply *while* a run waits rather than only once somebody rescues it.
  assert.equal(
    parkedSeconds(
      [
        { toState: "CREATED", at: at(0) },
        { toState: "WAITING_FOR_APPROVAL", at: at(1 * HOUR) },
      ],
      now,
    ),
    9 * 3600,
  );

  // A run that never parked has nothing to subtract.
  assert.equal(parkedSeconds([{ toState: "CREATED", at: at(0) }], now), 0);
});

test("the wall clock bounds working time, so a parked run outlives it", () => {
  const startedAt = new Date(Date.UTC(2026, 8, 22, 0, 0, 0));
  const now = new Date(startedAt.getTime() + 3 * HOUR);
  const rails = { spend_cap_usd: 25, wall_clock_cap_seconds: DEFAULT_WALL_CLOCK_CAP_SECONDS };

  // Three hours of *work* is past the two-hour cap. This is the rail doing its job.
  assert.equal(checkCaps({ rails, cost: 1, started_at: startedAt }, now), "wall_clock_cap");

  // Three hours of *waiting* is not. Same elapsed time, same cap, and the run survives — which
  // is the whole of #262 in one assertion.
  assert.equal(
    checkCaps({ rails, cost: 1, started_at: startedAt, parked_seconds: 3 * 3600 }, now),
    null,
  );

  // Parking exempts time, never money: a run that burned its budget before it parked is still
  // stopped, and stopped for the right reason.
  assert.equal(
    checkCaps({ rails, cost: 25, started_at: startedAt, parked_seconds: 3 * 3600 }, now),
    "spend_cap",
  );
});

test("the approval gate has its own deadline, and expiring is not failing", () => {
  const parkedAt = new Date(Date.UTC(2026, 8, 22, 0, 0, 0));
  const within = new Date(parkedAt.getTime() + 71 * HOUR);
  const past = new Date(parkedAt.getTime() + 73 * HOUR);

  assert.equal(checkApprovalDeadline(parkedAt, within), null);
  assert.equal(checkApprovalDeadline(parkedAt, past), "approval_expired");
  assert.equal(
    approvalDeadlineAt(parkedAt).toISOString(),
    new Date(parkedAt.getTime() + 72 * HOUR).toISOString(),
  );

  // CANCELLED, not FAILED. A run in the failed bucket invites someone to look for the defect,
  // and there isn't one — a person was asked and did not answer.
  assert.equal(terminalStateFor("approval_expired"), "CANCELLED");
  assert.equal(terminalStateFor("wall_clock_cap"), "FAILED");
});

test("the deadline is stated where a human meets it: in the criteria comment", () => {
  const parkedAt = new Date(Date.UTC(2026, 8, 22, 9, 30, 0));
  const body = criteriaApprovalComment(
    [{ id: "AC1", text: "retries a 500", source: { kind: "linked_issue", ref: "x" } }],
    { vendor: "anthropic", model: "claude-opus-5" },
    { at: approvalDeadlineAt(parkedAt), seconds: DEFAULT_APPROVAL_DEADLINE_SECONDS },
  );

  assert.match(body, /Approve by 2026-09-25 09:30 UTC/);
  assert.match(body, /3 days from now/);
  // The other half of the surprise: an operator who reads "you have three days" still needs to
  // know that waiting is free, or they will approve something unread to be safe.
  assert.match(body, /[Nn]othing is spent while it waits/);

  // Called without a deadline — the local path, where nothing parks — it says nothing about one
  // rather than inventing a date.
  const noDeadline = criteriaApprovalComment([], { vendor: "anthropic", model: "claude-opus-5" });
  assert.doesNotMatch(noDeadline, /Approve by/);
});

test("expiry is reported as what expired, never as a state name", () => {
  const body = approvalExpiredComment(DEFAULT_APPROVAL_DEADLINE_SECONDS);
  assert.match(body, /went unapproved for 3 days/);
  assert.match(body, /nothing was spent waiting/i);
  // The sentence #262 exists to stop: naming the machine's clock for a run that used none.
  assert.doesNotMatch(body, /wall.?clock/i);
  assert.doesNotMatch(body, /WAITING_FOR_APPROVAL|FAILED/);
});

// ---------------------------------------------------------------- driven as a run

function scripted(name, value) {
  const path = join(tempDir(name), `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

async function withSchema(fn) {
  const schema = `windkeel_window_test_${Date.now()}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    await fn(pool);
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

async function seed(pool) {
  const repository = await upsertRepository(pool, {
    owner: OWNER,
    name: NAME,
    defaultBranch: "trunk",
    cloneUrl: `https://github.com/${OWNER}/${NAME}.git`,
    githubInstallationId: 42,
  });
  const task = await insertEngineeringTask(pool, {
    repositoryId: repository.id,
    sourceType: "github_issue",
    sourceReference: `${OWNER}/${NAME}#7`,
    title: "Uploader retries are missing",
    description: "The uploader is broken.",
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
  return { repository, task, run };
}

function makeDeps(pool, github) {
  const sandboxes = new FakeSandboxProvider();
  return {
    pool,
    sandboxes,
    worker: new FakeWorkerAdapter([]),
    registry: new SandboxRegistry(),
    sessions: new WorkerSessionRegistry(),
    github,
    config: {
      repository: { url: "/nonexistent", baseRevision: "HEAD" },
      makerModel: "gpt-5-codex",
      makerVendor: "openai",
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
        maker: { vendor: "openai", model: "gpt-5-codex" },
        fakes: { criteria: scripted("criteria", GENERATED) },
      },
    },
  };
}

/** Drives the run to `WAITING_FOR_APPROVAL`, then rewrites history so it parked `ago` ago. */
async function parkFor(pool, deps, runId, ago) {
  const provider = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool) });
  for (const handler of createIntakeHandlers(deps)) provider.register(handler);
  provider.register(createProvisioningHandler(deps));
  await provider.start();
  await provider.startRun(runId);
  await provider.drain();
  assert.equal((await getEngineeringRun(pool, runId)).status, "WAITING_FOR_APPROVAL");

  // The run started and parked `ago` ago. Backdating the rows rather than injecting a clock is
  // what makes this a test of the query the handler actually runs.
  const then = new Date(Date.now() - ago);
  await pool.query("update engineering_run set started_at = $2 where id = $1", [runId, then]);
  await pool.query(
    `update run_state_transition set at = $2
      where engineering_run_id = $1 and to_state = 'WAITING_FOR_APPROVAL'`,
    [runId, then],
  );
  return provider;
}

test(
  "a run parked past its wall-clock cap is still approvable",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const { run } = await seed(pool);
      const github = new FakeGitHubClient({
        repositories: [{ owner: OWNER, name: NAME, issues: [{ number: 7 }] }],
      });
      const deps = makeDeps(pool, github);
      // Three hours: comfortably past the 7200 s cap that used to close this gate, and
      // comfortably inside the 72 h the gate now gets.
      const provider = await parkFor(pool, deps, run.id, 3 * HOUR);
      try {
        await provider.signal(run.id, { type: "approval_granted", actor: "jyothepro" });
        await provider.startRun(run.id);
        await provider.drain();

        const after = await getEngineeringRun(pool, run.id);
        assert.notEqual(after.stopReason, "wall_clock_cap", "the human is not on the machine's clock");
        assert.ok(
          ["PROVISIONING", "IMPLEMENTING", "FAILED"].includes(after.status),
          `expected the approval to release the run, got ${after.status} (${after.stopReason})`,
        );
      } finally {
        await provider.stop();
      }
    });
  },
);

test(
  "a gate that has genuinely gone stale is cancelled, and the issue is told why",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const { run } = await seed(pool);
      const github = new FakeGitHubClient({
        repositories: [{ owner: OWNER, name: NAME, issues: [{ number: 7 }] }],
      });
      const deps = makeDeps(pool, github);
      const provider = await parkFor(pool, deps, run.id, 4 * DAY);
      try {
        await provider.startRun(run.id);
        await provider.drain();

        const after = await getEngineeringRun(pool, run.id);
        assert.equal(after.status, "CANCELLED");
        assert.equal(after.stopReason, "approval_expired");

        const comments = github.commentsOn({ owner: OWNER, name: NAME }, 7);
        const last = comments[comments.length - 1].body;
        assert.match(last, /went unapproved/i);
        assert.doesNotMatch(last, /wall.?clock/i);
      } finally {
        await provider.stop();
      }
    });
  },
);

test(
  "/windkeel approve after the gate closed says what expired, instead of nothing at all",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const { repository, run } = await seed(pool);
      const github = new FakeGitHubClient({
        repositories: [{ owner: OWNER, name: NAME, issues: [{ number: 7 }] }],
      });
      const deps = makeDeps(pool, github);
      const provider = await parkFor(pool, deps, run.id, 4 * DAY);
      try {
        await provider.startRun(run.id);
        await provider.drain();
        assert.equal((await getEngineeringRun(pool, run.id)).stopReason, "approval_expired");

        const before = github.commentsOn({ owner: OWNER, name: NAME }, 7).length;
        const result = await applyIssueCommand(
          { db: pool, github, control: provider },
          {
            repository: { id: repository.id, owner: OWNER, name: NAME },
            issueNumber: 7,
            actor: "jyothepro",
            authority: { via: "github_permission", permission: "admin" },
            command: "approve",
          },
        );
        await result.afterCommit();

        assert.equal(result.outcome.kind, "ignored");
        const comments = github.commentsOn({ owner: OWNER, name: NAME }, 7);
        assert.equal(comments.length, before + 1, "an approval that missed its window gets an answer");
        assert.match(comments[comments.length - 1].body, /Too late to approve/);
        // The sentence the operator used to get was about a state. It is now about the gate.
        assert.doesNotMatch(comments[comments.length - 1].body, /WAITING_FOR_APPROVAL/);
      } finally {
        await provider.stop();
      }
    });
  },
);
