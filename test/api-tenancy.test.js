import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { poolGithubIdentities, supabaseSessionVerifier } from "../apps/ingress/dist/src/api/session.js";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const BOOTSTRAP = "test-bootstrap-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";

/**
 * A session verifier that trusts a bearer of the form `session:<subject>:<githubUserId>:<login>`.
 * The real verifier has its own tests at the bottom of this file; here the subject is who signed in,
 * and what is under test is what the API does with them.
 */
const fakeSessions = {
  async verify(jwt) {
    const [kind, subject, id, login] = jwt.split(":");
    if (kind !== "session") return null;
    const githubUserId = id === "null" ? null : Number(id);
    return { provider: "supabase", subject, githubUserId, githubLogin: login, displayName: login };
  },
};

const fakeGithubUsers = {
  async lookup(login) {
    const known = { octocat: 583231, hubot: 480938, mona: 9919 };
    return known[login] ? { id: known[login], login } : null;
  },
};

function query(params = {}) {
  return { get: (name) => params[name] };
}

async function withTenancy(fn) {
  const schema = `windkeel_tenancy_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const task = await insertEngineeringTask(pool, {
      repositoryId: REPO_ID,
      sourceType: "api",
      sourceReference: "api:operator:1",
      title: "Make the gauge read zero when empty",
      description: "- [ ] the gauge reads zero",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    const deps = {
      pool,
      control: {
        approve: async () => ({ outcome: "signalled" }),
        cancel: async () => ({ outcome: "cancelled" }),
        message: async () => ({ outcome: "queued" }),
        listMessages: async () => [],
        startRun: async () => ({ engineeringRunId: run.id }),
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
        query: query(),
        headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
        body,
      });
    const defaultOrg = (await pool.query("select id from organization where is_default")).rows[0].id;
    await fn({ pool, deps, auth, call, task, run, defaultOrg });
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

/** A second organization in the same account, with one member who belongs only to it. */
async function secondOrganization(pool, call) {
  const { rows } = await pool.query(
    `insert into organization (account_id, name) select account_id, 'platform' from organization where is_default
     returning id`,
  );
  const orgId = rows[0].id;
  const invite = await call("POST", `/v1/orgs/${orgId}/invitations`, BOOTSTRAP, { githubLogin: "mona", role: "admin" });
  assert.equal(invite.status, 201);
  return { orgId, monaSession: "session:sub-mona:9919:mona" };
}

// --- the bootstrap token ---------------------------------------------------

test("the bootstrap token is the operator, an account admin in the default organization", { skip }, async () => {
  await withTenancy(async ({ call, defaultOrg }) => {
    const self = await call("GET", "/v1/self");
    assert.equal(self.status, 200);
    assert.equal(self.body.principal.displayName, "operator");
    assert.equal(self.body.via, "bootstrap");
    assert.equal(self.body.token, null);
    assert.deepEqual(self.body.organizations.map((o) => o.id), [defaultOrg]);
    // Every permission: the three account-level ones of #393, knowledge.manage (#388), the two
    // playbook permissions (#390), batches.manage (#391) and billing.manage (#394) included.
    assert.equal(self.body.organizations[0].permissions.length, 21);
    assert.equal(self.body.accountRole.key, "admin");
    // The pre-tenancy fields, so a client written against them keeps working for a release.
    assert.equal(self.body.subject, "operator");
    assert.deepEqual(self.body.scopes, ["operator"]);
  });
});

// --- scoped personal tokens ------------------------------------------------

test("a read-only token reads, and is refused a write with the permission it lacks", { skip }, async () => {
  await withTenancy(async ({ pool, call, run }) => {
    const created = await call("POST", "/v1/tokens", BOOTSTRAP, { name: "claude-code", preset: "read" });
    assert.equal(created.status, 201);
    assert.match(created.body.secret, /^orq_/);
    assert.deepEqual(created.body.token.permissions, ["runs.read"]);

    const { rows } = await pool.query("select row_to_json(t) as row from api_token t");
    assert.ok(
      !JSON.stringify(rows).includes(created.body.secret),
      "only a hash of the token may be stored",
    );

    const token = created.body.secret;
    assert.equal((await call("GET", `/v1/runs/${run.id}`, token)).status, 200);
    const cancel = await call("POST", `/v1/runs/${run.id}/cancel`, token);
    assert.equal(cancel.status, 403);
    assert.equal(cancel.body.missing, "runs.write");
    assert.match(cancel.body.error, /token's scope/);

    const self = await call("GET", "/v1/self", token);
    assert.deepEqual(self.body.organizations[0].permissions, ["runs.read"], "self reports the narrowed power");
    assert.equal(self.body.token.name, "claude-code");
  });
});

test("a token without tokens.manage cannot make tokens, and one with it cannot make a wider one", { skip }, async () => {
  await withTenancy(async ({ call }) => {
    const execute = (await call("POST", "/v1/tokens", BOOTSTRAP, { name: "ci", preset: "execute" })).body.secret;
    const refused = await call("POST", "/v1/tokens", execute, { name: "escalate", preset: "read" });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.missing, "tokens.manage");

    const minter = (
      await call("POST", "/v1/tokens", BOOTSTRAP, { name: "minter", permissions: ["runs.read", "tokens.manage"] })
    ).body.secret;
    const wider = await call("POST", "/v1/tokens", minter, { name: "wider", preset: "execute" });
    assert.equal(wider.status, 400);
    assert.match(wider.body.error, /runs\.write/);
    const narrower = await call("POST", "/v1/tokens", minter, { name: "narrower", preset: "read" });
    assert.equal(narrower.status, 201);
  });
});

test("a revoked token is rejected exactly like an unknown one", { skip }, async () => {
  await withTenancy(async ({ call }) => {
    const created = await call("POST", "/v1/tokens", BOOTSTRAP, { name: "short-lived", preset: "read" });
    const revoked = await call("POST", `/v1/tokens/${created.body.token.id}/revoke`);
    assert.equal(revoked.status, 200);
    assert.ok(revoked.body.token.revokedAt);

    const withRevoked = await call("GET", "/v1/self", created.body.secret);
    const withUnknown = await call("GET", "/v1/self", "orq_notatoken");
    assert.equal(withRevoked.status, 403);
    assert.deepEqual(withRevoked.body, withUnknown.body, "revoked and unknown must be indistinguishable");
  });
});

test("an unknown preset or permission is refused by name", { skip }, async () => {
  await withTenancy(async ({ call }) => {
    const preset = await call("POST", "/v1/tokens", BOOTSTRAP, { name: "x", preset: "superuser" });
    assert.equal(preset.status, 400);
    assert.equal(preset.body.code, "invalid_scope");
    const both = await call("POST", "/v1/tokens", BOOTSTRAP, { name: "x", preset: "read", permissions: ["runs.read"] });
    assert.equal(both.status, 400);
  });
});

// --- organizations ---------------------------------------------------------

test("another organization's run, task and repository do not exist, and its lists are empty", { skip }, async () => {
  await withTenancy(async ({ pool, call, run, task }) => {
    const { monaSession } = await secondOrganization(pool, call);

    for (const path of [`/v1/runs/${run.id}`, `/v1/runs/${run.id}/events`, `/v1/tasks/${task.id}`]) {
      const result = await call("GET", path, monaSession);
      assert.equal(result.status, 404, `${path} must be 404, not 403: a 403 confirms the id exists`);
    }
    assert.equal((await call("POST", `/v1/runs/${run.id}/cancel`, monaSession)).status, 404);
    assert.equal((await call("GET", `/v1/repositories/${REPO_ID}/secrets`, monaSession)).status, 404);

    for (const path of ["/v1/runs", "/v1/tasks", "/v1/queue", "/v1/repositories"]) {
      const result = await call("GET", path, monaSession);
      assert.equal(result.status, 200, path);
      assert.deepEqual(result.body.items, [], `${path} leaked another organization's rows`);
    }
  });
});

test("a caller in two organizations must name one, and a pinned token reaches only its own", { skip }, async () => {
  await withTenancy(async ({ pool, call, defaultOrg }) => {
    const { orgId } = await secondOrganization(pool, call);
    // The operator is an account admin, so they now reach both.
    const unnamed = await call("GET", "/v1/runs");
    assert.equal(unnamed.status, 400);
    assert.equal(unnamed.body.code, "organization_required");
    assert.deepEqual(unnamed.body.organizations.map((o) => o.id).sort(), [defaultOrg, orgId].sort());

    assert.equal((await call("GET", `/v1/orgs/${defaultOrg}/runs`)).status, 200);

    const pinned = (
      await call("POST", "/v1/tokens", BOOTSTRAP, { name: "pinned", preset: "read", organizationId: orgId })
    ).body.secret;
    assert.equal((await call("GET", "/v1/runs", pinned)).status, 200, "a pinned token has one organization");
    assert.equal((await call("GET", `/v1/orgs/${defaultOrg}/runs`, pinned)).status, 404);
  });
});

test("ORQ-06: a pinned token mints only tokens pinned to its own organization", { skip }, async () => {
  await withTenancy(async ({ pool, call, defaultOrg }) => {
    const { orgId } = await secondOrganization(pool, call);
    const pinned = (
      await call("POST", "/v1/tokens", BOOTSTRAP, {
        name: "ci-for-default",
        permissions: ["runs.read", "runs.write", "tokens.manage"],
        organizationId: defaultOrg,
      })
    ).body.secret;

    // No organizationId: the new token inherits the pin rather than becoming unpinned.
    const minted = await call("POST", "/v1/tokens", pinned, { name: "escape", permissions: ["runs.read", "tokens.manage"] });
    assert.equal(minted.status, 201);
    assert.equal(minted.body.token.organizationId, defaultOrg);
    const self = await call("GET", "/v1/self", minted.body.secret);
    assert.deepEqual(self.body.organizations.map((o) => o.id), [defaultOrg], "it reaches only the pinned organization");
    assert.equal((await call("GET", `/v1/orgs/${orgId}/runs`, minted.body.secret)).status, 404);

    // Naming another organization is naming one the pinned token cannot reach.
    const elsewhere = await call("POST", "/v1/tokens", pinned, { name: "elsewhere", preset: "read", organizationId: orgId });
    assert.equal(elsewhere.status, 404);

    // And the store refuses a pinned creator's unpinned token whoever calls it.
    const { createApiToken, TokenScopeError } = await import("../dist/factory/tenancy.js");
    const operator = (await pool.query("select id from principal where is_bootstrap")).rows[0].id;
    await assert.rejects(
      createApiToken(pool, {
        name: "unpinned",
        ownerPrincipalId: operator,
        createdByPrincipalId: operator,
        organizationId: null,
        creatorPin: defaultOrg,
        permissions: ["runs.read"],
        ceiling: ["runs.read"],
      }),
      TokenScopeError,
    );

    // An unpinned caller still makes unpinned tokens.
    const unpinned = await call("POST", "/v1/tokens", BOOTSTRAP, { name: "laptop", preset: "read" });
    assert.equal(unpinned.body.token.organizationId, null);
  });
});

test("ORQ-05/ORQ-10: once the grant is withdrawn, a run cannot be started, approved or steered, but can still be cancelled and read", { skip }, async () => {
  await withTenancy(async ({ pool, deps, call, task, run }) => {
    const started = [];
    deps.control.startRun = async (taskId) => {
      started.push(taskId);
      return { engineeringRunId: run.id };
    };
    let approved = 0;
    let messaged = 0;
    deps.control.approve = async () => {
      approved++;
      return { outcome: "signalled" };
    };
    deps.control.message = async () => {
      messaged++;
      return { outcome: "queued" };
    };

    const withdrawn = await call("POST", `/v1/repositories/grants/${REPO_ID}/delete`);
    assert.equal(withdrawn.status, 200);

    // A CREATED run would be re-handed-over; a terminal one would get a fresh run. Neither now.
    const rehand = await call("POST", "/v1/runs", BOOTSTRAP, { taskId: task.id });
    assert.equal(rehand.status, 404);
    assert.equal(rehand.body.error, "no such repository");
    await pool.query("update engineering_run set status = 'FAILED' where id = $1", [run.id]);
    const fresh = await call("POST", "/v1/runs", BOOTSTRAP, { taskId: task.id });
    assert.equal(fresh.status, 404);
    assert.deepEqual(started, [], "no run was started on an ungranted repository");

    await pool.query("update engineering_run set status = 'WAITING_FOR_APPROVAL' where id = $1", [run.id]);
    assert.equal((await call("POST", `/v1/runs/${run.id}/approve`)).status, 404);
    await pool.query("update engineering_run set status = 'IMPLEMENTING' where id = $1", [run.id]);
    assert.equal((await call("POST", `/v1/runs/${run.id}/messages`, BOOTSTRAP, { message: "try the other file" })).status, 404);
    assert.equal(approved + messaged, 0, "nothing reached the run");

    // Stopping the work is always allowed, and the run is still the organization's history.
    assert.notEqual((await call("POST", `/v1/runs/${run.id}/cancel`)).status, 404);
    assert.equal((await call("GET", `/v1/runs/${run.id}`)).status, 200);

    // Re-granting restores it.
    await pool.query(
      "insert into repository_grant (organization_id, repository_id, intake) select id, $1, true from organization where is_default",
      [REPO_ID],
    );
    assert.equal((await call("POST", `/v1/runs/${run.id}/messages`, BOOTSTRAP, { message: "try the other file" })).status, 202);
  });
});

test("metrics are account-wide, so a member of one of two organizations is refused them", { skip }, async () => {
  await withTenancy(async ({ pool, call }) => {
    const { monaSession } = await secondOrganization(pool, call);
    const refused = await call("GET", "/v1/metrics", monaSession);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /whole account/);
  });
});

test("a grant is what makes a repository usable, and moving intake moves it", { skip }, async () => {
  await withTenancy(async ({ pool, call, defaultOrg }) => {
    const { orgId, monaSession } = await secondOrganization(pool, call);
    const before = await call("GET", "/v1/repositories/grants", monaSession);
    assert.deepEqual(before.body.items, []);

    const granted = await call("POST", `/v1/orgs/${orgId}/repositories/grants`, BOOTSTRAP, {
      repositoryId: REPO_ID,
      intake: true,
    });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.grant.intake, true);

    const { rows } = await pool.query("select organization_id from repository_grant where intake");
    assert.deepEqual(rows.map((r) => r.organization_id), [orgId], "a repository has one intake");
    const defaults = await call("GET", `/v1/orgs/${defaultOrg}/repositories/grants`);
    assert.equal(defaults.body.items[0].intake, false, "the default organization keeps access, not intake");
  });
});

test("an organization admin cannot grant themselves another organization's repository, or take its intake", { skip }, async () => {
  await withTenancy(async ({ pool, call, defaultOrg }) => {
    // Mona is an admin of "platform" — `repositories.manage` there — and holds no account role.
    const { orgId, monaSession } = await secondOrganization(pool, call);
    const intakeOf = async () =>
      (await pool.query("select organization_id from repository_grant where repository_id = $1 and intake", [REPO_ID]))
        .rows.map((r) => r.organization_id);
    assert.deepEqual(await intakeOf(), [defaultOrg]);

    for (const intake of [true, false]) {
      const refused = await call("POST", `/v1/orgs/${orgId}/repositories/grants`, monaSession, {
        repositoryId: REPO_ID,
        intake,
      });
      assert.equal(refused.status, 403, `intake: ${intake}`);
      assert.equal(refused.body.code, "forbidden");
      assert.match(refused.body.error, /account role/);
    }
    const { rows } = await pool.query("select count(*)::int as n from repository_grant where organization_id = $1", [orgId]);
    assert.equal(rows[0].n, 0, "nothing was granted");
    assert.deepEqual(await intakeOf(), [defaultOrg], "the default organization keeps its intake");

    // Shared by the account admin, the repository is still the default organization's intake, and
    // Mona cannot use her organization's own grant to take it either.
    const shared = await call("POST", `/v1/orgs/${orgId}/repositories/grants`, BOOTSTRAP, { repositoryId: REPO_ID, intake: false });
    assert.equal(shared.status, 200);
    const takeover = await call("POST", `/v1/orgs/${orgId}/repositories/grants`, monaSession, { repositoryId: REPO_ID, intake: true });
    assert.equal(takeover.status, 403);
    assert.deepEqual(await intakeOf(), [defaultOrg]);

    // Removing her own organization's grant is hers to do, and reaches no one else's.
    const removed = await call("POST", `/v1/orgs/${orgId}/repositories/grants/${REPO_ID}/delete`, monaSession);
    assert.equal(removed.status, 200);
    assert.deepEqual(await intakeOf(), [defaultOrg]);

    // A repository nobody holds is hers to grant: that reaches no other organization.
    const { rows: fresh } = await pool.query(
      `insert into repository (owner, name, default_branch, clone_url)
       values ('jyothepro', 'unclaimed', 'main', 'https://github.com/jyothepro/unclaimed.git') returning id`,
    );
    const claimed = await call("POST", `/v1/orgs/${orgId}/repositories/grants`, monaSession, {
      repositoryId: fresh[0].id,
      intake: true,
    });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.grant.intake, true);
  });
});

test("two organization admins claiming one unheld repository at once: exactly one wins", { skip }, async () => {
  await withTenancy(async ({ pool, call }) => {
    const { orgId: platform, monaSession } = await secondOrganization(pool, call);
    const { rows: orgs } = await pool.query(
      `insert into organization (account_id, name) select account_id, 'growth' from organization where is_default
       returning id`,
    );
    const growth = orgs[0].id;
    const invite = await call("POST", `/v1/orgs/${growth}/invitations`, BOOTSTRAP, { githubLogin: "octocat", role: "admin" });
    assert.equal(invite.status, 201);
    const octoSession = "session:sub-octo:583231:octocat";
    // Sign both in first, so the race below is only the two grants.
    await call("GET", "/v1/self", monaSession);
    await call("GET", "/v1/self", octoSession);

    const { rows: fresh } = await pool.query(
      `insert into repository (owner, name, default_branch, clone_url)
       values ('jyothepro', 'contested', 'main', 'https://github.com/jyothepro/contested.git') returning id`,
    );
    const repositoryId = fresh[0].id;

    // Hold the repository row so both claims are in flight before either can commit. Without
    // serialisation both read "nobody holds it" and both insert; with it, the second waits and
    // then sees the first's grant.
    // The suite's pools hold two connections; this needs the holder plus one per claim, or the
    // pool itself would serialise the claims and the test would prove nothing.
    pool.options.max = 4;
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from repository where id = $1 for update", [repositoryId]);
      const claims = Promise.all([
        call("POST", `/v1/orgs/${platform}/repositories/grants`, monaSession, { repositoryId, intake: false }),
        call("POST", `/v1/orgs/${growth}/repositories/grants`, octoSession, { repositoryId, intake: false }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query("commit");
      const statuses = (await claims).map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 403]);
    } finally {
      holder.release();
    }
    const { rows } = await pool.query("select count(*)::int as n from repository_grant where repository_id = $1", [repositoryId]);
    assert.equal(rows[0].n, 1, "one organization holds it, not two");
  });
});

// --- people ------------------------------------------------------------------

test("a signed-in stranger is not a member, and is never given an account", { skip }, async () => {
  await withTenancy(async ({ pool, call }) => {
    const result = await call("GET", "/v1/self", "session:sub-stranger:480938:hubot");
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "not_a_member");
    const { rows } = await pool.query("select 1 from principal where github_user_id = 480938");
    assert.equal(rows.length, 0, "a row in the shared auth.users table must grant nothing here");
  });
});

test("an invitation is accepted on first sign-in, matched on the GitHub id rather than the login", { skip }, async () => {
  await withTenancy(async ({ call, defaultOrg }) => {
    const invite = await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "octocat", role: "viewer" });
    assert.equal(invite.status, 201);
    assert.equal(invite.body.invitation.invitedByName, "operator");

    // Renamed since the invitation: same id, different login. Still them.
    const self = await call("GET", "/v1/self", "session:sub-octo:583231:octocat-renamed");
    assert.equal(self.status, 200);
    assert.equal(self.body.via, "session");
    assert.deepEqual(self.body.organizations.map((o) => [o.id, o.role]), [[defaultOrg, "viewer"]]);

    const members = await call("GET", "/v1/members");
    assert.ok(members.body.items.some((m) => m.githubLogin === "octocat-renamed" && m.role === "viewer"));

    const unknown = await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "nobody-at-all" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "github_user_not_found");
  });
});

test("the last admin cannot be demoted or removed", { skip }, async () => {
  await withTenancy(async ({ pool, call }) => {
    const { orgId, monaSession } = await secondOrganization(pool, call);
    const self = await call("GET", "/v1/self", monaSession);
    const monaId = self.body.principal.id;
    const demote = await call("POST", `/v1/orgs/${orgId}/members/${monaId}/role`, monaSession, { role: "member" });
    assert.equal(demote.status, 409);
    assert.match(demote.body.error, /no admin/);
    const remove = await call("POST", `/v1/orgs/${orgId}/members/${monaId}/delete`, monaSession);
    assert.equal(remove.status, 409);
  });
});

// --- the CLI's device login ----------------------------------------------------

test("a device login is approved by a session, minted on the next poll, and usable once", { skip }, async () => {
  await withTenancy(async ({ call, run }) => {
    await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "octocat", role: "admin" });
    const session = "session:sub-octo:583231:octocat";
    await call("GET", "/v1/self", session);

    const started = await call("POST", "/v1/auth/device", null, { machineName: "laptop", preset: "admin" });
    assert.equal(started.status, 200);
    assert.match(started.body.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(
      started.body.verificationUriComplete,
      `https://console.example/login/device?code=${started.body.userCode}`,
    );

    const pending = await call("POST", "/v1/auth/device/token", null, { deviceCode: started.body.deviceCode });
    assert.equal(pending.body.code, "authorization_pending");

    // A token cannot approve a login: that would let one leaked token mint others forever.
    const byToken = await call("POST", `/v1/auth/device/${started.body.userCode}/approve`, BOOTSTRAP);
    assert.equal(byToken.status, 403);
    assert.equal(byToken.body.code, "session_required");

    // The console accepts the code as a person types it: lower case, no dash.
    const typed = started.body.userCode.toLowerCase().replace("-", "");
    const shown = await call("GET", `/v1/auth/device/${typed}`, session);
    assert.equal(shown.body.machineName, "laptop");
    assert.equal(shown.body.admin, false, "admin permissions are dropped unless --admin asked for them");

    assert.equal((await call("POST", `/v1/auth/device/${typed}/approve`, session)).status, 200);

    // The poll is rate limited per device code, so wait out the interval rather than racing it.
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const approved = await call("POST", "/v1/auth/device/token", null, { deviceCode: started.body.deviceCode });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.token.name, "CLI on laptop");
    assert.deepEqual(approved.body.token.permissions, ["runs.read", "runs.write", "runs.approve", "secrets.manage", "models.read", "runs.takeover", "playbooks.read"]);
    assert.equal((await call("GET", `/v1/runs/${run.id}`, approved.body.secret)).status, 200);

    const replayed = await call("POST", "/v1/auth/device/token", null, { deviceCode: started.body.deviceCode });
    assert.equal(replayed.body.code, "expired_token", "a device code yields one token, not one per poll");
  });
});

test("polling faster than the interval is told to slow down", { skip }, async () => {
  await withTenancy(async ({ call }) => {
    const started = await call("POST", "/v1/auth/device", null, { machineName: "laptop" });
    await call("POST", "/v1/auth/device/token", null, { deviceCode: started.body.deviceCode });
    const fast = await call("POST", "/v1/auth/device/token", null, { deviceCode: started.body.deviceCode });
    assert.equal(fast.body.code, "slow_down");
  });
});

test("a denied device login yields no token", { skip }, async () => {
  await withTenancy(async ({ call }) => {
    await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "octocat", role: "member" });
    const session = "session:sub-octo:583231:octocat";
    const started = await call("POST", "/v1/auth/device", null, { machineName: "unknown box" });
    assert.equal((await call("POST", `/v1/auth/device/${started.body.userCode}/deny`, session)).status, 200);
    const poll = await call("POST", "/v1/auth/device/token", null, { deviceCode: started.body.deviceCode });
    assert.equal(poll.body.code, "access_denied");
  });
});

// --- the Supabase session verifier ---------------------------------------------

const PROJECT = "https://abcd.supabase.co";

function jwt(header, payload, signer) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  return `${signingInput}.${signer(Buffer.from(signingInput)).toString("base64url")}`;
}

const OCTO = "00000000-0000-4000-8000-000000583231";
const EVIL = "00000000-0000-4000-8000-000000480938";

function githubClaims(overrides = {}) {
  return {
    iss: `${PROJECT}/auth/v1`,
    aud: "authenticated",
    sub: OCTO,
    exp: Math.floor(Date.now() / 1000) + 3600,
    amr: [{ method: "oauth", timestamp: Math.floor(Date.now() / 1000) }],
    app_metadata: { provider: "github", providers: ["github"] },
    user_metadata: { provider_id: "583231", user_name: "octocat", full_name: "The Octocat" },
    ...overrides,
  };
}

/** A row of `github_identity_of`, as `GithubIdentitySource.lookup` returns it. */
function identityRow(githubUserId, githubLogin, displayName = null) {
  return { githubUserId: String(githubUserId), githubLogin, displayName };
}

/** `auth.identities` in memory: the GitHub rows per Supabase user, and every subject asked about. */
function fakeIdentities(users, asked = []) {
  return {
    async lookup(subject) {
      asked.push(subject);
      return users[subject] ?? [];
    },
  };
}

test("an ES256 session signed by a published key is verified, and yields the GitHub account", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "ES256" };
  let fetches = 0;
  const asked = [];
  const verifier = supabaseSessionVerifier({
    url: PROJECT,
    githubIdentities: fakeIdentities({ [OCTO]: [identityRow(583231, "octocat", "The Octocat")] }, asked),
    fetch: async (url) => {
      fetches += 1;
      assert.equal(String(url), `${PROJECT}/auth/v1/.well-known/jwks.json`);
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    },
  });
  const token = jwt({ alg: "ES256", kid: "key-1", typ: "JWT" }, githubClaims(), (input) =>
    sign("sha256", input, { key: privateKey, dsaEncoding: "ieee-p1363" }),
  );
  const claims = await verifier.verify(token);
  assert.deepEqual(claims, {
    provider: "supabase",
    subject: OCTO,
    githubUserId: 583231,
    githubLogin: "octocat",
    displayName: "The Octocat",
    // #393 8F: what the idle timeout and MFA rules read; this token carries neither claim.
    sessionId: null,
    aal: null,
  });
  await verifier.verify(token);
  assert.equal(fetches, 1, "the key set is cached, not fetched per request");
  assert.deepEqual(asked, [OCTO], "the subject's identity is cached, not looked up per request");
});

test("a legacy HS256 session verifies only with the secret configured", async () => {
  const secret = "legacy-jwt-secret";
  const token = jwt({ alg: "HS256", typ: "JWT" }, githubClaims(), (input) =>
    createHmac("sha256", secret).update(input).digest(),
  );
  const githubIdentities = fakeIdentities({ [OCTO]: [identityRow(583231, "octocat")] });
  assert.ok(await supabaseSessionVerifier({ url: PROJECT, jwtSecret: secret, githubIdentities }).verify(token));
  assert.equal(await supabaseSessionVerifier({ url: PROJECT, githubIdentities }).verify(token), null);
  assert.equal(await supabaseSessionVerifier({ url: PROJECT, jwtSecret: "wrong", githubIdentities }).verify(token), null);
});

test("an expired, foreign, unsigned or non-GitHub session is not a GitHub identity", async () => {
  const secret = "s";
  const verifier = supabaseSessionVerifier({
    url: PROJECT,
    jwtSecret: secret,
    githubIdentities: {
      lookup: async () => assert.fail("a session refused on its face, or with no GitHub provider, needs no lookup"),
    },
  });
  const hs = (payload) =>
    jwt({ alg: "HS256" }, payload, (input) => createHmac("sha256", secret).update(input).digest());

  assert.equal(await verifier.verify(hs(githubClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }))), null);
  assert.equal(await verifier.verify(hs(githubClaims({ iss: "https://other.supabase.co/auth/v1" }))), null);
  assert.equal(await verifier.verify(hs(githubClaims({ aud: "anon" }))), null);
  assert.equal(await verifier.verify(jwt({ alg: "none" }, githubClaims(), () => Buffer.alloc(0))), null);

  // Signed in with email on another product sharing the project: a real session, no GitHub account.
  const email = await verifier.verify(hs(githubClaims({ app_metadata: { provider: "email" }, user_metadata: {} })));
  assert.equal(email.githubUserId, null);
});

test("a GitHub identity counts only for a session that signed in through GitHub (ORQ-02)", async () => {
  const secret = "s";
  const verifier = supabaseSessionVerifier({
    url: PROJECT,
    jwtSecret: secret,
    githubIdentities: {
      lookup: async () => assert.fail("a session that did not sign in through GitHub needs no lookup"),
    },
  });
  const hs = (payload) =>
    jwt({ alg: "HS256" }, payload, (input) => createHmac("sha256", secret).update(input).digest());
  const at = Math.floor(Date.now() / 1000);
  const emailFirst = { provider: "email", providers: ["email", "github"] };

  // The pre-registration: an attacker signs up v@example.com with a password on the shared project,
  // the victim's GitHub sign-in is auto-linked onto that user, and the attacker signs in with the
  // password. The user holds the victim's GitHub identity; the session never went through GitHub.
  const password = await verifier.verify(
    hs(githubClaims({ amr: [{ method: "password", timestamp: at }], app_metadata: emailFirst })),
  );
  assert.equal(password.githubUserId, null);
  assert.equal(password.githubLogin, null);

  // The same user through an OAuth sign-in: `amr` says oauth but not which provider, and the user
  // was created by email, so the GitHub identity was linked onto it, not the other way round.
  const linked = await verifier.verify(
    hs(githubClaims({ amr: [{ method: "oauth", timestamp: at }], app_metadata: emailFirst })),
  );
  assert.equal(linked.githubUserId, null);

  // A GitHub-created user signing in some other way (a magic link from another product).
  const magic = await verifier.verify(hs(githubClaims({ amr: [{ method: "otp", timestamp: at }] })));
  assert.equal(magic.githubUserId, null);

  // A GitHub-created user with another OAuth identity linked (Google, say): `amr` says oauth but
  // not which, so a session through the other one is indistinguishable and is refused too.
  for (const providers of [["github", "google"], ["github", "email", "azure"]]) {
    const ambiguous = await verifier.verify(hs(githubClaims({ app_metadata: { provider: "github", providers } })));
    assert.equal(ambiguous.githubUserId, null, JSON.stringify(providers));
  }

  // No `amr` at all is not GitHub's word either.
  const bare = githubClaims();
  delete bare.amr;
  assert.equal((await verifier.verify(hs(bare))).githubUserId, null);
});

test("a GitHub OAuth session is honoured whether amr is in object or RFC 8176 string form", async () => {
  const secret = "amr-secret";
  const githubIdentities = fakeIdentities({ [OCTO]: [identityRow(583231, "octocat")] });
  for (const amr of [[{ method: "oauth", timestamp: 1 }], ["oauth"], [{ method: "mfa/totp", timestamp: 2 }, "oauth"]]) {
    const verifier = supabaseSessionVerifier({ url: PROJECT, jwtSecret: secret, githubIdentities });
    const token = jwt({ alg: "HS256" }, githubClaims({ amr }), (input) =>
      createHmac("sha256", secret).update(input).digest(),
    );
    assert.equal((await verifier.verify(token)).githubUserId, 583231, JSON.stringify(amr));
  }

  // Email or phone linked alongside is fine: neither is an OAuth sign-in, so `oauth` still means GitHub.
  const verifier = supabaseSessionVerifier({ url: PROJECT, jwtSecret: secret, githubIdentities });
  const withEmail = jwt(
    { alg: "HS256" },
    githubClaims({ app_metadata: { provider: "github", providers: ["github", "email", "phone"] } }),
    (input) => createHmac("sha256", secret).update(input).digest(),
  );
  assert.equal((await verifier.verify(withEmail)).githubUserId, 583231);
});

// --- the GitHub account comes from auth.identities, never from user_metadata ----------

const hsSecret = "identity-secret";
const hsSession = (overrides) =>
  jwt({ alg: "HS256", typ: "JWT" }, githubClaims(overrides), (input) =>
    createHmac("sha256", hsSecret).update(input).digest(),
  );

/**
 * The exploit, as Supabase lets anyone on the shared project sign it: a real GitHub sign-in as hubot
 * (480938), then `supabase.auth.updateUser({ data: { provider_id: "583231", user_name: "octocat" } })`
 * and a refresh. The token is correctly signed and its `user_metadata` names octocat.
 */
const forgedMetadata = { provider_id: "583231", sub: "583231", user_name: "octocat", full_name: "The Octocat" };

test("a session whose user_metadata names another GitHub account is still its own account", async () => {
  const verifier = supabaseSessionVerifier({
    url: PROJECT,
    jwtSecret: hsSecret,
    githubIdentities: fakeIdentities({ [EVIL]: [identityRow(480938, "hubot")] }),
  });
  const claims = await verifier.verify(hsSession({ sub: EVIL, user_metadata: forgedMetadata }));
  assert.equal(claims.githubUserId, 480938, "the id is Auth's identity row, not the user's metadata");
  assert.equal(claims.githubLogin, "hubot");
  assert.equal(claims.displayName, "The Octocat", "a typed display name is shown, and decides nothing");
});

test("without auth.identities' word there is no GitHub account, and a failed lookup is no session", async () => {
  const token = hsSession({ sub: EVIL, user_metadata: forgedMetadata });

  // No identity source: the id cannot be learned, so it is not read from the token instead.
  const sourceless = supabaseSessionVerifier({ url: PROJECT, jwtSecret: hsSecret });
  assert.equal((await sourceless.verify(token)).githubUserId, null);

  // The lookup fails (function not installed, database down): refused, not guessed, and not cached.
  let calls = 0;
  const down = supabaseSessionVerifier({
    url: PROJECT,
    jwtSecret: hsSecret,
    githubIdentities: {
      async lookup() {
        calls += 1;
        throw Object.assign(new Error("function github_identity_of(uuid) does not exist"), { code: "42883" });
      },
    },
  });
  assert.equal(await down.verify(token), null);
  assert.equal(await down.verify(token), null);
  assert.equal(calls, 2, "a failure is asked again, not remembered");

  // A subject that is not a Supabase user id is never looked up.
  const asked = [];
  const odd = supabaseSessionVerifier({ url: PROJECT, jwtSecret: hsSecret, githubIdentities: fakeIdentities({}, asked) });
  assert.equal((await odd.verify(hsSession({ sub: "not-a-uuid", user_metadata: forgedMetadata }))).githubUserId, null);
  assert.deepEqual(asked, []);

  // No GitHub row (deleted, banned or unlinked), a non-numeric one, or two different ones: none.
  for (const rows of [[], [identityRow("x@example.com", "x")], [identityRow(480938, "hubot"), identityRow(583231, "octocat")]]) {
    const verifier = supabaseSessionVerifier({
      url: PROJECT,
      jwtSecret: hsSecret,
      githubIdentities: fakeIdentities({ [EVIL]: rows }),
    });
    const claims = await verifier.verify(token);
    assert.equal(claims.githubUserId, null);
    assert.equal(claims.githubLogin, null);
  }
});

/**
 * Installs `migrations/supabase/github_identity_of.sql` — the file an operator runs as `postgres` —
 * into this test's schema, over a stand-in `auth` schema with just the columns it reads.
 */
async function installGithubIdentityOf(pool) {
  const schema = (await pool.query("select current_schema() as s")).rows[0].s;
  const authSchema = `${schema}_auth`;
  await pool.query(`create schema ${authSchema}`);
  await pool.query(
    `create table ${authSchema}.users (id uuid primary key, deleted_at timestamptz, banned_until timestamptz);
     create table ${authSchema}.identities (
       user_id uuid not null references ${authSchema}.users (id), provider text not null,
       provider_id text not null, identity_data jsonb not null)`,
  );
  const sql = readFileSync(join(repoRoot, "migrations", "supabase", "github_identity_of.sql"), "utf8")
    .replaceAll("auth.", `${authSchema}.`)
    .replaceAll("orqon.", `${schema}.`)
    .replace("to orqon_app;", "to current_user;");
  await pool.query(sql);
  const addUser = async (id, githubId, login, extra = {}) => {
    await pool.query(`insert into ${authSchema}.users (id, deleted_at, banned_until) values ($1, $2, $3)`, [
      id,
      extra.deletedAt ?? null,
      extra.bannedUntil ?? null,
    ]);
    if (githubId !== null) {
      await pool.query(
        `insert into ${authSchema}.identities (user_id, provider, provider_id, identity_data) values ($1, 'github', $2, $3)`,
        [id, String(githubId), { sub: String(githubId), user_name: login, full_name: `${login} (name)` }],
      );
    }
    // Another product's sign-in for the same person: never a GitHub account.
    await pool.query(
      `insert into ${authSchema}.identities (user_id, provider, provider_id, identity_data) values ($1, 'email', $2, '{}')`,
      [id, `${id}@example.com`],
    );
  };
  return { authSchema, addUser, drop: () => pool.query(`drop schema ${authSchema} cascade`) };
}

test("github_identity_of returns a live user's GitHub row and nothing else", { skip }, async () => {
  await withTenancy(async ({ pool }) => {
    const auth = await installGithubIdentityOf(pool);
    try {
      const deleted = "00000000-0000-4000-8000-0000000000d1";
      const banned = "00000000-0000-4000-8000-0000000000b1";
      const emailOnly = "00000000-0000-4000-8000-0000000000e1";
      await auth.addUser(OCTO, 583231, "octocat");
      await auth.addUser(deleted, 1001, "gone", { deletedAt: new Date() });
      await auth.addUser(banned, 1002, "banned", { bannedUntil: new Date(Date.now() + 3600_000) });
      await auth.addUser(emailOnly, null, null);
      const source = poolGithubIdentities(pool);
      assert.deepEqual(await source.lookup(OCTO), [identityRow(583231, "octocat", "octocat (name)")]);
      for (const subject of [deleted, banned, emailOnly, EVIL]) assert.deepEqual(await source.lookup(subject), []);
      const fn = await pool.query(
        `select prosecdef, proconfig from pg_proc where proname = 'github_identity_of' and pronamespace = current_schema()::regnamespace`,
      );
      assert.equal(fn.rows[0].prosecdef, true, "security definer: orqon_app gets the function, not the table");
      assert.deepEqual(fn.rows[0].proconfig, ['search_path=""']);
    } finally {
      await auth.drop();
    }
  });
});

test("forged user_metadata neither takes over a principal nor accepts its invitations", { skip }, async () => {
  await withTenancy(async ({ pool, deps, auth, defaultOrg }) => {
    const authSchema = await installGithubIdentityOf(pool);
    try {
      await authSchema.addUser(EVIL, 480938, "hubot");
      await authSchema.addUser(OCTO, 583231, "octocat");
      const sessions = supabaseSessionVerifier({
        url: PROJECT,
        jwtSecret: hsSecret,
        githubIdentities: poolGithubIdentities(pool),
      });
      const real = { ...auth, sessions };
      const call = (method, path, bearer = BOOTSTRAP, body) =>
        handleApiRequest(deps, real, {
          method,
          path,
          query: query(),
          headers: { authorization: `Bearer ${bearer}` },
          body,
        });

      // octocat is invited, as an admin; the attacker (hubot) is not.
      const invite = await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "octocat", role: "admin" });
      assert.equal(invite.status, 201);
      const evil = hsSession({ sub: EVIL, user_metadata: forgedMetadata });
      const refused = await call("GET", "/v1/self", evil);
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, "not_a_member");
      const pending = await pool.query("select accepted_at from invitation where github_user_id = 583231");
      assert.equal(pending.rows[0].accepted_at, null, "octocat's invitation is still waiting for octocat");
      const links = await pool.query("select 1 from user_identity where subject = $1", [EVIL]);
      assert.equal(links.rows.length, 0);

      // The real octocat signs in and gets the invitation; the attacker still cannot ride on it.
      const octo = await call("GET", "/v1/self", hsSession({ sub: OCTO, user_metadata: {} }));
      assert.equal(octo.status, 200);
      assert.equal(octo.body.principal.githubLogin, "octocat");
      assert.deepEqual(octo.body.organizations.map((o) => [o.id, o.role]), [[defaultOrg, "admin"]]);
      assert.equal((await call("GET", "/v1/self", evil)).status, 403);
    } finally {
      await authSchema.drop();
    }
  });
});

test("an identity link that no longer matches the session's GitHub account is not honoured", { skip }, async () => {
  await withTenancy(async ({ pool, call }) => {
    const invite = await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "octocat", role: "admin" });
    assert.equal(invite.status, 201);
    const octo = await call("GET", "/v1/self", "session:sub-octo:583231:octocat");
    assert.equal(octo.status, 200);

    // A link made while the id was read from user_metadata: hubot's subject, octocat's principal.
    await pool.query(`insert into user_identity (principal_id, provider, subject) values ($1, 'supabase', 'sub-evil')`, [
      octo.body.principal.id,
    ]);
    const stale = await call("GET", "/v1/self", "session:sub-evil:480938:hubot");
    assert.equal(stale.status, 403);
    assert.equal(stale.body.code, "not_a_member");
    const noGithub = await call("GET", "/v1/self", "session:sub-evil:null:hubot");
    assert.equal(noGithub.status, 403, "no GitHub account at all is not a match either");
    const seen = await pool.query("select last_seen_at from user_identity where subject = 'sub-evil'");
    assert.equal(seen.rows[0].last_seen_at, null, "a refused link is not touched, and stays as evidence");

    // The legitimate link keeps working.
    assert.equal((await call("GET", "/v1/self", "session:sub-octo:583231:octocat")).status, 200);
  });
});


// --- usage and budgets (#394, ADR-0037) --------------------------------------------------------

test("an admin of one organization cannot read another's usage, and a member cannot change a budget", { skip }, async () => {
  await withTenancy(async ({ pool, call, defaultOrg }) => {
    const { orgId, monaSession } = await secondOrganization(pool, call);
    // Mona is an admin of `platform` only.
    assert.equal((await call("GET", `/v1/orgs/${orgId}/usage`, monaSession)).status, 200);
    assert.equal((await call("GET", `/v1/orgs/${defaultOrg}/usage`, monaSession)).status, 404);
    assert.equal((await call("PUT", `/v1/orgs/${defaultOrg}/budget`, monaSession, { monthlyLimitUsd: 1 })).status, 404);
    assert.equal((await call("PUT", `/v1/orgs/${orgId}/budget`, monaSession, { monthlyLimitUsd: 1 })).status, 200);
    // A read-only token of the operator's reads usage and is refused the budget write.
    const token = await call("POST", "/v1/tokens", BOOTSTRAP, { name: "ro", preset: "read" });
    assert.equal(token.status, 201);
    assert.equal((await call("GET", `/v1/orgs/${defaultOrg}/usage`, token.body.secret)).status, 200);
    const refused = await call("PUT", `/v1/orgs/${defaultOrg}/budget`, token.body.secret, { monthlyLimitUsd: 1 });
    assert.deepEqual([refused.status, refused.body.missing], [403, "billing.manage"]);
  });
});
