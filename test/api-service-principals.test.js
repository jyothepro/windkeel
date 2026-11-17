import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { runMigrations } from "../dist/factory/migrate.js";
import { createTaskAndRun } from "../dist/billing/admitted-runs.js";
import { getSystemActor, PERMISSIONS } from "../dist/factory/tenancy.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";

/**
 * Organization service principals and service tokens (ADR-0024 §6; M8-2).
 *
 * Against the real router and a real schema, because what is under test is the whole chain a
 * service token travels: hash lookup, its owner's membership, the token's narrowing, and the
 * organization boundary.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const BOOTSTRAP = "test-bootstrap-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";
const MONA = "session:sub-mona:9919:mona";
const HUBOT = "session:sub-hubot:480938:hubot";

const fakeSessions = {
  async verify(jwt) {
    const [kind, subject, id, login] = jwt.split(":");
    if (kind !== "session") return null;
    return { provider: "supabase", subject, githubUserId: Number(id), githubLogin: login, displayName: login };
  },
};

const fakeGithubUsers = {
  async lookup(login) {
    const known = { octocat: 583231, hubot: 480938, mona: 9919 };
    return known[login] ? { id: known[login], login } : null;
  },
};

async function freshSchema(prefix) {
  const schema = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await setup.query(`create schema ${schema}`);
  await setup.end();
  const pool = new Pool({ connectionString: dbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const drop = async () => {
    await pool.end();
    const teardown = new Pool({ connectionString: dbUrl, ...TEST_POOL });
    await teardown.query(`drop schema ${schema} cascade`);
    await teardown.end();
  };
  return { pool, drop };
}

async function withServicePrincipals(fn) {
  const { pool, drop } = await freshSchema("windkeel_sp_test");
  try {
    await runMigrations(pool, join(repoRoot, "migrations"));
    await seedFixtureRepository(pool);
    const deps = {
      pool,
      control: {
        approve: async () => ({ outcome: "signalled" }),
        cancel: async () => ({ outcome: "cancelled" }),
        message: async () => ({ outcome: "queued" }),
        listMessages: async () => [],
        startRun: async () => ({}),
        enqueue: async () => ({ enqueued: true }),
      },
      githubUsers: fakeGithubUsers,
      consoleUrl: "https://console.example",
    };
    const auth = { token: BOOTSTRAP, subject: "operator", sessions: fakeSessions };
    const call = (method, path, bearer = BOOTSTRAP, body) =>
      handleApiRequest(deps, auth, {
        method,
        path,
        query: { get: () => undefined },
        headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
        body,
      });
    const defaultOrg = (await pool.query("select id from organization where is_default")).rows[0].id;
    await fn({ pool, call, defaultOrg });
  } finally {
    await drop();
  }
}

/** Mona joins the default organization as `role`, and signs in once so she exists. */
async function join_(call, defaultOrg, login, session, role) {
  const invite = await call("POST", `/v1/orgs/${defaultOrg}/invitations`, BOOTSTRAP, { githubLogin: login, role });
  assert.equal(invite.status, 201);
  const self = await call("GET", "/v1/self", session);
  assert.equal(self.status, 200);
  return self.body.principal.id;
}

/** Everything written to the console or stdio while `fn` runs. */
async function captureLogs(fn) {
  const lines = [];
  const methods = ["log", "info", "warn", "error", "debug"];
  const saved = methods.map((m) => console[m]);
  const writes = [process.stdout.write, process.stderr.write];
  methods.forEach((m) => {
    console[m] = (...args) => lines.push(args.map(String).join(" "));
  });
  const tap = (original) =>
    function (chunk, ...rest) {
      lines.push(String(chunk));
      return original.call(this, chunk, ...rest);
    };
  process.stdout.write = tap(writes[0]);
  process.stderr.write = tap(writes[1]);
  try {
    await fn();
  } finally {
    methods.forEach((m, i) => {
      console[m] = saved[i];
    });
    process.stdout.write = writes[0];
    process.stderr.write = writes[1];
  }
  return lines.join("\n");
}

test("a service principal's token authenticates as the service principal, pinned to its organization", { skip }, async () => {
  await withServicePrincipals(async ({ call, defaultOrg }) => {
    const created = await call("POST", "/v1/service-principals", BOOTSTRAP, { name: "Slack intake", role: "member" });
    assert.equal(created.status, 201);
    const sp = created.body.servicePrincipal;
    assert.equal(sp.displayName, "Slack intake");
    assert.equal(sp.role, "member");
    assert.equal(sp.organizationId, defaultOrg);
    assert.equal(sp.system, false);

    const minted = await call("POST", `/v1/service-principals/${sp.id}/tokens`, BOOTSTRAP, { name: "slack" });
    assert.equal(minted.status, 201);
    assert.match(minted.body.secret, /^orq_/);
    assert.equal(minted.body.token.organizationId, defaultOrg, "a service token is always pinned");
    assert.equal(minted.body.token.ownerPrincipalId, sp.id);
    assert.deepEqual(minted.body.token.permissions.sort(), ["models.read", "playbooks.read", "runs.approve", "runs.read", "runs.takeover", "runs.write"]);

    const self = await call("GET", "/v1/self", minted.body.secret);
    assert.equal(self.status, 200);
    assert.equal(self.body.via, "token");
    assert.equal(self.body.principal.id, sp.id);
    assert.equal(self.body.principal.kind, "token");
    assert.equal(self.body.principal.displayName, "Slack intake");
    assert.deepEqual(self.body.organizations.map((o) => o.id), [defaultOrg]);

    // It acts as itself: a task it creates names it.
    const task = await call("POST", "/v1/tasks", minted.body.secret, {
      repositoryId: REPO_ID,
      title: "Fix the gauge",
      description: "- [ ] the gauge reads zero",
    });
    assert.equal(task.status, 202, JSON.stringify(task.body));

    // It is not a member a person manages, and it cannot mint its own tokens.
    const members = await call("GET", "/v1/members");
    assert.ok(!members.body.items.some((m) => m.principalId === sp.id));
    const own = await call("POST", "/v1/tokens", minted.body.secret, { name: "sneaky", preset: "read" });
    assert.equal(own.status, 403);
  });
});

test("a task a service token creates records the service principal as its creator", { skip }, async () => {
  await withServicePrincipals(async ({ pool, call }) => {
    const sp = (await call("POST", "/v1/service-principals", BOOTSTRAP, { name: "ci", role: "member" })).body.servicePrincipal;
    const { secret } = (await call("POST", `/v1/service-principals/${sp.id}/tokens`, BOOTSTRAP, { name: "ci" })).body;
    const created = await call("POST", "/v1/tasks", secret, {
      repositoryId: REPO_ID,
      title: "Fix it",
      description: "- [ ] fixed",
    });
    assert.equal(created.status, 202);
    const { rows } = await pool.query("select created_by_principal_id from engineering_task where id = $1", [
      created.body.taskId,
    ]);
    assert.equal(rows[0].created_by_principal_id, sp.id);
  });
});

test("a service token does not reach another organization", { skip }, async () => {
  await withServicePrincipals(async ({ pool, call, defaultOrg }) => {
    const { rows } = await pool.query(
      `insert into organization (account_id, name) select account_id, 'platform' from organization where is_default
       returning id`,
    );
    const otherOrg = rows[0].id;
    const sp = (await call("POST", `/v1/orgs/${defaultOrg}/service-principals`, BOOTSTRAP, { name: "bot", role: "admin" }))
      .body.servicePrincipal;
    const { secret } = (
      await call("POST", `/v1/orgs/${defaultOrg}/service-principals/${sp.id}/tokens`, BOOTSTRAP, {
        name: "bot",
        permissions: ["runs.read", "tokens.manage"],
      })
    ).body;

    assert.equal((await call("GET", `/v1/orgs/${defaultOrg}/runs`, secret)).status, 200);
    // Another organization does not exist for it: 404, as the tenancy tests expect.
    assert.equal((await call("GET", `/v1/orgs/${otherOrg}/runs`, secret)).status, 404);
    assert.equal((await call("GET", `/v1/orgs/${otherOrg}/service-principals`, secret)).status, 404);

    // And the other organization's service principals are not addressable from this one.
    const theirs = (await call("POST", `/v1/orgs/${otherOrg}/service-principals`, BOOTSTRAP, { name: "theirs" })).body
      .servicePrincipal;
    assert.equal((await call("POST", `/v1/orgs/${defaultOrg}/service-principals/${theirs.id}/tokens`, BOOTSTRAP, { name: "x" })).status, 404);
    assert.equal((await call("DELETE", `/v1/orgs/${defaultOrg}/service-principals/${theirs.id}`, BOOTSTRAP)).status, 404);
  });
});

test("removing the person who made a service token leaves the token working", { skip }, async () => {
  await withServicePrincipals(async ({ call, defaultOrg }) => {
    const monaId = await join_(call, defaultOrg, "mona", MONA, "admin");
    const sp = (await call("POST", "/v1/service-principals", MONA, { name: "nightly", role: "member" })).body.servicePrincipal;
    const minted = await call("POST", `/v1/service-principals/${sp.id}/tokens`, MONA, { name: "nightly" });
    assert.equal(minted.status, 201);
    assert.equal(minted.body.token.createdBy, monaId, "the creator is recorded, for audit");

    const removed = await call("POST", `/v1/members/${monaId}/delete`);
    assert.equal(removed.status, 200);
    assert.equal((await call("GET", "/v1/runs", MONA)).status, 403, "mona herself is out");

    const self = await call("GET", "/v1/self", minted.body.secret);
    assert.equal(self.status, 200);
    assert.equal(self.body.principal.id, sp.id);
    assert.equal((await call("GET", "/v1/runs", minted.body.secret)).status, 200);
  });
});

test("deleting a service principal revokes every token it holds", { skip }, async () => {
  await withServicePrincipals(async ({ call }) => {
    const sp = (await call("POST", "/v1/service-principals", BOOTSTRAP, { name: "linear" })).body.servicePrincipal;
    const one = (await call("POST", `/v1/service-principals/${sp.id}/tokens`, BOOTSTRAP, { name: "one" })).body.secret;
    const two = (await call("POST", `/v1/service-principals/${sp.id}/tokens`, BOOTSTRAP, { name: "two" })).body.secret;
    assert.equal((await call("GET", "/v1/self", one)).status, 200);

    const deleted = await call("DELETE", `/v1/service-principals/${sp.id}`);
    assert.equal(deleted.status, 200);
    assert.ok(deleted.body.servicePrincipal.deactivatedAt);

    for (const secret of [one, two]) {
      const refused = await call("GET", "/v1/self", secret);
      // 403, as every rejected credential is (api-tenancy: revoked and unknown are indistinguishable).
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, "forbidden");
    }
    const list = await call("GET", "/v1/service-principals");
    assert.ok(!list.body.items.some((p) => p.id === sp.id));
    assert.equal((await call("DELETE", `/v1/service-principals/${sp.id}`)).status, 404, "deleting twice is 404");
    assert.equal((await call("POST", `/v1/service-principals/${sp.id}/tokens`, BOOTSTRAP, { name: "three" })).status, 404);
  });
});

test("one token can be revoked on its own, by DELETE or by the revoke command", { skip }, async () => {
  await withServicePrincipals(async ({ call }) => {
    const sp = (await call("POST", "/v1/service-principals", BOOTSTRAP, { name: "jira" })).body.servicePrincipal;
    const a = (await call("POST", `/v1/service-principals/${sp.id}/tokens`, BOOTSTRAP, { name: "a" })).body;
    const b = (await call("POST", `/v1/service-principals/${sp.id}/tokens`, BOOTSTRAP, { name: "b" })).body;
    assert.equal((await call("DELETE", `/v1/service-principals/${sp.id}/tokens/${a.token.id}`)).status, 200);
    assert.equal((await call("GET", "/v1/self", a.secret)).status, 403);
    assert.equal((await call("GET", "/v1/self", b.secret)).status, 200);
    assert.equal((await call("POST", `/v1/service-principals/${sp.id}/tokens/${b.token.id}/revoke`)).status, 200);
    assert.equal((await call("GET", "/v1/self", b.secret)).status, 403);
  });
});

test("a caller without tokens.manage is refused, and nobody makes a principal wider than themselves", { skip }, async () => {
  await withServicePrincipals(async ({ call, defaultOrg }) => {
    await join_(call, defaultOrg, "hubot", HUBOT, "member");
    for (const [method, path, body] of [
      ["GET", "/v1/service-principals"],
      ["POST", "/v1/service-principals", { name: "x" }],
    ]) {
      const refused = await call(method, path, HUBOT, body);
      assert.equal(refused.status, 403, `${method} ${path}`);
      assert.equal(refused.body.missing, "tokens.manage");
    }
    const sp = (await call("POST", "/v1/service-principals", BOOTSTRAP, { name: "y" })).body.servicePrincipal;
    assert.equal((await call("POST", `/v1/service-principals/${sp.id}/tokens`, HUBOT, { name: "z" })).status, 403);
    assert.equal((await call("DELETE", `/v1/service-principals/${sp.id}`, HUBOT)).status, 403);

    // A token holding tokens.manage but not members.manage cannot make an admin robot.
    const minter = (
      await call("POST", "/v1/tokens", BOOTSTRAP, { name: "minter", permissions: ["runs.read", "runs.write", "tokens.manage"] })
    ).body.secret;
    const wider = await call("POST", "/v1/service-principals", minter, { name: "admin-bot", role: "admin" });
    assert.equal(wider.status, 400);
    assert.equal(wider.body.code, "invalid_scope");
    // Nor give a member robot's token a permission its role lacks.
    const beyondRole = await call("POST", `/v1/service-principals/${sp.id}/tokens`, BOOTSTRAP, {
      name: "w",
      permissions: ["members.manage"],
    });
    assert.equal(beyondRole.status, 400);
  });
});

test("a service token's value never appears in a list response or a log line", { skip }, async () => {
  await withServicePrincipals(async ({ pool, call }) => {
    let secret;
    const responses = [];
    const logs = await captureLogs(async () => {
      const sp = (await call("POST", "/v1/service-principals", BOOTSTRAP, { name: "webhooks" })).body.servicePrincipal;
      const minted = await call("POST", `/v1/service-principals/${sp.id}/tokens`, BOOTSTRAP, {
        name: "hook",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      assert.equal(minted.status, 201);
      assert.ok(minted.body.token.expiresAt);
      secret = minted.body.secret;
      responses.push(await call("GET", "/v1/service-principals"));
      responses.push(await call("GET", `/v1/service-principals/${sp.id}/tokens`));
      responses.push(await call("GET", "/v1/tokens"));
      responses.push(await call("GET", "/v1/self", secret));
      responses.push(await call("GET", "/v1/runs", secret));
      await call("DELETE", `/v1/service-principals/${sp.id}`);
      responses.push(await call("GET", "/v1/self", secret));
    });
    assert.match(secret, /^orq_/);
    const tokens = responses[1].body.items;
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].name, "hook");
    for (const response of responses) {
      assert.ok(!JSON.stringify(response.body).includes(secret), "a response echoed the token");
      assert.ok(!JSON.stringify(response.body).includes(secret.slice(12)), "a response echoed part of the token");
    }
    assert.ok(!logs.includes(secret), "a log line carried the token");
    const { rows } = await pool.query("select row_to_json(t) as row from api_token t");
    assert.ok(!JSON.stringify(rows).includes(secret), "only a hash of the token may be stored");
  });
});

test("getSystemActor makes one principal per organization and purpose, even under concurrent calls", { skip }, async () => {
  await withServicePrincipals(async ({ pool, call, defaultOrg }) => {
    const racers = await Promise.all(Array.from({ length: 6 }, () => getSystemActor(pool, defaultOrg, "schedules")));
    assert.equal(new Set(racers.map((p) => p.id)).size, 1, "two parallel first calls made two principals");
    const actor = racers[0];
    assert.equal(actor.kind, "token");
    assert.equal(actor.organizationId, defaultOrg);
    assert.equal((await getSystemActor(pool, defaultOrg, "schedules")).id, actor.id);
    assert.notEqual((await getSystemActor(pool, defaultOrg, "integrations")).id, actor.id);

    const { rows } = await pool.query(
      `select count(*)::int as n from principal where organization_id = $1 and system_purpose = 'schedules'`,
      [defaultOrg],
    );
    assert.equal(rows[0].n, 1);
    const { rows: memberships } = await pool.query(
      `select r.key from membership m join access_role r on r.id = m.access_role_id where m.principal_id = $1`,
      [actor.id],
    );
    assert.deepEqual(memberships.map((r) => r.key), ["member"]);

    // Tasks an automation creates record it as the actor.
    const { task } = await createTaskAndRun(pool, {
      organizationId: defaultOrg,
      createdByPrincipalId: actor.id,
      repositoryId: REPO_ID,
      sourceType: "api",
      sourceReference: "schedule:nightly:1",
      title: "Nightly dependency bump",
      description: "- [ ] dependencies are current",
      criteria: [],
      riskLevel: "low",
    });
    assert.equal(task.createdByPrincipalId, actor.id);

    // It is listed, marked as the system's, and cannot be deleted.
    const listed = await call("GET", "/v1/service-principals");
    const shown = listed.body.items.find((p) => p.id === actor.id);
    assert.equal(shown.system, true);
    assert.equal(shown.systemPurpose, "schedules");
    assert.equal((await call("DELETE", `/v1/service-principals/${actor.id}`)).status, 400);

    await assert.rejects(() => getSystemActor(pool, defaultOrg, "Not A Purpose"), /purpose/);
  });
});

test("migration 0024 keeps existing roles valid and gives admin the two M8 permissions", { skip }, async () => {
  const { pool, drop } = await freshSchema("windkeel_sp_migration_test");
  const before = mkdtempSync(join(tmpdir(), "windkeel-migrations-"));
  try {
    cpSync(join(repoRoot, "migrations"), before, {
      recursive: true,
      // 0024 and everything after it: a later migration may depend on one of those (0030 on 0029).
      filter: (src) => !/\/0024_[^/]*\.sql$/.test(src) && !/\/00(2[5-9]|[3-9]\d)_[^/]*\.sql$/.test(src),
    });
    await runMigrations(pool, before);
    // A custom account role and a membership that exist before the migration.
    await pool.query(
      `insert into access_role (account_id, key, name, permissions)
       select id, 'auditor', 'Auditor', array['runs.read'] from account where is_default`,
    );
    const roleBefore = (await pool.query("select key, permissions from access_role order by key")).rows;

    await runMigrations(pool, join(repoRoot, "migrations"));
    const roles = Object.fromEntries(
      (await pool.query("select key, permissions from access_role")).rows.map((r) => [r.key, r.permissions]),
    );
    const adminBefore = roleBefore.find((r) => r.key === "admin").permissions;
    assert.deepEqual(roles.admin.slice(0, adminBefore.length), adminBefore, "admin keeps what it had, in order");
    assert.ok(roles.admin.includes("integrations.manage"));
    assert.ok(roles.admin.includes("schedules.manage"));
    assert.equal(new Set(roles.admin).size, roles.admin.length, "0024 and 0025 both add integrations.manage; admin holds it once");
    assert.deepEqual([...roles.admin].sort(), [...PERMISSIONS].sort(), "admin holds every permission");
    // 0029 (M9-2) gives members models.read, so they can see which model credentials exist.
    // 0034 (ADR-0029 §3) gives members runs.takeover: take over, submit, hand back.
    // 0044 (#388) gives members knowledge.manage: write notes, accept or reject learned lessons.
    // 0045 (#390) gives members playbooks.read: pick a playbook when filing work.
    assert.deepEqual(roles.member, ["runs.read", "runs.write", "runs.approve", "models.read", "runs.takeover", "knowledge.manage", "playbooks.read"]);
    assert.deepEqual(roles.viewer, ["runs.read"]);
    assert.deepEqual(roles.auditor, ["runs.read"]);

    // The bootstrap operator, an account admin, now holds them too.
    const { rows } = await pool.query(
      `select r.permissions from account_membership am join principal p on p.id = am.principal_id
         join access_role r on r.id = am.access_role_id where p.is_bootstrap`,
    );
    assert.ok(rows[0].permissions.includes("schedules.manage"));
  } finally {
    rmSync(before, { recursive: true, force: true });
    await drop();
  }
});
