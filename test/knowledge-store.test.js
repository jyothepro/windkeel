import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import {
  createNote,
  deleteNote,
  getNote,
  insertLearnedLesson,
  listNotes,
  listRevisions,
  setNoteStatus,
  updateNote,
} from "../dist/factory/knowledge.js";
import { FIXTURE_REPOSITORY_ID, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
let counter = 0;

async function withSchema(fn) {
  const schema = `windkeel_knowledge_store_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const { rows } = await pool.query("select id, account_id from organization where is_default");
    const otherOrg = (
      await pool.query("insert into organization (account_id, name) values ($1, 'other') returning id", [rows[0].account_id])
    ).rows[0].id;
    await fn({ pool, orgId: rows[0].id, otherOrg });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

test("a note is created active and attributed, and every edit bumps its version and writes a revision", { skip }, async () => {
  await withSchema(async ({ pool, orgId }) => {
    const note = await createNote(pool, { organizationId: orgId, repositoryId: FIXTURE_REPOSITORY_ID, title: "Use pnpm", body: "pnpm workspaces.", actor: "alice" });
    assert.equal(note.status, "active");
    assert.equal(note.sourceKind, "human");
    assert.equal(note.version, 1);
    assert.equal(note.createdBy, "alice");

    const edited = await updateNote(pool, { organizationId: orgId, noteId: note.id, expectedVersion: 1, body: "pnpm -w.", actor: "bob" });
    assert.equal(edited.version, 2);
    assert.equal(edited.title, "Use pnpm");
    assert.equal(edited.updatedBy, "bob");

    await assert.rejects(
      updateNote(pool, { organizationId: orgId, noteId: note.id, expectedVersion: 1, body: "stale", actor: "carol" }),
      (err) => err.name === "KnowledgeNoteError" && err.status === 409 && err.code === "version_conflict",
    );
    const revisions = await listRevisions(pool, orgId, note.id);
    assert.deepEqual(revisions.map((r) => [r.version, r.body, r.actor]), [[1, "pnpm workspaces.", "alice"], [2, "pnpm -w.", "bob"]]);
  });
});

test("invalid notes are refused with the reason", { skip }, async () => {
  await withSchema(async ({ pool, orgId }) => {
    const create = (fields) => createNote(pool, { organizationId: orgId, repositoryId: null, actor: "a", ...fields });
    const refused = (code) => (err) => err.name === "KnowledgeNoteError" && err.status === 400 && err.code === code;
    await assert.rejects(create({ title: "", body: "x" }), refused("invalid_note"));
    await assert.rejects(create({ title: "t", body: "x".repeat(8001) }), refused("invalid_note"));
    await assert.rejects(create({ title: "t", body: "b", pathGlobs: ["../etc"] }), refused("invalid_note"));
    await assert.rejects(create({ title: "t", body: "b", pathGlobs: "src/**" }), refused("invalid_note"));
  });
});

test("status transitions: accept, reject, archive, restore — and the ones that make no sense are refused", { skip }, async () => {
  await withSchema(async ({ pool, orgId }) => {
    const lesson = await insertLearnedLesson(pool, {
      organizationId: orgId,
      repositoryId: FIXTURE_REPOSITORY_ID,
      title: "The test check must pass",
      body: "On run 1234abcd the test check (`npm test`) failed.",
      sourceKind: "verifier_finding",
      sourceRef: { runId: "1234abcd" },
    });
    assert.equal(lesson.status, "suggested", "high risk waits for a person");
    assert.equal(lesson.risk, "high");
    assert.ok(lesson.riskReasons.length > 0);

    const accepted = await setNoteStatus(pool, { organizationId: orgId, noteId: lesson.id, action: "accept", actor: "alice" });
    assert.equal(accepted.status, "active");
    assert.equal(accepted.updatedBy, "alice");
    const archived = await setNoteStatus(pool, { organizationId: orgId, noteId: lesson.id, action: "archive", actor: "alice" });
    assert.equal(archived.status, "archived");
    await assert.rejects(
      setNoteStatus(pool, { organizationId: orgId, noteId: lesson.id, action: "archive", actor: "alice" }),
      (err) => err.status === 409 && err.code === "invalid_transition",
    );
    const restored = await setNoteStatus(pool, { organizationId: orgId, noteId: lesson.id, action: "restore", actor: "alice" });
    assert.equal(restored.status, "active");
    assert.equal(restored.version, 4);
    await assert.rejects(
      setNoteStatus(pool, { organizationId: orgId, noteId: lesson.id, action: "explode", actor: "alice" }),
      (err) => err.status === 400,
    );
  });
});

test("a low-risk learned lesson is active at once; a duplicate or a deleted one is not learned again", { skip }, async () => {
  await withSchema(async ({ pool, orgId }) => {
    const input = {
      organizationId: orgId,
      repositoryId: FIXTURE_REPOSITORY_ID,
      title: "Naming",
      body: "Exported functions in this module use camelCase naming.",
      sourceKind: "verifier_finding",
      sourceRef: { runId: "r1" },
    };
    const lesson = await insertLearnedLesson(pool, input);
    assert.equal(lesson.status, "active");
    assert.equal(lesson.risk, "low");
    assert.equal(lesson.createdBy, "orqon");
    assert.equal(await insertLearnedLesson(pool, { ...input, body: "exported functions in this module use  camelcase naming" }), null, "deduplicated");

    assert.equal(await deleteNote(pool, { organizationId: orgId, noteId: lesson.id, actor: "alice" }), true);
    assert.equal(await getNote(pool, orgId, lesson.id), null);
    assert.equal(await insertLearnedLesson(pool, input), null, "deleted stays deleted");
  });
});

test("notes are isolated by organization, and a repository's view includes its organization's notes", { skip }, async () => {
  await withSchema(async ({ pool, orgId, otherOrg }) => {
    const repoNote = await createNote(pool, { organizationId: orgId, repositoryId: FIXTURE_REPOSITORY_ID, title: "Repo", body: "b", actor: "a" });
    const orgNote = await createNote(pool, { organizationId: orgId, repositoryId: null, title: "Org", body: "b", actor: "a" });
    const foreign = await createNote(pool, { organizationId: otherOrg, repositoryId: FIXTURE_REPOSITORY_ID, title: "Foreign", body: "b", actor: "z" });

    const visible = await listNotes(pool, { organizationId: orgId, repositoryId: FIXTURE_REPOSITORY_ID });
    assert.deepEqual(visible.map((n) => n.title).sort(), ["Org", "Repo"]);
    assert.deepEqual((await listNotes(pool, { organizationId: orgId, repositoryId: null })).map((n) => n.id), [orgNote.id]);
    assert.equal(await getNote(pool, orgId, foreign.id), null, "another organization's note is not found");
    assert.equal(await updateNote(pool, { organizationId: orgId, noteId: foreign.id, expectedVersion: 1, body: "x", actor: "a" }), null);
    assert.equal(await deleteNote(pool, { organizationId: orgId, noteId: foreign.id, actor: "a" }), false);
    assert.ok(repoNote);
  });
});

test("deleting a repository deletes its notes, and their revisions, with it", { skip }, async () => {
  await withSchema(async ({ pool, orgId }) => {
    const repoId = "22222222-2222-2222-2222-222222222222";
    await seedFixtureRepository(pool, repoId);
    const note = await createNote(pool, { organizationId: orgId, repositoryId: repoId, title: "Gone", body: "b", actor: "a" });
    await pool.query("delete from repository_grant where repository_id = $1", [repoId]);
    await pool.query("delete from repository where id = $1", [repoId]);
    assert.equal(await getNote(pool, orgId, note.id), null);
    const { rows } = await pool.query("select count(*)::int as n from knowledge_note_revision where note_id = $1", [note.id]);
    assert.equal(rows[0].n, 0);
  });
});
