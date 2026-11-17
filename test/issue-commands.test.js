import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeGitHubClient } from "../dist/github/fake.js";
import {
  applyIssueCommand,
  authorizeCommenter,
  cancelRunForIssue,
  mayHoldWriteAccess,
} from "../dist/factory/issue-commands.js";
import { upsertRepository } from "../dist/factory/repository-entity.js";
import {
  insertEngineeringRun,
  insertEngineeringTask,
  updateEngineeringRun,
} from "../dist/factory/repositories.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
let serial = 0;

const OWNER = "jyothepro";
const NAME = "windkeel-fixture";

async function withSchema(fn) {
  const schema = `windkeel_cmd_test_${Date.now()}_${serial++}`;
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

async function seed(pool, { status } = {}) {
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
  if (status) await pool.query("update engineering_run set status = $2 where id = $1", [run.id, status]);
  return { repository, task, run };
}

function makeDeps(pool) {
  const github = new FakeGitHubClient({
    repositories: [{ owner: OWNER, name: NAME, issues: [{ number: 7 }] }],
  });
  const signals = [];
  const cancels = [];
  return {
    github,
    signals,
    cancels,
    deps: {
      db: pool,
      github,
      control: {
        async signal(runId, signal) {
          signals.push({ runId, signal });
        },
        async cancel(runId, reason) {
          cancels.push({ runId, reason });
        },
      },
    },
  };
}

const input = (repository, extra = {}) => ({
  repository: { id: repository.id, owner: OWNER, name: NAME },
  issueNumber: 7,
  actor: "jyothepro",
  authority: { via: "github_permission", permission: "write" },
  ...extra,
});

test("author_association is only a pre-filter: it can rule a commenter out, never in", () => {
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR", "collaborator"]) {
    assert.equal(mayHoldWriteAccess(association), true, association);
  }
  for (const association of ["CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "NONE", "MANNEQUIN", undefined]) {
    assert.equal(mayHoldWriteAccess(association), false, String(association));
  }
});

const REF = { owner: OWNER, name: NAME };
const commenter = (actor, authorAssociation = "MEMBER") => ({ repository: REF, actor, authorAssociation });

test("a MEMBER or COLLABORATOR whose GitHub role is read or triage cannot command a run", async () => {
  const github = new FakeGitHubClient({
    repositories: [
      {
        owner: OWNER,
        name: NAME,
        collaborators: {
          reader: { permission: "read", roleName: "read" },
          triager: { permission: "read", roleName: "triage" },
        },
      },
    ],
  });
  for (const [actor, association] of [
    ["reader", "MEMBER"],
    ["triager", "COLLABORATOR"],
    ["nobody-listed", "MEMBER"],
  ]) {
    const answer = await authorizeCommenter(github, commenter(actor, association));
    assert.equal(answer.ok, false, actor);
    assert.match(answer.reason, /not write/, actor);
  }
  assert.equal(github.calls.filter((c) => c.type === "getCollaboratorPermission").length, 3, "GitHub was asked each time");
});

test("write, maintain, admin and a custom role built on write may command a run", async () => {
  const github = new FakeGitHubClient({
    repositories: [
      {
        owner: OWNER,
        name: NAME,
        collaborators: {
          writer: { permission: "write", roleName: "write" },
          maintainer: { permission: "write", roleName: "maintain" },
          Admin: { permission: "admin", roleName: "admin" },
          custom: { permission: "write", roleName: "release-manager" },
        },
      },
    ],
  });
  assert.deepEqual(await authorizeCommenter(github, commenter("writer")), { ok: true, permission: "write" });
  assert.deepEqual(await authorizeCommenter(github, commenter("maintainer")), { ok: true, permission: "maintain" });
  assert.deepEqual(await authorizeCommenter(github, commenter("admin", "OWNER")), { ok: true, permission: "admin" });
  assert.deepEqual(await authorizeCommenter(github, commenter("custom")), { ok: true, permission: "write" });
});

test("a commenter the pre-filter rules out costs no API call", async () => {
  const github = new FakeGitHubClient({ repositories: [{ owner: OWNER, name: NAME }] });
  const answer = await authorizeCommenter(github, commenter("drive-by", "NONE"));
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /drive-by \(NONE\) cannot hold write access/);
  assert.deepEqual(github.calls, []);
});

test("a permission lookup that fails, or was never wired, fails closed", async () => {
  const github = new FakeGitHubClient({
    repositories: [{ owner: OWNER, name: NAME, collaborators: { writer: { permission: "write" } } }],
  });
  for (const failure of [
    { kind: "apiError", status: 502 },
    { kind: "rateLimited" },
    { kind: "permissionDenied", permission: "metadata" },
    { kind: "notFound" },
  ]) {
    github.injectFailure("getCollaboratorPermission", failure);
    const answer = await authorizeCommenter(github, commenter("writer"));
    assert.equal(answer.ok, false, failure.kind);
    assert.match(answer.reason, /could not confirm writer has write access/, failure.kind);
  }
  const unwired = await authorizeCommenter(undefined, commenter("writer"));
  assert.equal(unwired.ok, false);
  // And the same writer passes once GitHub answers.
  assert.equal((await authorizeCommenter(github, commenter("writer"))).ok, true);
});

test("/windkeel approve signals the run and acknowledges on the issue", { skip }, async () => {
  await withSchema(async (pool) => {
    const { repository, run } = await seed(pool, { status: "WAITING_FOR_APPROVAL" });
    const { deps, github, signals } = makeDeps(pool);

    const result = await applyIssueCommand(deps, input(repository, { command: "approve" }));
    await result.afterCommit();

    assert.equal(result.outcome.kind, "signalled");
    assert.equal(result.outcome.engineeringRunId, run.id);
    // A signal, never a state change: the ingress does not advance runs (ADR-0007 §2).
    assert.deepEqual(signals, [
      { runId: run.id, signal: { type: "approval_granted", actor: "jyothepro" } },
    ]);
    const comments = github.commentsOn({ owner: OWNER, name: NAME }, 7);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /Approved by @jyothepro/);
  });
});

test("/windkeel cancel latches the cancellation and posts the terminal note", { skip }, async () => {
  await withSchema(async (pool) => {
    const { repository, run } = await seed(pool, { status: "IMPLEMENTING" });
    const { deps, github, cancels, signals } = makeDeps(pool);

    const result = await applyIssueCommand(deps, input(repository, { command: "cancel" }));
    await result.afterCommit();

    assert.equal(result.outcome.kind, "cancelled");
    assert.deepEqual(signals, [], "cancellation is latched, not signalled (migrations/0003)");
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].runId, run.id);
    assert.match(cancels[0].reason, /\/windkeel cancel from jyothepro/);

    const comments = github.commentsOn({ owner: OWNER, name: NAME }, 7);
    assert.equal(comments.length, 1);
    // "stopping", not "stopped": a streaming stage is asked, never preempted.
    assert.match(comments[0].body, /is stopping/);
  });
});

test("removing the label cancels through the same path as /windkeel cancel", { skip }, async () => {
  await withSchema(async (pool) => {
    const { repository, run } = await seed(pool, { status: "IMPLEMENTING" });
    const { deps, github, cancels } = makeDeps(pool);

    // No authorisation check here on purpose: GitHub only lets someone with write access change
    // labels, so the event's existence is the authorisation. Note the authority is absent.
    const result = await cancelRunForIssue(
      deps,
      input(repository, { authority: undefined, actor: "someone-with-write" }),
    );
    await result.afterCommit();

    assert.equal(result.outcome.kind, "cancelled");
    assert.equal(cancels[0].runId, run.id);
    assert.match(cancels[0].reason, /label was removed/);
    assert.match(github.commentsOn({ owner: OWNER, name: NAME }, 7)[0].body, /is stopping/);
  });
});

test("a command from someone without write access changes nothing and says nothing", { skip }, async () => {
  await withSchema(async (pool) => {
    const { repository } = await seed(pool, { status: "WAITING_FOR_APPROVAL" });
    const { deps, github, signals, cancels } = makeDeps(pool);

    const result = await applyIssueCommand(
      deps,
      input(repository, {
        command: "approve",
        actor: "drive-by",
        authority: { via: "github_permission", permission: "read" },
      }),
    );
    await result.afterCommit();

    assert.equal(result.outcome.kind, "refused");
    assert.match(result.outcome.reason, /lacks write access/);

    // The pre-fix spelling — an association and no authority — has no meaning any more.
    const legacy = await applyIssueCommand(
      deps,
      input(repository, { command: "cancel", actor: "read-only-member", authority: undefined, authorAssociation: "MEMBER" }),
    );
    assert.equal(legacy.outcome.kind, "refused");
    assert.deepEqual(signals, []);
    assert.deepEqual(cancels, []);
    // Silent: answering would let anyone make the App post whatever they liked, as often as
    // they liked.
    assert.equal(github.commentsOn({ owner: OWNER, name: NAME }, 7).length, 0);
  });
});

test("a command for a run that is already terminal is a no-op with a reason", { skip }, async () => {
  await withSchema(async (pool) => {
    const { repository, run } = await seed(pool);
    await updateEngineeringRun(pool, run.id, { status: "COMPLETED" });
    const { deps, signals, cancels } = makeDeps(pool);

    const approve = await applyIssueCommand(deps, input(repository, { command: "approve" }));
    await approve.afterCommit();
    assert.equal(approve.outcome.kind, "ignored");
    assert.match(approve.outcome.reason, /already terminal/);

    const cancel = await cancelRunForIssue(deps, input(repository));
    await cancel.afterCommit();
    assert.equal(cancel.outcome.kind, "ignored");

    assert.deepEqual(signals, []);
    assert.deepEqual(cancels, []);
  });
});

test("a command on an issue Windkeel has never seen is a no-op with a reason", { skip }, async () => {
  await withSchema(async (pool) => {
    const repository = await upsertRepository(pool, {
      owner: OWNER,
      name: NAME,
      defaultBranch: "trunk",
      cloneUrl: "https://example/x.git",
      githubInstallationId: 42,
    });
    const { deps } = makeDeps(pool);
    const result = await applyIssueCommand(deps, input(repository, { command: "approve" }));
    assert.equal(result.outcome.kind, "ignored");
    assert.match(result.outcome.reason, /no Windkeel task/);
  });
});
