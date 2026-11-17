import "./helpers.js"; // WINDKEEL_VALIDATE_RESPONSES: every API answer here is checked against the contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isConnectionLimit } from "../apps/ingress/dist/src/connection-limit.js";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";

/**
 * 2026-09-25: the session pooler the API then used ran out of clients (#317 moved it to the
 * transaction pooler). Every API request crashed before it reached a handler, and the platform
 * turned each crash into an HTML 500 the console could only call "something other than the API's
 * JSON". Whatever pooler is behind it, running out is possible; these pin what the API says.
 */

const POOLER_FULL = Object.assign(new Error("(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15"), {
  code: "XX000",
});

/** A pool whose every query fails the way the pooler failed. */
const fullPool = { query: async () => Promise.reject(POOLER_FULL), connect: async () => Promise.reject(POOLER_FULL) };

const request = (path, headers = { authorization: "Bearer t" }) => ({
  method: "GET",
  path,
  query: { get: () => undefined },
  headers,
});

test("the pooler's refusals are told apart from the database being down", () => {
  assert.equal(isConnectionLimit(POOLER_FULL), true);
  assert.equal(isConnectionLimit(Object.assign(new Error("sorry, too many clients already"), { code: "53300" })), true);
  assert.equal(isConnectionLimit(new Error("timeout exceeded when trying to connect")), true, "pg's pool waiting past connectionTimeoutMillis");
  assert.equal(isConnectionLimit(new Error("connect ECONNREFUSED 10.0.0.1:5432")), false);
  assert.equal(isConnectionLimit("EMAXCONNSESSION"), false, "only errors");
});

test("a request that can't get a connection is a 503 the caller can retry, as the API's JSON", async () => {
  // A personal token is looked up in the database, so authentication is the first thing to fail.
  const result = await handleApiRequest({ pool: fullPool, control: {} }, { token: "bootstrap" }, request("/v1/runs", { authorization: "Bearer orq_abc" }));
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "connection_limit");
  assert.match(result.body.error, /out of database connections/);
  assert.equal(result.headers["retry-after"], "2");
});

test("health says the database is full, not unreachable", async () => {
  const full = await handleApiRequest({ pool: fullPool, control: {} }, { token: "t" }, request("/v1/health"));
  assert.equal(full.status, 503);
  assert.deepEqual(full.body, { ok: false, database: "connection_limit" });

  const down = await handleApiRequest(
    { pool: { query: async () => Promise.reject(new Error("connect ECONNREFUSED")) }, control: {} },
    { token: "t" },
    request("/v1/health"),
  );
  assert.deepEqual(down.body, { ok: false, database: "unreachable" });
});
