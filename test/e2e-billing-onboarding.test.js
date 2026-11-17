/**
 * #394 end to end, against real Postgres and the real workflow runtime, with fakes for everything
 * outside (FakeSandboxProvider, ScriptedWorkerAdapter, FakeBillingProvider, a fake installation
 * verifier) — the pattern of `e2e-repair-loop.test.js`.
 *
 * 1. **Fresh signup to a verdict, then a bill.** Invite → signup → link the App installation → the
 *    repository is the new organization's → a task through the ordinary intake → the independent
 *    verifier's verdict → ledger rows → the sweep debits each line once from the trial's credits
 *    (#431), the receipt equals the debits, nothing is sent to the meter (no overage) → a budget
 *    below what was spent refuses the next task.
 * 2. **The budget runs out mid-run.** The verification already under way finishes and its fail
 *    verdict stands; no repair turn starts; the run stops `org_budget`; nothing moves toward a PR.
 *
 * The same honesty caveat as M5's: the sandbox is a local clone, the worker is scripted. This proves
 * the orchestration and the accounting, not a real microVM or a real Stripe.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { ScriptedWorkerAdapter } from "../dist/worker/scripted.js";
import { getEngineeringRun, listAgentRuns, listVerificationRuns } from "../dist/factory/repositories.js";
import { FakeBillingProvider } from "../dist/billing/fake.js";
import { OrganizationBudgetExhaustedError, setBudget } from "../dist/billing/budget.js";
import { createInstallState, createSelfServeAccount, createSignupInvite, linkInstallation } from "../dist/billing/onboarding.js";
import { reportPendingUsage } from "../dist/billing/report.js";
import { getOrganizationUsage, periodContaining } from "../dist/billing/usage.js";
import { getCreditBalance } from "../dist/billing/credit-ledger.js";
import { runReceipt } from "../dist/billing/receipt.js";
import { fakeInstallationVerifier } from "../dist/github/installation-verifier.js";
import { createAndStartTask } from "./start-task.js";
import { bareFixtureRepo, repoRoot, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { startFactory } from "./factory-stack.js";
import { closeWorkflowRuntime, endExecutions, runtimeSkip } from "./workflow-runtime.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);
const REPO_ID = "44444444-4444-4444-4444-444444444444";
const INSTALLATION = 90210;
let counter = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CRITERIA = [{ id: "ac-1", text: "`node index.js` prints the greeting and the farewell" }];
const CLEAN_REVIEW = { summary: "no defects found", findings: [] };
const CLEAN_MAPPING = {
  mappings: CRITERIA.map((c) => ({ criterion: c.id, status: "satisfied", evidence: ["ev-01"], reason: "the repo's own checks decide" })),
};
const CHECK_JS = `const { execFileSync } = require("node:child_process");
const out = execFileSync(process.execPath, ["index.js"], { encoding: "utf8" }).trim();
if (out !== "hello\\nbye") { console.error("got " + JSON.stringify(out)); process.exit(1); }
console.log("ok");
`;
const turn = (contents, usage) => ({
  apply: async (sandbox) => sandbox.writeFile("index.js", contents),
  events: [
    { type: "started", sessionId: "scripted-billing" },
    { type: "file_changed", path: "index.js", kind: "update" },
    { type: "completed", usage },
  ],
  diff: { patch: "+console.log(...)\n", filesChanged: ["index.js"], truncated: false },
  usage,
});
const FIXED = `console.log("hello");\nconsole.log("bye");\n`;
const DEFECTIVE = `console.log("hello");\nconsole.log("goodbye");\n`;

function scripted(name, value) {
  const path = join(tempDir(name), `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

class MemoryEvidenceStorage {
  constructor() {
    this.packages = new Map();
  }
  async putPackage(localDir, bucket, key) {
    const { cpSync } = await import("node:fs");
    const dest = tempDir("stored");
    cpSync(localDir, dest, { recursive: true });
    this.packages.set(`${bucket}/${key}`, dest);
  }
  async deletePackage(bucket, key) {
    this.packages.delete(`${bucket}/${key}`);
  }
}

/** A fake sandbox provider that tells the test when a verifier sandbox is made — verification has begun. */
class WatchedSandboxes extends FakeSandboxProvider {
  constructor(onVerifier) {
    super();
    this.onVerifier = onVerifier;
  }
  async create(options) {
    if (options.role === "verifier" && this.onVerifier) await this.onVerifier();
    return super.create(options);
  }
}

after(async () => {
  await closeWorkflowRuntime();
});

async function withStack(fn) {
  const schema = `windkeel_billing_e2e_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const schemaUrl = `${schemaDbUrl}${schemaDbUrl.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "node check.js" }, { "check.js": CHECK_JS, "index.js": `console.log("hello");\n` });
  const stacks = [];
  const makeFactory = async (adapter, sandboxes) => {
    const stack = await startFactory(
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
        policyVersion: "billing-e2e",
        codex: { binary: "codex", pinnedVersion: "0.0.0-e2e", allowVersionDrift: false },
        evidence: undefined,
        checkerEndpoints: [],
      },
      { applicationSchema: schema, sandboxes, worker: adapter },
    );
    stack.deps.config.fakeSecurity = join(repoRoot, "test", "fixtures", "no-scanners.json");
    stack.deps.config.checkerModels.fakes = { review: scripted("review", CLEAN_REVIEW), mapping: scripted("mapping", CLEAN_MAPPING) };
    stack.deps.evidence = { storage: new MemoryEvidenceStorage(), bucket: "evidence" };
    stacks.push(stack);
    return stack;
  };
  try {
    await fn({ pool, schemaUrl, remote, makeFactory });
  } finally {
    await endExecutions(pool).catch(() => {});
    for (const stack of stacks) await stack.stop().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

/** Signup, then the App installed on a repository and linked: the repository is the new organization's. */
async function onboard(pool, remote) {
  const { code } = await createSignupInvite(pool, { note: "e2e" });
  const created = await createSelfServeAccount(pool, {
    claims: { provider: "supabase", subject: "sub-e2e", githubUserId: 31337, githubLogin: "newcomer", displayName: "newcomer" },
    inviteCode: code,
    organizationName: "Newcomer Inc",
    plan: "managed",
    mode: "invite",
    provider: "fake",
  });
  await pool.query(
    `insert into repository (id, owner, name, default_branch, clone_url, github_installation_id)
     values ($1, 'newcomer', 'widgets', 'HEAD', $2, $3)`,
    [REPO_ID, remote.bare, INSTALLATION],
  );
  const { state } = await createInstallState(pool, { organizationId: created.organizationId, principalId: created.principalId });
  const linked = await linkInstallation(pool, {
    state,
    installationId: INSTALLATION,
    code: "oauth-code",
    principalId: created.principalId,
    verifier: fakeInstallationVerifier({ "oauth-code": [INSTALLATION] }),
  });
  assert.equal(linked.granted, 1);
  return created;
}

const startTask = (schemaUrl, description = "Add a farewell line to index.js. `node index.js` must print hello then bye.") =>
  createAndStartTask({
    databaseUrl: schemaUrl,
    title: "Say goodbye too",
    description,
    criteria: CRITERIA,
    riskLevel: "low",
    repositoryId: REPO_ID,
  });

async function settle(pool, runId, timeoutMs = 120_000) {
  const done = ["PR_CREATING", "BLOCKED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED", "COMPLETED", "CANCELLED", "PR_READY"];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getEngineeringRun(pool, runId);
    if (run && done.includes(run.status) && run.status !== "PR_CREATING") return run;
    await sleep(200);
  }
  throw new Error(`run ${runId} never settled`);
}

const transitions = async (pool, runId) =>
  (await pool.query("select from_state, to_state from run_state_transition where engineering_run_id = $1 order by at, id", [runId])).rows.map(
    (r) => `${r.from_state}->${r.to_state}`,
  );

test("a fresh signup's first task reaches a verdict through the verifier, and is billed exactly once", { skip, timeout: 300_000 }, async () => {
  await withStack(async ({ pool, schemaUrl, remote, makeFactory }) => {
    const owner = await onboard(pool, remote);
    await seedFixtureRepository(pool); // the operator's fixture, untouched by any of this
    await makeFactory(new ScriptedWorkerAdapter([turn(FIXED, { inputTokens: 500, outputTokens: 100 })]), new FakeSandboxProvider());

    const created = await startTask(schemaUrl);
    const { rows: task } = await pool.query("select organization_id from engineering_task where id = $1", [created.taskId]);
    assert.equal(task[0].organization_id, owner.organizationId, "the task is the new organization's, by the installation's grant");

    const run = await settle(pool, created.engineeringRunId);
    assert.equal(run.finalVerdict, "pass");
    assert.ok((await transitions(pool, run.id)).includes("VERIFYING->PR_CREATING"), "the verified candidate goes toward its PR");
    const [verification] = await listVerificationRuns(pool, run.id);
    assert.equal(verification.verdict, "pass", "the verdict is the independent verifier's");

    // The bill is the ledger.
    const { rows: ledger } = await pool.query("select count(*)::int as n, coalesce(sum(usd), 0) as usd from cost_event where engineering_run_id = $1", [run.id]);
    assert.ok(ledger[0].n > 0);
    const provider = new FakeBillingProvider();
    const later = new Date(Date.now() + 120_000);
    const usage = await getOrganizationUsage(pool, owner.organizationId, periodContaining(later));
    assert.ok(usage.billable.totalMicroUsd > 0);
    // #431: a new account is on credits, so the run is paid from the trial: every ledger line is
    // debited once, the receipt is those debits, and the meter is sent nothing (no overage).
    const before = await runReceipt(pool, run.id);
    assert.ok(before.totals.totalMicro > 0, "sandbox minutes and Windkeel-key tokens cost credits");
    assert.ok(before.compute.some((c) => c.role === "verifier"), "verification is metered, never waived");
    const first = await reportPendingUsage({ pool, provider, now: later });
    assert.equal(first.reports.filter((r) => r.organizationId === owner.organizationId).length, 0, "nothing past the trial: nothing metered");
    const { rows: debits } = await pool.query(
      "select count(*)::int as n, coalesce(sum(amount_micro), 0)::bigint as micro from credit_debit where engineering_run_id = $1",
      [run.id],
    );
    assert.equal(debits[0].n, ledger[0].n, "one debit per cost line");
    const receipt = await runReceipt(pool, run.id);
    assert.equal(receipt.settled, true);
    assert.equal(receipt.totals.totalMicro, Number(debits[0].micro), "the receipt totals equal the ledger debits");
    assert.equal(receipt.totals.totalMicro, before.totals.totalMicro, "and equal what it showed before the sweep");
    const balance = await getCreditBalance(pool, owner.accountId, later);
    assert.equal(balance.topups[0].source, "trial");
    assert.equal(balance.topups[0].leftMicro, 500_000_000 - receipt.totals.totalMicro);
    assert.equal((await reportPendingUsage({ pool, provider, now: later })).debitsWritten, 0, "a second sweep debits nothing");

    // A budget below what was spent refuses the next task, by name.
    await setBudget(pool, owner.organizationId, { monthlyLimitUsd: usage.billable.totalUsd / 2 }, owner.principalId);
    await assert.rejects(startTask(schemaUrl), OrganizationBudgetExhaustedError);
  });
});

test("the budget running out mid-run: the verification finishes, its verdict stands, no repair, org_budget", { skip, timeout: 300_000 }, async () => {
  await withStack(async ({ pool, schemaUrl, remote, makeFactory }) => {
    const owner = await onboard(pool, remote);
    await setBudget(pool, owner.organizationId, { monthlyLimitUsd: 20 }, owner.principalId);
    // The moment verification begins, the month's budget is gone (a limit of 0).
    const sandboxes = new WatchedSandboxes(async () => {
      await setBudget(pool, owner.organizationId, { monthlyLimitUsd: 0 }, owner.principalId);
    });
    const adapter = new ScriptedWorkerAdapter([
      turn(DEFECTIVE, { inputTokens: 500, outputTokens: 100 }),
      turn(FIXED, { inputTokens: 60, outputTokens: 20 }),
    ]);
    await makeFactory(adapter, sandboxes);

    const created = await startTask(schemaUrl);
    const run = await settle(pool, created.engineeringRunId);
    assert.equal(run.status, "FAILED");
    assert.equal(run.stopReason, "org_budget");

    const verifications = await listVerificationRuns(pool, run.id);
    assert.equal(verifications.length, 1, "the verification under way when the budget ran out");
    assert.equal(verifications[0].verdict, "fail", "finished, with the verifier's own verdict");
    assert.ok(verifications[0].completedAt, "and completed, not skipped");
    assert.equal(adapter.turnsTaken, 1, "no repair turn was spent");
    assert.ok(!(await listAgentRuns(pool, run.id)).some((a) => a.role === "repairer"));
    const path = await transitions(pool, run.id);
    assert.ok(!path.some((p) => p.endsWith("PR_CREATING") || p.endsWith("PR_READY")), `nothing toward a PR: ${path.join(", ")}`);
    assert.ok(path.includes("VERIFYING->FAILED"), path.join(", "));
  });
});

test("the budget running out mid-verification never changes a pass: the verdict stands and goes toward its PR", { skip, timeout: 300_000 }, async () => {
  await withStack(async ({ pool, schemaUrl, remote, makeFactory }) => {
    const owner = await onboard(pool, remote);
    await setBudget(pool, owner.organizationId, { monthlyLimitUsd: 20 }, owner.principalId);
    // The moment verification begins, the month's budget is gone (a limit of 0).
    const sandboxes = new WatchedSandboxes(async () => {
      await setBudget(pool, owner.organizationId, { monthlyLimitUsd: 0 }, owner.principalId);
    });
    await makeFactory(new ScriptedWorkerAdapter([turn(FIXED, { inputTokens: 500, outputTokens: 100 })]), sandboxes);

    const created = await startTask(schemaUrl);
    const run = await settle(pool, created.engineeringRunId);
    const [verification] = await listVerificationRuns(pool, run.id);
    assert.equal(verification.verdict, "pass", "the verifier's verdict, untouched by billing");
    assert.equal(run.finalVerdict, "pass");
    assert.notEqual(run.stopReason, "org_budget", "a spent budget does not stop a verified pass");
    const path = await transitions(pool, run.id);
    assert.ok(path.includes("VERIFYING->PR_CREATING"), path.join(", "));
    // And the next run is refused: the budget blocks new work, not the verdict.
    await assert.rejects(startTask(schemaUrl), OrganizationBudgetExhaustedError);
  });
});
