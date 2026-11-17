import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { FakeGitHubClient } from "../dist/github/fake.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { ScriptedWorkerAdapter } from "../dist/worker/scripted.js";
import {
  getEngineeringRun,
  getEngineeringTaskBySource,
  listAgentRuns,
  listRepairAttempts,
  listVerificationRuns,
  listWorkspaces,
} from "../dist/factory/repositories.js";
import { getRepositoryByFullName } from "../dist/factory/repository-entity.js";
import { runBranchFor } from "../dist/factory/workflow/branch.js";
import { stickyMarker } from "../dist/github/summary.js";
import { handleWebhook } from "../apps/ingress/dist/src/handler.js";
import { signWebhookBody } from "../apps/ingress/dist/src/signature.js";
import { windkeelActions, runEnqueuer } from "../apps/ingress/dist/src/windkeel-actions.js";
import { bareFixtureRepo, branchHeadsIn, repoRoot, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { startFactory } from "./factory-stack.js";
import { closeWorkflowRuntime, endExecutions, runtimeSkip } from "./workflow-runtime.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * **Milestone 6's success criterion, end to end:**
 *
 *     GitHub issue → Windkeel → implementation → verification → repair → verified draft PR
 *
 * Driven by a **signed webhook delivery** through the real ingress handler, the real
 * `VercelWorkflowProvider` against real Postgres and the real workflow runtime, and the real
 * stage handlers — the same code
 * paths a deployed system runs, with the outside world replaced at exactly three seams.
 *
 * **No scripted verdicts.** The fail and the pass both come from the engine observing the
 * repository: the fixture's own `npm test` runs `node check.js`, which executes `index.js` and
 * demands exact output. Turn one writes a defect and that check exits non-zero; turn two fixes
 * it. The review and mapping models are scripted *clean* and held constant across both cycles,
 * so they cannot be what flips the verdict.
 *
 * **The honesty caveat, carried forward from M4.7 and M5.6 and now with a third layer.** The
 * sandbox is `FakeSandboxProvider` (a real local clone in a temp directory, not an isolated
 * microVM), the worker is `ScriptedWorkerAdapter` (canned edits, not a coding agent), and the
 * GitHub side is `FakeGitHubClient` with locally-signed payloads (not a registered App talking to
 * github.com). What this proves is the *orchestration*: a signed delivery becomes a task, a run,
 * a defect, a repair, a second verification, a draft pull request, a check run, one sticky
 * comment, and a COMPLETED run — all durable on real Postgres. What it does not prove is a real
 * Vercel sandbox, a real `codex exec`, or a real GitHub App installation.
 * [#116](https://github.com/jyothepro/orqon/issues/116) remains where the live-stack proof lives,
 * and M6 is "code complete" rather than "done" for exactly that reason.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);
const SECRET = "webhook-secret-for-tests";
const OWNER = "jyothepro";
const NAME = "windkeel-fixture";
const REF = { owner: OWNER, name: NAME };

let counter = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scripted(name, value) {
  const path = join(tempDir(name), `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const CRITERIA_TEXT = "`node index.js` prints the greeting and the farewell";
const CLEAN_REVIEW = { summary: "no defects found", findings: [] };
const CLEAN_MAPPING = {
  mappings: [
    {
      criterion: "AC1",
      status: "satisfied",
      evidence: ["ev-01"],
      reason: "the repo's own checks decide this one",
    },
  ],
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

const turnEvents = (usage) => [
  { type: "started", sessionId: "scripted-thread-1" },
  { type: "file_changed", path: "index.js", kind: "update" },
  { type: "command_started", command: "npm test" },
  { type: "completed", usage },
];

function makeScriptedWorker() {
  return new ScriptedWorkerAdapter([
    {
      apply: async (sandbox) => sandbox.writeFile("index.js", DEFECTIVE_INDEX_JS),
      events: turnEvents({ inputTokens: 500, outputTokens: 100 }),
      diff: { patch: '+console.log("goodbye");\n', filesChanged: ["index.js"], truncated: false },
      usage: { inputTokens: 500, outputTokens: 100 },
    },
    {
      apply: async (sandbox) => sandbox.writeFile("index.js", FIXED_INDEX_JS),
      events: turnEvents({ inputTokens: 60, outputTokens: 20 }),
      diff: {
        patch: '-console.log("goodbye");\n+console.log("bye");\n',
        filesChanged: ["index.js"],
        truncated: false,
      },
      usage: { inputTokens: 60, outputTokens: 20 },
    },
  ]);
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

/** The branch the fixture repo actually has, rather than an assumption about git's default. */
function defaultBranchOf(bare) {
  const result = spawnSync("git", ["--git-dir", bare, "symbolic-ref", "--short", "HEAD"], {
    encoding: "utf8",
  });
  return (result.stdout || "main").trim();
}

/**
 * Trimmed from GitHub's documented `issues` payload, not invented: the fields the ingress reads,
 * in the shapes it reads them. `clone_url` points at the local bare repo because that is this
 * test's "GitHub" — everything downstream treats it as the repository's clone URL, which is
 * exactly the substitution ADR-0016 asks for.
 */
function issuePayload(remote, { action = "labeled", body, state = "open" } = {}) {
  return {
    action,
    installation: { id: 42 },
    sender: { login: "jyothepro" },
    label: { name: "windkeel" },
    repository: {
      name: NAME,
      full_name: `${OWNER}/${NAME}`,
      owner: { login: OWNER },
      default_branch: defaultBranchOf(remote.bare),
      clone_url: remote.bare,
      fork: false,
    },
    issue: {
      number: 7,
      title: "Say goodbye too",
      state,
      locked: false,
      body:
        body ??
        `Add a farewell line to index.js.\n\n- [ ] ${CRITERIA_TEXT}\n`,
      labels: [{ name: "windkeel" }],
      html_url: `https://github.com/${OWNER}/${NAME}/issues/7`,
      user: { login: "jyothepro" },
    },
  };
}

function commentPayload(remote, body) {
  return {
    action: "created",
    installation: { id: 42 },
    sender: { login: "jyothepro" },
    repository: issuePayload(remote).repository,
    issue: issuePayload(remote).issue,
    comment: { body, user: { login: "jyothepro" }, author_association: "OWNER" },
  };
}

function pullClosedPayload(remote, pullNumber, { merged = true } = {}) {
  const repository = issuePayload(remote).repository;
  return {
    action: "closed",
    installation: { id: 42 },
    sender: { login: "jyothepro" },
    repository,
    pull_request: {
      number: pullNumber,
      merged,
      merged_at: merged ? "2026-09-06T13:00:00Z" : null,
      head: { ref: "windkeel/whatever", repo: { full_name: repository.full_name, fork: false } },
      base: { repo: { full_name: repository.full_name } },
    },
  };
}

function delivery(event, payload, id) {
  const rawBody = JSON.stringify(payload);
  return {
    headers: {
      "x-github-event": event,
      "x-github-delivery": id,
      "x-hub-signature-256": signWebhookBody(SECRET, rawBody),
    },
    rawBody,
  };
}

after(async () => {
  await closeWorkflowRuntime();
});

async function withStack(fn) {
  const suffix = `${Date.now()}_${process.pid}_${counter++}`;
  const schema = `windkeel_m6e2e_${suffix}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const schemaUrl = `${schemaDbUrl}${schemaDbUrl.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo(
    { test: "node check.js" },
    { "check.js": CHECK_JS, "index.js": BASE_INDEX_JS },
  );

  const github = new FakeGitHubClient({
    repositories: [
      {
        owner: OWNER,
        name: NAME,
        defaultBranch: defaultBranchOf(remote.bare),
        issues: [{ number: 7, title: "Say goodbye too", labels: ["windkeel"] }],
        // The commenter who approves: `/windkeel` commands are authorised on GitHub's answer.
        collaborators: { jyothepro: { permission: "admin", roleName: "admin" } },
      },
    ],
  }, { resolveBranchHead: branchHeadsIn(remote.bare) });

  const storage = new MemoryEvidenceStorage();
  const stacks = [];
  const makeFactory = async (adapter, options = {}) => {
    const stack = await startFactory(
      {
        databaseUrl: schemaUrl,
        // Only the fallback for local tasks now (ADR-0018); this run resolves its repository
        // from the row the webhook created.
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
        policyVersion: "m6-e2e",
        // Unread here — a `WorkerAdapter` is injected below, so no Codex adapter is built — but
        // `WorkerConfig` is a complete shape and this literal is not type-checked. The other two
        // e2e suites carry the same field for the same reason (#164).
        codex: { binary: "codex", pinnedVersion: "0.0.0-e2e", allowVersionDrift: false },
        checkerEndpoints: [],
      },
      {
        applicationSchema: schema,
        sandboxes: options.sandboxes ?? new FakeSandboxProvider(),
        worker: adapter,
        github,
      },
    );
    stack.deps.config.fakeSecurity = join(repoRoot, "test", "fixtures", "no-scanners.json");
    stack.deps.config.checkerModels.fakes = {
      review: scripted("review", CLEAN_REVIEW),
      mapping: scripted("mapping", CLEAN_MAPPING),
      criteria: scripted("criteria", {
        criteria: [{ text: CRITERIA_TEXT }],
      }),
    };
    stack.deps.evidence = { storage, bucket: "evidence" };
    stacks.push(stack);
    return stack;
  };

  /**
   * The ingress's own enqueuer, on the same backing. It publishes no stage runner — see
   * `runEnqueuer` — so this is genuinely the producer half, exactly as ADR-0002 §3 requires and
   * ADR-0020 preserves.
   */
  const enqueue = runEnqueuer({
    connectionString: schemaDbUrl,
    applicationSchema: schema,
    backing: "vercel-workflow",
  });
  const actions = windkeelActions({ github, enqueue });
  const post = (event, payload, id) =>
    handleWebhook(delivery(event, payload, id), { secret: SECRET, pool, actions, permissions: github });

  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    await fn({ pool, remote, github, storage, makeFactory, post, enqueue });
  } finally {
    await endExecutions(pool).catch(() => {});
    for (const stack of stacks) await stack.stop().catch(() => {});
    await enqueue.stop().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

async function waitFor(fn, description, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`waitFor: ${description} never became true`);
}

async function runFor(pool, repositoryId) {
  const task = await getEngineeringTaskBySource(
    pool,
    repositoryId,
    "github_issue",
    `${OWNER}/${NAME}#7`,
  );
  if (!task) return null;
  const { rows } = await pool.query("select id from engineering_run where task_id = $1", [task.id]);
  return rows[0] ? { taskId: task.id, runId: rows[0].id } : null;
}

const SETTLED = ["WAITING_FOR_HUMAN", "COMPLETED", "BLOCKED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED"];

test(
  "a labelled issue becomes a verified draft pull request, and a merge completes the run",
  { skip },
  async () => {
    await withStack(async ({ pool, remote, github, makeFactory, post }) => {
      const adapter = makeScriptedWorker();
      await makeFactory(adapter);

      // --- the trigger: one signed delivery ------------------------------------------------
      const response = await post("issues", issuePayload(remote), "delivery-label-1");
      assert.equal(response.status, 200);
      assert.equal(response.body.intent, "create_task");

      const repository = await getRepositoryByFullName(pool, OWNER, NAME);
      assert.ok(repository, "the delivery created the repository row (ADR-0018)");

      const ids = await waitFor(() => runFor(pool, repository.id), "a run to exist");
      const { runId, taskId } = ids;

      const run = await waitFor(async () => {
        const current = await getEngineeringRun(pool, runId);
        return current && SETTLED.includes(current.status) ? current : null;
      }, "the run to settle");

      assert.equal(run.status, "WAITING_FOR_HUMAN", "the happy path ends with a human");
      assert.equal(run.finalVerdict, "pass");
      assert.equal(run.stopReason, null);
      assert.ok(run.prNumber, "the pull request number is recorded");

      // --- the defect was caught by the repository, and repaired ---------------------------
      const verifications = await listVerificationRuns(pool, runId);
      assert.equal(verifications.length, 2);
      assert.equal(verifications[0].verdict, "fail");
      assert.equal(verifications[1].verdict, "pass");
      assert.notEqual(verifications[0].candidateSha, verifications[1].candidateSha);

      const attempts = await listRepairAttempts(pool, runId);
      assert.equal(attempts.length, 1);
      assert.deepEqual(
        attempts[0].repairPacket.failed_checks.map((c) => c.check),
        ["tests"],
        "the packet names the repo's own failing check, from a real non-zero exit",
      );
      const agentRuns = await listAgentRuns(pool, runId);
      assert.ok(agentRuns.some((a) => a.role === "repairer"), "a repairer ran");

      // --- the task came from the issue ----------------------------------------------------
      const { rows: taskRows } = await pool.query(
        "select source_type, source_reference, criteria_provenance from engineering_task where id = $1",
        [taskId],
      );
      assert.equal(taskRows[0].source_type, "github_issue");
      assert.equal(taskRows[0].source_reference, `${OWNER}/${NAME}#7`);
      assert.equal(taskRows[0].criteria_provenance, "extracted", "the author's own checklist");

      // --- the GitHub surface --------------------------------------------------------------
      const pulls = await github.listPullRequests({ repository: REF, state: "all" });
      assert.equal(pulls.length, 1, "exactly one draft pull request");
      assert.equal(pulls[0].draft, true);
      assert.equal(pulls[0].headRef, runBranchFor(runId, { sourceType: "github_issue", sourceReference: `${OWNER}/${NAME}#7`, title: "Say goodbye too" }));
      assert.match(pulls[0].body, /WINDKEEL RESULT/);
      assert.match(pulls[0].body, /Resolves #7/);

      const stickies = github.commentsOn(REF, pulls[0].number);
      assert.equal(stickies.length, 1, "one sticky comment, whatever happened during the run");
      assert.ok(stickies[0].body.startsWith(stickyMarker(runId)));

      const checkRuns = github.calls.filter((c) => c.type === "createCheckRun");
      assert.equal(checkRuns.length, 1, "the check run is published on the candidate of record");
      assert.equal(checkRuns[0].input.headSha, verifications[1].candidateSha);
      assert.equal(checkRuns[0].input.conclusion, "success");

      // ADR-0009 §4: the issue hears at run start and at the terminal state, and nowhere else.
      const issueComments = github.commentsOn(REF, 7);
      assert.equal(issueComments.length, 2, `expected start + PR, got ${issueComments.length}`);
      assert.match(issueComments[0].body, /Windkeel is on it/);
      assert.match(issueComments[1].body, /Draft pull request/);

      // --- ADR-0014 §2: the verifier never held a write-capable credential -----------------
      const mints = github.calls.filter((c) => c.type === "mintInstallationToken");
      assert.ok(mints.length >= 2, "a token per workspace");
      const workspaces = await listWorkspaces(pool, runId);
      const verifierWorkspaces = workspaces.filter((w) => w.role === "verifier");
      assert.ok(verifierWorkspaces.length >= 1);
      const writeMints = mints.filter((m) => m.input.permissions.contents === "write");
      const readMints = mints.filter((m) => m.input.permissions.contents === "read");
      assert.equal(writeMints.length + readMints.length, mints.length, "only contents scopes");
      assert.equal(readMints.length, verifierWorkspaces.length, "one read token per verifier");

      // --- every sandbox is gone -----------------------------------------------------------
      for (const workspace of workspaces) {
        assert.ok(
          ["destroyed", "teardown_failed"].includes(workspace.status),
          `workspace ${workspace.id} is ${workspace.status}`,
        );
      }

      // --- the human merges ----------------------------------------------------------------
      // Whenever they like: no waiting for the run's sleep to be journalled first. A merge that
      // lands while the run is still parking is the provider's job to deliver (#279), and the
      // two cases at the bottom of this file open those windows deliberately.
      const merged = await post(
        "pull_request",
        pullClosedPayload(remote, run.prNumber),
        "delivery-merged-1",
      );
      assert.equal(merged.status, 200);

      const completed = await waitFor(async () => {
        const current = await getEngineeringRun(pool, runId);
        return current?.status === "COMPLETED" ? current : null;
      }, "the run to complete after the merge");
      assert.ok(completed.prMergedAt, "pr_merged_at is recorded for ADR-0013's metrics");

      // Nothing was duplicated by the second delivery.
      assert.equal((await github.listPullRequests({ repository: REF, state: "all" })).length, 1);
      assert.equal(github.commentsOn(REF, pulls[0].number).length, 1);

      // --- #393 8A: the audit trail proves the merge followed a passing verification -------
      const { rows: trail } = await pool.query(
        `select action, actor_kind, detail from audit_event where target_type = 'run' and target_id = $1 order by seq`,
        [runId],
      );
      assert.deepEqual(trail.map((e) => e.action), ["run.verification_failed", "run.verified", "run.merged"]);
      assert.equal(trail[0].detail.verificationRunId, verifications[0].id);
      assert.equal(trail[1].detail.verificationRunId, verifications[1].id);
      assert.equal(trail[1].detail.candidateSha, verifications[1].candidateSha);
      assert.equal(trail[1].actor_kind, "system");
      assert.deepEqual([trail[2].actor_kind, trail[2].detail.via], ["github", "github"]);
      const { verifyAuditChain } = await import("../dist/factory/audit-log.js");
      const accountId = (await pool.query("select id from account where is_default")).rows[0].id;
      assert.equal((await verifyAuditChain(pool, accountId)).ok, true);
    });
  },
);

test(
  "an issue with no criteria holds for approval, spends nothing, then runs on /windkeel approve",
  { skip },
  async () => {
    await withStack(async ({ pool, remote, github, makeFactory, post }) => {
      const sandboxes = new FakeSandboxProvider();
      const creates = [];
      const countingSandboxes = {
        name: "counting",
        capabilities: sandboxes.capabilities,
        create: (options) => {
          creates.push(options.role);
          return sandboxes.create(options);
        },
      };
      await makeFactory(makeScriptedWorker(), { sandboxes: countingSandboxes });

      // An issue that says what it wants in prose, with no checklist at all.
      await post(
        "issues",
        issuePayload(remote, { body: "The farewell is missing. Please add it." }),
        "delivery-label-2",
      );

      const repository = await getRepositoryByFullName(pool, OWNER, NAME);
      const { runId, taskId } = await waitFor(() => runFor(pool, repository.id), "a run to exist");

      await waitFor(async () => {
        const current = await getEngineeringRun(pool, runId);
        return current?.status === "WAITING_FOR_APPROVAL" ? current : null;
      }, "the run to hold at the approval gate");

      // ADR-0012's whole promise: a misread costs nothing before a human sees it.
      assert.deepEqual(creates, [], "no sandbox exists for an unapproved run");
      const { rows: costs } = await pool.query(
        "select coalesce(sum(usd), 0)::float as spent from cost_event where engineering_run_id = $1",
        [runId],
      );
      assert.equal(costs[0].spent, 0, "and nothing has been spent");

      const { rows: taskRows } = await pool.query(
        "select criteria_provenance, criteria_approved_at from engineering_task where id = $1",
        [taskId],
      );
      assert.equal(taskRows[0].criteria_provenance, "generated");
      assert.equal(taskRows[0].criteria_approved_at, null);

      const gateComment = github
        .commentsOn(REF, 7)
        .find((c) => /approval needed before anything runs/i.test(c.body));
      assert.ok(gateComment, "the criteria were posted for a human to approve");

      // --- the human approves ---------------------------------------------------------------
      const approved = await post(
        "issue_comment",
        commentPayload(remote, "/windkeel approve"),
        "delivery-approve-1",
      );
      assert.equal(approved.status, 200);

      const settled = await waitFor(async () => {
        const current = await getEngineeringRun(pool, runId);
        return current && SETTLED.includes(current.status) ? current : null;
      }, "the approved run to settle");

      assert.equal(settled.status, "WAITING_FOR_HUMAN");
      assert.ok(creates.length > 0, "and only now is a sandbox created");
      const { rows: approvedRows } = await pool.query(
        "select criteria_approved_by, criteria_approved_at from engineering_task where id = $1",
        [taskId],
      );
      assert.equal(approvedRows[0].criteria_approved_by, "jyothepro");
      assert.ok(approvedRows[0].criteria_approved_at, "who approved, and when, from rows alone");

      const pulls = await github.listPullRequests({ repository: REF, state: "all" });
      assert.equal(pulls.length, 1, "a draft PR after approval");
    });
  },
);

test(
  "the stage host dying mid-run and a fresh one taking over duplicates nothing",
  { skip },
  async () => {
    await withStack(async ({ pool, remote, github, makeFactory, post }) => {
      const first = await makeFactory(makeScriptedWorker());

      await post("issues", issuePayload(remote), "delivery-label-3");
      const repository = await getRepositoryByFullName(pool, OWNER, NAME);
      const { runId } = await waitFor(() => runFor(pool, repository.id), "a run to exist");

      /**
       * **The interruption point is deliberate, and it moved.**
       *
       * It used to be "before the maker is provisioned", chosen to avoid ADR-0017's limitation
       * that a restart between VERIFYING and REPAIRING ended the run at FAILED.
       *
       * On ADR-0021's backing that spot is not reachable on purpose. The intake stages run back
       * to back inside one durable execution, so a poll asking for CLASSIFYING or PLANNING is
       * racing them — and it reliably lands *inside* PROVISIONING, between the workspace row
       * being inserted and the sandbox handle being recorded. Resuming there is correctly a
       * visible failure rather than a retry: `workspace-service.ts` writes `providerHandle` and
       * `ready` together after `create()` returns, so a row with a null handle means nobody
       * knows whether a sandbox exists, and provisioning a second one might double-spend.
       *
       * So the interruption now happens at the **stage boundary that matters for this case's
       * invariant**: once a verification has *passed*, with the run about to open a pull
       * request. Everything this test asserts against duplication — one pull request, one check
       * run, one sticky comment — happens after that point, so it is the interruption most
       * likely to catch a double. That is deterministic, and it is
       * squarely inside what the system promises — the sandbox handle is recorded, the candidate
       * is committed, the verdict is durable, and a fresh process has to carry the run to a pull
       * request without doing anything twice.
       *
       * Earlier interruptions are deliberately not tested here, and the reasons are about the
       * test doubles rather than the system. This suite's `makeScriptedWorker` is a two-turn
       * script — turn one writes a defect, turn two repairs it — and a fresh
       * `ScriptedWorkerAdapter` starts again at turn one, so interrupting before the repair makes
       * the resumed run replay the defect and stop at `produced no new candidate`. That measures
       * the double, not the factory.
       *
       * The resume properties that *are* the system's get asserted where a real double exists
       * for them: re-acquiring a sandbox by identity and resuming a repair turn from a persisted
       * `WorkerSessionRef` are both covered by `e2e-repair-loop`.
       */
      await waitFor(async () => {
        const { rows } = await pool.query(
          "select id from verification_run where engineering_run_id = $1 " +
            "and completed_at is not null and verdict = 'pass'",
          [runId],
        );
        return rows[0] ?? null;
      }, "a verification to pass, with the pull request still to come");

      await first.stop();

      const second = await makeFactory(makeScriptedWorker());
      await second.provider.startRun(runId);

      const settled = await waitFor(async () => {
        const current = await getEngineeringRun(pool, runId);
        return current && SETTLED.includes(current.status) ? current : null;
      }, "the resumed run to settle");
      assert.equal(settled.status, "WAITING_FOR_HUMAN", "the run resumed and finished");

      assert.equal(
        (await github.listPullRequests({ repository: REF, state: "all" })).length,
        1,
        "one pull request across the restart",
      );
      assert.equal(
        github.commentsOn(REF, settled.prNumber).length,
        1,
        "one sticky comment across the restart",
      );
      const { rows } = await pool.query(
        "select count(*)::int as n from engineering_task where source_type = 'github_issue'",
      );
      assert.equal(rows[0].n, 1, "one task");
    });
  },
);

/**
 * **#279: a merge that lands while the run is parking is not lost.**
 *
 * A parked run sleeps `WAIT_SLEEP_MS` — 300 s, because the *ingress* starts the execution and so
 * the production value applies here, not `factory-stack.js`'s 2 s — and `signal()` interrupts
 * that sleep with `wakeUp()`. There are two windows in which the signal row is written but there
 * is no sleep yet to interrupt, and before #279 both cost the full 300 s, which is past this
 * suite's two-minute wait:
 *
 * 1. the stage handler has already taken its signals and is about to return `wait`;
 * 2. the handler has returned `wait` and the binding says `waiting`, but the loop has not yet
 *    journalled its `sleep` — `wakeUp()` then finds no open wait, completes nothing, and
 *    returns `{ stoppedCount: 0 }` without error.
 *
 * These are what the first case above hit under full-suite load. Its merge is sent a few dozen
 * milliseconds after the run is seen at `WAITING_FOR_HUMAN`, and how long the run takes to get
 * from there to a journalled sleep grows with how busy the machine is. #359's `untilAsleep`
 * stopped the test sending into the window; this closes the window, so the test no longer waits.
 *
 * Both windows are opened on purpose here, by wrapping the real `WAITING_FOR_HUMAN` handler, so
 * everything else is the stack the first case uses. Each fails deterministically without its half
 * of the fix. The wait for completion is 20 s: anything that depends on the 300 s sleep fails it,
 * and the woken path takes milliseconds.
 */
async function parkedMergeCase({ pool, remote, makeFactory, post }, deliveryId, onFirstWait) {
  const stack = await makeFactory(makeScriptedWorker());
  // `handlers` is the provider's registration map; replacing one entry keeps every other stage real.
  const handlers = stack.provider.handlers;
  const real = handlers.get("WAITING_FOR_HUMAN");
  let fired = null;
  handlers.set("WAITING_FOR_HUMAN", {
    ...real,
    async handle(context) {
      const outcome = await real.handle(context);
      if (outcome.kind === "wait" && !fired) {
        const run = await getEngineeringRun(pool, context.engineeringRunId);
        const merge = () =>
          post("pull_request", pullClosedPayload(remote, run.prNumber), `${deliveryId}-merged`);
        fired = onFirstWait({ runId: context.engineeringRunId, merge, provider: stack.provider });
        await fired.inside;
      }
      return outcome;
    },
  });

  await post("issues", issuePayload(remote), `${deliveryId}-label`);
  const repository = await getRepositoryByFullName(pool, OWNER, NAME);
  const { runId } = await waitFor(() => runFor(pool, repository.id), "a run to exist");

  await waitFor(() => fired?.response, "the run to park at WAITING_FOR_HUMAN, and the merge to be sent");
  const response = await fired.response;
  assert.equal(response.status, 200);
  assert.equal(response.body.intent, "pr_closed");

  const completed = await waitFor(
    async () => {
      const current = await getEngineeringRun(pool, runId);
      return current?.status === "COMPLETED" ? current : null;
    },
    "the run to complete after a merge that landed while it was parking",
    20_000,
  );
  assert.ok(completed.prMergedAt);
}

test(
  "a merge that arrives after the parked stage took its signals is still observed (#279)",
  { skip },
  async () => {
    await withStack(async (ctx) => {
      await parkedMergeCase(ctx, "delivery-race-a", ({ merge }) => {
        // Inside the handler, after `takeSignals()` found nothing: the merge is written and its
        // wake attempted before the stage returns `wait`.
        const response = merge();
        return { inside: response, response };
      });
    });
  },
);

test(
  "a merge that arrives once the binding says waiting, before the sleep exists, is still observed (#279)",
  { skip },
  async () => {
    await withStack(async (ctx) => {
      await parkedMergeCase(ctx, "delivery-race-b", ({ runId, merge, provider }) => {
        /**
         * The window opened on demand rather than left to scheduling. `arrivedSince` is the last
         * thing the tick does before it returns `wait`: by then the binding says `waiting`, and
         * the step has not returned, so the journal cannot hold the sleep yet. The merge lands
         * exactly there — after the check, before the sleep — and the step is held until its
         * row is written, so `wakeUp()` is guaranteed to find nothing to complete.
         */
        let response;
        const check = provider.arrivedSince.bind(provider);
        provider.arrivedSince = async (...args) => {
          const found = await check(...args);
          provider.arrivedSince = check;
          response = merge();
          await waitFor(async () => {
            const { rows } = await ctx.pool.query(
              "select 1 from run_signal where engineering_run_id = $1",
              [runId],
            );
            return rows.length > 0;
          }, "the merge's signal row", 20_000);
          return found;
        };
        return { inside: Promise.resolve(), get response() { return response; } };
      });
    });
  },
);
