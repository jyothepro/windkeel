import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeGitHubClient } from "../dist/github/fake.js";
import { applyPullRequestClosed } from "../dist/factory/pull-request-events.js";
import { upsertRepository } from "../dist/factory/repository-entity.js";
import {
  getEngineeringRun,
  getEngineeringTask,
  insertEngineeringRun,
  insertEngineeringTask,
  insertVerificationRun,
  updateVerificationRun,
} from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { FakeWorkflowProvider } from "../dist/factory/workflow/fake.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { runBranchFor, assertRunBranch, slugify } from "../dist/factory/workflow/branch.js";
import { createPullRequestHandlers } from "../dist/factory/workflow/handlers/pr-creating.js";
import { stickyMarker } from "../dist/github/summary.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * The output half of M6, driven as a run: PR_CREATING → PR_READY → WAITING_FOR_HUMAN →
 * COMPLETED. Postgres holds the state; `FakeGitHubClient` records every call, so idempotency is
 * asserted on what was *sent*, not on what came back.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
let serial = 0;

const OWNER = "jyothepro";
const NAME = "windkeel-fixture";
const REF = { owner: OWNER, name: NAME };
const CANDIDATE = "a".repeat(40);

async function withSchema(fn) {
  const schema = `windkeel_pr_test_${Date.now()}_${serial++}`;
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

/** A run that has verified and is sitting at PR_CREATING, exactly as VERIFYING leaves it. */
async function seedVerifiedRun(pool, { verdict = "pass", candidateSha = CANDIDATE } = {}) {
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
    description: "It gives up on the first 500.",
    acceptanceCriteria: [
      { id: "AC1", text: "retries a 500 three times", source: { kind: "linked_issue", ref: "x" } },
    ],
    riskLevel: "low",
    priority: null,
    status: "IN_PROGRESS",
  });
  const run = await insertEngineeringRun(pool, {
    taskId: task.id,
    spendCapUsd: 25,
    wallClockCapSeconds: 7200,
  });
  const verification = await insertVerificationRun(pool, {
    engineeringRunId: run.id,
    candidateSha,
    policyVersion: "windkeel@test",
  });
  await updateVerificationRun(pool, verification.id, {
    verdict,
    completedAt: new Date(),
    riskSummary: { blocking: [], nonBlocking: [], unsatisfied: [], satisfied: ["AC1"] },
  });
  for (const state of ["CLASSIFYING", "PLANNING", "PROVISIONING", "IMPLEMENTING", "VERIFYING", "PR_CREATING"]) {
    await advanceRun(pool, run.id, state, "test seed");
  }
  return { repository, task, run, verification };
}

function makeDeps(pool, github) {
  return {
    pool,
    github,
    sandboxes: { name: "unused", capabilities: {}, async create() { throw new Error("no sandbox here"); } },
    worker: {},
    registry: { get: () => undefined, put: () => {}, delete: () => {} },
    sessions: { get: () => undefined, put: () => {}, release: () => {} },
    config: {
      repository: { url: "/unused", baseRevision: "HEAD" },
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
      checkerModels: { endpoints: [] },
    },
  };
}

/**
 * Every branch the run asks about is at `branchHead` — the verified candidate, unless a test is
 * exercising the pin. `null` is a branch nobody pushed.
 */
function makeGitHub({ branchHead = CANDIDATE, pullRequests = [] } = {}) {
  return new FakeGitHubClient(
    {
      repositories: [
        {
          owner: OWNER,
          name: NAME,
          defaultBranch: "trunk",
          issues: [{ number: 7, labels: ["windkeel"] }],
          pullRequests,
        },
      ],
    },
    { resolveBranchHead: () => branchHead },
  );
}

async function drive(pool, deps, runId) {
  const provider = new FakeWorkflowProvider({ store: new PostgresRunStateStore(pool) });
  for (const handler of createPullRequestHandlers(deps)) provider.register(handler);
  await provider.start();
  await provider.startRun(runId);
  await provider.drain();
  return provider;
}

// --- The branch convention (ADR-0019) ---

test("a GitHub-sourced branch names the issue and the run; the local one does not", () => {
  const runId = "6f1c2b9e-1111-2222-3333-444444444444";
  const task = { sourceType: "github_issue", sourceReference: "o/r#7", title: "Uploader retries are missing" };
  assert.equal(runBranchFor(runId, task), "windkeel/issue-7-uploader-retries-are-missing-6f1c2b9e");
  assert.equal(runBranchFor(runId, null), `windkeel/run/${runId}`);

  // ADR-0009 §3 allows a second run on the same task; the discriminator is what stops it from
  // pushing onto the first run's branch.
  const other = runBranchFor("aaaaaaaa-1111-2222-3333-444444444444", task);
  assert.notEqual(other, runBranchFor(runId, task));
});

test("the guard still refuses anything but the computed branch", () => {
  const runId = "6f1c2b9e-1111-2222-3333-444444444444";
  const task = { sourceType: "github_issue", sourceReference: "o/r#7", title: "t" };
  assertRunBranch(runBranchFor(runId, task), runId, task);
  assert.throws(() => assertRunBranch("main", runId, task), /may only write/);
  assert.throws(() => assertRunBranch("windkeel/issue-7-t-deadbeef", runId, task), /may only write/);
  assert.equal(slugify("  A Title!! "), "a-title");
  assert.equal(slugify("!!!"), "task");
});

// --- The happy path ---

test("a verified run opens one draft PR, one check run, one sticky comment", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run, task } = await seedVerifiedRun(pool);
    const github = makeGitHub();
    const provider = await drive(pool, makeDeps(pool, github), run.id);
    try {
      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "WAITING_FOR_HUMAN", "the happy path reaches a human");
      assert.ok(after.prNumber, "pr_number is persisted");

      const pulls = await github.listPullRequests({ repository: REF, state: "all" });
      assert.equal(pulls.length, 1);
      assert.equal(pulls[0].draft, true, "ADR-0009 §5: always draft");
      assert.equal(pulls[0].baseRef, "trunk", "cut against the repository's default branch");
      assert.equal(pulls[0].headRef, runBranchFor(run.id, task));
      assert.match(pulls[0].body, /WINDKEEL RESULT/);
      assert.match(pulls[0].body, /Resolves #7/);
      assert.equal(pulls[0].title, "Uploader retries are missing");

      const checks = github.checkRunsFor(REF, CANDIDATE);
      assert.equal(checks.length, 1);
      assert.equal(checks[0].name, "windkeel/verification");
      assert.equal(checks[0].conclusion, "success");

      const sticky = github.commentsOn(REF, pulls[0].number);
      assert.equal(sticky.length, 1);
      assert.ok(sticky[0].body.startsWith(stickyMarker(run.id)));

      // ADR-0009 §4: the issue hears once, at the end.
      const issueComments = github.commentsOn(REF, 7);
      assert.equal(issueComments.length, 1);
      assert.match(issueComments[0].body, /Draft pull request #\d+ is open/);

      const storedTask = await getEngineeringTask(pool, task.id);
      assert.equal(storedTask.status, "WAITING_FOR_HUMAN");
    } finally {
      await provider.stop();
    }
  });
});

test("a second delivery adopts the PR instead of opening another", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run } = await seedVerifiedRun(pool);
    const github = makeGitHub();
    const deps = makeDeps(pool, github);
    const provider = await drive(pool, deps, run.id);
    try {
      // Re-run PR_CREATING against a run that has already been through it.
      await pool.query("update engineering_run set status = 'PR_CREATING' where id = $1", [run.id]);
      await provider.startRun(run.id);
      await provider.drain();

      const created = github.calls.filter((c) => c.type === "createPullRequest");
      assert.equal(created.length, 1, "one PR, however many deliveries");
      const pulls = await github.listPullRequests({ repository: REF, state: "all" });
      assert.equal(pulls.length, 1);

      // The check run is updated on the same SHA, never duplicated.
      assert.equal(github.checkRunsFor(REF, CANDIDATE).length, 1);
      assert.ok(github.calls.some((c) => c.type === "updateCheckRun"));

      // And the sticky comment is edited, not re-posted.
      assert.equal(github.commentsOn(REF, pulls[0].number).length, 1);
      assert.ok(github.calls.some((c) => c.type === "updateIssueComment"));
    } finally {
      await provider.stop();
    }
  });
});

test("a warn verdict still opens the PR, with a neutral check run", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run } = await seedVerifiedRun(pool, { verdict: "warn" });
    const github = makeGitHub();
    const provider = await drive(pool, makeDeps(pool, github), run.id);
    try {
      assert.equal(github.checkRunsFor(REF, CANDIDATE)[0].conclusion, "neutral");
      const pulls = await github.listPullRequests({ repository: REF, state: "all" });
      assert.equal(pulls.length, 1);
      assert.match(pulls[0].body, /Verdict of record\s+WARN/);
    } finally {
      await provider.stop();
    }
  });
});

test("nothing in this path can mark ready, approve, or merge", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run } = await seedVerifiedRun(pool);
    const github = makeGitHub();
    const provider = await drive(pool, makeDeps(pool, github), run.id);
    try {
      // The capabilities are unrepresentable on the client (M6.1), so the assertion is that the
      // stage never reached for the tripwire either.
      assert.ok(!github.calls.some((c) => c.type === "refuse"));
      assert.equal(typeof github.mergePullRequest, "undefined");
    } finally {
      await provider.stop();
    }
  });
});

// --- Failure paths (ADR-0009 §6) ---

test("a lost Pull-requests permission fails the run with the reason recorded", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run } = await seedVerifiedRun(pool);
    const github = makeGitHub();
    github.revokePermission(REF, "pull_requests");
    const provider = await drive(pool, makeDeps(pool, github), run.id);
    try {
      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "FAILED");
      assert.equal(after.stopReason, "error");
      const { rows } = await pool.query(
        "select reason from run_state_transition where engineering_run_id = $1 and to_state = 'FAILED'",
        [run.id],
      );
      assert.match(rows[0].reason, /permissions changed mid-run/);
      // Asserted on the calls, not by reading back: with the permission revoked, a read would
      // fail too, and the property that matters is that nothing was *created*.
      assert.ok(
        !github.calls.some((c) => c.type === "createPullRequest"),
        "no half-created pull request left behind",
      );
    } finally {
      await provider.stop();
    }
  });
});

// --- The pin: the PR is opened only at the commit verification judged ---

async function failedReason(pool, runId) {
  const { rows } = await pool.query(
    "select reason from run_state_transition where engineering_run_id = $1 and to_state = 'FAILED'",
    [runId],
  );
  return rows[0]?.reason ?? null;
}

test("a branch that moved after verification opens no pull request", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run } = await seedVerifiedRun(pool);
    // Something pushed over the verified candidate — a leaked maker token, or anyone else with
    // push access — between VERIFYING and this stage.
    const moved = "b".repeat(40);
    const github = makeGitHub({ branchHead: moved });
    const provider = await drive(pool, makeDeps(pool, github), run.id);
    try {
      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "FAILED");
      assert.equal(after.stopReason, "error");
      const reason = await failedReason(pool, run.id);
      assert.match(reason, new RegExp(`is at ${moved}, not at ${CANDIDATE}`), "both SHAs, by name");
      assert.match(reason, /no pull request was opened/);

      // The order is the property: the ref was read, and nothing was created after it.
      assert.ok(github.calls.some((c) => c.type === "getBranchHead"));
      for (const type of ["createPullRequest", "createCheckRun", "createIssueComment"]) {
        assert.ok(!github.calls.some((c) => c.type === type), `no ${type} for an unverified head`);
      }
      assert.equal(after.prNumber, null);
    } finally {
      await provider.stop();
    }
  });
});

test("a run branch that does not exist on the remote opens no pull request", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run } = await seedVerifiedRun(pool);
    const github = makeGitHub({ branchHead: null });
    const provider = await drive(pool, makeDeps(pool, github), run.id);
    try {
      assert.equal((await getEngineeringRun(pool, run.id)).status, "FAILED");
      assert.match(await failedReason(pool, run.id), /does not exist on the remote/);
      assert.ok(!github.calls.some((c) => c.type === "createPullRequest"));
    } finally {
      await provider.stop();
    }
  });
});

test("an existing PR whose head is not the verified commit is not adopted", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run, task } = await seedVerifiedRun(pool);
    // The branch ref agrees with verification, but an open PR for it reports another head: the
    // adopt path is held to the same rule as the create path, not trusted because it exists.
    const github = makeGitHub({
      pullRequests: [{ number: 41, headRef: runBranchFor(run.id, task), headSha: "c".repeat(40) }],
    });
    const provider = await drive(pool, makeDeps(pool, github), run.id);
    try {
      assert.equal((await getEngineeringRun(pool, run.id)).status, "FAILED");
      const reason = await failedReason(pool, run.id);
      assert.match(reason, /#41 carries that unverified head/);
      assert.ok(!github.calls.some((c) => c.type === "createCheckRun"), "no verdict attached to it");
      assert.ok(!github.calls.some((c) => c.type === "createIssueComment"));
    } finally {
      await provider.stop();
    }
  });
});

test("a run whose repository row is gone fails rather than guessing", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run, task } = await seedVerifiedRun(pool);
    // `migrations/0010`'s foreign key makes this state unreachable through the database, which
    // is the point of that migration. It is still reachable on a database that has not run
    // 0010, and this asserts the *handler's* refusal — the first line of defence the constraint
    // backs up rather than replaces. Dropped inside this throwaway schema only.
    await pool.query(
      "alter table engineering_task drop constraint engineering_task_repository_id_fkey",
    );
    await pool.query("update engineering_task set repository_id = $2 where id = $1", [
      task.id,
      "99999999-9999-9999-9999-999999999999",
    ]);
    const provider = await drive(pool, makeDeps(pool, makeGitHub()), run.id);
    try {
      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "FAILED");
    } finally {
      await provider.stop();
    }
  });
});

// --- The human's half ---

/** The ingress's half plus the signal: a human merged the pull request. */
async function mergeIt(pool, provider, repository, run, prNumber, mergedAt = "2026-09-06T13:00:00.000Z") {
  const signalled = [];
  const result = await applyPullRequestClosed(
    { db: pool, control: { async signal(id, signal) { signalled.push({ id, signal }); } } },
    { repositoryId: repository.id, pullNumber: prNumber, merged: true, mergedAt },
  );
  await result.afterCommit();
  await provider.signal(run.id, signalled[0].signal);
  await provider.drain();
}

test("a merged pull request drives the run to COMPLETED", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run, task, repository } = await seedVerifiedRun(pool);
    const github = makeGitHub();
    const deps = makeDeps(pool, github);
    const provider = await drive(pool, deps, run.id);
    try {
      const prNumber = (await getEngineeringRun(pool, run.id)).prNumber;

      // The ingress's half: find the run by pr_number and signal it.
      const signalled = [];
      const result = await applyPullRequestClosed(
        { db: pool, control: { async signal(id, signal) { signalled.push({ id, signal }); } } },
        { repositoryId: repository.id, pullNumber: prNumber, merged: true, mergedAt: "2026-09-06T13:00:00.000Z" },
      );
      await result.afterCommit();
      assert.equal(result.outcome.kind, "signalled");
      assert.equal(signalled[0].signal.name, "pull_request.closed");

      await provider.signal(run.id, signalled[0].signal);
      await provider.drain();

      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "COMPLETED", "the first run in this project's history to get here");
      assert.equal(after.prMergedAt.toISOString(), "2026-09-06T13:00:00.000Z");
      assert.equal((await getEngineeringTask(pool, task.id)).status, "COMPLETED");

      // ADR-0013's PR-outcome metrics read these columns; a merged run must be visible to them.
      const { rows } = await pool.query(
        "select count(*)::int as merged from engineering_run where pr_merged_at is not null",
      );
      assert.equal(rows[0].merged, 1);
    } finally {
      await provider.stop();
    }
  });
});

test(
  "a merge records the human commits the pull request actually carries (ADR-0013 §3)",
  { skip },
  async () => {
    await withSchema(async (pool) => {
      const { run, repository } = await seedVerifiedRun(pool);
      const github = makeGitHub();
      const provider = await drive(pool, makeDeps(pool, github), run.id);
      try {
        const prNumber = (await getEngineeringRun(pool, run.id)).prNumber;

        // Windkeel's candidate, Windkeel's repair (pushed after the PR opened — ADR-0017), a human's
        // fix, and a merge commit from the "Update branch" button. Exactly one of the four is
        // human rework, and every other one is a way the old code would have got it wrong.
        github.seedPullRequestCommits(REF, prNumber, [
          { sha: "1".repeat(40), authorEmail: "factory@windkeel.invalid", authoredAt: "2026-09-06T10:00:00Z" },
          { sha: "2".repeat(40), authorEmail: "factory@windkeel.invalid", authoredAt: "2026-09-06T12:00:00Z" },
          { sha: "3".repeat(40), authorEmail: "human@example.com", authorLogin: "someone", authoredAt: "2026-09-06T12:30:00Z" },
          { sha: "4".repeat(40), authorEmail: "human@example.com", authorLogin: "someone", parentCount: 2 },
        ]);

        await mergeIt(pool, provider, repository, run, prNumber);

        const after = await getEngineeringRun(pool, run.id);
        assert.equal(after.status, "COMPLETED");
        assert.equal(
          after.humanCommitsAfterPr,
          1,
          "the candidate and the repair are Windkeel's, the merge commit authors nothing, and one " +
            "human commit remains — the PR's total commit count would have said four",
        );

        const { rows } = await pool.query(
          "select reason from run_state_transition where engineering_run_id = $1 and to_state = 'COMPLETED'",
          [run.id],
        );
        assert.match(rows[0].reason, /1 human commit after it opened/);
      } finally {
        await provider.stop();
      }
    });
  },
);

test("a merge with no human commits records a measured zero, not an absence", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run, repository } = await seedVerifiedRun(pool);
    const github = makeGitHub();
    const provider = await drive(pool, makeDeps(pool, github), run.id);
    try {
      const prNumber = (await getEngineeringRun(pool, run.id)).prNumber;
      github.seedPullRequestCommits(REF, prNumber, [
        { sha: "1".repeat(40), authorEmail: "factory@windkeel.invalid" },
      ]);

      await mergeIt(pool, provider, repository, run, prNumber);

      // 0 and null are different facts as of migration 0009, and this is the one that means
      // "a human added nothing" rather than "nobody looked".
      assert.equal((await getEngineeringRun(pool, run.id)).humanCommitsAfterPr, 0);
      const clean = (await pool.query("select * from verified_work_merged_without_rework")).rows[0];
      assert.equal(clean.clean_merges, "1");
      assert.equal(clean.merged_unmeasured, "0");
    } finally {
      await provider.stop();
    }
  });
});

test("a merge whose commits cannot be read records null and says why", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run, repository } = await seedVerifiedRun(pool);
    const github = makeGitHub();
    const provider = await drive(pool, makeDeps(pool, github), run.id);
    try {
      const prNumber = (await getEngineeringRun(pool, run.id)).prNumber;
      github.injectFailure("listPullRequestCommits", {
        kind: "permissionDenied",
        permission: "pull_requests",
      });

      await mergeIt(pool, provider, repository, run, prNumber);

      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "COMPLETED", "an unreadable metric must not fail a merged run");
      assert.equal(
        after.humanCommitsAfterPr,
        null,
        "a wrong number is worse than a missing one; 0 here would be a lie the views repeat",
      );

      const { rows } = await pool.query(
        "select reason from run_state_transition where engineering_run_id = $1 and to_state = 'COMPLETED'",
        [run.id],
      );
      assert.match(rows[0].reason, /human commits after it opened are unknown/);

      const clean = (await pool.query("select * from verified_work_merged_without_rework")).rows[0];
      assert.equal(clean.merged_unmeasured, "1");
      assert.equal(clean.clean_merges, "0", "an unmeasured merge is not a clean merge");
    } finally {
      await provider.stop();
    }
  });
});

test("a redelivered pull_request.closed does not change the recorded count", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run, repository } = await seedVerifiedRun(pool);
    const github = makeGitHub();
    const provider = await drive(pool, makeDeps(pool, github), run.id);
    try {
      const prNumber = (await getEngineeringRun(pool, run.id)).prNumber;
      github.seedPullRequestCommits(REF, prNumber, [
        { sha: "1".repeat(40), authorEmail: "human@example.com", authorLogin: "someone" },
      ]);

      await mergeIt(pool, provider, repository, run, prNumber);
      const first = await getEngineeringRun(pool, run.id);
      assert.equal(first.humanCommitsAfterPr, 1);

      // GitHub redelivers. The run is terminal, so the ingress refuses the second delivery
      // before it can reach a handler — the count cannot drift, and no second API call is made.
      const before = github.calls.filter((c) => c.type === "listPullRequestCommits").length;
      const again = await applyPullRequestClosed(
        { db: pool, control: { async signal() { throw new Error("must not signal a terminal run"); } } },
        { repositoryId: repository.id, pullNumber: prNumber, merged: true },
      );
      await again.afterCommit();

      assert.equal(again.outcome.kind, "ignored");
      assert.match(again.outcome.reason, /already COMPLETED/);
      assert.equal(
        github.calls.filter((c) => c.type === "listPullRequestCommits").length,
        before,
        "a redelivery must not re-query GitHub for a metric that is already final",
      );
      assert.equal((await getEngineeringRun(pool, run.id)).humanCommitsAfterPr, 1);
    } finally {
      await provider.stop();
    }
  });
});

test("a pull request closed without merging cancels the run", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run, repository } = await seedVerifiedRun(pool);
    const github = makeGitHub();
    const provider = await drive(pool, makeDeps(pool, github), run.id);
    try {
      const prNumber = (await getEngineeringRun(pool, run.id)).prNumber;
      const result = await applyPullRequestClosed(
        { db: pool, control: { async signal() {} } },
        { repositoryId: repository.id, pullNumber: prNumber, merged: false },
      );
      await result.afterCommit();
      await provider.signal(run.id, {
        type: "external_event",
        source: "github",
        name: "pull_request.closed",
        payload: { merged: false, pullNumber: prNumber },
      });
      await provider.drain();

      const after = await getEngineeringRun(pool, run.id);
      assert.equal(after.status, "CANCELLED");
      const { rows } = await pool.query(
        "select reason from run_state_transition where engineering_run_id = $1 and to_state = 'CANCELLED'",
        [run.id],
      );
      assert.match(rows[0].reason, /closed without merging/);
    } finally {
      await provider.stop();
    }
  });
});

test("a pull_request.closed for a PR Windkeel never opened is ignored", { skip }, async () => {
  await withSchema(async (pool) => {
    const { repository } = await seedVerifiedRun(pool);
    const result = await applyPullRequestClosed(
      { db: pool, control: { async signal() { throw new Error("must not signal"); } } },
      { repositoryId: repository.id, pullNumber: 4242, merged: true },
    );
    await result.afterCommit();
    assert.equal(result.outcome.kind, "ignored");
    assert.match(result.outcome.reason, /no Windkeel run opened/);
  });
});

test("waiting for a human parks the run rather than spinning", { skip }, async () => {
  await withSchema(async (pool) => {
    const { run } = await seedVerifiedRun(pool);
    const github = makeGitHub();
    const provider = await drive(pool, makeDeps(pool, github), run.id);
    try {
      // No signal has arrived: the run sits at WAITING_FOR_HUMAN with no further transition.
      const before = await pool.query(
        "select count(*)::int as n from run_state_transition where engineering_run_id = $1",
        [run.id],
      );
      await provider.startRun(run.id);
      await provider.drain();
      const after = await pool.query(
        "select count(*)::int as n from run_state_transition where engineering_run_id = $1",
        [run.id],
      );
      assert.equal(after.rows[0].n, before.rows[0].n, "a wait makes no transition");
      assert.equal((await getEngineeringRun(pool, run.id)).status, "WAITING_FOR_HUMAN");
    } finally {
      await provider.stop();
    }
  });
});
