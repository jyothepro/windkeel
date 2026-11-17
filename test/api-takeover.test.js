import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { createApiToken, PERMISSIONS } from "../dist/factory/tenancy.js";
import { FakeHumanWorkspaceProvider } from "../dist/sandbox/human-workspace.js";
import { liveHumanSession, updateHumanSession } from "../dist/factory/human-session.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * The four intents (ADR-0029 §3–4, #369): `takeover`, `submit`, `handback`, `workspace/session`.
 * Intents under ADR-0023's shape — 202 or a named 409 — behind `WINDKEEL_TAKEOVER`, needing
 * `runs.takeover`. And the capability token: returned once, in a URL fragment, `no-store`, and only
 * its hash ever reaches the sandbox.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const TOKEN = "test-operator-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

async function withApi(fn, { enabled = true } = {}) {
  const schema = `windkeel_takeover_api_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const workspaces = new FakeHumanWorkspaceProvider();
  try {
    await seedFixtureRepository(pool);
    const task = await insertEngineeringTask(pool, {
      repositoryId: REPO_ID,
      sourceType: "local",
      sourceReference: "ia-369",
      title: "t",
      description: "d",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    const wakes = [];
    const deps = {
      pool,
      control: {
        wake: async (runId, intent, actor) => wakes.push({ runId, intent, actor }),
        enqueue: async () => ({ enqueued: true }),
      },
      ...(enabled ? { takeover: { enabled: true, workspaces: async () => workspaces } } : {}),
    };
    const auth = { token: TOKEN, subject: "operator" };
    const call = async (method, path, bearer = TOKEN, body) =>
      handleApiRequest(deps, auth, {
        method,
        path,
        query: { get: () => undefined },
        headers: { authorization: `Bearer ${bearer}` },
        ...(body ? { body } : {}),
      });
    const operator = (await pool.query("select id from principal where is_bootstrap")).rows[0].id;
    const setState = (status) => pool.query("update engineering_run set status = $1 where id = $2", [status, run.id]);
    const linkGithub = () =>
      pool.query("update principal set github_user_id = 583231, github_login = 'octocat' where is_bootstrap");
    await fn({ pool, run, task, call, setState, linkGithub, operator, wakes, workspaces });
  } finally {
    workspaces.cleanup();
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

const POST = (call, runId, intent, bearer) => call("POST", `/v1/runs/${runId}/${intent}`, bearer);

test("off by default: every intent is 409 takeover_disabled, and the run read says so", { skip }, async () => {
  await withApi(
    async ({ run, call, setState, linkGithub }) => {
      await linkGithub();
      await setState("IMPLEMENTING");
      for (const intent of ["takeover", "submit", "handback", "workspace/session"]) {
        const result = await POST(call, run.id, intent);
        assert.equal(result.status, 409, intent);
        assert.equal(result.body.code, "takeover_disabled", intent);
      }
      const read = await call("GET", `/v1/runs/${run.id}`);
      assert.equal(read.body.takeover.enabled, false);
      assert.deepEqual(read.body.candidates, []);
      assert.equal((await call("GET", "/v1/self")).body.features.takeover, false);
      const pair = await call("POST", "/v1/tasks", TOKEN, { repositoryId: REPO_ID, title: "t", description: "d", mode: "pair" });
      assert.equal(pair.status, 409);
      assert.equal(pair.body.code, "takeover_disabled");
    },
    { enabled: false },
  );
});

test("runs.takeover is required, and Admin and Member hold it", { skip }, async () => {
  await withApi(async ({ pool, run, call, setState, operator }) => {
    await setState("IMPLEMENTING");
    const { secret } = await createApiToken(pool, {
      name: "no takeover",
      ownerPrincipalId: operator,
      createdByPrincipalId: operator,
      organizationId: null,
      permissions: ["runs.read", "runs.write"],
      ceiling: PERMISSIONS,
    });
    for (const intent of ["takeover", "submit", "handback", "workspace/session"]) {
      const result = await POST(call, run.id, intent, secret);
      assert.equal(result.status, 403, intent);
      assert.equal(result.body.missing, "runs.takeover");
    }
    const roles = Object.fromEntries((await pool.query("select key, permissions from access_role where account_id is null")).rows.map((r) => [r.key, r.permissions]));
    assert.ok(roles.admin.includes("runs.takeover"));
    assert.ok(roles.member.includes("runs.takeover"));
    assert.ok(!roles.viewer.includes("runs.takeover"));
  });
});

test("take over: only while IMPLEMENTING or REPAIRING (make changes on a PR), never while VERIFYING, and as a GitHub-linked person", { skip }, async () => {
  await withApi(async ({ pool, run, call, setState, linkGithub, wakes }) => {
    await setState("VERIFYING");
    let result = await POST(call, run.id, "takeover");
    assert.deepEqual([result.status, result.body.code], [409, "not_takeover_state"]);
    assert.match(result.body.error, /verification/);
    await setState("PROVISIONING");
    assert.equal((await POST(call, run.id, "takeover")).body.code, "not_takeover_state");
    await setState("COMPLETED");
    assert.equal((await POST(call, run.id, "takeover")).body.code, "run_terminal");

    await setState("IMPLEMENTING");
    result = await POST(call, run.id, "takeover");
    assert.deepEqual([result.status, result.body.code], [409, "no_github_identity"]);

    await linkGithub();
    result = await POST(call, run.id, "takeover");
    assert.equal(result.status, 202);
    assert.equal(result.body.accepted, true);
    assert.equal(result.body.outcome, "queued");
    assert.ok(result.body.cursor !== undefined);
    assert.deepEqual(wakes.map((w) => w.intent), ["takeover"]);
    const session = await liveHumanSession(pool, run.id);
    assert.deepEqual([session.origin, session.state, session.githubLogin], ["takeover", "requested", "octocat"]);

    result = await POST(call, run.id, "takeover");
    assert.deepEqual([result.status, result.body.code], [409, "already_editing"]);

    const read = await call("GET", `/v1/runs/${run.id}`);
    assert.equal(read.body.takeover.enabled, true);
    assert.equal(read.body.takeover.session.yours, true);
    assert.equal(read.body.takeover.session.canHandBack, true);
    assert.deepEqual(read.body.takeover.cycles, { used: 0, cap: 10 });
    assert.equal((await call("GET", "/v1/self")).body.features.takeover, true);
  });
});

test("the human cycle cap refuses another take over", { skip }, async () => {
  await withApi(async ({ pool, run, call, setState, linkGithub }) => {
    await linkGithub();
    await setState("WAITING_FOR_HUMAN");
    await pool.query("update engineering_run set human_cycles = human_cycles_cap where id = $1", [run.id]);
    const result = await POST(call, run.id, "takeover");
    assert.deepEqual([result.status, result.body.code], [409, "human_cycle_cap"]);
    await pool.query("update engineering_run set human_cycles = 9 where id = $1", [run.id]);
    const ok = await POST(call, run.id, "takeover");
    assert.equal(ok.status, 202);
    assert.equal(ok.body.outcome, "making_changes", "on a verified PR, take over is Make changes");
  });
});

test("submit and hand back: only the editor, only once the workspace is ready, one at a time; no hand back without a maker", { skip }, async () => {
  await withApi(async ({ pool, run, call, setState, linkGithub, operator, wakes }) => {
    await linkGithub();
    assert.equal((await POST(call, run.id, "submit")).body.code, "not_editing");
    await setState("IMPLEMENTING");
    await POST(call, run.id, "takeover");
    await setState("HUMAN_EDITING");
    assert.equal((await POST(call, run.id, "submit")).body.code, "workspace_not_ready");

    const session = await liveHumanSession(pool, run.id);
    await updateHumanSession(pool, session.id, { state: "ready", sandboxName: "x" });

    // Someone else in the organization.
    const { rows } = await pool.query(
      `insert into principal (account_id, kind, display_name, github_user_id, github_login)
         select account_id, 'user', 'mona', 9919, 'mona' from organization where is_default returning id`,
    );
    const mona = rows[0].id;
    await pool.query(
      `insert into membership (organization_id, principal_id, access_role_id)
         select o.id, $1, r.id from organization o, access_role r where o.is_default and r.key = 'member' and r.account_id is null`,
      [mona],
    );
    const { secret } = await createApiToken(pool, {
      name: "mona",
      ownerPrincipalId: mona,
      createdByPrincipalId: mona,
      organizationId: null,
      permissions: ["runs.read", "runs.takeover"],
      ceiling: PERMISSIONS,
    });
    for (const intent of ["submit", "handback", "workspace/session"]) {
      const refused = await POST(call, run.id, intent, secret);
      assert.deepEqual([refused.status, refused.body.code], [409, "not_your_session"], intent);
    }
    assert.equal((await call("GET", `/v1/runs/${run.id}`, secret)).body.takeover.session.yours, false);

    const submitted = await POST(call, run.id, "submit");
    assert.equal(submitted.status, 202);
    assert.equal(submitted.body.outcome, "queued");
    assert.equal((await POST(call, run.id, "handback")).body.code, "intent_pending");
    assert.equal((await liveHumanSession(pool, run.id)).intent, "submit");
    assert.deepEqual(wakes.map((w) => w.intent), ["takeover", "submit"]);

    // A Make changes session has no maker to hand back to.
    await updateHumanSession(pool, session.id, { intent: null });
    await pool.query("update human_session set origin = 'make_changes' where id = $1", [session.id]);
    assert.equal((await POST(call, run.id, "handback")).body.code, "no_maker");
    assert.equal((await call("GET", `/v1/runs/${run.id}`)).body.takeover.session.canHandBack, false);
    void operator;
  });
});

test("workspace/session: a fresh token in the URL fragment, no-store, and only its SHA-256 reaches the sandbox", { skip }, async () => {
  await withApi(async ({ pool, run, call, setState, linkGithub, workspaces }) => {
    await linkGithub();
    await setState("IMPLEMENTING");
    await POST(call, run.id, "takeover");
    await setState("HUMAN_EDITING");

    // A real fake workspace, as the HUMAN_EDITING tick would have left it.
    const root = mkdtempSync(join(tmpdir(), "windkeel-ws-api-"));
    git(root, "init", "-q", "work");
    writeFileSync(join(root, "work", "a"), "a\n");
    git(join(root, "work"), "add", "-A");
    git(join(root, "work"), "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-q", "-m", "c");
    const base = git(join(root, "work"), "rev-parse", "HEAD");
    const handle = await workspaces.create({ repoUrl: join(root, "work"), baseSha: base, timeoutMs: 1000 });
    const session = await liveHumanSession(pool, run.id);
    await updateHumanSession(pool, session.id, { state: "sleeping", sandboxName: handle.name, startedAt: new Date() });

    const opened = await POST(call, run.id, "workspace/session");
    assert.equal(opened.status, 202);
    assert.equal(opened.headers["cache-control"], "no-store");
    const url = new URL(opened.body.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.pathname, "/__windkeel/open");
    assert.equal(url.search, "", "never in a query string");
    const token = url.hash.replace(/^#t=/, "");
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(Date.parse(opened.body.expiresAt) > Date.now());

    assert.equal(handle.server.tokenSha256, createHash("sha256").update(token).digest("hex"), "the server got the hash");
    assert.ok(handle.events.includes("woke"), "a sleeping workspace is woken");
    const inVm = handle.contains(token);
    assert.deepEqual([inVm.files, inVm.envs], [[], []], "the token itself is nowhere in the workspace");
    const stored = JSON.stringify((await pool.query("select * from human_session")).rows);
    assert.ok(!stored.includes(token), "the token is not stored");
    assert.equal((await liveHumanSession(pool, run.id)).state, "ready");

    const again = await POST(call, run.id, "workspace/session");
    assert.notEqual(new URL(again.body.url).hash, url.hash, "every open mints a new token (and the restart revokes the old)");
  });
});

test("Pair mode is a task's mode, stored for the person who asked", { skip }, async () => {
  await withApi(async ({ pool, call, operator, linkGithub }) => {
    await linkGithub();
    const bad = await call("POST", "/v1/tasks", TOKEN, { repositoryId: REPO_ID, title: "t", description: "d", mode: "solo" });
    assert.deepEqual([bad.status, bad.body.code], [400, "invalid_mode"]);
    const created = await call("POST", "/v1/tasks", TOKEN, { repositoryId: REPO_ID, title: "Pair", description: "Make it so.", mode: "pair" });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const { rows } = await pool.query("select session_mode, pair_principal_id from engineering_task where id = $1", [created.body.taskId]);
    assert.deepEqual(rows[0], { session_mode: "pair", pair_principal_id: operator });
  });
});

test("Pair mode needs runs.takeover, refused by name when the task is created", { skip }, async () => {
  await withApi(async ({ pool, call, operator, linkGithub }) => {
    await linkGithub();
    const { secret } = await createApiToken(pool, {
      name: "write but no takeover",
      ownerPrincipalId: operator,
      createdByPrincipalId: operator,
      organizationId: null,
      permissions: ["runs.read", "runs.write"],
      ceiling: PERMISSIONS,
    });
    const refused = await call("POST", "/v1/tasks", secret, { repositoryId: REPO_ID, title: "Pair", description: "Make it so.", mode: "pair" });
    assert.deepEqual([refused.status, refused.body.code, refused.body.missing], [403, "forbidden", "runs.takeover"]);
    assert.equal((await pool.query("select count(*)::int as n from engineering_task where session_mode = 'pair'")).rows[0].n, 0, "no task was written");
    const autonomous = await call("POST", "/v1/tasks", secret, { repositoryId: REPO_ID, title: "Auto", description: "Make it so." });
    assert.equal(autonomous.status, 202, "runs.write alone still creates an autonomous task");
  });
});

test("Pair mode needs a linked GitHub identity (a service principal has none), refused like an explicit take over", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const refused = await call("POST", "/v1/tasks", TOKEN, { repositoryId: REPO_ID, title: "Pair", description: "Make it so.", mode: "pair" });
    assert.deepEqual([refused.status, refused.body.code], [409, "no_github_identity"]);
    assert.equal((await pool.query("select count(*)::int as n from engineering_task where session_mode = 'pair'")).rows[0].n, 0);
  });
});

test("take over waits on the run's row lock and re-reads the state: a turn that commits first wins, and the takeover is refused", { skip }, async () => {
  await withApi(async ({ pool, run, call, setState, linkGithub }) => {
    await linkGithub();
    await setState("IMPLEMENTING");
    // The turn boundary holds the row lock while it commits IMPLEMENTING -> VERIFYING.
    const boundary = await pool.connect();
    await boundary.query("begin");
    await boundary.query("select id from engineering_run where id = $1 for update", [run.id]);
    const pending = POST(call, run.id, "takeover");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await boundary.query("update engineering_run set status = 'VERIFYING' where id = $1", [run.id]);
    await boundary.query("commit");
    boundary.release();
    const result = await pending;
    assert.deepEqual([result.status, result.body.code], [409, "not_takeover_state"], "judged against the state after the boundary");
    assert.equal(await liveHumanSession(pool, run.id), null, "nothing was left to block a later session");
  });
});
