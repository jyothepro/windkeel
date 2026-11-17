import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_PERMISSIONS, DEFAULT_PRESET, PERMISSIONS, canManage, defaultTokenScopes, grantable, offeredPresets, scopeProblem, visibleTabs } from "./permissions.ts";

const MEMBER = ["runs.read", "runs.write", "runs.approve"];
const ADMIN = [...PERMISSIONS];

test("the permission list matches ADR-0024 §4, plus the two M8 added, the two M9 added, runs.merge, #393's three, batches.manage and billing.manage", () => {
  assert.deepEqual([...PERMISSIONS].sort(), [
    "account.manage",
    "audit.read",
    "batches.manage",
    "billing.manage",
    "integrations.manage",
    "knowledge.manage",
    "members.manage",
    "models.manage",
    "models.read",
    "playbooks.manage",
    "playbooks.read",
    "repositories.manage",
    "roles.manage",
    "runs.approve",
    "runs.merge",
    "runs.read",
    "runs.takeover",
    "runs.write",
    "schedules.manage",
    "secrets.manage",
    "tokens.manage",
  ]);
  assert.deepEqual([...ADMIN_PERMISSIONS].sort(), [
    "account.manage",
    "audit.read",
    "batches.manage",
    "billing.manage",
    "integrations.manage",
    "knowledge.manage",
    "members.manage",
    "models.manage",
    "playbooks.manage",
    "repositories.manage",
    "roles.manage",
    "runs.merge",
    "schedules.manage",
    "tokens.manage",
  ]);
});

test("a token is never offered more than its creator holds", () => {
  assert.deepEqual(grantable(MEMBER), MEMBER);
  assert.deepEqual(grantable(["runs.read", "made.up"]), ["runs.read"]);
});

test("a new token starts without admin permissions, even for an admin", () => {
  const scopes = defaultTokenScopes(ADMIN);
  assert.ok(scopes.includes("runs.write"));
  for (const admin of ADMIN_PERMISSIONS) assert.ok(!scopes.includes(admin), admin);
});

test("asking for more than you hold is refused, and says what", () => {
  assert.match(scopeProblem(["runs.read", "members.manage"], MEMBER) ?? "", /Manage members/);
  assert.equal(scopeProblem(["runs.read"], MEMBER), null);
  assert.match(scopeProblem(["nope"], ADMIN) ?? "", /Unknown/);
  assert.ok(scopeProblem([], ADMIN), "a token that can do nothing is refused");
});

test("presets are offered only as far as the role reaches, and default to execute", () => {
  assert.deepEqual(offeredPresets(MEMBER).map((p) => p.preset), ["read", "execute", "approve"]);
  assert.deepEqual(offeredPresets(["runs.read"]).map((p) => p.preset), ["read"]);
  assert.deepEqual(offeredPresets(ADMIN).map((p) => p.preset), ["read", "execute", "approve", "admin"]);
  assert.equal(DEFAULT_PRESET, "execute");
});

test("a viewer sees General, their own tokens, and integrations, schedules and knowledge read-only", () => {
  assert.deepEqual(
    visibleTabs(["runs.read"]).map((t) => t.tab),
    ["general", "tokens", "integrations", "schedules", "knowledge"],
  );
  assert.equal(canManage("knowledge", ["runs.read"]), false);
  assert.equal(canManage("knowledge", ["runs.read", "knowledge.manage"]), true);
  assert.equal(canManage("integrations", ["runs.read"]), false);
  assert.equal(canManage("schedules", ["runs.read"]), false);
  assert.deepEqual(
    visibleTabs(ADMIN).map((t) => t.tab),
    ["general", "tokens", "members", "access", "models", "integrations", "schedules", "webhooks", "service-principals", "merging", "audit", "knowledge", "playbooks", "billing"],
  );
});

test("#393: the Audit tab is audit.read in the organization; Roles needs it through the account role", () => {
  assert.ok(!visibleTabs(MEMBER).some((t) => t.tab === "audit"), "a member does not see the audit log");
  assert.ok(visibleTabs(["audit.read"]).some((t) => t.tab === "audit"));
  assert.ok(!visibleTabs(ADMIN).some((t) => t.tab === "roles"));
  assert.ok(!visibleTabs(ADMIN, ["runs.read"]).some((t) => t.tab === "roles"));
  assert.ok(visibleTabs([], ["roles.manage"]).some((t) => t.tab === "roles"));
  for (const p of ["audit.read", "roles.manage", "account.manage"]) assert.ok(ADMIN_PERMISSIONS.has(p as never), `${p} stays out of tokens by default`);
});

test("Playbooks: a member reads them (to file work under one), only playbooks.manage changes them", () => {
  assert.ok(!visibleTabs(["runs.read"]).some((t) => t.tab === "playbooks"), "a viewer has no playbooks.read");
  assert.ok(visibleTabs([...MEMBER, "playbooks.read"]).some((t) => t.tab === "playbooks"));
  assert.equal(canManage("playbooks", [...MEMBER, "playbooks.read"]), false);
  assert.equal(canManage("playbooks", ["playbooks.manage"]), true);
});

test("with nothing to read, only the personal tabs show", () => {
  assert.deepEqual(visibleTabs([]).map((t) => t.tab), ["general", "tokens"]);
});

test("M8 tabs follow the API's permissions: manage to change, runs.read to look", () => {
  assert.ok(!visibleTabs(MEMBER).some((t) => t.tab === "webhooks"));
  assert.ok(visibleTabs(["integrations.manage"]).some((t) => t.tab === "webhooks"));
  assert.ok(!visibleTabs(MEMBER).some((t) => t.tab === "service-principals"));
  assert.ok(visibleTabs(["runs.read", "tokens.manage"]).some((t) => t.tab === "service-principals"));
  assert.ok(visibleTabs(["schedules.manage"]).some((t) => t.tab === "schedules"));
  assert.equal(canManage("schedules", ["schedules.manage"]), true);
  assert.equal(canManage("schedules", ["integrations.manage"]), false);
  assert.equal(canManage("integrations", ADMIN), true);
  assert.equal(canManage("general", []), true);
});

test("Models: a member reads the keys and default models, only models.manage changes them", () => {
  assert.ok(!visibleTabs(["runs.read"]).some((t) => t.tab === "models"), "a viewer has no models.read");
  assert.ok(visibleTabs([...MEMBER, "models.read"]).some((t) => t.tab === "models"));
  assert.equal(canManage("models", [...MEMBER, "models.read"]), false);
  assert.equal(canManage("models", ADMIN), true);
});

test("Billing is an admin's tab: a member never sees it (ADR-0037)", () => {
  assert.ok(!visibleTabs(MEMBER).some((t) => t.tab === "billing"));
  assert.ok(!visibleTabs([...MEMBER, "models.read", "runs.takeover"]).some((t) => t.tab === "billing"));
  assert.ok(visibleTabs(ADMIN).some((t) => t.tab === "billing"));
  assert.equal(canManage("billing", ADMIN), true);
});
