/**
 * `/v1/knowledge` and friends (#388) through the real router: `knowledge.manage` to write,
 * `runs.read` to read, 404 for a repository the organization holds no grant on, 409 for a stale
 * version, 400 for a note that cannot be saved.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { insertEngineeringRun, insertEngineeringTask } from "../dist/factory/repositories.js";
import { createApiToken, PERMISSIONS } from "../dist/factory/tenancy.js";
import { insertLearnedLesson, putDigest, recordRunKnowledge } from "../dist/factory/knowledge.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const TOKEN = "test-operator-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";
const FOREIGN_REPO = "33333333-3333-3333-3333-333333333333";

async function withApi(fn) {
  const schema = `windkeel_knowledge_api_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const org = (await pool.query("select id, account_id from organization where is_default")).rows[0];
    // A repository another organization holds, and this one does not.
    // In an account of its own, so the operator (an admin of the default account) cannot reach it.
    const account = (await pool.query("insert into account (name) values ('elsewhere') returning id")).rows[0].id;
    const other = (await pool.query("insert into organization (account_id, name) values ($1, 'other') returning id", [account])).rows[0].id;
    await pool.query(
      "insert into repository (id, owner, name, default_branch, clone_url) values ($1, 'acme', 'secret-sauce', 'main', 'https://github.com/acme/secret-sauce.git')",
      [FOREIGN_REPO],
    );
    await pool.query("insert into repository_grant (organization_id, repository_id, intake) values ($1, $2, false)", [other, FOREIGN_REPO]);

    const deps = { pool, control: { wake: async () => {}, enqueue: async () => ({ enqueued: true }) } };
    const auth = { token: TOKEN, subject: "operator" };
    const call = async (method, path, { bearer = TOKEN, body, query = {} } = {}) =>
      handleApiRequest(deps, auth, {
        method,
        path,
        query: new URLSearchParams(query),
        headers: { authorization: `Bearer ${bearer}` },
        ...(body ? { body } : {}),
      });
    const operator = (await pool.query("select id from principal where is_bootstrap")).rows[0].id;
    const token = async (permissions) =>
      (
        await createApiToken(pool, {
          name: permissions.join(","),
          ownerPrincipalId: operator,
          createdByPrincipalId: operator,
          organizationId: null,
          permissions,
          ceiling: PERMISSIONS,
        })
      ).secret;
    await fn({ pool, call, token, orgId: org.id, otherOrg: other });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

test("create, list, edit with optimistic concurrency, read revisions, archive and delete a note", { skip }, async () => {
  await withApi(async ({ call }) => {
    const created = await call("POST", "/v1/knowledge", { body: { repositoryId: REPO_ID, title: "Use pnpm", body: "pnpm workspaces.", pathGlobs: ["packages/**"] } });
    assert.equal(created.status, 201);
    const note = created.body.note;
    assert.equal(note.status, "active");
    assert.equal(note.scope, "repository");
    assert.equal(note.createdBy, "operator");
    assert.deepEqual(note.pathGlobs, ["packages/**"]);

    const orgWide = await call("POST", "/v1/knowledge", { body: { title: "House style", body: "British spelling." } });
    assert.equal(orgWide.status, 201);
    assert.equal(orgWide.body.note.scope, "organization");

    const listed = await call("GET", "/v1/knowledge", { query: { repositoryId: REPO_ID } });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.items.map((n) => n.title).sort(), ["House style", "Use pnpm"]);
    const orgOnly = await call("GET", "/v1/knowledge", { query: { scope: "organization" } });
    assert.deepEqual(orgOnly.body.items.map((n) => n.title), ["House style"]);

    const edited = await call("POST", `/v1/knowledge/${note.id}`, { body: { version: 1, body: "pnpm -w." } });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.note.version, 2);
    const stale = await call("POST", `/v1/knowledge/${note.id}`, { body: { version: 1, body: "lost update" } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "version_conflict");
    const noVersion = await call("POST", `/v1/knowledge/${note.id}`, { body: { body: "x" } });
    assert.equal(noVersion.status, 400);

    const revisions = await call("GET", `/v1/knowledge/${note.id}/revisions`);
    assert.deepEqual(revisions.body.items.map((r) => r.version), [1, 2]);

    const archived = await call("POST", `/v1/knowledge/${note.id}/status`, { body: { action: "archive" } });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.note.status, "archived");
    const again = await call("POST", `/v1/knowledge/${note.id}/status`, { body: { action: "archive" } });
    assert.equal(again.status, 409);

    assert.equal((await call("DELETE", `/v1/knowledge/${note.id}`)).status, 200);
    assert.equal((await call("POST", `/v1/knowledge/${orgWide.body.note.id}/delete`)).status, 200);
    assert.equal((await call("GET", `/v1/knowledge/${note.id}/revisions`)).status, 404);
  });
});

test("a suggested lesson is accepted or rejected through the API, with its risk and reasons shown", { skip }, async () => {
  await withApi(async ({ pool, call, orgId }) => {
    const lesson = await insertLearnedLesson(pool, {
      organizationId: orgId,
      repositoryId: REPO_ID,
      title: "The test check must pass",
      body: "On run 1234abcd the test check (`npm test`) failed.",
      sourceKind: "verifier_finding",
      sourceRef: { runId: "1234abcd" },
    });
    const suggested = await call("GET", "/v1/knowledge", { query: { repositoryId: REPO_ID, status: "suggested" } });
    assert.equal(suggested.body.items.length, 1);
    assert.equal(suggested.body.items[0].risk, "high");
    assert.ok(suggested.body.items[0].riskReasons.length > 0);
    assert.deepEqual(suggested.body.items[0].sourceRef, { runId: "1234abcd" });

    const accepted = await call("POST", `/v1/knowledge/${lesson.id}/status`, { body: { action: "accept" } });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.note.status, "active");
    assert.equal(accepted.body.note.updatedBy, "operator");
    const other = await insertLearnedLesson(pool, {
      organizationId: orgId,
      repositoryId: REPO_ID,
      title: "The lint check could not run",
      body: "On run 1234abcd the lint check could not run: missing script.",
      sourceKind: "verifier_finding",
      sourceRef: { runId: "1234abcd" },
    });
    const rejected = await call("POST", `/v1/knowledge/${other.id}/status`, { body: { action: "reject" } });
    assert.equal(rejected.body.note.status, "rejected");
    assert.equal((await call("GET", "/v1/knowledge", { query: { status: "bogus" } })).status, 400);
  });
});

test("writing needs knowledge.manage; a read-only token can read but not write", { skip }, async () => {
  await withApi(async ({ pool, call, token }) => {
    const reader = await token(["runs.read"]);
    const read = await call("GET", "/v1/knowledge", { bearer: reader });
    assert.equal(read.status, 200);
    const refused = await call("POST", "/v1/knowledge", { bearer: reader, body: { title: "t", body: "b" } });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.missing, "knowledge.manage");

    const writer = await token(["runs.read", "knowledge.manage"]);
    const created = await call("POST", "/v1/knowledge", { bearer: writer, body: { title: "t", body: "b" } });
    assert.equal(created.status, 201);

    // Every one of the nine routes, not just create (#409 review): the five writes refuse a token
    // without knowledge.manage, and the four reads refuse one without runs.read.
    const id = created.body.note.id;
    const writes = [
      ["POST", "/v1/knowledge", { title: "t", body: "b" }],
      ["POST", `/v1/knowledge/${id}`, { version: 1, body: "x" }],
      ["POST", `/v1/knowledge/${id}/status`, { action: "archive" }],
      ["POST", `/v1/knowledge/${id}/delete`, {}],
      ["DELETE", `/v1/knowledge/${id}`, undefined],
    ];
    for (const [method, path, body] of writes) {
      const res = await call(method, path, { bearer: reader, ...(body ? { body } : {}) });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.body.missing, "knowledge.manage", `${method} ${path}`);
    }
    const blind = await token(["knowledge.manage"]);
    const reads = ["/v1/knowledge", `/v1/knowledge/${id}/revisions`, `/v1/repositories/${REPO_ID}/digest`, "/v1/runs/00000000-0000-4000-8000-000000000000/knowledge"];
    for (const path of reads) {
      const res = await call("GET", path, { bearer: blind });
      assert.equal(res.status, 403, path);
      assert.equal(res.body.missing, "runs.read", path);
    }
    const after = (await pool.query("select status, version from knowledge_note where id = $1", [id])).rows[0];
    assert.deepEqual(after, { status: "active", version: 1 }, "nothing the refused calls asked for happened");

    // Admin and Member hold it (migration 0044); Viewer does not.
    const roles = Object.fromEntries((await pool.query("select key, permissions from access_role where account_id is null")).rows.map((r) => [r.key, r.permissions]));
    assert.ok(roles.admin.includes("knowledge.manage"));
    assert.ok(roles.member.includes("knowledge.manage"));
    assert.ok(!roles.viewer.includes("knowledge.manage"));
  });
});

test("another organization's repository, and its notes, are 404", { skip }, async () => {
  await withApi(async ({ pool, call, otherOrg }) => {
    assert.equal((await call("GET", "/v1/knowledge", { query: { repositoryId: FOREIGN_REPO } })).status, 404);
    assert.equal((await call("POST", "/v1/knowledge", { body: { repositoryId: FOREIGN_REPO, title: "t", body: "b" } })).status, 404);
    assert.equal((await call("GET", `/v1/repositories/${FOREIGN_REPO}/digest`)).status, 404);
    const foreign = (
      await pool.query(
        `insert into knowledge_note (organization_id, repository_id, title, body, status, source_kind, created_by, updated_by)
         values ($1, $2, 't', 'b', 'active', 'human', 'z', 'z') returning id`,
        [otherOrg, FOREIGN_REPO],
      )
    ).rows[0].id;
    assert.equal((await call("POST", `/v1/knowledge/${foreign}`, { body: { version: 1, body: "x" } })).status, 404);
    assert.equal((await call("POST", `/v1/knowledge/${foreign}/status`, { body: { action: "archive" } })).status, 404);
    assert.equal((await call("DELETE", `/v1/knowledge/${foreign}`)).status, 404);
    assert.equal((await call("POST", `/v1/knowledge/${foreign}/delete`)).status, 404);
    assert.equal((await call("GET", `/v1/knowledge/${foreign}/revisions`)).status, 404);
    assert.equal((await call("GET", "/v1/knowledge")).body.items.length, 0);
    // An organization-wide note of the other organization is as invisible as its repository's.
    const foreignOrgWide = (
      await pool.query(
        `insert into knowledge_note (organization_id, repository_id, title, body, status, source_kind, created_by, updated_by)
         values ($1, null, 't', 'b', 'active', 'human', 'z', 'z') returning id`,
        [otherOrg],
      )
    ).rows[0].id;
    assert.equal((await call("POST", `/v1/knowledge/${foreignOrgWide}/status`, { body: { action: "archive" } })).status, 404);
    assert.equal((await call("GET", "/v1/knowledge", { query: { scope: "organization" } })).body.items.length, 0);
    const untouched = await pool.query("select status, version from knowledge_note where organization_id = $1 order by id", [otherOrg]);
    assert.deepEqual(untouched.rows, [{ status: "active", version: 1 }, { status: "active", version: 1 }], "the other organization's notes are untouched");
  });
});

test("validation: an empty title or a body over 8000 characters is 400", { skip }, async () => {
  await withApi(async ({ call }) => {
    const empty = await call("POST", "/v1/knowledge", { body: { title: "", body: "b" } });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, "invalid_note");
    const long = await call("POST", "/v1/knowledge", { body: { title: "t", body: "x".repeat(8001) } });
    assert.equal(long.status, 400);
    const glob = await call("POST", "/v1/knowledge", { body: { title: "t", body: "b", pathGlobs: ["/etc/passwd"] } });
    assert.equal(glob.status, 400);
  });
});

test("the digest and a run's knowledge snapshot are readable with runs.read", { skip }, async () => {
  await withApi(async ({ pool, call, token }) => {
    assert.deepEqual((await call("GET", `/v1/repositories/${REPO_ID}/digest`)).body.digest, null);
    await putDigest(pool, { repositoryId: REPO_ID, commitSha: "a".repeat(40), body: "Top-level layout:\n- src/", sources: [{ path: "package.json", bytes: 10, sha256: "0".repeat(64) }] });
    const digest = await call("GET", `/v1/repositories/${REPO_ID}/digest`);
    assert.equal(digest.body.digest.commitSha, "a".repeat(40));

    const task = await insertEngineeringTask(pool, {
      repositoryId: REPO_ID, sourceType: "local", sourceReference: "k", title: "t", description: "d",
      acceptanceCriteria: [], riskLevel: "low", priority: null, status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    await recordRunKnowledge(pool, run.id, [
      { noteId: null, noteVersion: null, digestSha: "a".repeat(40), sourceKind: "digest", risk: null, title: "Codebase digest", body: "x", provenance: "codebase digest" },
    ], () => 42);
    const reader = await token(["runs.read"]);
    const snapshot = await call("GET", `/v1/runs/${run.id}/knowledge`, { bearer: reader });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.items.length, 1);
    assert.equal(snapshot.body.items[0].provenance, "codebase digest");
    assert.equal(snapshot.body.items[0].chars, 42);
    assert.equal((await call("GET", "/v1/runs/00000000-0000-4000-8000-000000000000/knowledge")).status, 404);
  });
});
