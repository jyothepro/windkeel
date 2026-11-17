/**
 * The platform's clock and the database's clock, which used to disagree by a factor of 48.
 *
 * `Sandbox.create`'s `timeout` is the sandbox's whole lifetime. Nothing passed one, so every
 * sandbox took the SDK default of 300 s while `Workspace.expires_at` said four hours and #198's
 * reaper was built around that. The first verification to exceed five minutes was killed
 * mid-stage — semgrep took the SIGTERM and reported `exit 143`, which reads as a scanner bug and
 * is not one. Every earlier run happened to finish inside five minutes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_SANDBOX_LIFETIME_MS,
  MIN_SANDBOX_LIFETIME_MS,
  sandboxLifetimeMs,
} from "../dist/factory/workspace-service.js";

const NOW = Date.parse("2026-09-19T22:00:00.000Z");
const at = (ms) => new Date(NOW + ms);

test("the sandbox lives as long as the workspace row says it does", () => {
  // The whole point: one number, taken from the expiry the caller already chose.
  assert.equal(sandboxLifetimeMs(at(4 * 60 * 60_000), NOW), 4 * 60 * 60_000);
  assert.equal(sandboxLifetimeMs(at(30 * 60_000), NOW), 30 * 60_000);
});

test("a verification longer than the old five-minute default now survives it", () => {
  // The run that exposed this took 313s. Under the old default the sandbox was gone at 300s.
  const lifetime = sandboxLifetimeMs(at(4 * 60 * 60_000), NOW);
  assert.ok(lifetime > 313_000, `313s verification must fit, got ${lifetime}ms`);
});

test("an expiry already in the past asks for a floor, not a negative lifetime", () => {
  // A retried provision or a skewed clock must not turn into a rejected create, which would
  // make a recoverable condition a failed run.
  assert.equal(sandboxLifetimeMs(at(-60_000), NOW), MIN_SANDBOX_LIFETIME_MS);
  assert.equal(sandboxLifetimeMs(at(0), NOW), MIN_SANDBOX_LIFETIME_MS);
});

test("an absent or unusable expiry falls back rather than throwing", () => {
  assert.equal(sandboxLifetimeMs(null, NOW), MIN_SANDBOX_LIFETIME_MS);
  assert.equal(sandboxLifetimeMs(undefined, NOW), MIN_SANDBOX_LIFETIME_MS);
  assert.equal(sandboxLifetimeMs(new Date("nonsense"), NOW), MIN_SANDBOX_LIFETIME_MS);
});

test("a very distant expiry is clamped to what the platform was measured to accept", () => {
  // 45m, 2h, 4h and 5h were all accepted against the real API; beyond that is a guess about
  // someone else's plan limit, and `expires_at` plus the reaper remain the backstop.
  assert.equal(sandboxLifetimeMs(at(30 * 24 * 60 * 60_000), NOW), MAX_SANDBOX_LIFETIME_MS);
});
