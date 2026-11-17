/**
 * `/v1/integrations` (ADR-0025 §2, M8-3): connecting a provider workspace, routing its work, and who
 * may do either. The token source is `FakeProviderTokenSource`; nothing reaches Vercel Connect.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { IntegrationMisconfigured } from "../dist/integrations/errors.js";
import { FakeProviderTokenSource } from "../dist/integrations/token-source.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const BOOTSTRAP = "test-bootstrap-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_REPO = "33333333-3333-3333-3333-333333333333";

const fakeSessions = {
  async verify(jwt) {
    const [kind, subject, id, login] = jwt.split(":");
    if (kind !== "session") return null;
    return { provider: "supabase", subject, githubUserId: Number(id), githubLogin: login, displayName: login };
  },
};
const fakeGithubUsers = {
  async lookup(login) {
    return login === "mona" ? { id: 9919, login } : null;
  },
};

let serial = 0;
async function withApi(fn) {
  const schema = `windkeel_api_integrations_test_${Date.now()}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool, REPO_ID);
    await seedFixtureRepository(pool, OTHER_REPO);
    await pool.query("delete from repository_grant where repository_id = $1", [OTHER_REPO]);

    const tokens = new FakeProviderTokenSource()
      .install("slack", "inst_acme", { tenantId: "T_ACME", name: "Acme" })
      .install("linear", "inst_nameless", { tenantId: null, name: null });
    const deps = {
      pool,
      control: {},
      githubUsers: fakeGithubUsers,
      consoleUrl: "https://console.example",
      integrationTokens: tokens,
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
    await fn({ pool, deps, call, tokens });
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

test("connect a workspace, route it, change the route, remove it, disconnect", { skip }, async () => {
  await withApi(async ({ pool, call, tokens }) => {
    assert.deepEqual((await call("GET", "/v1/integrations")).body.items, []);

    const created = await call("POST", "/v1/integrations", BOOTSTRAP, { provider: "slack", installationId: "inst_acme" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const connection = created.body.connection;
    assert.equal(connection.externalTenantId, "T_ACME");
    assert.equal(connection.externalTenantName, "Acme");
    assert.equal(connection.status, "active");
    assert.ok("createdByPrincipalId" in connection, "the console shows who connected it");
    assert.deepEqual(tokens.calls.map((c) => c.method), ["describeInstallation"]);

    // Connecting it again from the same organization is idempotent.
    const again = await call("POST", "/v1/integrations", BOOTSTRAP, { provider: "slack", installationId: "inst_acme" });
    assert.equal(again.status, 200);
    assert.equal(again.body.connection.id, connection.id);

    const base = `/v1/integrations/${connection.id}/routes`;
    const fallback = await call("POST", base, BOOTSTRAP, { repositoryId: REPO_ID });
    assert.equal(fallback.status, 201, JSON.stringify(fallback.body));
    assert.equal(fallback.body.route.scopeKind, "default");
    const channel = await call("POST", base, BOOTSTRAP, {
      repositoryId: REPO_ID,
      scopeKind: "slack_channel",
      scopeValue: "C123",
      triggerLabel: "ship-it",
    });
    assert.equal(channel.status, 201);

    const ungranted = await call("POST", base, BOOTSTRAP, { repositoryId: OTHER_REPO, scopeKind: "slack_channel", scopeValue: "C9" });
    assert.equal(ungranted.status, 422);
    assert.equal(ungranted.body.code, "repository_not_granted");

    const duplicate = await call("POST", base, BOOTSTRAP, { repositoryId: REPO_ID });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, "route_exists");

    const patched = await call("PATCH", `${base}/${channel.body.route.id}`, BOOTSTRAP, { enabled: false });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.route.enabled, false);
    assert.equal(patched.body.route.triggerLabel, "ship-it");

    const listed = await call("GET", "/v1/integrations");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].routes.length, 2);

    const removed = await call("DELETE", `${base}/${channel.body.route.id}`);
    assert.equal(removed.status, 200);
    assert.equal((await call("DELETE", `${base}/${channel.body.route.id}`)).status, 404);

    const disconnected = await call("DELETE", `/v1/integrations/${connection.id}`);
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.body.connection.status, "disconnected");
    const late = await call("POST", base, BOOTSTRAP, { repositoryId: REPO_ID, scopeKind: "slack_channel", scopeValue: "C5" });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, "connection_disconnected");

    // Nothing that looks like a token was stored or answered.
    const { rows } = await pool.query("select row_to_json(c) as row from integration_connection c");
    assert.ok(!JSON.stringify(rows).includes("fake-slack"));
    assert.ok(!JSON.stringify(created.body).includes("fake-slack"));
  });
});

test("writes need integrations.manage; reads need runs.read", { skip }, async () => {
  await withApi(async ({ call }) => {
    const minted = await call("POST", "/v1/tokens", BOOTSTRAP, { name: "ci", preset: "execute" });
    assert.equal(minted.status, 201);
    const narrow = minted.body.secret;

    assert.equal((await call("GET", "/v1/integrations", narrow)).status, 200);
    const refused = await call("POST", "/v1/integrations", narrow, { provider: "slack", installationId: "inst_acme" });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.missing, "integrations.manage");

    const connection = (await call("POST", "/v1/integrations", BOOTSTRAP, { provider: "slack", installationId: "inst_acme" })).body
      .connection;
    for (const [method, path] of [
      ["DELETE", `/v1/integrations/${connection.id}`],
      ["POST", `/v1/integrations/${connection.id}/routes`],
      ["PATCH", `/v1/integrations/${connection.id}/routes/${connection.id}`],
      ["DELETE", `/v1/integrations/${connection.id}/routes/${connection.id}`],
    ]) {
      const answer = await call(method, path, narrow, { repositoryId: REPO_ID });
      assert.equal(answer.status, 403, `${method} ${path}`);
      assert.equal(answer.body.missing, "integrations.manage");
    }

    // The admin preset carries it.
    const admin = (await call("POST", "/v1/tokens", BOOTSTRAP, { name: "admin", preset: "admin" })).body;
    assert.ok(admin.token.permissions.includes("integrations.manage"));
    assert.equal((await call("DELETE", `/v1/integrations/${connection.id}`, admin.secret)).status, 200);

    const unauthenticated = await call("GET", "/v1/integrations", null);
    assert.equal(unauthenticated.status, 401);
  });
});

test("a workspace another organization holds is 409 tenant_claimed", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const { rows } = await pool.query(
      `insert into organization (account_id, name) select account_id, 'platform' from organization where is_default
       returning id`,
    );
    const otherOrg = rows[0].id;
    const invite = await call("POST", `/v1/orgs/${otherOrg}/invitations`, BOOTSTRAP, { githubLogin: "mona", role: "admin" });
    assert.equal(invite.status, 201);
    const mona = "session:sub-mona:9919:mona";

    const defaultOrg = (await pool.query("select id from organization where is_default")).rows[0].id;
    const home = `/v1/orgs/${defaultOrg}/integrations`;
    // The operator is in both organizations now, so it names which one.
    assert.equal((await call("POST", home, BOOTSTRAP, { provider: "slack", installationId: "inst_acme" })).status, 201);

    const claimed = await call("POST", `/v1/orgs/${otherOrg}/integrations`, mona, { provider: "slack", installationId: "inst_acme" });
    assert.equal(claimed.status, 409);
    assert.equal(claimed.body.code, "tenant_claimed");

    // Mona sees none of the default organization's connections.
    const listed = await call("GET", `/v1/orgs/${otherOrg}/integrations`, mona);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.items, []);
    const defaultConnection = (await call("GET", home)).body.items[0];
    assert.equal((await call("DELETE", `/v1/orgs/${otherOrg}/integrations/${defaultConnection.id}`, mona)).status, 404);
  });
});

test("bad input and a token source that cannot answer are named refusals", { skip }, async () => {
  await withApi(async ({ call, deps, tokens }) => {
    const badProvider = await call("POST", "/v1/integrations", BOOTSTRAP, { provider: "github", installationId: "x" });
    assert.equal(badProvider.status, 400);
    assert.equal(badProvider.body.code, "invalid_provider");

    const missing = await call("POST", "/v1/integrations", BOOTSTRAP, { provider: "slack" });
    assert.equal(missing.status, 400);

    const unknown = await call("POST", "/v1/integrations", BOOTSTRAP, { provider: "slack", installationId: "inst_nobody" });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.code, "integration_not_connected");

    const nameless = await call("POST", "/v1/integrations", BOOTSTRAP, { provider: "linear", installationId: "inst_nameless" });
    assert.equal(nameless.status, 422);
    assert.equal(nameless.body.code, "tenant_unknown");

    tokens.failWith = new IntegrationMisconfigured("slack", "WINDKEEL_CONNECT_SLACK is not set");
    const misconfigured = await call("POST", "/v1/integrations", BOOTSTRAP, { provider: "slack", installationId: "inst_acme" });
    assert.equal(misconfigured.status, 503);
    assert.equal(misconfigured.body.code, "integration_misconfigured");
    tokens.failWith = undefined;

    delete deps.integrationTokens;
    const disabled = await call("POST", "/v1/integrations", BOOTSTRAP, { provider: "slack", installationId: "inst_acme" });
    assert.equal(disabled.status, 503);
    assert.equal(disabled.body.code, "integrations_disabled");
  });
});

// --- #389: Sentry, which Connect does not carry (ADR-0034) ---

const SENTRY_UUID = "7a485448-a9e2-4c85-8a3c-4f44175783c9";
const SENTRY_TOKEN = "sntrys_fake_token_0123456789";

test("sentry: connect by installation uuid, token sealed and never echoed; routes are sentry_project; disconnect drops it", { skip }, async () => {
  await withApi(async ({ pool, deps, call }) => {
    // No public key: a token cannot be sealed, so it is refused before anything is written.
    const refused = await call("POST", "/v1/integrations", BOOTSTRAP, { provider: "sentry", externalTenantId: SENTRY_UUID, token: SENTRY_TOKEN });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, "secrets_disabled");
    assert.equal((await pool.query("select count(*)::int as n from integration_connection")).rows[0].n, 0);

    const { generateSecretKeyPair } = await import("../dist/factory/secret-box.js");
    deps.secretPublicKey = generateSecretKeyPair().publicKey;
    const made = await call("POST", "/v1/integrations", BOOTSTRAP, {
      provider: "sentry",
      externalTenantId: SENTRY_UUID.toUpperCase(),
      orgSlug: "acme-shop",
      token: SENTRY_TOKEN,
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.connection.provider, "sentry");
    assert.equal(made.body.connection.externalTenantId, SENTRY_UUID);
    assert.equal(made.body.connection.externalTenantName, "acme-shop");
    assert.equal(made.body.credential.last4, SENTRY_TOKEN.slice(-4));
    assert.ok(!JSON.stringify(made.body).includes(SENTRY_TOKEN), "the token is never echoed");
    const { rows } = await pool.query("select sealed_value from sentry_credential");
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].sealed_value.includes(SENTRY_TOKEN));

    const id = made.body.connection.id;
    const route = await call("POST", `/v1/integrations/${id}/routes`, BOOTSTRAP, { scopeKind: "sentry_project", scopeValue: "checkout-web", repositoryId: REPO_ID });
    assert.equal(route.status, 201, JSON.stringify(route.body));
    assert.equal(route.body.route.triggerLabel, "windkeel");
    const wrongScope = await call("POST", `/v1/integrations/${id}/routes`, BOOTSTRAP, { scopeKind: "jira_project", scopeValue: "ENG", repositoryId: REPO_ID });
    assert.equal(wrongScope.status, 400);
    const ungranted = await call("POST", `/v1/integrations/${id}/routes`, BOOTSTRAP, { repositoryId: OTHER_REPO });
    assert.equal(ungranted.status, 422);
    assert.equal(ungranted.body.code, "repository_not_granted");

    for (const body of [
      { provider: "sentry" },
      { provider: "sentry", externalTenantId: "not-a-uuid" },
      { provider: "sentry", externalTenantId: SENTRY_UUID, token: "short" },
      { provider: "sentry", externalTenantId: SENTRY_UUID, orgSlug: "a b" },
    ]) {
      assert.equal((await call("POST", "/v1/integrations", BOOTSTRAP, body)).status, 400, JSON.stringify(body));
    }

    // Reconnecting without a token keeps the stored one.
    const again = await call("POST", "/v1/integrations", BOOTSTRAP, { provider: "sentry", installationId: SENTRY_UUID });
    assert.equal(again.status, 200);
    assert.equal(again.body.credential.last4, SENTRY_TOKEN.slice(-4));

    assert.equal((await call("DELETE", `/v1/integrations/${id}`)).status, 200);
    assert.equal((await pool.query("select count(*)::int as n from sentry_credential")).rows[0].n, 0, "a disconnect keeps no credential");
  });
});
