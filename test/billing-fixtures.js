/**
 * Shared fixtures for the billing tests (#394): a throwaway schema with every migration, extra
 * accounts and organizations, runs in them, and ledger rows at chosen instants.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { recordCost } from "../dist/factory/cost-ledger.js";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

export const dbUrl = process.env.TEST_DATABASE_URL;
export const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let counter = 0;

export async function withSchema(prefix, fn) {
  counter += 1;
  const schema = `windkeel_${prefix}_${Date.now()}_${process.pid}_${counter}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    return await fn(pool, schema);
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

export async function defaultOrganization(pool) {
  const { rows } = await pool.query("select id, account_id from organization where is_default");
  return { organizationId: rows[0].id, accountId: rows[0].account_id };
}

/** A second account and organization, with its own repository granted to it. */
export async function createOrganization(pool, name, { billing } = {}) {
  const { rows: account } = await pool.query("insert into account (name) values ($1) returning id", [name]);
  const { rows: org } = await pool.query("insert into organization (account_id, name) values ($1, $2) returning id", [
    account[0].id,
    name,
  ]);
  const repositoryId = randomUUID();
  await pool.query(
    `insert into repository (id, owner, name, default_branch, clone_url) values ($1, 'acme', $2, 'main', $3)`,
    [repositoryId, `repo-${repositoryId.slice(0, 8)}`, `https://github.com/acme/repo-${repositoryId.slice(0, 8)}.git`],
  );
  await pool.query("insert into repository_grant (organization_id, repository_id, intake) values ($1, $2, true)", [
    org[0].id,
    repositoryId,
  ]);
  if (billing) {
    await pool.query(
      "insert into billing_account (account_id, provider, plan, status) values ($1, $2, $3, $4)",
      [account[0].id, billing.provider ?? "fake", billing.plan ?? "managed", billing.status ?? "active"],
    );
  }
  return { accountId: account[0].id, organizationId: org[0].id, repositoryId };
}

export async function runIn(pool, organizationId, repositoryId) {
  const task = await insertEngineeringTask(pool, {
    organizationId,
    repositoryId,
    sourceType: "local",
    sourceReference: randomUUID(),
    title: "t",
    description: "d",
    acceptanceCriteria: [],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
  return { taskId: task.id, runId: run.id };
}

export async function workspace(pool, runId, role) {
  const { rows } = await pool.query(
    `insert into workspace (engineering_run_id, role, sandbox_provider, repository, base_sha, status)
     values ($1, $2, 'fake', 'acme/x', 'abc', 'destroyed') returning id`,
    [runId, role],
  );
  return rows[0].id;
}

export async function credential(pool, organizationId) {
  const id = randomUUID();
  await pool.query(
    `insert into model_credential (id, organization_id, provider, label, last4, sealed_value, keypair_id)
     values ($1, $2, 'openai', $3, 'abcd', 'sealed', 'k1')`,
    [id, organizationId, `key-${id.slice(0, 6)}`],
  );
  return id;
}

/** One ledger row through the real writer, then moved to `at` when given. */
export async function cost(pool, runId, event, at) {
  const recorded = await recordCost(pool, {
    engineeringRunId: runId,
    stageType: event.stageType ?? "agent_run",
    stageId: event.stageId ?? randomUUID(),
    kind: event.kind ?? "model",
    usd: event.usd,
    tokensIn: event.tokensIn ?? null,
    tokensOut: event.tokensOut ?? null,
    ...(event.keySource ? { keySource: event.keySource } : {}),
    ...(event.credentialId ? { credentialId: event.credentialId } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.sandboxMs !== undefined ? { sandboxMs: event.sandboxMs } : {}),
  });
  if (at) await pool.query("update cost_event set recorded_at = $2 where id = $1", [recorded.id, at]);
  return recorded;
}

export async function verificationRun(pool, runId, verdict, completedAt = new Date()) {
  await pool.query(
    `insert into verification_run (engineering_run_id, candidate_sha, policy_version, verdict, started_at, completed_at)
     values ($1, 'sha', 'v0', $2, $3, $3)`,
    [runId, verdict, completedAt],
  );
}
