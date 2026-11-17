import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { FakeGitHubClient } from "../dist/github/fake.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { ScriptedWorkerAdapter } from "../dist/worker/scripted.js";
import { listVerificationRuns } from "../dist/factory/repositories.js";
import { createBatchNotifier } from "../dist/batches/notifier.js";
import { registerSourceNotifier, unregisterSourceNotifier } from "../dist/intake/notifiers.js";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { runEnqueuer } from "../apps/ingress/dist/src/windkeel-actions.js";
import { bareFixtureRepo, repoRoot, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { startFactory } from "./factory-stack.js";
import { closeWorkflowRuntime, endExecutions, runtimeSkip } from "./workflow-runtime.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * **#391 end to end: a batch multiplies verified runs, and never anything else.**
 *
 *     POST /v1/batches (3 repositories, maxConcurrency 2)
 *       → two child runs now, the third when one settles
 *       → each child implemented, verified in its own sandbox, repaired, and handed over
 *       → the batch settles PARTIAL with a roll-up equal to its children
 *
 * The real router, dispatcher, intake path, `VercelWorkflowProvider` on real Postgres and the
 * loopback workflow runtime, and the real stage handlers; the outside world replaced at the usual
 * three seams (ADR-0016): `FakeSandboxProvider` (a local clone), a scripted worker, and
 * `FakeGitHubClient`. The batch notifier is registered as the deployed flow function registers it
 * (`deployed-runner.ts`), so a settling child fills its slot through `advanceRun`.
 *
 * **No scripted verdicts.** Each fixture repository's own `npm test` decides: two repositories get
 * a defect then a fix (fail, repair, pass, draft pull request); the third gets the defect on every
 * turn, so its verifier never passes and the run stops at the repair cap. The batch has no say in
 * any of it.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);
const BOOTSTRAP = "e2e-batch-bootstrap";
const OWNER = "jyothepro";

const CRITERION = "`node index.js` prints the greeting and the farewell";
const CHECK_JS = `const { execFileSync } = require("node:child_process");
const out = execFileSync(process.execPath, ["index.js"], { encoding: "utf8" }).trim();
if (out !== "hello\\nbye") {
  console.error("expected 'hello\\\\nbye', got " + JSON.stringify(out));
  process.exit(1);
}
console.log("ok");
`;
const BASE = `console.log("hello");\n`;
const DEFECT = `console.log("hello");\nconsole.log("goodbye");\n`;
const FIX = `console.log("hello");\nconsole.log("bye");\n`;

function scripted(name, value) {
  const path = join(tempDir(name), `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const turn = (content, n) => ({
  apply: async (sandbox) => sandbox.writeFile("index.js", content),
  events: [
    { type: "started", sessionId: `scripted-thread-${n}` },
    { type: "file_changed", path: "index.js", kind: "update" },
    { type: "completed", usage: { inputTokens: 400, outputTokens: 80 } },
  ],
  diff: { patch: `+${content}`, filesChanged: ["index.js"], truncated: false },
  usage: { inputTokens: 400, outputTokens: 80 },
});

/**
 * One scripted session per child run, chosen by the repository the sandbox holds (`variant.txt`).
 * `ScriptedWorkerAdapter` keeps one session's state, and two children run at once, so each start
 * gets its own; every later call is routed by the session id this hands out.
 */
class PerRepositoryWorker {
  name = "scripted-per-repository";
  capabilities = { resumableSessions: true, reattachableSessions: false, reattachedSessionsAcceptNewTurns: false };
  sessions = new Map();
  started = [];
  #n = 0;

  async start(input) {
    const variant = (await input.sandbox.readFile("variant.txt")).toString("utf8").trim();
    const turns = variant === "never-passes" ? [1, 2, 3, 4, 5, 6].map((n) => turn(DEFECT, n)) : [turn(DEFECT, 1), turn(FIX, 2)];
    const inner = new ScriptedWorkerAdapter(turns);
    const innerSession = await inner.start(input);
    const id = `scripted-${++this.#n}`;
    this.sessions.set(id, { inner, innerSession });
    this.started.push(variant);
    return { id, workerSessionId: `thread-${id}` };
  }
  #route(session) {
    const s = this.sessions.get(session.id);
    if (!s) throw new Error(`no scripted session ${session.id}`);
    return s;
  }
  send(session, message) {
    const s = this.#route(session);
    return s.inner.send(s.innerSession, message);
  }
  events(session) {
    const s = this.#route(session);
    return s.inner.events(s.innerSession);
  }
  poll(session) {
    const s = this.#route(session);
    return s.inner.poll(s.innerSession);
  }
  cancel(session) {
    const s = this.#route(session);
    return s.inner.cancel(s.innerSession);
  }
  result(session) {
    const s = this.#route(session);
    return s.inner.result(s.innerSession);
  }
  reference() {
    return this.sessions.values().next().value.inner.reference();
  }
  attach() {
    return this.sessions.values().next().value.inner.attach();
  }
}

function defaultBranchOf(bare) {
  const result = spawnSync("git", ["--git-dir", bare, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" });
  return (result.stdout || "main").trim();
}

class MemoryEvidenceStorage {
  async putPackage() {}
  async deletePackage() {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, description, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`waitFor: ${description} never became true`);
}

after(async () => {
  await closeWorkflowRuntime();
});

test("a 3-repository batch at maxConcurrency 2: never more than 2 at once, every child verified, 2 draft PRs, 1 at the repair cap, PARTIAL", { skip, timeout: 600_000 }, async () => {
  const schema = `windkeel_batche2e_${Date.now()}_${process.pid}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const schemaUrl = `${schemaDbUrl}${schemaDbUrl.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  const pool = new Pool({ connectionString: schemaDbUrl, max: 6, idleTimeoutMillis: 1_000, options: `-c search_path=${schema}` });

  const fixtures = [
    { id: "a1111111-1111-4111-8111-111111111111", variant: "passes-after-repair" },
    { id: "b2222222-2222-4222-8222-222222222222", variant: "never-passes" },
    { id: "c3333333-3333-4333-8333-333333333333", variant: "passes-after-repair" },
  ].map((f) => ({
    ...f,
    name: `windkeel-fixture-${f.id.slice(0, 8)}`,
    remote: bareFixtureRepo({ test: "node check.js" }, { "check.js": CHECK_JS, "index.js": BASE, "variant.txt": `${f.variant}\n` }),
  }));
  const byName = new Map(fixtures.map((f) => [f.name, f]));
  const github = new FakeGitHubClient(
    {
      repositories: fixtures.map((f) => ({
        owner: OWNER,
        name: f.name,
        defaultBranch: defaultBranchOf(f.remote.bare),
        collaborators: { jyothepro: { permission: "admin", roleName: "admin" } },
      })),
    },
    {
      resolveBranchHead: (repository, branch) => {
        const f = byName.get(repository.name);
        if (!f) return null;
        const r = spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: f.remote.bare, encoding: "utf8" });
        return r.status === 0 ? r.stdout.trim() : null;
      },
    },
  );
  const worker = new PerRepositoryWorker();
  let factory;
  let sampler;
  const enqueue = runEnqueuer({ connectionString: schemaDbUrl, applicationSchema: schema, backing: "vercel-workflow" });
  try {
    for (const f of fixtures) await seedFixtureRepository(pool, { id: f.id, cloneUrl: f.remote.bare, defaultBranch: "HEAD" });

    factory = await startFactory(
      {
        databaseUrl: schemaUrl,
        repository: { url: fixtures[0].remote.bare, baseRevision: "HEAD" },
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
        policyVersion: "batch-e2e",
        codex: { binary: "codex", pinnedVersion: "0.0.0-e2e", allowVersionDrift: false },
        checkerEndpoints: [],
      },
      { applicationSchema: schema, sandboxes: new FakeSandboxProvider(), worker, github },
    );
    factory.deps.config.fakeSecurity = join(repoRoot, "test", "fixtures", "no-scanners.json");
    factory.deps.config.checkerModels.fakes = {
      review: scripted("review", { summary: "no defects found", findings: [] }),
      mapping: scripted("mapping", {
        mappings: [{ criterion: "AC1", status: "satisfied", evidence: ["ev-01"], reason: "the repo's own checks decide this one" }],
      }),
      criteria: scripted("criteria", { criteria: [{ text: CRITERION }] }),
    };
    factory.deps.evidence = { storage: new MemoryEvidenceStorage(), bucket: "evidence" };

    // As the deployed flow function does: a settling child dispatches its organization.
    registerSourceNotifier(createBatchNotifier(pool, { startRun: (runId) => enqueue.startRun(runId), log: () => {} }));

    // Never more than maxConcurrency children holding a slot, sampled throughout.
    let maxActive = 0;
    sampler = setInterval(async () => {
      try {
        const { rows } = await pool.query(
          `select count(*)::int as n from engineering_run r join engineering_task t on t.id = r.task_id
            where t.batch_id is not null
              and r.status not in ('COMPLETED', 'CANCELLED', 'FAILED', 'MAX_REPAIR_ATTEMPTS_REACHED', 'WAITING_FOR_HUMAN')`,
        );
        maxActive = Math.max(maxActive, rows[0].n);
      } catch {
        // The pool is closing at the end of the test.
      }
    }, 100);

    const deps = {
      pool,
      control: { enqueue: (runId) => enqueue.startRun(runId), cancel: async () => ({ outcome: "cancelled" }), listMessages: async () => [] },
    };
    const created = await handleApiRequest(deps, { token: BOOTSTRAP, subject: "e2e" }, {
      method: "POST",
      path: "/v1/batches",
      query: { get: () => undefined },
      headers: { authorization: `Bearer ${BOOTSTRAP}` },
      body: {
        kind: "multi_repo",
        title: "Say goodbye too",
        description: "Add a farewell line to index.js.",
        criteria: [CRITERION],
        repositories: fixtures.map((f) => f.id),
        maxConcurrency: 2,
        batchSpendCapUsd: 30,
        spendCapUsd: 10,
      },
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    assert.equal(created.body.started, 2, "exactly two children start at once");
    const batchId = created.body.batchId;
    assert.equal((await pool.query("select count(*)::int as n from engineering_run")).rows[0].n, 2);

    const settled = await waitFor(async () => {
      const { rows } = await pool.query("select status, stop_reason from batch where id = $1", [batchId]);
      return ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(rows[0].status) ? rows[0] : null;
    }, "the batch to settle");
    clearInterval(sampler);
    sampler = undefined;

    assert.equal(settled.status, "PARTIAL");
    assert.equal(settled.stop_reason, null);
    assert.ok(maxActive <= 2, `at most 2 children held a slot at once (saw ${maxActive})`);
    assert.ok(maxActive >= 1);

    const children = (
      await pool.query(
        `select r.id, r.status, r.final_verdict, r.pr_number, r.cost, r.created_at, t.repository_id, t.source_type, t.source_reference
           from engineering_run r join engineering_task t on t.id = r.task_id
          where t.batch_id = $1 order by t.source_reference`,
        [batchId],
      )
    ).rows;
    assert.equal(children.length, 3);
    const byRepo = new Map(children.map((c) => [c.repository_id, c]));
    const bad = byRepo.get(fixtures[1].id);
    assert.equal(bad.status, "MAX_REPAIR_ATTEMPTS_REACHED");
    assert.equal(bad.pr_number, null, "no pull request without a passing verdict");
    for (const f of [fixtures[0], fixtures[2]]) {
      const child = byRepo.get(f.id);
      assert.equal(child.status, "WAITING_FOR_HUMAN", f.variant);
      assert.equal(child.final_verdict, "pass");
      assert.ok(child.pr_number);
      const pulls = await github.listPullRequests({ repository: { owner: OWNER, name: f.name }, state: "all" });
      assert.equal(pulls.length, 1);
      assert.equal(pulls[0].draft, true, "draft: a batch never marks anything ready");
    }
    const otherPulls = await github.listPullRequests({ repository: { owner: OWNER, name: fixtures[1].name }, state: "all" });
    assert.equal(otherPulls.length, 0);

    // Every child went through its own verification; every pull request followed a passing one.
    for (const child of children) {
      const verifications = await listVerificationRuns(pool, child.id);
      assert.ok(verifications.length >= 1, `${child.source_reference}: verified in its own sandbox`);
      if (child.pr_number) {
        assert.deepEqual(verifications.map((v) => v.verdict), ["fail", "pass"], "caught by the repo's checks, repaired, re-verified");
      } else {
        assert.ok(verifications.every((v) => v.verdict === "fail"), "never passed, so never a pull request");
      }
    }

    // The third child was materialised only after one of the first two settled.
    const third = children.find((c) => c.source_reference.endsWith(":2"));
    const firstSettled = (
      await pool.query(
        `select min(t.at) as at from run_state_transition t
          where t.engineering_run_id = any($1) and t.to_state in ('WAITING_FOR_HUMAN', 'MAX_REPAIR_ATTEMPTS_REACHED', 'FAILED', 'COMPLETED', 'CANCELLED')`,
        [children.filter((c) => c !== third).map((c) => c.id)],
      )
    ).rows[0].at;
    assert.ok(third.created_at >= firstSettled, "the third run was created after a slot freed");

    // The roll-up is its children: cost is SUM(engineering_run.cost), verdicts are theirs.
    const detail = await handleApiRequest(deps, { token: BOOTSTRAP, subject: "e2e" }, {
      method: "GET",
      path: `/v1/batches/${batchId}`,
      query: { get: () => undefined },
      headers: { authorization: `Bearer ${BOOTSTRAP}` },
    });
    const sum = children.reduce((s, c) => s + Number(c.cost), 0);
    assert.ok(sum > 0, "the children spent something");
    assert.ok(Math.abs(detail.body.batch.progress.totalCostUsd - sum) < 1e-6);
    assert.equal(detail.body.batch.progress.succeeded, 2);
    assert.equal(detail.body.batch.progress.failed, 1);
    assert.deepEqual(detail.body.batch.progress.verdicts, { pass: 2, warn: 0, fail: 1, none: 0 });
    assert.equal(worker.started.length, 3);
  } finally {
    if (sampler) clearInterval(sampler);
    unregisterSourceNotifier("batch");
    await endExecutions(pool).catch(() => {});
    await factory?.stop().catch(() => {});
    await enqueue.stop().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
});
