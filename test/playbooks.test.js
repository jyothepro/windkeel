/**
 * Playbooks in the factory (#390, ADR-0033): built-ins in code, organization rows that shadow
 * them, versioned edits, archive, tenancy, the frozen snapshot a task keeps, and — the maintainer's
 * decision on #390 — playbook criteria that are added on top of the author's and never count as
 * them, so ADR-0012's generation-then-approval route still runs for a description with none.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { BUILTIN_PLAYBOOKS, builtinPlaybooks } from "../dist/factory/playbooks-builtin.js";
import {
  archivePlaybook,
  createPlaybook,
  describePlaybookVerifier,
  effectiveCriteria,
  getPlaybook,
  listPlaybooks,
  parsePlaybookInput,
  PlaybookError,
  playbookCriteria,
  snapshotPlaybook,
  updatePlaybook,
} from "../dist/factory/playbooks.js";
import { assertProvisionable, needsGeneration } from "../dist/factory/criteria-gate.js";
import { getEngineeringTask } from "../dist/factory/repositories.js";
import { createTaskFromIntake } from "../dist/intake/create-task.js";
import { persistedCriteriaOutcome } from "../dist/factory/workflow/handlers/intake.js";
import { FIXTURE_REPOSITORY_ID as REPO_ID, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let counter = 0;
async function withDb(fn) {
  const schema = `windkeel_playbooks_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const { rows } = await pool.query("select id from organization where is_default");
    await fn({ pool, org: rows[0].id });
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

// --- pure ---------------------------------------------------------------------------------------

test("five built-ins with stable slugs, each strengthen-only and read-only", () => {
  assert.deepEqual(
    BUILTIN_PLAYBOOKS.map((p) => p.slug),
    ["code-review", "migration", "incident-fix", "test-writing", "dependency-upgrade"],
  );
  for (const p of BUILTIN_PLAYBOOKS) {
    assert.equal(p.builtin, true);
    assert.equal(p.id, null);
    assert.ok(p.version >= 1);
    // A built-in must itself pass the strict parser it holds organization rows to.
    assert.doesNotThrow(() => parsePlaybookInput({ slug: p.slug, name: p.name, kind: p.kind, makerInstructions: p.makerInstructions, criteria: p.criteria, verifier: p.verifier }));
  }
  const dep = BUILTIN_PLAYBOOKS.find((p) => p.slug === "dependency-upgrade");
  assert.deepEqual(dep.verifier, { checksRequired: true, requireStages: ["security"] });
  assert.deepEqual(describePlaybookVerifier(dep.verifier), [
    "fail when the repository declares no checks",
    "require the security stage to run (a skip blocks)",
  ]);
  assert.equal(builtinPlaybooks({ WINDKEEL_PLAYBOOKS_BUILTIN: "0" }).length, 0, "WINDKEEL_PLAYBOOKS_BUILTIN=0 turns them off");
});

test("the parser refuses unknown and weakening fields, naming the field", () => {
  const cases = [
    [{ ...CUSTOM, verifier: { checksRequired: false } }, /verifier\.checksRequired/],
    [{ ...CUSTOM, verifier: { skipStages: ["security"] } }, /unknown field skipStages/],
    [{ ...CUSTOM, verifier: { gateLevel: "warn" } }, /unknown field gateLevel/],
    [{ ...CUSTOM, approved: true }, /unknown field approved/],
    [{ ...CUSTOM, slug: "Has Spaces" }, /slug/],
    [{ ...CUSTOM, name: "x".repeat(61) }, /name/],
    [{ ...CUSTOM, makerInstructions: "x".repeat(8001) }, /makerInstructions/],
    [{ ...CUSTOM, criteria: Array.from({ length: 11 }, () => ({ text: "c" })) }, /criteria/],
    [{ ...CUSTOM, criteria: [{ text: "c", approved: true }] }, /criteria\[0\]/],
    [{ ...CUSTOM, kind: "anything" }, /kind/],
    [{ ...CUSTOM, defaultRiskLevel: "none" }, /defaultRiskLevel/],
    [{ ...CUSTOM, verifier: { extraChecks: [{ name: "../x", command: "true" }] } }, /extraChecks\[0\]/],
  ];
  for (const [input, message] of cases) {
    assert.throws(
      () => parsePlaybookInput(input),
      (err) => err instanceof PlaybookError && err.status === 400 && err.code === "invalid_playbook" && message.test(err.message),
      JSON.stringify(input).slice(0, 80),
    );
  }
});

test("playbook criteria are PB-numbered with provenance and follow the task's own", () => {
  const snapshot = snapshotPlaybook({ ...CUSTOM, id: "x", kind: "custom", version: 3, builtin: false, defaultRiskLevel: null, modelPresetId: null });
  assert.deepEqual(playbookCriteria(snapshot), [
    { id: "PB1", text: "No new lint warnings", source: { kind: "explicit", ref: "playbook:strict-lint@3" } },
  ]);
  const own = [{ id: "AC1", text: "mine", source: { kind: "explicit", ref: "api" } }];
  assert.deepEqual(effectiveCriteria({ acceptanceCriteria: own, playbook: snapshot }).map((c) => c.id), ["AC1", "PB1"]);
  assert.deepEqual(effectiveCriteria({ acceptanceCriteria: own, playbook: null }), own);
  // The gate sees the task's own alone.
  assert.equal(needsGeneration([]), true);
});

test("a snapshot is a deep copy: changing the playbook afterwards changes nothing in it", () => {
  const p = { ...structuredClone(CUSTOM), id: "x", kind: "custom", version: 1, builtin: false, defaultRiskLevel: null, modelPresetId: null };
  const snapshot = snapshotPlaybook(p);
  p.verifier.extraChecks[0].command = "exit 1";
  p.criteria.push({ text: "later" });
  assert.equal(snapshot.verifier.extraChecks[0].command, "exit 0");
  assert.equal(snapshot.criteria.length, 1);
  assert.equal("name" in snapshot, false);
});

// --- Postgres -----------------------------------------------------------------------------------

test("a fresh organization lists the five built-ins; a row shadows its built-in", { skip }, async () => {
  await withDb(async ({ pool, org }) => {
    const fresh = await listPlaybooks(pool, org);
    assert.deepEqual(fresh.map((p) => [p.slug, p.builtin]), BUILTIN_PLAYBOOKS.map((p) => [p.slug, true]));

    const copy = await createPlaybook(pool, org, { from: "dependency-upgrade", makerInstructions: "Our way." });
    assert.equal(copy.slug, "dependency-upgrade");
    assert.equal(copy.builtin, false);
    assert.equal(copy.version, 1);
    assert.deepEqual(copy.verifier, { checksRequired: true, requireStages: ["security"] }, "the copy keeps the built-in's requirements");
    const listed = await listPlaybooks(pool, org);
    assert.equal(listed.filter((p) => p.slug === "dependency-upgrade").length, 1);
    assert.equal((await getPlaybook(pool, org, "dependency-upgrade")).makerInstructions, "Our way.");
  });
});

test("create, edit (version++), archive (hidden, slug reusable); built-ins are read-only", { skip }, async () => {
  await withDb(async ({ pool, org }) => {
    const created = await createPlaybook(pool, org, CUSTOM);
    assert.equal(created.version, 1);
    const edited = await updatePlaybook(pool, org, created.id, { makerInstructions: "Stricter." });
    assert.equal(edited.version, 2);
    assert.equal(edited.makerInstructions, "Stricter.");
    assert.deepEqual(edited.criteria, CUSTOM.criteria, "an edit keeps what it does not name");
    const bySlug = await updatePlaybook(pool, org, "strict-lint", { name: "Strict lint v3" });
    assert.equal(bySlug.version, 3);

    await assert.rejects(() => createPlaybook(pool, org, CUSTOM), (e) => e.code === "playbook_slug_taken" && e.status === 409);
    await assert.rejects(() => updatePlaybook(pool, org, "test-writing", { name: "x" }), (e) => e.code === "builtin_readonly" && e.status === 409);
    await assert.rejects(() => archivePlaybook(pool, org, "test-writing"), (e) => e.code === "builtin_readonly");
    await assert.rejects(() => updatePlaybook(pool, org, created.id, { verifier: { checksRequired: false } }), (e) => e.code === "invalid_playbook");
    await assert.rejects(() => createPlaybook(pool, org, { from: "no-such" }), (e) => e.code === "unknown_playbook" && e.status === 404);

    await archivePlaybook(pool, org, created.id);
    assert.equal(await getPlaybook(pool, org, created.id), null);
    assert.equal(await getPlaybook(pool, org, "strict-lint"), null);
    assert.ok(!(await listPlaybooks(pool, org)).some((p) => p.slug === "strict-lint"));
    const again = await createPlaybook(pool, org, CUSTOM);
    assert.notEqual(again.id, created.id);
  });
});

test("another organization's playbook is not found by id or by slug", { skip }, async () => {
  await withDb(async ({ pool, org }) => {
    const { rows } = await pool.query(
      "insert into organization (account_id, name) select account_id, 'other' from organization where is_default returning id",
    );
    const other = rows[0].id;
    const theirs = await createPlaybook(pool, other, CUSTOM);
    assert.equal(await getPlaybook(pool, org, theirs.id), null);
    assert.equal(await getPlaybook(pool, org, "strict-lint"), null);
    await assert.rejects(() => updatePlaybook(pool, org, theirs.id, { name: "mine now" }), (e) => e.code === "unknown_playbook");
    // The same slug is free in this organization.
    assert.ok(await createPlaybook(pool, org, CUSTOM));
  });
});

test("a stored row that would weaken verification fails on read rather than being trusted", { skip }, async () => {
  await withDb(async ({ pool, org }) => {
    const created = await createPlaybook(pool, org, CUSTOM);
    await pool.query(`update playbook set verifier = '{"checksRequired": false}' where id = $1`, [created.id]);
    await assert.rejects(() => getPlaybook(pool, org, created.id), (e) => e.code === "invalid_stored_playbook");
    await pool.query(`update playbook set verifier = '{"skipStages": ["security"]}' where id = $1`, [created.id]);
    await assert.rejects(() => listPlaybooks(pool, org), (e) => e.code === "invalid_stored_playbook");
  });
});

test("a preset from another organization cannot be named; the database caps lengths too", { skip }, async () => {
  await withDb(async ({ pool, org }) => {
    await assert.rejects(
      () => createPlaybook(pool, org, { ...CUSTOM, modelPresetId: "00000000-0000-4000-8000-000000000000" }),
      (e) => e.code === "invalid_playbook" && /modelPresetId/.test(e.message),
    );
    await assert.rejects(() =>
      pool.query(
        "insert into playbook (organization_id, slug, name, kind, maker_instructions) values ($1, 'x', 'x', 'custom', $2)",
        [org, "x".repeat(8001)],
      ),
    );
  });
});

test("the task keeps its snapshot: editing the playbook afterwards changes nothing on it", { skip }, async () => {
  await withDb(async ({ pool, org }) => {
    const playbook = await createPlaybook(pool, org, CUSTOM);
    const created = await createTaskFromIntake(
      pool,
      {
        organizationId: org,
        repositoryId: REPO_ID,
        sourceType: "api",
        sourceReference: "api:test:1",
        title: "Tidy",
        description: "Tidy the module.\n\n- [ ] the module is tidy",
        playbook: snapshotPlaybook(playbook),
      },
      { startRun: async () => ({ enqueued: true }) },
    );
    await updatePlaybook(pool, org, playbook.id, { verifier: { extraChecks: [{ name: "lint-strict", command: "exit 1" }] }, criteria: [] });
    const task = await getEngineeringTask(pool, created.taskId);
    assert.equal(task.playbook.version, 1);
    assert.equal(task.playbook.verifier.extraChecks[0].command, "exit 0");
    assert.deepEqual(task.playbook.criteria, CUSTOM.criteria);
    // The author's criteria are the task's; the playbook's ride on top.
    assert.deepEqual(task.acceptanceCriteria.map((c) => c.id), ["AC1"]);
    assert.deepEqual(effectiveCriteria(task).map((c) => c.id), ["AC1", "PB1"]);
  });
});

test("zero criteria of the author's own plus a playbook still generates and waits for approval (ADR-0012)", { skip }, async () => {
  await withDb(async ({ pool, org }) => {
    const playbook = await getPlaybook(pool, org, "dependency-upgrade");
    const created = await createTaskFromIntake(
      pool,
      {
        organizationId: org,
        repositoryId: REPO_ID,
        sourceType: "api",
        sourceReference: "api:test:2",
        title: "Bump left-pad",
        description: "Upgrade left-pad to 2.0.",
        playbook: snapshotPlaybook(playbook),
      },
      { startRun: async () => ({ enqueued: true }) },
    );
    assert.deepEqual(created.criteria, [], "intake extracted none");
    const task = await getEngineeringTask(pool, created.taskId);
    assert.deepEqual(task.acceptanceCriteria, [], "the playbook's criteria are not stored as the author's");
    assert.equal(task.playbook.criteria.length, 2);
    assert.equal(needsGeneration(task.acceptanceCriteria), true);
    // No author criteria: the gate generates (it does not proceed on the playbook's).
    assert.equal(persistedCriteriaOutcome(task), null);
    assert.throws(
      () =>
        assertProvisionable({
          status: "PROVISIONING",
          acceptance_criteria: task.acceptanceCriteria,
          criteria_provenance: task.criteriaProvenance,
          criteria_approved_at: task.criteriaApprovedAt,
        }),
      /no acceptance criteria/,
    );
    // Once generated, they wait for a person — the playbook approves nothing.
    await pool.query(
      `update engineering_task set acceptance_criteria = $2, criteria_provenance = 'generated' where id = $1`,
      [task.id, JSON.stringify([{ id: "AC1", text: "left-pad is 2.0", source: { kind: "explicit", ref: "gen" } }])],
    );
    const generated = await getEngineeringTask(pool, task.id);
    assert.equal(persistedCriteriaOutcome(generated).to, "WAITING_FOR_APPROVAL");
    assert.throws(
      () =>
        assertProvisionable({
          status: "PROVISIONING",
          acceptance_criteria: generated.acceptanceCriteria,
          criteria_provenance: generated.criteriaProvenance,
          criteria_approved_at: generated.criteriaApprovedAt,
        }),
      /unapproved/,
    );
  });
});
