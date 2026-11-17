import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { recordCost, sumCostEvents } from "../dist/factory/cost-ledger.js";
import { runMigrations } from "../dist/factory/migrate.js";
import {
  getEngineeringRun,
  getLastTransitionInto,
  insertEngineeringRun,
  insertEngineeringTask,
  insertVerificationRun,
  insertWorkspace,
  listVerificationRuns,
  listWorkspaces,
  updateVerificationRun,
} from "../dist/factory/repositories.js";
import { assembleRunReport } from "../dist/factory/run-report.js";
import { VercelWorkflowProvider } from "../dist/factory/workflow/vercel.js";
import { repoRoot, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { SPINE, stage } from "./workflow-conformance.js";
import {
  closeWorkflowRuntime,
  destroyWorldData,
  endExecutions,
  runtimeSkip,
  settle as settleBinding,
  workflowRuntime,
} from "./workflow-runtime.js";

/**
 * #194. ADR-0007 Decision §1 says the `EngineeringRun` row is the single authority and that
 * jobs are "transport and retry machinery, never truth." `src/factory/workflow/provider.ts`
 * restates it. Until this file existed, that claim was supported by *reading those comments* —
 * and the whole Vercel migration rests on it. If any run fact lived only in a pg-boss job row,
 * retiring pg-boss (#200) would silently destroy it, and the damage would surface much later as
 * a run that cannot be resumed or reported on.
 *
 * So the question this file answers is deliberately blunt: **if the orchestrator vanished right
 * now, what would be lost?** It vanishes for real here, and every answer is a failing assertion
 * or nothing.
 *
 * ## What "vanishes" means now, and the one way this proof got weaker (#200)
 *
 * It used to mean `drop schema <bossSchema> cascade`: pg-boss kept its journal in a schema in
 * *our* database, so the proof could destroy the real thing mid-run.
 *
 * Vercel Workflow's journal is not a schema we own. Production's lives in Vercel's queue and
 * storage and there is no statement this test could issue against it. So the destruction here is
 * of everything the orchestrator has that this process *can* reach:
 *
 * - **`world.clear()`** — the durable execution, its journal, its steps and its event log. In
 *   these suites that is `@workflow/world-local`, the real runtime over a local store.
 * - **`delete from workflow_run_binding`** — the row saying which execution carries the run.
 *   This one *is* ours, it *is* in the application schema, and it would survive the orchestrator
 *   entirely. A run fact hiding there would be invisible to the clause above.
 *
 * **Stated plainly: this is a weaker proof than the one it replaces**, and the weakening is not
 * recoverable — the schema that could be dropped no longer exists. What it still shows is that
 * no run fact lives in the journal or the binding, which is the claim ADR-0021 actually makes.
 * What it can no longer show is the same thing against production's journal, because nothing can.
 *
 * Three proofs, in order:
 *
 * 1. Destroying the execution and its binding does not destroy the run.
 * 2. A fresh provider over the same database resumes the run from where Postgres says it is.
 * 3. No domain read path touches the orchestrator — checked statically, with the limits of that
 *    check written down rather than assumed (see the comment on that test).
 *
 * Gated on TEST_DATABASE_URL and on the built workflow bundle, skipped cleanly when either is
 * missing, with a schema per case that is created and dropped here.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);

after(async () => {
  await closeWorkflowRuntime();
});

let schemaCounter = 0;
function nextSchemaSuffix() {
  return `${Date.now()}_${process.pid}_${schemaCounter++}`;
}

async function makeSchemas() {
  const suffix = nextSchemaSuffix();
  const appSchema = `windkeel_auth_${suffix}`;
  const setup = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await setup.query(`create schema ${appSchema}`);
  await setup.end();

  const pool = new Pool({
    connectionString: dbUrl,
    ...TEST_POOL,
    options: `-c search_path=${appSchema}`,
  });
  await runMigrations(pool, join(repoRoot, "migrations"));
  await seedFixtureRepository(pool);
  return { appSchema, pool };
}

/** A pool bound to `appSchema` and nothing else — no provider, no job schema on its path. */
function domainPool(appSchema) {
  return new Pool({
    connectionString: dbUrl,
    ...TEST_POOL,
    options: `-c search_path=${appSchema}`,
  });
}

async function dropSchema(name) {
  const teardown = new Pool({ connectionString: dbUrl, ...TEST_POOL });
  await teardown.query(`drop schema if exists ${name} cascade`);
  await teardown.end();
}

async function newProvider(appSchema) {
  const { world } = await workflowRuntime();
  return new VercelWorkflowProvider({
    connectionString: dbUrl,
    applicationSchema: appSchema,
    world,
    waitSleepMs: 2_000,
    retrySleepMs: 50,
  });
}

async function seedRun(pool) {
  const task = await insertEngineeringTask(pool, {
    repositoryId: "11111111-1111-1111-1111-111111111111",
    sourceType: "local",
    sourceReference: "postgres-authoritative",
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Quiescence, read from the binding row rather than from the provider.
 *
 * `RunStatus.inFlight` was pg-boss counting its own queued and active jobs. This backing has no
 * such counter — the execution is Vercel's — so the binding's `phase`, which the stage loop
 * writes about itself, is what says whether anything is runnable. `workflow-runtime.js` owns
 * that logic, and it is the same one the conformance suite uses.
 */
async function settle(pool, runId, timeoutMs = 30_000) {
  await settleBinding(pool, runId, timeoutMs);
}

function factHandlers() {
  return [
    ...SPINE,
    {
      state: "PROVISIONING",
      name: "provisions-and-bills",
      async handle(context) {
        const workspace = await insertWorkspace(context.pool, {
          engineeringRunId: context.engineeringRunId,
          role: "maker",
          sandboxProvider: "fake",
          providerHandle: "sbx-maker-194",
          repository: "jyothepro/windkeel-fixture",
          baseSha: "a".repeat(40),
          workingBranch: "windkeel/194",
          status: "active",
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        await recordCost(context.pool, {
          engineeringRunId: context.engineeringRunId,
          stageType: "workspace",
          stageId: workspace.id,
          kind: "sandbox",
          usd: 1.5,
        });
        return { kind: "transition", to: "IMPLEMENTING" };
      },
    },
    {
      state: "IMPLEMENTING",
      name: "verifies-and-stores-evidence",
      async handle(context) {
        const verification = await insertVerificationRun(context.pool, {
          engineeringRunId: context.engineeringRunId,
          candidateSha: "b".repeat(40),
          policyVersion: "1",
        });
        await updateVerificationRun(context.pool, verification.id, {
          verdict: "fail",
          evidencePackageRef: "windkeel-evidence/runs/194/package.tar.zst",
        });
        await recordCost(context.pool, {
          engineeringRunId: context.engineeringRunId,
          stageType: "verification_run",
          stageId: verification.id,
          kind: "model",
          tokensIn: 1000,
          tokensOut: 250,
          usd: 0.75,
        });
        // Park the run somewhere with a *return address*, so `blocked_from` is a real value
        // with something to lose rather than a null that survives trivially.
        return { kind: "transition", to: "BLOCKED", reason: "awaiting a human" };
      },
    },
  ];
}

/**
 * Every domain read path the issue names, read through the functions production reads through.
 * Called once before pg-boss is destroyed and once after; the two results must be equal.
 */
async function readEverything(pool, runId) {
  const run = await getEngineeringRun(pool, runId);
  const blockedFrom =
    run.status === "BLOCKED"
      ? (await getLastTransitionInto(pool, runId, "BLOCKED"))?.fromState ?? null
      : null;
  const { rows: transitionRows } = await pool.query(
    "select from_state, to_state, reason from run_state_transition where engineering_run_id = $1 order by at, id",
    [runId],
  );
  const { rows: costRows } = await pool.query(
    "select stage_type, kind, tokens_in, tokens_out, usd::text as usd from cost_event " +
      "where engineering_run_id = $1 order by recorded_at, id",
    [runId],
  );
  const workspaces = await listWorkspaces(pool, runId);
  const verifications = await listVerificationRuns(pool, runId);
  const report = await assembleRunReport(pool, runId);

  return {
    state: run.status,
    blockedFrom,
    stopReason: run.stopReason,
    cost: String(run.cost),
    transitions: transitionRows.map((r) => `${r.from_state}->${r.to_state}:${r.reason ?? ""}`),
    costEvents: costRows,
    costSum: await sumCostEvents(pool, runId),
    workspaces: workspaces.map((w) => ({
      role: w.role,
      provider: w.sandboxProvider,
      handle: w.providerHandle,
      status: w.status,
      branch: w.workingBranch,
    })),
    evidenceRefs: verifications.map((v) => v.evidencePackageRef),
    reportedEvidence: report.verifications.map((v) => ({
      state: v.evidence.state,
      ref: v.evidence.ref,
    })),
    reportedState: report.state,
    reportedCost: report.cost,
  };
}

test(
  "destroying the durable execution and its binding destroys no run fact",
  { skip },
  async () => {
    const { world } = await workflowRuntime();
    const { appSchema, pool } = await makeSchemas();
    const provider = await newProvider(appSchema);
    for (const handler of factHandlers()) {
      // The handlers above need a pool; `StageContext` deliberately is not a service locator,
      // so it is closed over here the way a real stage's deps are injected at construction.
      provider.register({ ...handler, handle: (ctx) => handler.handle({ ...ctx, pool }) });
    }
    await provider.start();

    try {
      const runId = await seedRun(pool);
      await provider.startRun(runId);
      await settle(pool, runId);

      const before = await readEverything(pool, runId);
      assert.equal(before.state, "BLOCKED", "the run is parked mid-spine, not finished");
      assert.equal(before.blockedFrom, "IMPLEMENTING", "BLOCKED's return address is recorded");
      assert.equal(before.workspaces.length, 1);
      assert.equal(before.evidenceRefs[0], "windkeel-evidence/runs/194/package.tar.zst");
      assert.equal(before.costSum, 2.25);

      // The orchestrator really was carrying this run, so its disappearance below is a loss of
      // something rather than a no-op dressed up as a proof.
      const { rows: bindingRows } = await pool.query(
        "select execution_handle from workflow_run_binding where engineering_run_id = $1",
        [runId],
      );
      assert.ok(bindingRows[0]?.execution_handle, "the run was actually carried by an execution");

      await endExecutions(pool);
      await provider.stop();

      // Everything the orchestrator had that this process can reach: the journal, and the row
      // that says which execution owns the run. See the file header on what this cannot reach.
      await destroyWorldData(world);
      await pool.query("delete from workflow_run_binding where engineering_run_id = $1", [runId]);

      // A pool that has never held a provider, to make the reconstruction unambiguous.
      const fresh = domainPool(appSchema);
      try {
        const after = await readEverything(fresh, runId);
        assert.deepEqual(
          after,
          before,
          "every run fact read before the orchestrator was destroyed reads identically after",
        );

        // The control, asserted rather than assumed: the binding really is gone. Without this
        // the assertion above could pass because nothing was destroyed.
        const { rows } = await fresh.query(
          "select count(*)::int as n from workflow_run_binding where engineering_run_id = $1",
          [runId],
        );
        assert.equal(rows[0].n, 0, "the binding is genuinely destroyed, not merely stale");
      } finally {
        await fresh.end();
      }
    } finally {
      await provider.stop().catch(() => {});
      await pool.end();
      await dropSchema(appSchema);
    }
  },
);

test(
  "a fresh provider over a destroyed execution resumes the run from the state Postgres records",
  { skip },
  async () => {
    const { world } = await workflowRuntime();
    const { appSchema, pool } = await makeSchemas();
    const first = await newProvider(appSchema);
    for (const handler of factHandlers()) {
      first.register({ ...handler, handle: (ctx) => handler.handle({ ...ctx, pool }) });
    }
    await first.start();

    let runId;
    try {
      runId = await seedRun(pool);
      await first.startRun(runId);
      await settle(pool, runId);
      assert.equal((await first.status(runId)).state, "BLOCKED");
      await endExecutions(pool);
    } finally {
      await first.stop();
    }

    // Everything the orchestrator knew is gone: the journal, the steps, the binding.
    await destroyWorldData(world);
    await pool.query("delete from workflow_run_binding where engineering_run_id = $1", [runId]);

    const second = await newProvider(appSchema);
    // BLOCKED -> IMPLEMENTING is legal only because the *transition log* remembers where the
    // run was blocked from (ADR-0003). A provider that resumed from CREATED would be asking
    // for an illegal move and would fail here rather than quietly restarting the run.
    second.register(stage("BLOCKED", "IMPLEMENTING", { name: "unblock" }));
    second.register(stage("IMPLEMENTING", "VERIFYING"));
    await second.start();

    try {
      const resumed = await second.startRun(runId);
      assert.equal(
        resumed.state,
        "BLOCKED",
        "the new provider reads where the run is from the row, not from an execution it never saw",
      );
      assert.notEqual(resumed.state, "CREATED");
      assert.equal(resumed.enqueued, true);

      await settle(pool, runId);
      assert.equal((await second.status(runId)).state, "VERIFYING");

      // The pre-existing history is still one continuous log, not a second run's.
      const { rows } = await pool.query(
        "select from_state, to_state from run_state_transition where engineering_run_id = $1 order by at, id",
        [runId],
      );
      assert.deepEqual(
        rows.map((r) => `${r.from_state}->${r.to_state}`),
        [
          "CREATED->CLASSIFYING",
          "CLASSIFYING->PLANNING",
          "PLANNING->PROVISIONING",
          "PROVISIONING->IMPLEMENTING",
          "IMPLEMENTING->BLOCKED",
          "BLOCKED->IMPLEMENTING",
          "IMPLEMENTING->VERIFYING",
        ],
      );

      // The facts written before the execution was destroyed are still the same facts.
      assert.equal((await listWorkspaces(pool, runId)).length, 1);
      assert.equal(await sumCostEvents(pool, runId), 2.25);
    } finally {
      await endExecutions(pool).catch(() => {});
      await second.stop();
      await pool.end();
      await dropSchema(appSchema);
    }
  },
);

// --- 3. no domain read path touches the orchestrator -----------------------------------------

const factoryDir = join(repoRoot, "src", "factory");
/**
 * The files allowed to know there is an orchestrator at all. `vercel.ts` is the provider,
 * `vercel-flow.ts` is the workflow module the SDK compiles, and `deployed-runner.ts` is what a
 * deployed step reaches for. Everything else under `src/factory` must be able to answer every
 * question from Postgres alone.
 */
const orchestratorFiles = new Set(
  ["vercel.ts", "vercel-flow.ts", "deployed-runner.ts"].map((name) =>
    join(factoryDir, "workflow", name),
  ),
);

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return name.endsWith(".ts") ? [p] : [];
  });
}

const rel = (p) => relative(repoRoot, p).split(sep).join("/");

/**
 * Comments and string literals removed, so the scan below reads *code*. This matters more
 * than it looks: `provider.ts`, `fake.ts` and half the handlers name pg-boss in prose,
 * because explaining the backing is the point of those comments. A scanner that counted
 * those would be permanently red and would be switched off within a week.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/** Every module specifier in an `import`/`export ... from` position, type-only included. */
function importedSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(
    /(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/g,
  )) {
    specifiers.push(match[1]);
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

test("no file under src/factory outside the provider names the orchestrator in code", () => {
  /**
   * The SDK's entry points and the identifiers that only exist because of it. Deliberately
   * broader than a package name: `workflow_run_binding` is a table we own and domain code may
   * read it, but `getRun`, `startRun` against the SDK, or a `World` are the orchestrator leaking
   * out of the three files that are allowed to hold it.
   */
  const forbidden = [
    /\bfrom\s+["']workflow["']/,
    /\bfrom\s+["']workflow\//,
    /\bfrom\s+["']@workflow\//,
    /\bWorkflowWorld\b/,
    /\bcreateWorld\b/,
  ];

  const offenders = [];
  for (const file of sourceFiles(factoryDir)) {
    if (orchestratorFiles.has(file)) continue;
    const code = codeOnly(readFileSync(file, "utf8"));
    for (const line of code.split("\n")) {
      if (forbidden.some((pattern) => pattern.test(line))) {
        offenders.push(`${rel(file)}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "ADR-0021 §1 keeps ADR-0007's rule: the orchestrator is transport, never truth. A domain " +
      "file that reaches into it is a run fact that changing backings would destroy.\n" +
      offenders.join("\n"),
  );
});

/**
 * **What this test can and cannot see, stated plainly, because a test that cannot see the
 * answer is worse than no test.**
 *
 * It *can* see: every relative import, transitively, from each read path named below, and
 * every third-party package those modules import. So the indirect-import mistake — a module
 * reading the job schema through an imported helper, invisible to a single-file grep — is
 * caught here. (A previous attempt at a "prove the ingress does not read X" test grepped one
 * directory for `process.env` and concluded a variable was unused; the ingress read it through
 * an imported helper. That is the mistake this closure exists to avoid.)
 *
 * It *cannot* see: a dynamic `import()` with a computed specifier, a module reached through
 * `require`, a raw SQL string assembled at runtime from a schema name that arrived as
 * configuration, or a call made through a function passed in as a parameter. None of those
 * exist in `src/factory/` today, and the test above (which reads code with strings blanked)
 * would not catch a schema name built from fragments either. If one is ever introduced, this
 * check will still pass and will be wrong — so the two tests are a pair, not a proof.
 */
test("the domain read paths do not reach the orchestrator, following imports", () => {
  const entryPoints = [
    "repositories.ts",
    "run-service.ts",
    "run-report.ts",
    "cost-ledger.ts",
    "workspace-service.ts",
    "evidence-retention.ts",
    "rails.ts",
    "rails-gate.ts",
    "run-state-machine.ts",
  ].map((name) => join(factoryDir, name));

  const seen = new Set();
  const externals = new Map();
  const queue = [...entryPoints];

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of importedSpecifiers(source)) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        if (!externals.has(specifier)) externals.set(specifier, []);
        externals.get(specifier).push(rel(file));
        continue;
      }
      // Source is `.ts`; ESM import specifiers carry `.js` (a repo convention).
      const resolved = join(file, "..", specifier.replace(/\.js$/, ".ts"));
      if (!statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`${rel(file)}: unresolvable import ${specifier} — this scan is blind here`);
      }
      queue.push(resolved);
    }
  }

  const reached = [...seen].filter((file) => orchestratorFiles.has(file));
  assert.deepEqual(
    reached.map(rel),
    [],
    `a domain read path imports the orchestrator, transitively:\n${[...seen].map(rel).join("\n")}`,
  );

  const sdkPackages = [...externals.keys()].filter(
    (name) => name === "workflow" || name.startsWith("workflow/") || name.startsWith("@workflow/"),
  );
  assert.deepEqual(
    sdkPackages,
    [],
    `a domain read path imports the Workflow SDK: ${sdkPackages
      .map((name) => `${name} (from ${externals.get(name).join(", ")})`)
      .join("; ")}`,
  );

  // A scan that silently found nothing would pass for the wrong reason. These two numbers say
  // the traversal actually walked the graph.
  assert.ok(seen.size >= entryPoints.length, "the traversal reached at least its entry points");
  assert.ok(seen.size > entryPoints.length, "the traversal followed imports beyond its roots");
});
