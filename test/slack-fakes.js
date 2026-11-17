/**
 * Shared fakes for the Slack intake and notifier tests (#298): a throwaway schema, a connected
 * workspace with a mapped channel, a fake Slack Web API (injected `fetch`), and a captured log.
 * Nothing here reaches the network.
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Pool } from "pg";
import { FakeProviderTokenSource } from "../dist/integrations/token-source.js";
import { FIXTURE_REPOSITORY_ID, repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

export const dbUrl = process.env.TEST_DATABASE_URL;
export const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
export const TEAM = "T0WINDKEEL1";
export const CHANNEL = "C0MAPPED1";
export const INSTALLATION = "inst-slack-1";
export const OIDC = "test-connect-oidc";

export async function withSchema(fn) {
  const schema = `windkeel_slack_test_${randomUUID().replaceAll("-", "")}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    await fn(pool);
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

/** The default organization, a Slack connection for TEAM, and a route for CHANNEL. */
export async function seedSlack(pool, { route = true, enabled = true } = {}) {
  const { rows } = await pool.query("select id from organization where is_default");
  const organizationId = rows[0].id;
  const { rows: conn } = await pool.query(
    `insert into integration_connection (organization_id, provider, installation_id, external_tenant_id, external_tenant_name)
     values ($1, 'slack', $2, $3, 'Windkeel Test') returning id`,
    [organizationId, INSTALLATION, TEAM],
  );
  const connectionId = conn[0].id;
  if (route) {
    await pool.query(
      `insert into integration_route (connection_id, scope_kind, scope_value, repository_id, enabled)
       values ($1, 'slack_channel', $2, $3, $4)`,
      [connectionId, CHANNEL, FIXTURE_REPOSITORY_ID, enabled],
    );
  }
  return { organizationId, connectionId };
}

export function tokenSource() {
  return new FakeProviderTokenSource().install("slack", INSTALLATION, { tenantId: TEAM, name: "Windkeel Test" });
}

/**
 * A fake `https://slack.com/api/*`. `script` is a queue of answers consumed first, one per call
 * (whatever the method): `{ok:false, error}` / `{ok:true}` (a body as-is), `{status, retryAfter?}`
 * (an HTTP failure), `{throwCode}` (fetch throws, cause code e.g. ECONNREFUSED), or `{hang: true}`
 * (never answers; rejects when the request's signal aborts).
 * After it runs dry every call succeeds with a fresh `ts`.
 */
export function fakeSlack(script = []) {
  const calls = [];
  let n = 0;
  const queue = [...script];
  const fetch = async (url, init) => {
    const call = {
      url,
      method: url.replace("https://slack.com/api/", ""),
      authorization: init.headers.authorization,
      body: JSON.parse(init.body),
    };
    calls.push(call);
    const next = queue.shift();
    if (next?.hang) {
      return new Promise((_, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (init.signal?.aborted) abort();
        init.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (next?.throwCode) {
      // Node's fetch: a TypeError whose `cause` carries the socket error's code.
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(next.throwCode), { code: next.throwCode }) });
    }
    if (next?.status) {
      return new Response("upstream", {
        status: next.status,
        headers: next.retryAfter ? { "retry-after": String(next.retryAfter) } : {},
      });
    }
    if (next) return Response.json(next);
    n += 1;
    return Response.json({ ok: true, channel: call.body.channel, ts: `1700000200.00000${n}` });
  };
  return { calls, fetch, posts: () => calls.filter((c) => c.method === "chat.postMessage") };
}

export function capturedLog() {
  const lines = [];
  const log = (message, fields) => lines.push(JSON.stringify({ message, ...fields }));
  return { lines, log };
}

export function fixture(name) {
  return readFileSync(join(repoRoot, "test", "fixtures", "slack", name), "utf8").trim();
}

export function slashRequest({ text, trigger = "1234567890.1111.aaaa", channel = CHANNEL, team = TEAM, auth = OIDC } = {}) {
  const form = new URLSearchParams(fixture("slash-command.form"));
  if (text !== undefined) form.set("text", text);
  form.set("trigger_id", trigger);
  form.set("channel_id", channel);
  form.set("team_id", team);
  return {
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/x-www-form-urlencoded" },
    rawBody: Buffer.from(form.toString()),
  };
}

export function eventRequest(body, { auth = OIDC, headers = {} } = {}) {
  return {
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", ...headers },
    rawBody: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

export async function counts(pool) {
  const { rows } = await pool.query(
    `select (select count(*)::int from intake_delivery) as deliveries,
            (select count(*)::int from engineering_task) as tasks`,
  );
  return rows[0];
}
