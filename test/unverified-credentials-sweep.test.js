/**
 * M9-2 follow-up (#325): a model credential left `unverified` with no check in flight gets its
 * check started again — by id, the way the API starts one — and fresh, revoked, decided and
 * abandoned credentials are left alone.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { putModelCredential, revokeModelCredential } from "../dist/factory/model-credentials.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import {
  DEFAULT_MINIMUM_UNVERIFIED_AGE_MS,
  restartUnverifiedCredentialChecks,
  restartUnverifiedCredentialChecksLocked,
} from "../dist/factory/sweeps/unverified-credentials.js";
import { TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const PAIR = generateSecretKeyPair();
const KEY = "sk-proj-Zx9QqRt7vB2mN4pL8sW1yH6jD3fA5gC0";

let serial = 0;
async function withSchema(fn) {
  const schema = `windkeel_unverified_${Date.now()}_${process.pid}_${serial++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    const { rows } = await pool.query("select id from organization where is_default");
    await fn(pool, rows[0].id);
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

const store = (pool, organizationId, label) =>
  putModelCredential(pool, { organizationId, provider: "openai", label, value: KEY, publicKey: PAIR.publicKey });

async function age(pool, id, ms) {
  await pool.query("update model_credential set updated_at = now() - ($2::bigint * interval '1 millisecond') where id = $1", [id, String(ms)]);
}

function recorder(fail = new Set()) {
  const started = [];
  return {
    started,
    startValidation: async (...args) => {
      // Two ids and nothing else ever reach the queue.
      assert.equal(args.length, 2);
      assert.ok(!JSON.stringify(args).includes(KEY));
      if (fail.has(args[1])) throw new Error("queue unavailable");
      started.push(args[1]);
    },
  };
}

test("stalled unverified credentials are re-checked; fresh, decided, revoked and abandoned ones are not", { skip }, async () => {
  await withSchema(async (pool, org) => {
    const stalled = await store(pool, org, "stalled");
    const fresh = await store(pool, org, "fresh");
    const valid = await store(pool, org, "valid");
    const revoked = await store(pool, org, "revoked");
    const abandoned = await store(pool, org, "abandoned");
    await pool.query("update model_credential set status = 'valid', validated_at = now() where id = $1", [valid.id]);
    await revokeModelCredential(pool, org, revoked.id);
    const old = DEFAULT_MINIMUM_UNVERIFIED_AGE_MS + 60_000;
    for (const c of [stalled, valid, revoked]) await age(pool, c.id, old);
    await age(pool, abandoned.id, 8 * 24 * 60 * 60 * 1000);

    const queue = recorder();
    const result = await restartUnverifiedCredentialChecks({ pool, startValidation: queue.startValidation });

    assert.deepEqual(queue.started, [stalled.id]);
    assert.deepEqual(result, { examined: 1, started: 1, failed: 0 });
    assert.ok(!queue.started.includes(fresh.id), "a credential stored a moment ago may have its check in flight");
  });
});

test("a start that throws is counted and logged by id, and the next tick tries again", { skip }, async () => {
  await withSchema(async (pool, org) => {
    const a = await store(pool, org, "a");
    await age(pool, a.id, DEFAULT_MINIMUM_UNVERIFIED_AGE_MS + 1_000);
    const logged = [];
    const failing = recorder(new Set([a.id]));
    const first = await restartUnverifiedCredentialChecks({ pool, startValidation: failing.startValidation, log: (m, f) => logged.push([m, f]) });
    assert.deepEqual(first, { examined: 1, started: 0, failed: 1 });
    assert.deepEqual(logged, [["could not restart a model credential check", { credentialId: a.id, error: "Error" }]]);

    const working = recorder();
    const second = await restartUnverifiedCredentialChecksLocked({ pool, startValidation: working.startValidation });
    assert.equal(second.kind, "ran");
    assert.deepEqual(working.started, [a.id]);
  });
});
