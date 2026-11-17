/**
 * The account security policy's pure parts (#393 8F): token lifetime, CIDR matching, the client
 * address and the idle-timeout arithmetic. The enforcement through the router is in
 * `api-audit.test.js`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIp, ipAllowed, parseCidr, resolveTokenExpiry, sessionIdle } from "../dist/factory/security-policy.js";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const DAY = 86_400_000;

test("no policy leaves a token's expiry exactly as asked", () => {
  assert.deepEqual(resolveTokenExpiry(null, {}, NOW), { expiresAt: null, clamped: false });
  assert.deepEqual(resolveTokenExpiry(null, { expiresInDays: 10 }, NOW), { expiresAt: new Date(NOW.getTime() + 10 * DAY), clamped: false });
});

test("a maximum clamps a longer request and fills in a missing one", () => {
  const policy = { maxTokenTtlDays: 30, requireTokenExpiry: false };
  assert.deepEqual(resolveTokenExpiry(policy, { expiresInDays: 90 }, NOW), { expiresAt: new Date(NOW.getTime() + 30 * DAY), clamped: true });
  assert.deepEqual(resolveTokenExpiry(policy, { expiresInDays: 7 }, NOW), { expiresAt: new Date(NOW.getTime() + 7 * DAY), clamped: false });
  assert.deepEqual(resolveTokenExpiry(policy, {}, NOW), { expiresAt: new Date(NOW.getTime() + 30 * DAY), clamped: true });
  const far = new Date(NOW.getTime() + 400 * DAY);
  assert.equal(resolveTokenExpiry(policy, { expiresAt: far }, NOW).clamped, true);
});

test("required expiry with no maximum refuses an undated token", () => {
  const policy = { maxTokenTtlDays: null, requireTokenExpiry: true };
  assert.throws(() => resolveTokenExpiry(policy, {}, NOW), { name: "TokenPolicyError" });
  assert.equal(resolveTokenExpiry(policy, { expiresInDays: 1 }, NOW).clamped, false);
  // A flow that cannot ask (the CLI's device login, already approved) gets its default instead.
  assert.deepEqual(resolveTokenExpiry(policy, { requiredDefaultDays: 90 }, NOW), { expiresAt: new Date(NOW.getTime() + 90 * DAY), clamped: true });
  assert.deepEqual(resolveTokenExpiry({ maxTokenTtlDays: null, requireTokenExpiry: false }, { requiredDefaultDays: 90 }, NOW), {
    expiresAt: null,
    clamped: false,
  });
});

test("CIDR matching for IPv4, IPv6, mapped addresses and bare hosts", () => {
  assert.ok(ipAllowed("10.1.2.3", ["10.0.0.0/8"]));
  assert.ok(!ipAllowed("11.1.2.3", ["10.0.0.0/8"]));
  assert.ok(ipAllowed("192.168.4.200", ["192.168.4.128/25"]));
  assert.ok(!ipAllowed("192.168.4.127", ["192.168.4.128/25"]));
  assert.ok(ipAllowed("203.0.113.9", ["203.0.113.9"]), "a bare address is its /32");
  assert.ok(ipAllowed("::ffff:10.9.9.9", ["10.0.0.0/8"]), "an IPv4-mapped address is the IPv4 address");
  assert.ok(ipAllowed("2001:db8::1", ["2001:db8::/32"]));
  assert.ok(ipAllowed("2001:0db8:ffff::1", ["2001:db8::/32"]));
  assert.ok(!ipAllowed("2001:db9::1", ["2001:db8::/32"]));
  assert.ok(ipAllowed("fe80::1:2", ["fe80::/64"]));
  assert.ok(!ipAllowed("10.0.0.1", ["::/0"]), "families never cross");
  assert.ok(ipAllowed("1.2.3.4", ["0.0.0.0/0"]));
  assert.ok(!ipAllowed(null, ["0.0.0.0/0"]), "no address is in nothing");
  assert.ok(!ipAllowed("not-an-ip", ["0.0.0.0/0"]));
  assert.throws(() => parseCidr("10.0.0.0/33"), { name: "SecurityPolicyError" });
  assert.throws(() => parseCidr("10.0.0.0/8/1"), { name: "SecurityPolicyError" });
  assert.throws(() => parseCidr("example.com"), { name: "SecurityPolicyError" });
});

test("the client address comes only from the trusted proxy header", () => {
  // Vercel's own header, first value.
  assert.equal(clientIp({ "x-vercel-forwarded-for": "203.0.113.5, 10.0.0.1" }, "10.9.9.9"), "203.0.113.5");
  // A client-written x-forwarded-for is ignored unless it is the configured header.
  assert.equal(clientIp({ "x-forwarded-for": "6.6.6.6" }, "198.51.100.2"), "198.51.100.2");
  // Configured as x-forwarded-for: the right-most value, the one the trusted proxy appended.
  assert.equal(clientIp({ "x-forwarded-for": "6.6.6.6, 198.51.100.7" }, null, "x-forwarded-for"), "198.51.100.7");
  assert.equal(clientIp({ "x-real-ip": "[2001:db8::5]" }, null, "x-real-ip"), "2001:db8::5");
  assert.equal(clientIp({ "x-vercel-forwarded-for": "garbage" }, "::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(clientIp({}, undefined), null);
});

test("a session is idle once the gap passes the limit, and never without one", () => {
  const seen = new Date(NOW.getTime() - 15 * 60_000);
  assert.equal(sessionIdle(seen, NOW, 15), false, "exactly the limit is still fine");
  assert.equal(sessionIdle(new Date(seen.getTime() - 1), NOW, 15), true);
  assert.equal(sessionIdle(seen, NOW, null), false);
  assert.equal(sessionIdle(null, NOW, 5), false, "a session's first request is never idle");
});
