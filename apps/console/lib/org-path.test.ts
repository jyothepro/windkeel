import { test } from "node:test";
import assert from "node:assert/strict";
import { orgScoped } from "./org-path.ts";

test("work routes name the organization once one is chosen", () => {
  assert.equal(orgScoped("/runs?status=BLOCKED", "org-1"), "/orgs/org-1/runs?status=BLOCKED");
  assert.equal(orgScoped("/runs/abc/events", "org-1"), "/orgs/org-1/runs/abc/events");
  assert.equal(orgScoped("/repositories/r1/secrets", "org 1"), "/orgs/org%201/repositories/r1/secrets");
});

test("identity routes, and callers with no choice made, are left alone", () => {
  assert.equal(orgScoped("/self", "org-1"), "/self");
  assert.equal(orgScoped("/tokens", "org-1"), "/tokens");
  assert.equal(orgScoped("/auth/device/ABCD", "org-1"), "/auth/device/ABCD");
  assert.equal(orgScoped("/runsx", "org-1"), "/runsx");
  assert.equal(orgScoped("/runs", null), "/runs");
});
