/**
 * Custom roles per account (#393 8B): an account admin makes a role from a subset of what they
 * hold, assigns it, and the member's power changes on the next request. Built-ins are immutable,
 * a role in use cannot be deleted, a role can never be wider than its maker, another account's
 * role does not exist — and no permission can switch verification off.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { ROUTES } from "../apps/ingress/dist/src/api/route.js";
import { ADMIN_PERMISSIONS, PERMISSIONS } from "../dist/factory/tenancy.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const BOOTSTRAP = "roles-bootstrap-token";

const fakeSessions = {
  async verify(jwt) {
    const [kind, subject, id, login] = jwt.split(":");
    if (kind !== "session") return null;
    return { provider: "supabase", subject, githubUserId: Number(id), githubLogin: login, displayName: login };
  },
};
const fakeGithubUsers = { lookup: async (login) => ({ mona: { id: 9919, login }, hubot: { id: 480938, login } })[login] ?? null };

async function withApi(fn) {
  const schema = `windkeel_api_roles_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const deps = { pool, control: { listMessages: async () => [] }, githubUsers: fakeGithubUsers };
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
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

// --- the invariant -----------------------------------------------------------------------------

test("no permission, and no route's permission, can disable, skip or bypass verification", () => {
  for (const name of PERMISSIONS) assert.doesNotMatch(name, /verif|bypass|skip/i, `${name} must not exist`);
  for (const route of ROUTES) if (route.permission) assert.doesNotMatch(route.permission, /verif|bypass|skip/i);
  for (const p of ["audit.read", "roles.manage", "account.manage"]) {
    assert.ok(PERMISSIONS.includes(p));
    assert.ok(ADMIN_PERMISSIONS.includes(p), `${p} is given to a token only when asked for by name`);
  }
});

test("built-in Admin holds exactly every permission after the migrations", { skip }, async () => {
  await withApi(async ({ pool }) => {
    const { rows } = await pool.query("select key, permissions from access_role where account_id is null order by key");
    const admin = rows.find((r) => r.key === "admin");
    assert.deepEqual([...admin.permissions].sort(), [...PERMISSIONS].sort());
    for (const r of rows) for (const p of r.permissions) assert.doesNotMatch(p, /verif|bypass|skip/i);
  });
});

// --- custom roles ------------------------------------------------------------------------------

test("a custom role is made, assigned, and changes what its holder can do on the next request", { skip }, async () => {
  await withApi(async ({ call, defaultOrg }) => {
    const created = await call("POST", "/v1/account/roles", BOOTSTRAP, {
      name: "Member + merge",
      description: "Runs, approvals and merging verified pull requests",
      permissions: ["runs.read", "runs.write", "runs.approve", "runs.takeover", "runs.merge"],
    });
    assert.equal(created.status, 201);
    const role = created.body.role;
    assert.equal(role.key, "member-merge");
    assert.equal(role.builtIn, false);

    const listed = await call("GET", "/v1/account/roles");
    assert.deepEqual(listed.body.items.map((r) => r.key), ["admin", "member", "viewer", "member-merge"]);
    // The organization's members tab reads the same list through its own route.
    assert.deepEqual((await call("GET", `/v1/orgs/${defaultOrg}/roles`)).body.items.map((r) => r.key), ["admin", "member", "viewer", "member-merge"]);

    // Invited with the custom role by key, accepted on sign-in.
    const invite = await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "mona", role: "member-merge" });
    assert.equal(invite.status, 201);
    assert.equal(invite.body.invitation.role, "member-merge");
    const mona = "session:sub-mona:9919:mona";
    const self = await call("GET", "/v1/self", mona);
    assert.deepEqual(self.body.organizations[0].permissions.sort(), ["runs.approve", "runs.merge", "runs.read", "runs.takeover", "runs.write"]);
    assert.equal(self.body.accountRole, null);

    // Narrowed: merge comes off, and the next request already lacks it.
    const updated = await call("PATCH", `/v1/account/roles/${role.id}`, BOOTSTRAP, { permissions: ["runs.read"] });
    assert.equal(updated.status, 200);
    assert.deepEqual((await call("GET", "/v1/self", mona)).body.organizations[0].permissions, ["runs.read"]);
    assert.equal((await call("GET", "/v1/members", mona)).status, 200);
    assert.equal((await call("POST", "/v1/tasks", mona, { title: "x" })).status, 403);

    // Assigned by id through the members route, too.
    const monaId = self.body.principal.id;
    assert.equal((await call("POST", `/v1/members/${monaId}/role`, BOOTSTRAP, { role: "viewer" })).status, 200);
    const byId = await call("POST", `/v1/members/${monaId}/role`, BOOTSTRAP, { role: role.id });
    assert.equal(byId.status, 200);
    assert.equal(byId.body.member.role, "member-merge");

    // Every change is audited.
    const events = await call("GET", "/v1/account/audit-events");
    const roleEvents = events.body.items.filter((e) => e.action.startsWith("role.")).map((e) => e.action);
    assert.deepEqual(roleEvents, ["role.updated", "role.created"]);
    const change = events.body.items.find((e) => e.action === "role.updated");
    assert.deepEqual(change.detail.before.permissions, ["runs.read", "runs.write", "runs.approve", "runs.takeover", "runs.merge"]);
    assert.deepEqual(change.detail.after.permissions, ["runs.read"]);
  });
});

test("the merge route still refuses every token, whatever role grants runs.merge", { skip }, async () => {
  await withApi(async ({ call }) => {
    const token = (await call("POST", "/v1/tokens", BOOTSTRAP, { name: "merger", permissions: ["runs.read", "runs.write", "runs.merge"] })).body.secret;
    const refused = await call("POST", "/v1/runs/00000000-0000-4000-8000-000000000000/merge", token, {});
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "session_required");
  });
});

test("a role wider than its maker, a built-in edit and a delete in use are refused with their codes", { skip }, async () => {
  await withApi(async ({ call }) => {
    // An account admin's token that can manage roles but holds only runs.read besides.
    const narrow = (await call("POST", "/v1/tokens", BOOTSTRAP, { name: "role-maker", permissions: ["roles.manage", "runs.read"] })).body.secret;
    const wider = await call("POST", "/v1/account/roles", narrow, { name: "Writer", permissions: ["runs.read", "runs.write"] });
    assert.equal(wider.status, 400);
    assert.equal(wider.body.code, "invalid_scope");
    assert.match(wider.body.error, /runs\.write/);
    assert.equal((await call("POST", "/v1/account/roles", narrow, { name: "Reader", permissions: ["runs.read"] })).status, 201);

    const roles = (await call("GET", "/v1/account/roles")).body.items;
    const member = roles.find((r) => r.key === "member");
    const edit = await call("PATCH", `/v1/account/roles/${member.id}`, BOOTSTRAP, { permissions: ["runs.read"] });
    assert.equal(edit.status, 403);
    assert.equal(edit.body.code, "builtin_role");
    assert.equal((await call("DELETE", `/v1/account/roles/${member.id}`)).body.code, "builtin_role");

    const reader = roles.find((r) => r.key === "reader");
    await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "hubot", role: "reader" });
    const pending = await call("DELETE", `/v1/account/roles/${reader.id}`);
    assert.equal(pending.status, 409, "a pending invitation offers it");
    assert.equal(pending.body.code, "role_in_use");
    await call("GET", "/v1/self", "session:sub-hubot:480938:hubot");
    assert.equal((await call("DELETE", `/v1/account/roles/${reader.id}`)).body.code, "role_in_use", "a member holds it");

    const hubotId = (await call("GET", "/v1/self", "session:sub-hubot:480938:hubot")).body.principal.id;
    await call("POST", `/v1/members/${hubotId}/role`, BOOTSTRAP, { role: "viewer" });
    const gone = await call("DELETE", `/v1/account/roles/${reader.id}`);
    assert.equal(gone.status, 200);
    assert.ok(!(await call("GET", "/v1/account/roles")).body.items.some((r) => r.key === "reader"));
    assert.equal((await call("POST", "/v1/account/roles", BOOTSTRAP, { name: "Reader", permissions: ["runs.read"] })).status, 201, "the key is free again");

    for (const body of [
      { name: "x", permissions: [] },
      { name: "x", permissions: ["verifier.skip"] },
      { name: "Admin", key: "admin", permissions: ["runs.read"] },
      { permissions: ["runs.read"] },
    ]) {
      const bad = await call("POST", "/v1/account/roles", BOOTSTRAP, body);
      assert.equal(bad.status, 400, JSON.stringify(body));
    }
    const duplicate = await call("POST", "/v1/account/roles", BOOTSTRAP, { name: "Reader", permissions: ["runs.read"] });
    assert.equal(duplicate.body.code, "invalid_role");
  });
});

test("assigning a role is refused beyond the assigner's own power", { skip }, async () => {
  await withApi(async ({ call }) => {
    await call("POST", "/v1/account/roles", BOOTSTRAP, { name: "People manager", permissions: ["runs.read", "members.manage"] });
    await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "mona", role: "people-manager" });
    const mona = "session:sub-mona:9919:mona";
    const monaId = (await call("GET", "/v1/self", mona)).body.principal.id;
    // members.manage, but not admin's power: cannot make themselves, or anyone, an admin.
    const escalate = await call("POST", `/v1/members/${monaId}/role`, mona, { role: "admin" });
    assert.equal(escalate.status, 400);
    assert.equal(escalate.body.code, "invalid_scope");
    const invite = await call("POST", "/v1/invitations", mona, { githubLogin: "hubot", role: "admin" });
    assert.equal(invite.body.code, "invalid_scope");
    assert.equal((await call("POST", "/v1/invitations", mona, { githubLogin: "hubot", role: "viewer" })).status, 201);
  });
});

test("another account's role does not exist, and account routes need an account role", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const other = (await pool.query("insert into account (name) values ('other') returning id")).rows[0].id;
    const foreign = (
      await pool.query("insert into access_role (account_id, key, name, permissions) values ($1, 'theirs', 'Theirs', '{runs.read}') returning id", [other])
    ).rows[0].id;
    assert.equal((await call("PATCH", `/v1/account/roles/${foreign}`, BOOTSTRAP, { name: "Mine now" })).status, 404);
    assert.equal((await call("DELETE", `/v1/account/roles/${foreign}`)).status, 404);
    assert.equal((await call("PATCH", "/v1/account/roles/not-a-uuid", BOOTSTRAP, { name: "x" })).status, 404);
    assert.ok(!(await call("GET", "/v1/account/roles")).body.items.some((r) => r.key === "theirs"));

    await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "mona", role: "admin" });
    const mona = "session:sub-mona:9919:mona";
    const monaId = (await call("GET", "/v1/self", mona)).body.principal.id;
    const assign = await call("POST", `/v1/members/${monaId}/role`, BOOTSTRAP, { role: foreign });
    assert.equal(assign.status, 404);
    assert.equal(assign.body.code, "role_not_found");
    const orgAdminOnly = await call("POST", "/v1/account/roles", mona, { name: "x", permissions: ["runs.read"] });
    assert.equal(orgAdminOnly.status, 403);
    assert.equal(orgAdminOnly.body.code, "account_role_required");
  });
});
