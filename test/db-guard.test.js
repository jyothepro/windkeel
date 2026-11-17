import assert from "node:assert/strict";
import { test } from "node:test";
import { REMOTE_OPT_IN, unsafeTestDatabase } from "./db-guard.js";

// AGENTS.md: never point tests at .env's DATABASE_URL — it can be production.
test("a local test database is allowed, or none at all", () => {
  for (const url of [
    undefined,
    "postgresql://windkeel:windkeel@localhost:5432/windkeel",
    "postgresql://localhost:5432/windkeel_test",
    "postgres://127.0.0.1/windkeel_test",
    "postgres://[::1]:5432/windkeel_test",
    "postgresql:///windkeel_test?host=/var/run/postgresql",
  ]) {
    assert.equal(unsafeTestDatabase({ TEST_DATABASE_URL: url }), null, String(url));
  }
});

test("a remote test database is refused unless opted in by name", () => {
  const env = { TEST_DATABASE_URL: "postgresql://u:p@db.example.supabase.co:5432/postgres" };
  assert.match(unsafeTestDatabase(env), /not a local server/);
  assert.match(unsafeTestDatabase(env), new RegExp(REMOTE_OPT_IN));
  assert.equal(unsafeTestDatabase({ ...env, [REMOTE_OPT_IN]: "1" }), null);
  assert.match(unsafeTestDatabase({ ...env, [REMOTE_OPT_IN]: "true" }), /not a local server/);
  assert.match(unsafeTestDatabase({ TEST_DATABASE_URL: "postgresql:///postgres?host=db.example.com" }), /db\.example\.com/);
});

test("a malformed test database URL is refused", () => {
  assert.match(unsafeTestDatabase({ TEST_DATABASE_URL: "localhost:5432" }) ?? "", /not a (postgres:\/\/ )?URL/);
});


test("duplicate host parameters and remote fallback hosts are refused", () => {
  assert.match(unsafeTestDatabase({ TEST_DATABASE_URL: "postgres://localhost/test?host=localhost&host=db.example.com" }), /multiple host/);
  assert.match(unsafeTestDatabase({ TEST_DATABASE_URL: "postgres://db.example.com/test?host=" }), /not a local server/);
  assert.match(unsafeTestDatabase({ TEST_DATABASE_URL: "postgres:///test", PGHOST: "db.example.com" }), /not a local server/);
  assert.equal(unsafeTestDatabase({ TEST_DATABASE_URL: "postgres://localhost/test?host=" }), null);
});
