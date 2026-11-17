/**
 * `/v1/playbooks` and `POST /v1/tasks { playbook }` (#390, ADR-0033).
 *
 * Routes read with `playbooks.read` and written with `playbooks.manage`; refusals are named
 * (`400 invalid_playbook`, `404 unknown_playbook`, `409 builtin_readonly`, `409
 * playbook_slug_taken`); a task filed under a playbook keeps a frozen snapshot; its default risk and
 * model preset apply only where the body says nothing; idempotency is unchanged.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { apiControl } from "../apps/ingress/dist/src/api/control.js";
import { matchRoute } from "../apps/ingress/dist/src/api/route.js";
import { createModelPreset } from "../dist/factory/model-presets.js";
import { getEngineeringTask } from "../dist/factory/repositories.js";
import { ADMIN_PERMISSIONS, PERMISSIONS } from "../dist/factory/tenancy.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { FIXTURE_REPOSITORY_ID as REPO_ID, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

const TOKEN = "test-operator-token";
const { publicKey: PUBLIC_KEY } = generateSecretKeyPair();

function request(method, path, extra = {}) {
  const params = extra.query ?? {};
  return {
    method,
    path,
    query: { get: (n) => params[n] },
    headers: { authorization: `Bearer ${TOKEN}`, ...(extra.key ? { "idempotency-key": extra.key } : {}) },
    body: extra.body,
  };
}

let counter = 0;
async function withApi(fn) {
  const schema = `windkeel_api_playbooks_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const { rows } = await pool.query("select id from organization where is_default");
    const enqueued = [];
    const control = apiControl({
      pool,
      control: { cancel: async () => {}, signal: async () => {}, startRun: async (id) => (enqueued.push(id), { enqueued: true }) },
      github: {},
    });
    const deps = { pool, control, secretPublicKey: PUBLIC_KEY };
    const auth = { token: TOKEN, subject: "operator" };
    await fn({ pool, org: rows[0].id, enqueued, call: (m, p, e) => handleApiRequest(deps, auth, request(m, p, e)) });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

const CUSTOM = {
  slug: "strict-lint",
  name: "Strict lint",
  makerInstructions: "Fix every lint warning you touch.",
  criteria: [{ text: "No new lint warnings" }],
  verifier: { extraChecks: [{ name: "lint-strict", command: "exit 0" }] },
};

const TASK = { repositoryId: REPO_ID, title: "Bump left-pad", description: "Upgrade left-pad.\n\n- [ ] left-pad is 2.0" };

// --- pure ---------------------------------------------------------------------------------------

test("playbook routes: read with playbooks.read, written with playbooks.manage, in an organization", () => {
  for (const path of ["/v1/playbooks", "/v1/playbooks/dependency-upgrade", "/v1/orgs/acme/playbooks"]) {
    const { route } = matchRoute("GET", path).matched;
    assert.equal(route.permission, "playbooks.read", path);
    assert.equal(route.organization, true);
  }
  for (const [method, path] of [
    ["POST", "/v1/playbooks"],
    ["PATCH", "/v1/playbooks/abc"],
    ["DELETE", "/v1/playbooks/abc"],
  ]) {
    const { route, params } = matchRoute(method, path).matched;
    assert.equal(route.permission, "playbooks.manage", `${method} ${path}`);
    if (method !== "POST") assert.equal(params.playbookId, "abc");
  }
  assert.ok(PERMISSIONS.includes("playbooks.read") && PERMISSIONS.includes("playbooks.manage"));
  // A leaked token must not be able to add a command the verifier runs.
  assert.ok(ADMIN_PERMISSIONS.includes("playbooks.manage"));
  assert.ok(!ADMIN_PERMISSIONS.includes("playbooks.read"));
});

// --- Postgres -----------------------------------------------------------------------------------

test("migration 0045 gives Admin and Member playbooks.read, and only Admin playbooks.manage", { skip }, async () => {
  await withApi(async ({ pool }) => {
    const roles = Object.fromEntries(
      (await pool.query("select key, permissions from access_role where account_id is null")).rows.map((r) => [r.key, r.permissions]),
    );
    assert.ok(roles.admin.includes("playbooks.read") && roles.admin.includes("playbooks.manage"));
    assert.ok(roles.member.includes("playbooks.read") && !roles.member.includes("playbooks.manage"));
    assert.ok(!roles.viewer.includes("playbooks.read"));
  });
});

test("CRUD: built-ins listed first; create 201; edit bumps the version; archive hides it; refusals are named", { skip }, async () => {
  await withApi(async ({ call }) => {
    const list = await call("GET", "/v1/playbooks");
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.items.map((p) => [p.slug, p.builtin]),
      [["code-review", true], ["migration", true], ["incident-fix", true], ["test-writing", true], ["dependency-upgrade", true]],
    );
    const dep = list.body.items.find((p) => p.slug === "dependency-upgrade");
    assert.deepEqual(dep.verifierAdds, ["fail when the repository declares no checks", "require the security stage to run (a skip blocks)"]);
    assert.deepEqual(dep.addedCriteria.map((c) => c.id), ["PB1", "PB2"]);

    const created = await call("POST", "/v1/playbooks", { body: CUSTOM });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.playbook.version, 1);
    const id = created.body.playbook.id;

    assert.equal((await call("POST", "/v1/playbooks", { body: CUSTOM })).body.code, "playbook_slug_taken");
    const weak = await call("POST", "/v1/playbooks", { body: { ...CUSTOM, slug: "weak", verifier: { checksRequired: false } } });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.code, "invalid_playbook");
    assert.match(weak.body.error, /checksRequired/);
    const skipper = await call("POST", "/v1/playbooks", { body: { ...CUSTOM, slug: "skipper", verifier: { skipStages: ["security"] } } });
    assert.equal(skipper.status, 400);
    assert.match(skipper.body.error, /skipStages/);

    const builtin = await call("PATCH", "/v1/playbooks/dependency-upgrade", { body: { name: "Mine" } });
    assert.equal(builtin.status, 409);
    assert.equal(builtin.body.code, "builtin_readonly");

    const edited = await call("PATCH", `/v1/playbooks/${id}`, { body: { makerInstructions: "Stricter." } });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.playbook.version, 2);

    const copy = await call("POST", "/v1/playbooks", { body: { from: "test-writing", slug: "our-tests" } });
    assert.equal(copy.status, 201);
    assert.equal(copy.body.playbook.kind, "test-writing");

    const unknown = await call("GET", "/v1/playbooks/nope");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "unknown_playbook");

    assert.equal((await call("DELETE", `/v1/playbooks/${id}`)).status, 200);
    assert.equal((await call("GET", `/v1/playbooks/${id}`)).status, 404);
    assert.ok(!(await call("GET", "/v1/playbooks")).body.items.some((p) => p.slug === "strict-lint"));
  });
});

test("POST /v1/tasks with a playbook stores a frozen snapshot, shown on GET /v1/tasks/:id", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const created = await call("POST", "/v1/playbooks", { body: CUSTOM });
    const res = await call("POST", "/v1/tasks", { body: { ...TASK, playbook: "strict-lint" } });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    // Edited afterwards: the task keeps v1.
    await call("PATCH", `/v1/playbooks/${created.body.playbook.id}`, { body: { verifier: { extraChecks: [{ name: "lint-strict", command: "exit 1" }] } } });
    const task = await getEngineeringTask(pool, res.body.taskId);
    assert.equal(task.playbook.slug, "strict-lint");
    assert.equal(task.playbook.version, 1);
    assert.equal(task.playbook.verifier.extraChecks[0].command, "exit 0");
    assert.deepEqual(task.acceptanceCriteria.map((c) => c.id), ["AC1"], "the playbook's criteria are not the author's");

    const view = await call("GET", `/v1/tasks/${res.body.taskId}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.playbook.slug, "strict-lint");
    assert.equal(view.body.playbook.builtin, false);

    const unknown = await call("POST", "/v1/tasks", { body: { ...TASK, playbook: "nope" } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "unknown_playbook");
    const bad = await call("POST", "/v1/tasks", { body: { ...TASK, playbook: 7 } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "invalid_playbook");
    // An archived playbook can no longer be chosen.
    await call("DELETE", `/v1/playbooks/${created.body.playbook.id}`);
    assert.equal((await call("POST", "/v1/tasks", { body: { ...TASK, playbook: "strict-lint" } })).body.code, "unknown_playbook");
  });
});

test("the playbook's default risk and model preset apply only when the body names none", { skip }, async () => {
  await withApi(async ({ pool, org, call }) => {
    const preset = await createModelPreset(
      pool,
      org,
      { name: "Fast", maker: { model: "gpt-5-codex", provider: "openai" }, checker: [{ model: "claude-sonnet-4-5", provider: "anthropic" }] },
      { enabledHarnesses: ["codex"] },
    );
    const pb = await call("POST", "/v1/playbooks", { body: { ...CUSTOM, defaultRiskLevel: "high", modelPresetId: preset.id } });
    assert.equal(pb.status, 201, JSON.stringify(pb.body));

    const defaults = await call("POST", "/v1/tasks", { body: { ...TASK, playbook: "strict-lint" } });
    assert.equal(defaults.status, 202, JSON.stringify(defaults.body));
    const t1 = await getEngineeringTask(pool, defaults.body.taskId);
    assert.equal(t1.riskLevel, "high");
    assert.deepEqual(t1.modelOverride, { maker: { model: "gpt-5-codex", provider: "openai" }, checker: [{ model: "claude-sonnet-4-5", provider: "anthropic" }] });

    const own = await call("POST", "/v1/tasks", {
      body: { ...TASK, playbook: "strict-lint", riskLevel: "low", models: { maker: { model: "gpt-5" } } },
    });
    assert.equal(own.status, 202, JSON.stringify(own.body));
    const t2 = await getEngineeringTask(pool, own.body.taskId);
    assert.equal(t2.riskLevel, "low");
    assert.deepEqual(t2.modelOverride, { maker: { model: "gpt-5" } });

    // Without a playbook, nothing changes: the default risk is low and there is no override.
    const plain = await call("POST", "/v1/tasks", { body: TASK });
    const t3 = await getEngineeringTask(pool, plain.body.taskId);
    assert.equal(t3.riskLevel, "low");
    assert.equal(t3.modelOverride, null);
    assert.equal(t3.playbook, null);
  });
});

test("Idempotency-Key with a playbook: a retry answers the original; another body is 422", { skip }, async () => {
  await withApi(async ({ pool, call }) => {
    const first = await call("POST", "/v1/tasks", { body: { ...TASK, playbook: "dependency-upgrade" }, key: "pb-key-1" });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    const again = await call("POST", "/v1/tasks", { body: { ...TASK, playbook: "dependency-upgrade" }, key: "pb-key-1" });
    assert.equal(again.status, 202);
    assert.equal(again.body.taskId, first.body.taskId);
    const other = await call("POST", "/v1/tasks", { body: { ...TASK, playbook: "test-writing" }, key: "pb-key-1" });
    assert.equal(other.status, 422);
    const { rows } = await pool.query("select count(*)::int as n from engineering_task");
    assert.equal(rows[0].n, 1);
    assert.equal((await getEngineeringTask(pool, first.body.taskId)).playbook.builtin, true);
  });
});
