/**
 * Integration connections and routes (ADR-0025 §2, M8-3): one provider workspace belongs to one
 * organization at a time, and a route picks a repository specific → default → nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import {
  addRoute,
  createConnection,
  disconnectConnection,
  listConnections,
  resolveConnection,
  resolveRoute,
  updateRoute,
} from "../dist/integrations/connections.js";
import { RouteError, TenantClaimedError } from "../dist/integrations/errors.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const REPO_A = "11111111-1111-1111-1111-111111111111";
const REPO_B = "22222222-2222-2222-2222-222222222222";

let serial = 0;
async function withSchema(fn) {
  const schema = `windkeel_integrations_model_test_${Date.now()}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool, REPO_A);
    await seedFixtureRepository(pool, REPO_B);
    const defaultOrg = (await pool.query("select id from organization where is_default")).rows[0].id;
    const otherOrg = (
      await pool.query(
        `insert into organization (account_id, name) select account_id, 'platform' from organization where is_default
         returning id`,
      )
    ).rows[0].id;
    // REPO_B is granted to the other organization only; `seedFixtureRepository` grants to the default.
    await pool.query("delete from repository_grant where repository_id = $1", [REPO_B]);
    await pool.query("insert into repository_grant (organization_id, repository_id) values ($1, $2)", [otherOrg, REPO_B]);
    await fn({ pool, defaultOrg, otherOrg });
  } finally {
    await dropMigratedDatabase(schema);
    await pool.end();
  }
}

function slack(organizationId, overrides = {}) {
  return {
    organizationId,
    provider: "slack",
    installationId: "inst_slack_1",
    externalTenantId: "T0001",
    externalTenantName: "Acme",
    createdByPrincipalId: null,
    ...overrides,
  };
}

test("a provider workspace belongs to one organization: a second org claiming it is refused", { skip }, async () => {
  await withSchema(async ({ pool, defaultOrg, otherOrg }) => {
    const first = await createConnection(pool, slack(defaultOrg));
    assert.equal(first.created, true);

    await assert.rejects(createConnection(pool, slack(otherOrg, { installationId: "inst_other" })), TenantClaimedError);

    // The same organization connecting again refreshes the row rather than making a second one.
    const again = await createConnection(pool, slack(defaultOrg, { installationId: "inst_slack_2" }));
    assert.equal(again.created, false);
    assert.equal(again.connection.id, first.connection.id);
    assert.equal(again.connection.installationId, "inst_slack_2");

    // The same tenant id under another provider is a different workspace.
    const linear = await createConnection(pool, slack(otherOrg, { provider: "linear" }));
    assert.equal(linear.created, true);

    // And the database refuses two active rows even if application code were bypassed.
    await assert.rejects(
      pool.query(
        `insert into integration_connection (organization_id, provider, installation_id, external_tenant_id)
         values ($1, 'slack', 'x', 'T0001')`,
        [otherOrg],
      ),
      /integration_connection_active_tenant_idx/,
    );
  });
});

/**
 * ORQ-13: a disconnect frees the workspace for another organization of the *same account*, and only
 * through an account role — a disconnect is not a moment for whoever knows the installation id to
 * take the workspace over.
 */
test("after a disconnect the workspace can be connected in another organization by an account admin", { skip }, async () => {
  await withSchema(async ({ pool, defaultOrg, otherOrg }) => {
    const operator = (await pool.query("select id from principal where is_bootstrap")).rows[0].id;
    const { connection } = await createConnection(pool, slack(defaultOrg));
    const disconnected = await disconnectConnection(pool, defaultOrg, connection.id);
    assert.equal(disconnected.status, "disconnected");
    assert.ok(disconnected.disconnectedAt instanceof Date);
    assert.equal(await resolveConnection(pool, "slack", "T0001"), null, "a disconnected workspace resolves to nobody");

    // Another organization cannot disconnect what it does not hold.
    assert.equal(await disconnectConnection(pool, otherOrg, connection.id), null);

    // An organization admin with no account role cannot take it over.
    await assert.rejects(
      createConnection(pool, slack(otherOrg, { installationId: "inst_moved" })),
      (err) => err instanceof TenantClaimedError && /needs integrations.manage through an account role/.test(err.message),
    );

    const moved = await createConnection(pool, slack(otherOrg, { installationId: "inst_moved", createdByPrincipalId: operator }));
    assert.equal(moved.created, true);
    const resolved = await resolveConnection(pool, "slack", "T0001");
    assert.equal(resolved.organizationId, otherOrg);
    assert.equal(resolved.installationId, "inst_moved");

    // History is kept: both rows are there.
    const { rows } = await pool.query("select status from integration_connection order by created_at");
    assert.deepEqual(rows.map((r) => r.status), ["disconnected", "active"]);

    // The organization it moved to is now its holder: after its own disconnect, its own admin
    // reconnects with no account role — the older holder's row does not decide.
    await disconnectConnection(pool, otherOrg, moved.connection.id);
    const back = await createConnection(pool, slack(otherOrg, { installationId: "inst_back" }));
    assert.equal(back.created, true);
    assert.equal((await resolveConnection(pool, "slack", "T0001")).organizationId, otherOrg);
  });
});

test("ORQ-13: a workspace another account connected cannot be reclaimed, even after a disconnect; its own org reconnects freely", { skip }, async () => {
  await withSchema(async ({ pool, defaultOrg }) => {
    const operator = (await pool.query("select id from principal where is_bootstrap")).rows[0].id;
    const { connection } = await createConnection(pool, slack(defaultOrg));
    await disconnectConnection(pool, defaultOrg, connection.id);

    const account = (await pool.query("insert into account (name) values ('elsewhere') returning id")).rows[0].id;
    const foreignOrg = (
      await pool.query("insert into organization (account_id, name) values ($1, 'foreign') returning id", [account])
    ).rows[0].id;
    await assert.rejects(
      createConnection(pool, slack(foreignOrg, { installationId: "inst_slack_1", createdByPrincipalId: operator })),
      (err) => err instanceof TenantClaimedError && /another account/.test(err.message),
    );
    assert.equal(await resolveConnection(pool, "slack", "T0001"), null, "nobody holds it");

    // The organization that disconnected it can always come back.
    const back = await createConnection(pool, slack(defaultOrg));
    assert.equal(back.created, true);
    assert.equal((await resolveConnection(pool, "slack", "T0001")).organizationId, defaultOrg);
  });
});

test("a route resolves specific, then default, then nothing", { skip }, async () => {
  await withSchema(async ({ pool, defaultOrg }) => {
    const { connection } = await createConnection(pool, slack(defaultOrg));
    const scope = { scopeKind: "slack_channel", scopeValue: "C123" };
    assert.equal(await resolveRoute(pool, connection.id, scope), null, "no routes: nowhere to go");

    const fallback = await addRoute(pool, defaultOrg, connection.id, { repositoryId: REPO_A });
    assert.equal(fallback.scopeKind, "default");
    assert.equal(fallback.triggerLabel, "windkeel");
    assert.equal((await resolveRoute(pool, connection.id, scope)).id, fallback.id);

    const channel = await addRoute(pool, defaultOrg, connection.id, {
      scopeKind: "slack_channel",
      scopeValue: "C123",
      repositoryId: REPO_A,
      triggerLabel: "build-it",
    });
    assert.equal((await resolveRoute(pool, connection.id, scope)).id, channel.id);
    assert.equal(
      (await resolveRoute(pool, connection.id, { scopeKind: "slack_channel", scopeValue: "C999" })).id,
      fallback.id,
      "another channel falls back to the default",
    );
    assert.equal((await resolveRoute(pool, connection.id, { scopeKind: "default" })).id, fallback.id);

    // A disabled specific route is still the answer, so the intake can say why it ignored the event.
    const disabled = await updateRoute(pool, defaultOrg, connection.id, channel.id, { enabled: false });
    assert.equal(disabled.enabled, false);
    assert.equal((await resolveRoute(pool, connection.id, scope)).id, channel.id);

    await assert.rejects(
      addRoute(pool, defaultOrg, connection.id, { scopeKind: "slack_channel", scopeValue: "C123", repositoryId: REPO_A }),
      (err) => err instanceof RouteError && err.code === "route_exists" && err.status === 409,
    );
    await assert.rejects(
      addRoute(pool, defaultOrg, connection.id, { scopeKind: "linear_team", scopeValue: "ENG", repositoryId: REPO_A }),
      (err) => err instanceof RouteError && err.code === "invalid_route",
      "a Slack connection has no Linear team scope",
    );

    const listed = await listConnections(pool, defaultOrg);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].routes.length, 2);
  });
});

test("a route to a repository not granted to the organization is refused with 422", { skip }, async () => {
  await withSchema(async ({ pool, defaultOrg, otherOrg }) => {
    const { connection } = await createConnection(pool, slack(defaultOrg));
    await assert.rejects(
      addRoute(pool, defaultOrg, connection.id, { repositoryId: REPO_B }),
      (err) => err instanceof RouteError && err.status === 422 && err.code === "repository_not_granted",
    );
    const route = await addRoute(pool, defaultOrg, connection.id, { repositoryId: REPO_A });
    await assert.rejects(
      updateRoute(pool, defaultOrg, connection.id, route.id, { repositoryId: REPO_B }),
      (err) => err instanceof RouteError && err.status === 422,
    );
    // Another organization's connection is not found, rather than refused: it does not exist for them.
    assert.equal(await addRoute(pool, otherOrg, connection.id, { repositoryId: REPO_B }), null);
  });
});
