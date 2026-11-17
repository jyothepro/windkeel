/**
 * #388 end to end: a run's repair cycle becomes a lesson; a high-risk lesson waits for a person;
 * once accepted it is in the next run's maker prompt — and the next run is still verified.
 *
 * The same stack as `e2e-repair-loop` (real Postgres, the real workflow runtime, the real
 * verification engine over a fixture repository whose own `npm test` fails on a defect), with a
 * scripted worker. Run 1 writes a defect, the repository's check catches it, run 1 repairs it and
 * passes. Its repair packet names the failed check and its command, which makes the lesson high
 * risk: `suggested`, not injected. Accepted through the API, it appears in run 2's start prompt
 * with provenance, and run 2's VERIFYING stage runs and decides the verdict as it always does.
 */
import assert from "node:assert/strict";
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { ScriptedWorkerAdapter } from "../dist/worker/scripted.js";
import { getEngineeringRun, listVerificationRuns } from "../dist/factory/repositories.js";
import { createNote, listNotes, listRunKnowledge } from "../dist/factory/knowledge.js";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { createAndStartTask } from "./start-task.js";
import { bareFixtureRepo, repoRoot, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { startFactory } from "./factory-stack.js";
import { closeWorkflowRuntime, endExecutions, runtimeSkip } from "./workflow-runtime.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);
const REPO_ID = "11111111-1111-1111-1111-111111111111";
const TOKEN = "e2e-knowledge-token";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CRITERIA = [{ id: "ac-1", text: "`node index.js` prints the greeting and the farewell" }];
const CLEAN_REVIEW = { summary: "no defects found", findings: [] };
const CLEAN_MAPPING = {
  mappings: CRITERIA.map((c) => ({ criterion: c.id, status: "satisfied", evidence: ["ev-01"], reason: "the repo's own checks decide this one" })),
};
const CHECK_JS = `const { execFileSync } = require("node:child_process");
const out = execFileSync(process.execPath, ["index.js"], { encoding: "utf8" }).trim();
if (out !== "hello\\nbye") {
  console.error("expected 'hello\\\\nbye', got " + JSON.stringify(out));
  process.exit(1);
}
console.log("ok");
`;
const BASE_INDEX_JS = `console.log("hello");\n`;
const DEFECTIVE_INDEX_JS = `console.log("hello");\nconsole.log("goodbye");\n`;
const FIXED_INDEX_JS = `console.log("hello");\nconsole.log("bye");\n`;

const turn = (contents, patch, usage) => ({
  apply: async (sandbox) => sandbox.writeFile("index.js", contents),
  events: [
    { type: "started", sessionId: "scripted-thread-1" },
    { type: "file_changed", path: "index.js", kind: "update" },
    { type: "completed", usage },
  ],
  diff: { patch, filesChanged: ["index.js"], truncated: false },
  usage,
});

const PLACEHOLDER = new ScriptedWorkerAdapter([turn("", "", { inputTokens: 0, outputTokens: 0 })]);

/** Delegates to whichever scripted worker is current, and keeps every start prompt. */
class RecordingWorker {
  constructor() {
    this.inner = null;
    this.prompts = [];
  }
  // The stage wiring reads the adapter's name (and may read its capabilities) when the factory
  // starts (#395's harness registry), before any run has installed its scripted worker.
  get name() {
    return this.inner?.name ?? "scripted";
  }
  get capabilities() {
    return (this.inner ?? PLACEHOLDER).capabilities;
  }
  start(input) {
    this.prompts.push(input.prompt);
    return this.inner.start(input);
  }
  send(session, message) {
    return this.inner.send(session, message);
  }
  cancel(session) {
    return this.inner.cancel(session);
  }
  result(session) {
    return this.inner.result(session);
  }
  events(session) {
    return this.inner.events(session);
  }
}

class MemoryEvidenceStorage {
  constructor() {
    this.packages = new Map();
  }
  async putPackage(localDir, bucket, key) {
    const dest = tempDir("stored");
    cpSync(localDir, dest, { recursive: true });
    this.packages.set(`${bucket}/${key}`, dest);
  }
  async deletePackage(bucket, key) {
    this.packages.delete(`${bucket}/${key}`);
  }
}

function scripted(name, value) {
  const path = join(tempDir(name), `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

after(async () => {
  await closeWorkflowRuntime();
});

const SETTLED = ["PR_CREATING", "BLOCKED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED", "COMPLETED"];

async function waitSettled(pool, runId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getEngineeringRun(pool, runId);
    if (run && SETTLED.includes(run.status)) return run;
    await sleep(200);
  }
  throw new Error(`run ${runId} never settled`);
}

async function path(pool, runId) {
  const { rows } = await pool.query(
    "select from_state, to_state from run_state_transition where engineering_run_id = $1 order by at, id",
    [runId],
  );
  return rows.map((r) => `${r.from_state}->${r.to_state}`);
}

test("a repair cycle becomes a held lesson; accepted, it shapes the next run's maker — and the next run is still verified", { skip, timeout: 600_000 }, async () => {
  const schema = `windkeel_e2e_knowledge_${Date.now()}_${process.pid}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const schemaUrl = `${schemaDbUrl}${schemaDbUrl.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "node check.js" }, { "check.js": CHECK_JS, "index.js": BASE_INDEX_JS });
  const worker = new RecordingWorker();
  let stack;
  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    stack = await startFactory(
      {
        databaseUrl: schemaUrl,
        repository: { url: remote.bare, baseRevision: "HEAD" },
        makerModel: "gpt-5-codex",
        makerVendor: "openai",
        modelApiDomain: "api.openai.com",
        modelKeyEnvVar: "OPENAI_API_KEY",
        modelPricing: { usdPerInputToken: 0.000_001, usdPerOutputToken: 0.000_01 },
        usdPerCpuMs: 0,
        usdPerEgressByte: 0,
        railsCheckIntervalMs: 1_000,
        workspaceTtlMs: 600_000,
        gitHost: "github.com",
        gitAuthorName: "Windkeel Factory",
        gitAuthorEmail: "factory@windkeel.invalid",
        policyVersion: "knowledge-e2e",
        codex: { binary: "codex", pinnedVersion: "0.0.0-e2e", allowVersionDrift: false },
        evidence: undefined,
        checkerEndpoints: [],
      },
      { applicationSchema: schema, sandboxes: new FakeSandboxProvider(), worker },
    );
    stack.deps.config.fakeSecurity = join(repoRoot, "test", "fixtures", "no-scanners.json");
    stack.deps.config.checkerModels.fakes = { review: scripted("review", CLEAN_REVIEW), mapping: scripted("mapping", CLEAN_MAPPING) };
    stack.deps.evidence = { storage: new MemoryEvidenceStorage(), bucket: "evidence" };

    const start = () =>
      createAndStartTask({
        databaseUrl: schemaUrl,
        backing: "vercel-workflow",
        title: "Say goodbye too",
        description: "Add a farewell line to index.js. `node index.js` must print hello then bye.",
        criteria: CRITERIA,
        riskLevel: "low",
        repositoryId: REPO_ID,
      });

    // --- run 1: defect, caught, repaired ---------------------------------------------------
    worker.inner = new ScriptedWorkerAdapter([
      turn(DEFECTIVE_INDEX_JS, '+console.log("goodbye");\n', { inputTokens: 50, outputTokens: 10 }),
      turn(FIXED_INDEX_JS, '-console.log("goodbye");\n+console.log("bye");\n', { inputTokens: 5, outputTokens: 2 }),
    ]);
    const run1 = (await start()).engineeringRunId;
    await waitSettled(pool, run1);
    assert.ok((await path(pool, run1)).includes("VERIFYING->REPAIRING"), "run 1 needed a repair cycle");
    assert.ok(!worker.prompts[0].includes("check must pass"), "run 1 started knowing nothing of it");

    const orgId = (await pool.query("select id from organization where is_default")).rows[0].id;
    const learned = (await listNotes(pool, { organizationId: orgId, repositoryId: REPO_ID })).filter((n) => n.sourceKind === "verifier_finding");
    assert.ok(learned.length >= 1 && learned.length <= 5, `learned ${learned.length} lesson(s)`);
    const lesson = learned.find((n) => n.sourceRef.kind === "failed_check");
    assert.ok(lesson, "the failed check became a lesson");
    assert.equal(lesson.sourceRef.runId, run1);
    assert.equal(lesson.risk, "high", "it names a command and the verifier's check");
    assert.equal(lesson.status, "suggested", "so it waits for a person");

    // --- a person accepts it ---------------------------------------------------------------
    const deps = { pool, control: { wake: async () => {}, enqueue: async () => ({ enqueued: true }) } };
    const accepted = await handleApiRequest(deps, { token: TOKEN, subject: "reviewer" }, {
      method: "POST",
      path: `/v1/knowledge/${lesson.id}/status`,
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { action: "accept" },
    });
    assert.equal(accepted.status, 200);

    // --- run 2: the lesson is in the maker's prompt, and verification still gates ---------
    // A canary note too: it must reach run 2's maker and nothing on the verifier's side.
    const CANARY = "knowledge-canary-5d1f0c";
    await createNote(pool, { organizationId: orgId, repositoryId: REPO_ID, actor: "reviewer", title: `Canary ${CANARY}`, body: `Marker ${CANARY} for the boundary.` });
    worker.inner = new ScriptedWorkerAdapter([turn(FIXED_INDEX_JS, '+console.log("bye");\n', { inputTokens: 40, outputTokens: 8 })]);
    const promptsBefore = worker.prompts.length;
    const run2 = (await start()).engineeringRunId;
    await waitSettled(pool, run2);
    const prompt2 = worker.prompts[promptsBefore];
    assert.ok(prompt2.includes("## Repository knowledge"), prompt2);
    assert.ok(prompt2.includes(`### ${lesson.title}  (source: learned from run ${run1.slice(0, 8)}, accepted by reviewer, v2)`), prompt2);
    const snapshot = await listRunKnowledge(pool, run2);
    assert.ok(snapshot.some((e) => e.noteId === lesson.id && e.noteVersion === 2));

    const run2Path = await path(pool, run2);
    assert.ok(run2Path.includes("IMPLEMENTING->VERIFYING"), `run 2 was verified: ${run2Path.join(", ")}`);
    const verifications = await listVerificationRuns(pool, run2);
    assert.equal(verifications.length, 1);
    assert.equal(verifications[0].verdict, "pass", "decided by the repository's own check, as in run 1");

    // ADR-0032 behaviourally, not only by imports: the canary reached the maker, and neither the
    // verification record (stage results, criteria mapping, verdict) nor the sealed evidence
    // package nor any repair packet carries it, or the accepted lesson's text.
    assert.ok(prompt2.includes(CANARY), "the canary reached run 2's maker");
    const markers = [CANARY, lesson.body];
    const rows = await pool.query(
      `select row_to_json(v)::text as t from verification_run v where engineering_run_id = $1
       union all select row_to_json(r)::text from repair_attempt r where engineering_run_id = $1`,
      [run2],
    );
    for (const { t } of rows.rows) for (const m of markers) assert.ok(!t.includes(m), `a verifier-side row carries knowledge: ${m}`);
    const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    let files = 0;
    for (const dir of stack.deps.evidence.storage.packages.values()) {
      for (const file of walk(dir)) {
        files += 1;
        const text = readFileSync(file, "utf8");
        for (const m of markers) assert.ok(!text.includes(m), `evidence ${file} carries knowledge: ${m}`);
      }
    }
    assert.ok(files > 0, "an evidence package was stored to inspect");
  } finally {
    await endExecutions(pool).catch(() => {});
    if (stack) await stack.stop().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
});
