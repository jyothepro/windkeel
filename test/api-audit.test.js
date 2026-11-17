/**
 * The audit log and the account's security policy through the real router (#393 8A, 8F): admin
 * acts are recorded with who and from where, list and export agree, other accounts see nothing,
 * the chain verifies, and the policy (IP allowlist, token lifetime, MFA, idle sessions) is
 * enforced and audited. Drives `handleApiRequest` as `api-tenancy.test.js` does.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { createApiToken } from "../dist/factory/tenancy.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const BOOTSTRAP = "test-bootstrap-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";
const { publicKey: PUBLIC_KEY } = generateSecretKeyPair();

/** `session:<subject>:<githubUserId>:<login>[:<sessionId>[:<aal>]]`. */
const fakeSessions = {
  async verify(jwt) {
    const [kind, subject, id, login, sessionId, aal] = jwt.split(":");
    if (kind !== "session") return null;
    return {
      provider: "supabase",
      subject,
      githubUserId: Number(id),
      githubLogin: login,
      displayName: login,
      sessionId: sessionId ?? null,
      aal: aal ?? null,
    };
  },
};

const fakeGithubUsers = {
  async lookup(login) {
    const known = { octocat: 583231, mona: 9919, hubot: 480938 };
    return known[login] ? { id: known[login], login } : null;
  },
};

const query = (params = {}) => ({ get: (name) => params[name] });

async function withApi(fn) {
  const schema = `windkeel_api_audit_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const deps = {
      pool,
      control: {
        approve: async () => ({ outcome: "signalled" }),
        cancel: async () => ({ outcome: "cancelled" }),
        message: async () => ({ outcome: "queued" }),
        listMessages: async () => [],
      },
      githubUsers: fakeGithubUsers,
      secretPublicKey: PUBLIC_KEY,
    };
    const auth = { token: BOOTSTRAP, subject: "operator", sessions: fakeSessions };
    const call = (method, path, bearer = BOOTSTRAP, body, params = {}, headers = {}) =>
      handleApiRequest(deps, auth, {
        method,
        path,
        query: query(params),
        headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), "user-agent": "api-audit-test", ...headers },
        body,
      });
    const defaultOrg = (await pool.query("select id from organization where is_default")).rows[0].id;
    const accountId = (await pool.query("select id from account where is_default")).rows[0].id;
    await fn({ pool, deps, call, defaultOrg, accountId });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

const actions = (page) => page.items.map((e) => e.action);

test("admin acts are recorded with who, where and what, and list and export agree", { skip }, async () => {
  await withApi(async ({ call, defaultOrg }) => {
    const created = await call("POST", "/v1/tokens", BOOTSTRAP, { name: "ci", preset: "read" }, {}, { "x-vercel-forwarded-for": "203.0.113.5" });
    assert.equal(created.status, 201);
    assert.equal((await call("POST", `/v1/tokens/${created.body.token.id}/revoke`)).status, 200);
    assert.equal((await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "mona", role: "member" })).status, 201);
    const mona = "session:sub-mona:9919:mona:sess-1";
    assert.equal((await call("GET", "/v1/self", mona)).status, 200, "accepting the invitation");
    const monaId = (await call("GET", "/v1/self", mona)).body.principal.id;
    assert.equal((await call("POST", `/v1/members/${monaId}/role`, BOOTSTRAP, { role: "viewer" })).status, 200);
    assert.equal((await call("POST", "/v1/repositories/grants", BOOTSTRAP, { repositoryId: REPO_ID, intake: true })).status, 200);
    assert.equal((await call("POST", `/v1/repositories/${REPO_ID}/secrets`, BOOTSTRAP, { key: "NPM_TOKEN", value: "npm_s3cr3t_value" })).status, 200);

    const page = await call("GET", "/v1/account/audit-events", BOOTSTRAP, undefined, { limit: "100" });
    assert.equal(page.status, 200);
    assert.deepEqual(actions(page.body).reverse(), [
      "token.created",
      "token.revoked",
      "invitation.created",
      "invitation.accepted",
      "session.signed_in",
      "member.role_changed",
      "grant.created",
      "secret.set",
    ]);
    const [tokenCreated] = page.body.items.slice(-1);
    assert.equal(tokenCreated.actorKind, "token", "the bootstrap token is a token, not a person");
    assert.equal(tokenCreated.actorText, "operator");
    assert.equal(tokenCreated.ip, "203.0.113.5");
    assert.equal(tokenCreated.userAgent, "api-audit-test");
    assert.equal(tokenCreated.detail.prefix, created.body.token.prefix);
    assert.ok(!JSON.stringify(page.body).includes(created.body.secret), "never a token's value");
    assert.ok(!JSON.stringify(page.body).includes("npm_s3cr3t_value"), "never a secret's value");
    const roleChanged = page.body.items.find((e) => e.action === "member.role_changed");
    assert.deepEqual(roleChanged.detail, { from: "member", to: "viewer" });
    assert.equal(roleChanged.organizationId, defaultOrg);
    const signedIn = page.body.items.find((e) => e.action === "session.signed_in");
    assert.equal(signedIn.actorKind, "user");
    assert.equal(signedIn.actorText, "mona");
    assert.equal(page.body.items.filter((e) => e.action === "session.signed_in").length, 1, "once per session, not per request");

    // The export, for the same range, is the same events oldest first.
    const exported = await call("GET", "/v1/account/audit-events/export", BOOTSTRAP, undefined, { format: "jsonl" });
    assert.equal(exported.status, 200);
    assert.match(exported.headers["content-type"], /ndjson/);
    const lines = exported.raw.trimEnd().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines, JSON.parse(JSON.stringify(page.body.items)).reverse());
    const csv = await call("GET", "/v1/account/audit-events/export", BOOTSTRAP, undefined, { format: "csv" });
    assert.equal(csv.raw.trimEnd().split("\n").length, 1 + 9, "a header, eight events and the first export's own record");
    const latest = await call("GET", "/v1/account/audit-events", BOOTSTRAP, undefined, { limit: "2" });
    assert.deepEqual(actions(latest.body), ["audit.exported", "audit.exported"], "an export is itself audited");

    // Filters: by action prefix, by actor, by time.
    const tokens = await call("GET", "/v1/account/audit-events", BOOTSTRAP, undefined, { action: "token.*" });
    assert.deepEqual(actions(tokens.body), ["token.revoked", "token.created"]);
    const byMona = await call("GET", "/v1/account/audit-events", BOOTSTRAP, undefined, { actor: monaId });
    assert.deepEqual(actions(byMona.body).sort(), ["invitation.accepted", "session.signed_in"]);
    const future = await call("GET", "/v1/account/audit-events", BOOTSTRAP, undefined, { after: new Date(Date.now() + 60_000).toISOString() });
    assert.deepEqual(future.body.items, []);
    const bad = await call("GET", "/v1/account/audit-events", BOOTSTRAP, undefined, { action: "verifier.off" });
    assert.equal(bad.body.code, "invalid_action");
    const badCursor = await call("GET", "/v1/account/audit-events", BOOTSTRAP, undefined, { cursor: "zzz" });
    assert.equal(badCursor.body.code, "invalid_cursor");

    // The organization mirror shows that organization's events.
    const mirror = await call("GET", `/v1/orgs/${defaultOrg}/audit-events`, BOOTSTRAP, undefined, { limit: "100" });
    assert.equal(mirror.status, 200);
    assert.ok(mirror.body.items.every((e) => e.organizationId === defaultOrg));
    assert.ok(mirror.body.items.some((e) => e.action === "grant.created"));

    const verdict = await call("GET", "/v1/account/audit-events/verify");
    assert.equal(verdict.status, 200);
    assert.equal(verdict.body.ok, true);
  });
});

test("audit routes need audit.read through an account role; another account sees nothing", { skip }, async () => {
  await withApi(async ({ pool, call, defaultOrg }) => {
    await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "mona", role: "admin" });
    const mona = "session:sub-mona:9919:mona";
    // An organization admin, but no account role: the account's log is not theirs.
    const refused = await call("GET", "/v1/account/audit-events", mona);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "account_role_required");
    // …though their organization's mirror is (Admin holds audit.read).
    assert.equal((await call("GET", `/v1/orgs/${defaultOrg}/audit-events`, mona)).status, 200);

    await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "hubot", role: "viewer" });
    const viewer = "session:sub-hubot:480938:hubot";
    const viewerMirror = await call("GET", `/v1/orgs/${defaultOrg}/audit-events`, viewer);
    assert.equal(viewerMirror.status, 403);
    assert.equal(viewerMirror.body.missing, "audit.read");

    // A token without audit.read, from the account admin, is refused naming it.
    const read = (await call("POST", "/v1/tokens", BOOTSTRAP, { name: "reader", preset: "read" })).body.secret;
    const narrow = await call("GET", "/v1/account/audit-events", read);
    assert.equal(narrow.status, 403);
    assert.equal(narrow.body.missing, "audit.read");
    // A token pinned to one organization cannot reach the account at all.
    const pinned = (await call("POST", "/v1/tokens", BOOTSTRAP, { name: "pinned", permissions: ["audit.read"], organizationId: defaultOrg })).body.secret;
    assert.equal((await call("GET", "/v1/account/audit-events", pinned)).status, 403);
    const auditor = (await call("POST", "/v1/tokens", BOOTSTRAP, { name: "siem", permissions: ["audit.read"] })).body.secret;
    assert.equal((await call("GET", "/v1/account/audit-events", auditor)).status, 200);

    // A second account with its own admin sees an empty log, and none of the first account's rows.
    const other = (await pool.query("insert into account (name) values ('other') returning id")).rows[0].id;
    await pool.query("insert into organization (account_id, name) values ($1, 'other-org')", [other]);
    const otherAdmin = (
      await pool.query("insert into principal (account_id, kind, display_name) values ($1, 'user', 'other-admin') returning id", [other])
    ).rows[0].id;
    await pool.query(
      "insert into account_membership (account_id, principal_id, access_role_id) select $1, $2, id from access_role where key = 'admin' and account_id is null",
      [other, otherAdmin],
    );
    const otherToken = (
      await createApiToken(pool, {
        name: "other",
        ownerPrincipalId: otherAdmin,
        createdByPrincipalId: otherAdmin,
        organizationId: null,
        permissions: ["audit.read"],
        ceiling: ["audit.read"],
      })
    ).secret;
    const theirs = await call("GET", "/v1/account/audit-events", otherToken);
    assert.equal(theirs.status, 200);
    assert.deepEqual(theirs.body.items, []);
    const theirExport = await call("GET", "/v1/account/audit-events/export", otherToken);
    assert.equal(theirExport.raw, "");
    const mirrorOfOurs = await call("GET", `/v1/orgs/${defaultOrg}/audit-events`, otherToken);
    assert.equal(mirrorOfOurs.status, 404, "another account's organization does not exist");
  });
});

test("tampering is detected by verify, and deleting audit data is a recorded prefix purge", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    for (const name of ["a", "b", "c"]) await call("POST", "/v1/tokens", BOOTSTRAP, { name, preset: "read" });
    assert.equal((await call("GET", "/v1/account/audit-events/verify")).body.ok, true);

    const client = await pool.connect();
    try {
      await client.query("alter table audit_event disable trigger audit_event_append_only");
      await client.query("update audit_event set actor_text = 'someone-else' where seq = 2");
      await client.query("alter table audit_event enable trigger audit_event_append_only");
    } finally {
      client.release();
    }
    const broken = await call("GET", "/v1/account/audit-events/verify");
    assert.deepEqual([broken.body.ok, broken.body.brokenAt.seq, broken.body.brokenAt.reason], [false, 2, "hash_mismatch"]);

    // A customer may delete their audit data (maintainer decision on #393): needs account.manage.
    const reader = (await call("POST", "/v1/tokens", BOOTSTRAP, { name: "reader", permissions: ["audit.read"] })).body.secret;
    const refused = await call("DELETE", "/v1/account/audit-events", reader, undefined, { before: new Date().toISOString() });
    assert.equal(refused.body.missing, "account.manage");
    assert.equal((await call("DELETE", "/v1/account/audit-events")).body.code, "missing_field");
    const deleted = await call("DELETE", "/v1/account/audit-events", BOOTSTRAP, undefined, { before: new Date(Date.now() + 1000).toISOString() });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, 4);
    assert.equal(deleted.body.event.action, "audit.deleted");
    // Deleting everything older does not restart the chain: seq keeps counting, and the record is
    // anchored to the last deleted row rather than posing as a fresh account's first event.
    assert.equal(deleted.body.event.seq, 5);
    assert.equal(deleted.body.event.prevHash, deleted.body.event.detail.anchorHash);
    const verdict = await call("GET", "/v1/account/audit-events/verify");
    assert.deepEqual(verdict.body, { ok: true, checked: 1 }, "the surviving chain starts at the recorded anchor");
  });
});

test("the IP allowlist refuses other addresses, audits them, and exempts only break-glass", { skip }, async () => {
  await withApi(async ({ call }) => {
    const token = (await call("POST", "/v1/tokens", BOOTSTRAP, { name: "ci", preset: "read" })).body.secret;
    const set = await call("PUT", "/v1/account/security-policy", BOOTSTRAP, { ipAllowlist: ["10.0.0.0/8", "2001:db8::/32"] });
    assert.equal(set.status, 200);
    assert.deepEqual(set.body.policy.ipAllowlist, ["10.0.0.0/8", "2001:db8::/32"]);

    const outside = await call("GET", "/v1/runs", token, undefined, {}, { "x-vercel-forwarded-for": "192.168.1.9" });
    assert.equal(outside.status, 403);
    assert.equal(outside.body.code, "ip_not_allowed");
    // A client-written x-forwarded-for is not the trusted header and does not let it in.
    const spoofed = await call("GET", "/v1/runs", token, undefined, {}, { "x-forwarded-for": "10.1.1.1" });
    assert.equal(spoofed.status, 403);
    assert.equal((await call("GET", "/v1/runs", token, undefined, {}, { "x-vercel-forwarded-for": "10.1.2.3" })).status, 200);
    assert.equal((await call("GET", "/v1/runs", token, undefined, {}, { "x-vercel-forwarded-for": "2001:db8::42" })).status, 200);
    assert.equal((await call("GET", "/v1/runs", BOOTSTRAP, undefined, {}, { "x-vercel-forwarded-for": "192.168.1.9" })).status, 200);

    const denied = await call("GET", "/v1/account/audit-events", BOOTSTRAP, undefined, { action: "request.ip_denied" });
    assert.deepEqual(denied.body.items.map((e) => e.ip), [null, "192.168.1.9"]);
    const policy = await call("GET", "/v1/account/audit-events", BOOTSTRAP, undefined, { action: "policy.updated" });
    assert.deepEqual(policy.body.items[0].detail.after.ipAllowlist, ["10.0.0.0/8", "2001:db8::/32"]);

    const malformed = await call("PUT", "/v1/account/security-policy", BOOTSTRAP, { ipAllowlist: ["10.0.0.1/8"] });
    assert.equal(malformed.body.code, "invalid_policy");
    assert.equal((await call("PUT", "/v1/account/security-policy", BOOTSTRAP, { ipAllowlist: ["nonsense"] })).status, 400);
  });
});

test("token lifetime policy clamps a long request and refuses a missing expiry", { skip }, async () => {
  await withApi(async ({ call }) => {
    await call("PUT", "/v1/account/security-policy", BOOTSTRAP, { requireTokenExpiry: true });
    const undated = await call("POST", "/v1/tokens", BOOTSTRAP, { name: "forever", preset: "read" });
    assert.equal(undated.status, 400);
    assert.equal(undated.body.code, "token_policy");
    assert.equal((await call("POST", "/v1/tokens", BOOTSTRAP, { name: "dated", preset: "read", expiresInDays: 7 })).status, 201);

    await call("PUT", "/v1/account/security-policy", BOOTSTRAP, { maxTokenTtlDays: 30 });
    const long = await call("POST", "/v1/tokens", BOOTSTRAP, { name: "long", preset: "read", expiresInDays: 90 });
    assert.equal(long.status, 201);
    assert.equal(long.body.expiryClamped, true);
    const days = (new Date(long.body.token.expiresAt).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30, `clamped to 30 days, got ${days}`);
    const defaulted = await call("POST", "/v1/tokens", BOOTSTRAP, { name: "no-date", preset: "read" });
    assert.equal(defaulted.status, 201, "with a maximum set, a missing expiry is given the maximum");
    assert.ok(defaulted.body.token.expiresAt);
    const recorded = await call("GET", "/v1/account/audit-events", BOOTSTRAP, undefined, { action: "token.created" });
    assert.equal(recorded.body.items[1].detail.expiryClamped, true);

    const invalid = await call("PUT", "/v1/account/security-policy", BOOTSTRAP, { maxTokenTtlDays: 0 });
    assert.equal(invalid.body.code, "invalid_policy");
    const retention = await call("PUT", "/v1/account/security-policy", BOOTSTRAP, { auditRetentionDays: 10 });
    assert.equal(retention.body.code, "invalid_policy", "below the 30-day floor");
    const year = await call("PUT", "/v1/account/security-policy", BOOTSTRAP, { auditRetentionDays: 365 });
    assert.equal(year.body.policy.auditRetentionDays, 365);
    assert.equal(year.body.policy.defaultAuditRetentionDays, 90);
  });
});

test("MFA and the idle timeout refuse sessions, audited, and a refused sign-in is recorded", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "mona", role: "member" });
    assert.equal((await call("GET", "/v1/self", "session:sub-mona:9919:mona:s1:aal1")).status, 200);

    await call("PUT", "/v1/account/security-policy", BOOTSTRAP, { requireMfa: true, idleSessionMinutes: 15 });
    const noMfa = await call("GET", "/v1/self", "session:sub-mona:9919:mona:s1:aal1");
    assert.equal(noMfa.status, 403);
    assert.equal(noMfa.body.code, "mfa_required");
    assert.equal((await call("GET", "/v1/self", "session:sub-mona:9919:mona:s2:aal2")).status, 200);

    await pool.query("update session_activity set last_seen_at = now() - interval '20 minutes' where session_id = 's2'");
    const idle = await call("GET", "/v1/self", "session:sub-mona:9919:mona:s2:aal2");
    assert.equal(idle.status, 401);
    assert.equal(idle.body.code, "session_idle");
    assert.equal((await call("GET", "/v1/self", "session:sub-mona:9919:mona:s3:aal2")).status, 200, "a new sign-in starts fresh");

    // Fail closed: with the idle rule on, a session the rule cannot track (no session_id) is refused.
    const untracked = await call("GET", "/v1/self", "session:sub-mona:9919:mona::aal2");
    assert.equal(untracked.status, 403);
    assert.equal(untracked.body.code, "session_untracked");

    const stranger = await call("GET", "/v1/self", "session:sub-x:1234:stranger:s9");
    assert.equal(stranger.body.code, "not_a_member");

    const refused = await call("GET", "/v1/account/audit-events", BOOTSTRAP, undefined, { action: "session.refused" });
    assert.deepEqual(refused.body.items.map((e) => e.detail.reason), ["not_a_member", "session_untracked", "session_idle", "mfa_required"]);
    assert.equal(refused.body.items[0].actorText, "stranger");
    assert.equal(refused.body.items[0].actorPrincipalId, null);
  });
});

test("the access review lists every principal, its roles and its live tokens", { skip }, async () => {
  await withApi(async ({ call }) => {
    await call("POST", "/v1/invitations", BOOTSTRAP, { githubLogin: "mona", role: "member" });
    await call("GET", "/v1/self", "session:sub-mona:9919:mona");
    const robot = await call("POST", "/v1/service-principals", BOOTSTRAP, { name: "deploy-bot", role: "member" });
    assert.equal(robot.status, 201);
    const token = await call("POST", "/v1/tokens", BOOTSTRAP, { name: "ci", preset: "read" });

    const review = await call("GET", "/v1/account/access-review");
    assert.equal(review.status, 200);
    const byName = Object.fromEntries(review.body.principals.map((p) => [p.displayName, p]));
    assert.deepEqual(Object.keys(byName).sort(), ["deploy-bot", "mona", "operator"]);
    assert.equal(byName.operator.bootstrap, true);
    assert.equal(byName.operator.accountRole, "admin");
    assert.deepEqual(byName.operator.tokens.map((t) => t.prefix), [token.body.token.prefix]);
    assert.deepEqual(byName.mona.organizations.map((o) => o.role), ["member"]);
    assert.equal(byName["deploy-bot"].kind, "service");
    assert.ok(!JSON.stringify(review.body).includes(token.body.secret));

    const csv = await call("GET", "/v1/account/access-review", BOOTSTRAP, undefined, { format: "csv" });
    assert.match(csv.headers["content-type"], /text\/csv/);
    assert.match(csv.raw, /^principal_id,kind,display_name/);
    assert.ok(csv.raw.includes(token.body.token.prefix));
    const recorded = await call("GET", "/v1/account/audit-events", BOOTSTRAP, undefined, { action: "access_review.exported" });
    assert.equal(recorded.body.items.length, 2);
    assert.equal((await call("GET", "/v1/account/access-review", "session:sub-mona:9919:mona")).status, 403);
  });
});

test("run commands, merging and service principals are audited in the organization", { skip }, async () => {
  await withApi(async ({ pool, call, defaultOrg }) => {
    const { insertEngineeringRun, insertEngineeringTask } = await import("../dist/factory/repositories.js");
    const task = await insertEngineeringTask(pool, {
      repositoryId: REPO_ID,
      sourceType: "api",
      sourceReference: "api:operator:1",
      title: "x",
      description: "- [ ] x",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 5, wallClockCapSeconds: 600 });
    assert.equal((await call("POST", `/v1/runs/${run.id}/approve`)).status, 202);
    assert.equal((await call("POST", `/v1/runs/${run.id}/cancel`, BOOTSTRAP, { reason: "not needed" })).status, 202);
    const sp = await call("POST", "/v1/service-principals", BOOTSTRAP, { name: "bot", role: "viewer" });
    const spToken = await call("POST", `/v1/service-principals/${sp.body.servicePrincipal.id}/tokens`, BOOTSTRAP, { name: "bot-token" });
    assert.equal(spToken.status, 201);
    assert.equal((await call("DELETE", `/v1/service-principals/${sp.body.servicePrincipal.id}`)).status, 200);
    const events = await call("GET", `/v1/orgs/${defaultOrg}/audit-events`, BOOTSTRAP, undefined, { limit: "50" });
    assert.deepEqual(actions(events.body).reverse(), [
      "run.approved",
      "run.cancelled",
      "service_principal.created",
      "token.created",
      "service_principal.deleted",
    ]);
    assert.equal(events.body.items.at(-1).targetId, run.id);
    assert.equal(events.body.items.at(-2).detail.reason, "not needed");
  });
});
