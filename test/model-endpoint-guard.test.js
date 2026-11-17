/**
 * The model `base_url` guard (ADR-0026 §7, #320), as a table.
 *
 * A base URL is where the factory will send a customer's key from inside its own network, so the
 * table is mostly refusals: every way a URL can name, resolve to or smuggle in a private, loopback,
 * link-local or metadata address. No test here touches real DNS — the resolver is injected — and
 * the connect-time half (`guardedLookup`) is driven against `localhost`, which resolves locally.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request } from "node:http";
import { test } from "node:test";
import {
  UnsafeEndpointError,
  assertSafeBaseUrl,
  forbiddenAddressReason,
  guardedLookup,
  parseBaseUrl,
} from "../dist/factory/model-endpoint-guard.js";

/** A resolver that answers from a table, so no test depends on what a DNS server says today. */
const DNS = {
  "api.example.com": ["93.184.216.34"],
  "v6.example.com": ["2606:2800:220:1:248:1893:25c8:1946"],
  "rebind.example.com": ["93.184.216.34", "10.0.0.5"],
  "metadata-alias.example.com": ["169.254.169.254"],
  "mapped.example.com": ["::ffff:192.168.1.1"],
  "ula.example.com": ["fd00:ec2::254"],
};
const resolve = async (host) => {
  if (!(host in DNS)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return DNS[host];
};

test("forbidden addresses, each with a reason; public ones pass", () => {
  const forbidden = [
    "127.0.0.1", "127.8.9.10", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.10",
    "169.254.169.254", "169.254.1.1", "100.64.0.1", "100.100.100.200", "0.0.0.0", "224.0.0.1",
    "255.255.255.255", "198.18.0.1", "192.0.2.1",
    "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "2002:a00:1::1",
    "::127.0.0.1",
  ];
  for (const address of forbidden) {
    assert.ok(forbiddenAddressReason(address), `${address} must be refused`);
  }
  for (const address of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "64:ff9b::808:808"]) {
    assert.equal(forbiddenAddressReason(address), null, `${address} is public`);
  }
  assert.match(forbiddenAddressReason("169.254.169.254"), /metadata/);
  assert.match(forbiddenAddressReason("::ffff:10.0.0.1"), /private.*IPv6/);
});

test("the URL's shape: https only, no userinfo, query or fragment, no private names or literals", async () => {
  const refused = [
    ["http://api.example.com/v1", /https/],
    ["ftp://api.example.com", /https/],
    ["https://user:pass@api.example.com/v1", /credentials/],
    ["https://api.example.com/v1?key=x", /query/],
    ["https://api.example.com/v1#x", /fragment/],
    ["https://localhost/v1", /loopback/],
    ["https://127.0.0.1/v1", /loopback/],
    ["https://[::1]/v1", /loopback/],
    ["https://10.0.0.1/v1", /private/],
    ["https://169.254.169.254/latest", /metadata/],
    ["https://[::ffff:169.254.169.254]/", /link-local/],
    ["https://2130706433/", /loopback/], // 127.0.0.1 as a decimal integer, normalised by URL
    ["https://0x7f.1/", /loopback/],
    ["https://metadata.google.internal/", /private host/],
    ["https://printer.local/", /private host/],
    ["https://svc.internal/", /private host/],
    ["not a url", /not a URL/],
    ["", /non-empty/],
  ];
  for (const [url, why] of refused) {
    await assert.rejects(
      () => assertSafeBaseUrl(url, { resolve }),
      (err) => err instanceof UnsafeEndpointError && why.test(err.message),
      url,
    );
  }
});

test("every resolved address must be public, so one private answer among public ones refuses", async () => {
  await assert.rejects(() => assertSafeBaseUrl("https://rebind.example.com/v1", { resolve }), /10\.0\.0\.5/);
  await assert.rejects(() => assertSafeBaseUrl("https://metadata-alias.example.com", { resolve }), /metadata/);
  await assert.rejects(() => assertSafeBaseUrl("https://mapped.example.com", { resolve }), /private/);
  await assert.rejects(() => assertSafeBaseUrl("https://ula.example.com", { resolve }), /unique-local/);
  await assert.rejects(() => assertSafeBaseUrl("https://nowhere.example.com", { resolve }), /does not resolve/);
});

test("a public https URL is accepted and normalised", async () => {
  assert.equal(await assertSafeBaseUrl("https://api.example.com/v1/", { resolve }), "https://api.example.com/v1");
  assert.equal(await assertSafeBaseUrl("https://API.example.com", { resolve }), "https://api.example.com");
  assert.equal(await assertSafeBaseUrl("https://v6.example.com/openai", { resolve }), "https://v6.example.com/openai");
  assert.equal(await assertSafeBaseUrl("https://93.184.216.34/v1", { resolve }), "https://93.184.216.34/v1");
});

test("no refusal quotes a URL's userinfo, where a key may have been pasted", async () => {
  await assert.rejects(
    () => assertSafeBaseUrl("https://sk-proj-abcdefghijkl:x@api.example.com/v1", { resolve }),
    (err) => !err.message.includes("sk-proj-abcdefghijkl"),
  );
});

test("plain http to localhost only with the explicit development flag", async () => {
  await assert.rejects(() => assertSafeBaseUrl("http://localhost:8080/v1", { resolve }), /https/);
  assert.equal(
    await assertSafeBaseUrl("http://localhost:8080/v1", { resolve, allowLocalhostHttp: true }),
    "http://localhost:8080/v1",
  );
  // The flag opens localhost and nothing else.
  await assert.rejects(
    () => assertSafeBaseUrl("http://10.0.0.1/v1", { resolve, allowLocalhostHttp: true }),
    /https/,
  );
  await assert.rejects(
    () => assertSafeBaseUrl("https://169.254.169.254/", { resolve, allowLocalhostHttp: true }),
    /metadata/,
  );
  assert.throws(() => parseBaseUrl("http://api.example.com", { allowLocalhostHttp: true }), /https/);
});

test("at connect time, guardedLookup refuses a loopback answer unless the dev flag names localhost", async () => {
  const server = createServer((_req, res) => res.end("ok"));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  const get = (lookup) =>
    new Promise((resolveStatus, reject) => {
      const req = request({ host: "localhost", port, path: "/", lookup, family: 4 }, (res) => {
        res.resume();
        resolveStatus(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
  try {
    await assert.rejects(() => get(guardedLookup()), (err) => err.name === "UnsafeEndpointError" && /loopback/.test(err.message));
    assert.equal(await get(guardedLookup({ allowLocalhostHttp: true })), 200);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
