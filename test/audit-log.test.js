/**
 * The account audit log (#393 8A, ADR-0030): the hash chain, its verification, paging, export,
 * the append-only trigger, retention (8F) and the SIEM sink. Pure functions first; the Postgres
 * half skips without `TEST_DATABASE_URL`.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import {
  AUDIT_ACTIONS,
  MAX_DETAIL_BYTES,
  canonicalJson,
  computeAuditHash,
  csvField,
  csvRow,
  decodeAuditCursor,
  encodeAuditCursor,
  exportAuditEvents,
  listAuditEvents,
  parseActionFilter,
  purgeAuditEvents,
  recordAuditEvent,
  sanitizeDetail,
  SYSTEM_ACTOR,
  verifyAuditChain,
  verifyChainRows,
  withTransaction,
} from "../dist/factory/audit-log.js";
import { sweepAuditRetention } from "../dist/factory/sweeps/audit-retention.js";
import { auditSinkFromEnv, forwardAuditEvents } from "../dist/factory/sweeps/audit-sink.js";
import { repoRoot, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const ACTOR = { principalId: null, text: "octocat", kind: "user" };

/** An in-memory chain, built exactly as `recordAuditEvent` builds one. */
function chain(n, start = { prevHash: null, seq: 0 }) {
  const rows = [];
  let prevHash = start.prevHash;
  for (let i = 1; i <= n; i += 1) {
    const row = {
      id: `00000000-0000-4000-8000-${String(start.seq + i).padStart(12, "0")}`,
      accountId: "a0000000-0000-4000-8000-000000000001",
      seq: start.seq + i,
      organizationId: null,
      actorPrincipalId: null,
      actorText: "octocat",
      actorKind: "user",
      action: "token.created",
      targetType: "token",
      targetId: `t${i}`,
      ip: "203.0.113.7",
      userAgent: "test",
      requestId: null,
      detail: { n: i, name: `token ${i}` },
      prevHash,
      occurredAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
    };
    row.hash = computeAuditHash(row);
    rows.push(row);
    prevHash = row.hash;
  }
  return rows;
}

// --- the hash and the chain ------------------------------------------------------------------

test("canonical JSON sorts keys at every depth and nothing else", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

test("the hash is deterministic, covers every field, and chains on the previous hash", () => {
  const [first, second] = chain(2);
  const { hash, ...rest } = first;
  assert.equal(computeAuditHash(rest), hash);
  assert.equal(computeAuditHash({ ...rest, detail: { name: "token 1", n: 1 } }), hash, "key order does not matter");
  assert.notEqual(computeAuditHash({ ...rest, actorText: "hubot" }), hash);
  assert.notEqual(computeAuditHash({ ...rest, ip: "203.0.113.8" }), hash);
  assert.equal(second.prevHash, first.hash);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test("verification passes an intact chain and names each kind of tampering", () => {
  const rows = chain(5);
  assert.deepEqual(verifyChainRows(rows), { ok: true, checked: 5 });

  const edited = rows.map((r) => (r.seq === 3 ? { ...r, detail: { ...r.detail, name: "something else" } } : r));
  assert.deepEqual(verifyChainRows(edited).brokenAt, { seq: 3, id: rows[2].id, reason: "hash_mismatch" });

  const removed = rows.filter((r) => r.seq !== 3);
  assert.deepEqual(verifyChainRows(removed).brokenAt, { seq: 4, id: rows[3].id, reason: "chain_broken" });

  const reordered = [rows[0], rows[2], rows[1], rows[3], rows[4]];
  assert.equal(verifyChainRows(reordered).brokenAt.reason, "chain_broken");
  assert.equal(verifyChainRows(reordered).brokenAt.seq, 3);

  // Someone careful re-pointed the next row's prev_hash and rehashed it, but seq still skips.
  const repaired = [...rows.slice(0, 2)];
  const next = { ...rows[3], prevHash: rows[1].hash };
  delete next.hash;
  repaired.push({ ...next, hash: computeAuditHash(next) });
  assert.equal(verifyChainRows(repaired).brokenAt.reason, "sequence_gap");
});

test("a cursor round-trips, and anything else is refused rather than restarted", () => {
  assert.equal(decodeAuditCursor(encodeAuditCursor(4242)), 4242);
  assert.throws(() => decodeAuditCursor("not-a-cursor"), { name: "InvalidAuditCursorError" });
  assert.throws(() => decodeAuditCursor(Buffer.from("audit:-1").toString("base64url")), { name: "InvalidAuditCursorError" });
});

test("an unknown action is refused before anything is written", async () => {
  const db = { query: () => assert.fail("nothing may reach the database") };
  await assert.rejects(recordAuditEvent(db, { accountId: "x", actor: ACTOR, action: "verifier.disabled" }), {
    name: "UnknownAuditActionError",
  });
  assert.throws(() => parseActionFilter("nonsense.thing"), { name: "UnknownAuditActionError" });
  assert.deepEqual(parseActionFilter("token.*"), { prefix: "token." });
  assert.deepEqual(parseActionFilter("run.merged"), { exact: "run.merged" });
});

test("CSV fields escape commas, quotes, newlines and formulas, and keep unicode", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("line one\nline two"), '"line one\nline two"');
  assert.equal(csvField("crlf\r\n"), '"crlf\r\n"');
  assert.equal(csvField("Zoë 🚀 日本"), "Zoë 🚀 日本");
  assert.equal(csvField("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvField("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvField(null), "");
  assert.equal(csvField({ b: 1, a: "x,y" }), '"{""a"":""x,y"",""b"":1}"');
  const [row] = chain(1);
  assert.equal(csvRow(row).split(",")[0], row.id);
});

test("a large detail is truncated to a marked preview without splitting a character", () => {
  const big = { text: "🚀".repeat(MAX_DETAIL_BYTES) };
  const out = sanitizeDetail(big);
  assert.equal(out.truncated, true);
  assert.ok(out.bytes > MAX_DETAIL_BYTES);
  assert.ok(!/[\uD800-\uDBFF]$/.test(out.preview), "no dangling high surrogate");
  assert.doesNotThrow(() => JSON.stringify(out));
  assert.deepEqual(sanitizeDetail({ a: "nul\u0000here", when: new Date("2026-10-01T00:00:00Z") }), {
    a: "nulhere",
    when: "2026-10-01T00:00:00.000Z",
  });
});

/**
 * The done condition: every action in `AUDIT_ACTIONS` is emitted by at least one code path. Read
 * from the source (as `api-routing.test.js` does for routes), because asserting each at runtime
 * would need a run of every subsystem; the API and end-to-end tests assert the important ones live.
 */
test("every audit action is emitted somewhere outside the module that lists them", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts") && !full.endsWith("audit-log.ts")) files.push(full);
    }
  };
  walk(join(repoRoot, "src"));
  walk(join(repoRoot, "apps", "ingress", "src"));
  // The module itself emits the purge's two actions; its list of names is not an emission.
  const audit = readFileSync(join(repoRoot, "src", "factory", "audit-log.ts"), "utf8").replace(
    /export const AUDIT_ACTIONS = \[[\s\S]*?\] as const;/,
    "",
  );
  const source = [audit, ...files.map((f) => readFileSync(f, "utf8"))].join("\n");
  for (const action of AUDIT_ACTIONS) {
    assert.ok(source.includes(`"${action}"`), `${action} is in AUDIT_ACTIONS but nothing emits it`);
  }
});

test("the audit sink needs both variables, and https", () => {
  assert.equal(auditSinkFromEnv({}), null);
  assert.throws(() => auditSinkFromEnv({ WINDKEEL_AUDIT_WEBHOOK_URL: "https://siem.example/in" }), /both/);
  assert.throws(() => auditSinkFromEnv({ WINDKEEL_AUDIT_WEBHOOK_URL: "http://siem.example/in", WINDKEEL_AUDIT_WEBHOOK_SECRET: "s" }), /https/);
  assert.deepEqual(auditSinkFromEnv({ WINDKEEL_AUDIT_WEBHOOK_URL: "https://siem.example/in", WINDKEEL_AUDIT_WEBHOOK_SECRET: "s" }), {
    url: "https://siem.example/in",
    secret: "s",
  });
});

// --- Postgres --------------------------------------------------------------------------------

async function withSchema(fn, poolSize = TEST_POOL.max) {
  const schema = `windkeel_audit_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, max: poolSize, options: `-c search_path=${schema}` });
  try {
    const accountId = (await pool.query("select id from account where is_default")).rows[0].id;
    const organizationId = (await pool.query("select id from organization where is_default")).rows[0].id;
    await fn({ pool, accountId, organizationId });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

/** Runs `fn` with `Date.now` moved back, so an event can be written in the past and still hashed honestly. */
async function at(when, fn) {
  const real = Date.now;
  Date.now = () => when.getTime();
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

/** Edits a row the way someone with SQL could: around the append-only trigger. */
async function tamper(pool, sql, params) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("alter table audit_event disable trigger audit_event_append_only");
    await client.query(sql, params);
    await client.query("alter table audit_event enable trigger audit_event_append_only");
    await client.query("commit");
  } finally {
    client.release();
  }
}

test("events chain per account, verify, and are append-only", { skip }, async () => {
  await withSchema(async ({ pool, accountId, organizationId }) => {
    for (let i = 0; i < 4; i += 1) {
      await recordAuditEvent(pool, {
        organizationId,
        actor: ACTOR,
        action: "grant.created",
        target: { type: "repository", id: `r${i}` },
        request: { ip: "::ffff:203.0.113.9", userAgent: "ua" },
        detail: { i },
      });
    }
    const { rows } = await pool.query("select seq, account_id, host(ip) as ip from audit_event order by seq");
    assert.deepEqual(rows.map((r) => r.seq), ["1", "2", "3", "4"]);
    assert.ok(rows.every((r) => r.account_id === accountId), "the account is derived from the organization");
    assert.equal(rows[0].ip, "::ffff:203.0.113.9");
    assert.deepEqual(await verifyAuditChain(pool, accountId), { ok: true, checked: 4 });

    await assert.rejects(pool.query("update audit_event set actor_text = 'mallory'"), /append-only/);
    await assert.rejects(pool.query("delete from audit_event"), /append-only/);
    await assert.rejects(pool.query("truncate audit_event"), /append-only/);

    await tamper(pool, "update audit_event set detail = '{\"i\": 99}' where seq = 2");
    assert.deepEqual((await verifyAuditChain(pool, accountId)).brokenAt.seq, 2);
    assert.equal((await verifyAuditChain(pool, accountId)).brokenAt.reason, "hash_mismatch");
  });
});

test("a deleted middle row and an unrecorded deleted prefix are both detected", { skip }, async () => {
  await withSchema(async ({ pool, accountId, organizationId }) => {
    for (let i = 0; i < 5; i += 1) await recordAuditEvent(pool, { organizationId, actor: ACTOR, action: "member.removed" });
    await tamper(pool, "delete from audit_event where seq = 3");
    assert.deepEqual((await verifyAuditChain(pool, accountId)).brokenAt, {
      seq: 4,
      id: (await pool.query("select id from audit_event where seq = 4")).rows[0].id,
      reason: "chain_broken",
    });
    await tamper(pool, "delete from audit_event where seq < 4");
    assert.equal((await verifyAuditChain(pool, accountId)).brokenAt.reason, "unanchored_start");
  });
});

test("a purge deletes only the old prefix, records its anchor, and the chain still verifies", { skip }, async () => {
  await withSchema(async ({ pool, accountId, organizationId }) => {
    const old = new Date(Date.now() - 200 * 86_400_000);
    await at(old, () => recordAuditEvent(pool, { organizationId, actor: ACTOR, action: "token.created" }));
    await at(new Date(old.getTime() + 1000), () => recordAuditEvent(pool, { organizationId, actor: ACTOR, action: "token.revoked" }));
    await recordAuditEvent(pool, { organizationId, actor: ACTOR, action: "grant.created" });

    const swept = await sweepAuditRetention({ pool, defaultDays: 90 });
    assert.deepEqual(swept.accounts.map((a) => a.deleted), [2]);
    const { rows } = await pool.query("select action, detail from audit_event order by seq");
    assert.deepEqual(rows.map((r) => r.action), ["grant.created", "audit.retention_swept"]);
    assert.equal(rows[1].detail.deleted, 2);
    assert.equal(rows[1].detail.retentionDays, 90);
    assert.match(rows[1].detail.anchorHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(await verifyAuditChain(pool, accountId), { ok: true, checked: 2 });

    // Nothing old left: a second sweep deletes nothing and records nothing.
    const again = await sweepAuditRetention({ pool, defaultDays: 90 });
    assert.deepEqual(again.accounts, []);
    assert.equal((await pool.query("select count(*)::int as n from audit_event")).rows[0].n, 2);

    // A customer's own deletion (maintainer decision on #393) is the same prefix purge.
    const { deleted, event } = await purgeAuditEvents(pool, {
      accountId,
      before: new Date(Date.now() + 60_000),
      actor: ACTOR,
      reason: "deleted",
    });
    assert.equal(deleted, 2);
    assert.equal(event.action, "audit.deleted");
    // Nothing older survives, yet the chain is not restarted: seq keeps counting from 4.
    assert.equal(event.seq, 5);
    assert.equal(event.prevHash, event.detail.anchorHash);
    assert.deepEqual(await verifyAuditChain(pool, accountId), { ok: true, checked: 1 });
    const next = await recordAuditEvent(pool, { organizationId, actor: ACTOR, action: "grant.created" });
    assert.equal(next.seq, 6);
    assert.deepEqual(await verifyAuditChain(pool, accountId), { ok: true, checked: 2 });
  });
});

test("an account's policy overrides the retention default", { skip }, async () => {
  await withSchema(async ({ pool, accountId, organizationId }) => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000);
    await at(fortyDaysAgo, () => recordAuditEvent(pool, { organizationId, actor: ACTOR, action: "token.created" }));
    assert.deepEqual((await sweepAuditRetention({ pool, defaultDays: 90 })).accounts, [], "inside 90 days");
    await pool.query("insert into account_security_policy (account_id, audit_retention_days) values ($1, 30)", [accountId]);
    assert.deepEqual((await sweepAuditRetention({ pool, defaultDays: 90 })).accounts.map((a) => [a.retentionDays, a.deleted]), [[30, 1]]);
  });
});

test("fifty concurrent writers leave one unbroken chain", { skip }, async () => {
  await withSchema(async ({ pool, accountId, organizationId }) => {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        recordAuditEvent(pool, { organizationId, actor: ACTOR, action: "secret.set", detail: { key: `K${i}` } }),
      ),
    );
    const { rows } = await pool.query("select seq from audit_event order by seq");
    assert.deepEqual(rows.map((r) => Number(r.seq)), Array.from({ length: 50 }, (_, i) => i + 1));
    assert.deepEqual(await verifyAuditChain(pool, accountId), { ok: true, checked: 50 });
  }, 10);
});

test("an event rolls back with the change it describes", { skip }, async () => {
  await withSchema(async ({ pool, organizationId }) => {
    await assert.rejects(
      withTransaction(pool, async (tx) => {
        await recordAuditEvent(tx, { organizationId, actor: ACTOR, action: "grant.deleted" });
        throw new Error("the change failed");
      }),
      /the change failed/,
    );
    assert.equal((await pool.query("select count(*)::int as n from audit_event")).rows[0].n, 0);
  });
});

test("pages are stable while others write, and the export matches the list", { skip }, async () => {
  await withSchema(async ({ pool, accountId, organizationId }) => {
    for (let i = 0; i < 7; i += 1) {
      await recordAuditEvent(pool, { organizationId, actor: ACTOR, action: i % 2 ? "token.created" : "grant.created", detail: { i, note: 'with "quotes", commas\nand lines' } });
    }
    const first = await listAuditEvents(pool, { accountId, limit: 3 });
    assert.deepEqual(first.items.map((e) => e.seq), [7, 6, 5]);
    assert.equal(first.hasNextPage, true);
    // Written between pages: appears above, never inside, what is being paged.
    await recordAuditEvent(pool, { organizationId, actor: ACTOR, action: "grant.created" });
    const second = await listAuditEvents(pool, { accountId, limit: 3, cursor: first.endCursor });
    const third = await listAuditEvents(pool, { accountId, limit: 3, cursor: second.endCursor });
    assert.deepEqual([...second.items, ...third.items].map((e) => e.seq), [4, 3, 2, 1]);
    assert.equal(third.hasNextPage, false);

    const tokens = await listAuditEvents(pool, { accountId, action: "token.*" });
    assert.deepEqual(tokens.items.map((e) => e.seq), [6, 4, 2]);

    const all = (await listAuditEvents(pool, { accountId, limit: 500 })).items.reverse();
    const jsonl = await exportAuditEvents(pool, { accountId, format: "jsonl" });
    assert.equal(jsonl.nextCursor, null);
    assert.deepEqual(jsonl.body.trimEnd().split("\n").map((l) => JSON.parse(l)), JSON.parse(JSON.stringify(all)));

    const csv = await exportAuditEvents(pool, { accountId, format: "csv" });
    assert.match(csv.body, /^id,seq,occurred_at,/);
    assert.equal(csv.count, all.length);

    // A small part size: the parts, followed by cursor, are the whole export exactly once.
    let cursor;
    const seen = [];
    do {
      const part = await exportAuditEvents(pool, { accountId, format: "jsonl", cursor, maxBytes: 1500 });
      seen.push(...part.body.trimEnd().split("\n").filter(Boolean).map((l) => JSON.parse(l).seq));
      cursor = part.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, all.map((e) => e.seq));
  });
});

test("the sink forwards at least once, signed, and only advances on 2xx", { skip }, async () => {
  await withSchema(async ({ pool, accountId, organizationId }) => {
    for (let i = 0; i < 3; i += 1) await recordAuditEvent(pool, { organizationId, actor: ACTOR, action: "grant.created" });
    const sink = { url: "https://siem.example/windkeel", secret: "sink-secret" };
    const deliveries = [];
    let answer = 500;
    const fetchImpl = async (url, init) => {
      deliveries.push({ url, init });
      return new Response("", { status: answer });
    };
    const failed = await forwardAuditEvents({ pool, sink, fetchImpl, now: () => new Date(1_790_000_000_000) });
    assert.deepEqual(failed, { accounts: 1, sent: 0, failed: 1 });
    assert.equal((await pool.query("select failures, last_seq from audit_sink_cursor")).rows[0].failures, 1);

    answer = 200;
    const sent = await forwardAuditEvents({ pool, sink, fetchImpl, now: () => new Date(1_790_000_000_000) });
    assert.deepEqual(sent, { accounts: 1, sent: 3, failed: 0 });
    const { init } = deliveries[1];
    const body = JSON.parse(init.body);
    assert.equal(body.accountId, accountId);
    assert.deepEqual(body.events.map((e) => e.seq), [1, 2, 3], "the failed batch is resent whole");
    const expected = `sha256=${createHmac("sha256", "sink-secret").update(`${init.headers["x-windkeel-timestamp"]}.${init.body}`).digest("hex")}`;
    assert.equal(init.headers["x-windkeel-signature"], expected);
    const cursor = (await pool.query("select last_seq, failures, last_error from audit_sink_cursor")).rows[0];
    assert.deepEqual([Number(cursor.last_seq), cursor.failures, cursor.last_error], [3, 0, null]);

    assert.deepEqual(await forwardAuditEvents({ pool, sink, fetchImpl }), { accounts: 0, sent: 0, failed: 0 });
    void SYSTEM_ACTOR;
  });
});
