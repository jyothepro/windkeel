/**
 * `windkeel audit` (#393 8A): `export` writes every part of a long range to stdout by following the
 * server's continuation cursor, and `verify` exits non-zero on a broken chain. Driven through a
 * stub fetch, as `cli-models.test.js` drives its commands.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { WindkeelApi } from "../packages/cli/dist/client/api.js";
import { auditCommand, auditTime } from "../packages/cli/dist/commands/audit.js";
import { runCli } from "./helpers.js";

function harness(parts) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: new URL(url), init });
    const part = parts[requests.length - 1];
    if (part.status && part.status !== 200) {
      return new Response(JSON.stringify(part.body), { status: part.status, headers: { "content-type": "application/json" } });
    }
    const headers = { "content-type": "application/x-ndjson", "x-windkeel-export-count": String(part.count) };
    if (part.next) headers["x-windkeel-next-cursor"] = part.next;
    return new Response(part.body, { status: 200, headers });
  };
  const out = [];
  const err = [];
  const io = { out: (l) => out.push(l), err: (l) => err.push(l) };
  return { api: new WindkeelApi({ baseUrl: "https://windkeel.example.com", token: "orq_test", fetch }), requests, out, err, io };
}

test("export follows the cursor to the end of the range and writes the parts in order", async () => {
  const h = harness([
    { body: '{"seq":1}\n{"seq":2}\n', count: 2, next: "c1" },
    { body: '{"seq":3}\n', count: 1 },
  ]);
  const written = [];
  const code = await auditCommand(h.api, h.io, { kind: "export", format: "jsonl", since: "2026-10-01", write: (c) => written.push(c) });
  assert.equal(code, 0);
  assert.equal(written.join(""), '{"seq":1}\n{"seq":2}\n{"seq":3}\n');
  assert.equal(h.requests[0].url.pathname, "/v1/account/audit-events/export");
  assert.equal(h.requests[0].url.searchParams.get("after"), "2026-10-01T00:00:00.000Z");
  assert.equal(h.requests[0].url.searchParams.get("format"), "jsonl");
  assert.equal(h.requests[0].url.searchParams.get("cursor"), null);
  assert.equal(h.requests[1].url.searchParams.get("cursor"), "c1");
  assert.equal(h.requests[0].init.headers.authorization, "Bearer orq_test");
  assert.deepEqual(h.err, ["exported 3 audit event(s)"], "the count goes to stderr, so stdout is only the file");
});

test("--org exports that organization's mirror", async () => {
  const h = harness([{ body: "", count: 0 }]);
  await auditCommand(h.api, h.io, { kind: "export", format: "csv", org: "org-1", write: () => {} });
  assert.equal(h.requests[0].url.pathname, "/v1/orgs/org-1/audit-events/export");
  assert.equal(h.requests[0].url.searchParams.get("format"), "csv");
});

test("a refusal surfaces as the API's error, and a bad date is refused before any request", async () => {
  const h = harness([{ status: 403, body: { error: "account routes need an account role", code: "account_role_required" } }]);
  await assert.rejects(auditCommand(h.api, h.io, { kind: "export", format: "jsonl", write: () => {} }), { code: "account_role_required" });
  const bad = harness([]);
  assert.equal(await auditCommand(bad.api, bad.io, { kind: "export", format: "jsonl", since: "last tuesday", write: () => {} }), 2);
  assert.equal(bad.requests.length, 0);
  assert.ok(auditTime("nope") instanceof Error);
  assert.equal(auditTime("2026-10-01T10:00:00Z"), "2026-10-01T10:00:00.000Z");
});

test("verify exits 1 and names where the chain breaks", async () => {
  const fetch = async () =>
    new Response(JSON.stringify({ ok: false, checked: 4, brokenAt: { seq: 5, id: "x", reason: "hash_mismatch" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const out = [];
  const api = new WindkeelApi({ baseUrl: "https://windkeel.example.com", token: "orq_test", fetch });
  assert.equal(await auditCommand(api, { out: (l) => out.push(l), err: () => {} }, { kind: "verify" }), 1);
  assert.match(out[0], /BROKEN at seq 5 \(hash_mismatch\)/);
});

test("the usage names both subcommands", () => {
  const result = runCli(["audit", "nonsense"], { env: { WINDKEEL_API_URL: "https://windkeel.example.com", WINDKEEL_API_TOKEN: "orq_x" } });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /windkeel audit export/);
  assert.match(result.stderr, /windkeel audit verify/);
});
