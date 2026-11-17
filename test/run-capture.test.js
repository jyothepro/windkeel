import assert from "node:assert/strict";
import { mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../dist/factory/migrate.js";
import {
  insertEngineeringRun,
  insertEngineeringTask,
  insertWorkspace,
} from "../dist/factory/repositories.js";
import { saveSessionBinding } from "../dist/factory/workflow/session-binding.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { captureRun } from "../dist/factory/run-capture.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";

/**
 * #252's secondary objective, and the reason it is an API route rather than a note in a runbook.
 *
 * The agent's own transcript exists in exactly one place — a scratch directory inside the maker
 * sandbox — and the reaper deletes that on a schedule. #116 asked four questions about the JSONL
 * shape and was closed before anyone pulled a real log out to answer them.
 *
 * So what these tests hold is not "it copies files". It is that **every way this can come up
 * empty says which way it was**: a reaped sandbox, a released session, a provider this
 * environment cannot reach. An operator running it after the fact needs to know whether to go
 * looking or give up, and a generic failure answers neither.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let counter = 0;
const cleanup = [];

async function makeSchema() {
  const schema = `windkeel_capture_${Date.now()}_${process.pid}_${counter++}`;
  const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await setup.query(`create schema ${schema}`);
  await setup.end();
  const pool = new Pool({
    connectionString: dbUrl,
    ...TEST_POOL,
    options: `-c search_path=${schema}`,
  });
  await runMigrations(pool, join(repoRoot, "migrations"));
  await seedFixtureRepository(pool);
  return { schema, pool, url: `${dbUrl}?options=-c%20search_path%3D${schema}` };
}

async function dropSchema(schema) {
  const teardown = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await teardown.query(`drop schema if exists ${schema} cascade`);
  await teardown.end();
}

async function seedRun(pool, reference) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "local",
    sourceReference: reference,
    title: "t",
    description: "d",
    acceptanceCriteria: [],
    riskLevel: "low",
    priority: null,
    status: "OPEN",
  });
  const run = await insertEngineeringRun(pool, {
    taskId: task.id,
    spendCapUsd: 25,
    wallClockCapSeconds: 7200,
  });
  return run.id;
}

/**
 * A sandbox with a scratch directory in it, the way a live maker has one.
 *
 * `FakeSandboxProvider.attach` derives the sandbox root from the handle id alone, so creating
 * that directory is the whole of "the sandbox still exists" — and *not* creating it is the whole
 * of "the reaper got there first", which is the case worth asserting.
 */
function makeSandbox(files) {
  const handleId = `capture-${Math.random().toString(36).slice(2, 10)}`;
  const root = join(tmpdir(), `windkeel-fake-sandbox-${handleId}`);
  const scratchDir = join(root, "scratch");
  mkdirSync(scratchDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(scratchDir, name), contents);
  }
  cleanup.push(root);
  return { handleId, scratchDir };
}

async function seedSession(pool, runId, handleId, scratchDir, turn = 1) {
  await insertWorkspace(pool, {
    engineeringRunId: runId,
    role: "maker",
    sandboxProvider: "fake",
    providerHandle: handleId,
    repository: "r",
    baseSha: "a".repeat(40),
    workingBranch: null,
    status: "ready",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  await saveSessionBinding(pool, runId, {
    workerType: "codex",
    sessionRef: {
      id: "session-1",
      workerType: "codex",
      workerSessionId: "codex-abc",
      adapterState: { scratchDir, turn, watermark: 42 },
    },
    resumable: true,
  });
}

function outDir() {
  const dir = mkdtempSync(join(tmpdir(), "windkeel-capture-out-"));
  cleanup.push(dir);
  return dir;
}

const providers = { fake: new FakeSandboxProvider() };

test("captures the agent transcript out of a live sandbox", { skip }, async (t) => {
  const { schema, pool, url } = await makeSchema();
  t.after(async () => {
    await pool.end();
    await dropSchema(schema);
  });

  const runId = await seedRun(pool, "capture-live");
  const jsonl = '{"type":"thread.started","session_id":"codex-abc"}\n{"type":"turn.completed"}\n';
  const { handleId, scratchDir } = makeSandbox({
    "turn-1.events.jsonl": jsonl,
    "turn-1.stderr.log": "warning: something\n",
    "turn-1.exit-status": "0\n",
    "workspace.diff": "diff --git a/x b/x\n",
  });
  await seedSession(pool, runId, handleId, scratchDir);

  const out = outDir();
  const report = await captureRun({ pool, runId, out, providers });

  assert.equal(report.kind, "captured");
  assert.equal(report.files.filter((f) => f.written).length, 4);
  assert.equal(readFileSync(join(out, "sandbox", "turn-1.events.jsonl"), "utf8"), jsonl);
  assert.equal(readFileSync(join(out, "sandbox", "workspace.diff"), "utf8"), "diff --git a/x b/x\n");

  // The reference is what makes the transcript interpretable afterwards: which turn it is, and
  // which codex session it belongs to. Without it a JSONL file is a log with no provenance.
  const ref = JSON.parse(readFileSync(join(out, "session-ref.json"), "utf8"));
  assert.equal(ref.engineeringRunId, runId);
  assert.equal(ref.workerSessionId, "codex-abc");
  assert.equal(ref.adapterState.turn, 1);
});

test("captures every turn, not only the one the reference names", { skip }, async (t) => {
  const { schema, pool, url } = await makeSchema();
  t.after(async () => {
    await pool.end();
    await dropSchema(schema);
  });

  const runId = await seedRun(pool, "capture-turns");
  const { handleId, scratchDir } = makeSandbox({
    "turn-1.events.jsonl": "one\n",
    "turn-2.events.jsonl": "two\n",
    "turn-3.events.jsonl": "three\n",
  });
  // The binding records turn 2 — a run still moving writes files the reference has not caught
  // up with, and a repair loop's turns are the whole point of capturing it.
  await seedSession(pool, runId, handleId, scratchDir, 2);

  const out = outDir();
  await captureRun({ pool, runId, out, providers });

  assert.equal(readFileSync(join(out, "sandbox", "turn-3.events.jsonl"), "utf8"), "three\n");
});

test("a file past the cap is named and left in place, never truncated", { skip }, async (t) => {
  const { schema, pool, url } = await makeSchema();
  t.after(async () => {
    await pool.end();
    await dropSchema(schema);
  });

  const runId = await seedRun(pool, "capture-cap");
  const { handleId, scratchDir } = makeSandbox({
    "turn-1.events.jsonl": "x".repeat(200),
    "turn-1.exit-status": "0\n",
  });
  await seedSession(pool, runId, handleId, scratchDir);

  const out = outDir();
  const report = await captureRun({ pool, runId, out, providers, maxBytes: 100 });

  // A half-transcript that looks whole is worse than an absent one: a fixture built from it
  // would encode a torn last line as if Codex had emitted it.
  assert.equal(existsSync(join(out, "sandbox", "turn-1.events.jsonl")), false);
  const skipped = report.files.find((f) => f.path === "turn-1.events.jsonl");
  assert.equal(skipped.written, false, "past the cap: named, not written");
  assert.ok(!skipped.escaped);
  assert.equal(report.maxBytes, 100);
  assert.equal(readFileSync(join(out, "sandbox", "turn-1.exit-status"), "utf8"), "0\n");
});

test("a path that escapes the capture directory is refused, not written", { skip }, async (t) => {
  const { schema, pool, url } = await makeSchema();
  t.after(async () => {
    await pool.end();
    await dropSchema(schema);
  });

  const runId = await seedRun(pool, "capture-escape");
  const { handleId, scratchDir } = makeSandbox({ "turn-1.events.jsonl": "safe\n" });
  await seedSession(pool, runId, handleId, scratchDir);

  const out = outDir();
  const escapee = join(out, "..", "windkeel-capture-escaped.txt");
  rmSync(escapee, { force: true });
  rmSync(join(out, "windkeel-capture-beside.txt"), { force: true });

  /**
   * The listing comes from inside the sandbox, which is where an agent has a shell. A `..` in a
   * path would make the copy write onto the operator's own machine, outside the directory they
   * named. Nothing observed has produced one; this is the guard that keeps it that way.
   */
  const provider = {
    capabilities: { ...providers.fake.capabilities },
    attach: async () => ({
      id: handleId,
      role: "maker",
      listFiles: async () => [
        { path: "turn-1.events.jsonl", bytes: 5 },
        // Out of the capture directory entirely, onto the operator's machine.
        { path: "../../windkeel-capture-escaped.txt", bytes: 9 },
        // Only out of the sandbox mirror. Still refused: a captured file belongs under the
        // mirror of the scratch directory or nowhere, and `session-ref.json` lives up there.
        { path: "../windkeel-capture-beside.txt", bytes: 9 },
      ],
      readFile: async () => Buffer.from("escaped!\n"),
    }),
  };

  const report = await captureRun({ pool, runId, out, providers: { fake: provider } });

  assert.equal(existsSync(escapee), false, "nothing is written outside the capture directory");
  assert.equal(existsSync(join(out, "windkeel-capture-beside.txt")), false);
  const refused = report.files.filter((f) => f.escaped).map((f) => f.path).sort();
  assert.deepEqual(refused, ["../../windkeel-capture-escaped.txt", "../windkeel-capture-beside.txt"]);
  // And the well-behaved sibling in the same listing is still captured.
  assert.equal(existsSync(join(out, "sandbox", "turn-1.events.jsonl")), true);
});

test("a reaped sandbox is reported as gone, not as an obscure failure", { skip }, async (t) => {
  const { schema, pool, url } = await makeSchema();
  t.after(async () => {
    await pool.end();
    await dropSchema(schema);
  });

  const runId = await seedRun(pool, "capture-reaped");
  const { handleId, scratchDir } = makeSandbox({ "turn-1.events.jsonl": "gone\n" });
  await seedSession(pool, runId, handleId, scratchDir);
  rmSync(join(tmpdir(), `windkeel-fake-sandbox-${handleId}`), { recursive: true, force: true });

  const out = outDir();
  const report = await captureRun({ pool, runId, out, providers });

  assert.equal(report.kind, "unavailable");
  assert.match(report.reason, /could not attach/);
  assert.match(report.reason, /reaped sandbox/);
  assert.equal(existsSync(join(out, "session-ref.json")), false);
});

test("a run that released its session says so rather than reporting nothing found", { skip }, async (t) => {
  const { schema, pool, url } = await makeSchema();
  t.after(async () => {
    await pool.end();
    await dropSchema(schema);
  });

  const runId = await seedRun(pool, "capture-no-binding");
  const out = outDir();
  const report = await captureRun({ pool, runId, out, providers });

  assert.equal(report.kind, "unavailable");
  assert.match(report.reason, /no worker session binding/);
  assert.match(report.reason, /released it/);
});

test("a provider this environment cannot reach names the credentials it needs", { skip }, async (t) => {
  const { schema, pool, url } = await makeSchema();
  t.after(async () => {
    await pool.end();
    await dropSchema(schema);
  });

  const runId = await seedRun(pool, "capture-no-provider");
  const { handleId, scratchDir } = makeSandbox({ "turn-1.events.jsonl": "x\n" });
  await seedSession(pool, runId, handleId, scratchDir);
  await pool.query("update workspace set sandbox_provider = 'vercel' where engineering_run_id = $1", [runId]);

  const out = outDir();
  const report = await captureRun({ pool, runId, out, providers });

  assert.equal(report.kind, "unavailable");
  assert.match(report.reason, /"vercel" provider, which is not configured/);
  assert.match(report.reason, /WINDKEEL_SANDBOX_TOKEN/);
});

test.after(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});
