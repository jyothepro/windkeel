import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { FakeGitHubClient } from "../dist/github/fake.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { ScriptedWorkerAdapter } from "../dist/worker/scripted.js";
import { getEngineeringRun } from "../dist/factory/repositories.js";
import { registerDeploymentNotifiers } from "../dist/factory/workflow/deployment-notifiers.js";
import { runIntake, wireResponse } from "../dist/intake/pipeline.js";
import { createSlackIntakeSource } from "../dist/intake/slack.js";
import { createLinearIntakeSource } from "../dist/intake/linear.js";
import { createWebhookIntakeSource, signWebhookPayload } from "../dist/intake/webhook.js";
import { createJiraIntakeSource } from "../dist/integrations/jira-intake.js";
import { createSentryIntakeSource, signSentryWebhook } from "../dist/integrations/sentry.js";
import { putSentryCredential } from "../dist/integrations/sentry-credential.js";
import { generateSecretKeyPair } from "../dist/factory/secret-box.js";
import { signJiraWebhookJwt } from "../dist/integrations/jira.js";
import { adfToText } from "../dist/integrations/adf.js";
import { addRoute, createConnection } from "../dist/integrations/connections.js";
import { FakeProviderTokenSource } from "../dist/integrations/token-source.js";
import { fakeConnectForwardVerifier } from "../dist/integrations/vercel-connect.js";
import { createSchedule } from "../dist/schedules/store.js";
import { fireDueSchedules, slotKey } from "../dist/schedules/tick.js";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { handleWebhook } from "../apps/ingress/dist/src/handler.js";
import { signWebhookBody } from "../apps/ingress/dist/src/signature.js";
import { windkeelActions, runEnqueuer } from "../apps/ingress/dist/src/windkeel-actions.js";
import { bareFixtureRepo, branchHeadsIn, FIXTURE_REPOSITORY_ID, redirectPushes, repoRoot, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { startFactory } from "./factory-stack.js";
import { closeWorkflowRuntime, endExecutions, runtimeSkip } from "./workflow-runtime.js";
import { fakeSlack } from "./slack-fakes.js";
import { FakeJira } from "./jira-fake.js";
import { FakeSentry } from "./sentry-fake.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * **Milestone 8's success criterion, end to end** (#302): every new intake reaches a verified draft
 * pull request, and the source that asked hears back.
 *
 *     Slack / Linear / Jira / Sentry / signed webhook / POST /v1/tasks / schedule
 *       → intake pipeline (verify → parse → ledger + task + run, one transaction)
 *       → workflow stages (real handlers, real VercelWorkflowProvider, real Postgres)
 *       → verified draft PR
 *       → the source's notifier (Slack thread, Linear comment, Jira ADF comment)
 *
 * The model is `e2e-github-loop.test.js`, and the honesty caveat is the same one, one layer wider:
 * the sandbox is `FakeSandboxProvider`, the worker is `ScriptedWorkerAdapter`, GitHub is
 * `FakeGitHubClient`, and now Vercel Connect (`fakeConnectForwardVerifier`,
 * `FakeProviderTokenSource`), Slack (`fakeSlack`), Linear (a recording `fetch`) and Jira
 * (`FakeJira`) are fakes too. No test reaches the network: the one `fetch` the notifiers get
 * answers those three hosts and throws for anything else. What this proves is the orchestration
 * from each front door to a pull request and back; the live checklist on #302 is where the real
 * providers are exercised.
 *
 * Every case also asserts the M6 intake contract where it is observable: the `intake_delivery`
 * ledger (ignored deliveries included, each with its reason), duplicates answered without a second
 * task, and the task's actor — always an organization principal of kind `token` (a system actor
 * or a service principal), never a person (ADR-0024 §2).
 *
 * The repository row's clone URL is a real `https://github.com/...` URL — that is what makes the
 * notifiers' pull-request links real links (`pullRequestUrl`) — and the sandbox provider maps that
 * one URL onto the local bare fixture repository, the substitution ADR-0016 asks for.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);
const GITHUB_SECRET = "webhook-secret-for-tests";
const OWNER = "jyothepro";
const NAME = `windkeel-fixture-${FIXTURE_REPOSITORY_ID.slice(0, 8)}`;
const REF = { owner: OWNER, name: NAME };
const CLONE_URL = `https://github.com/${OWNER}/${NAME}.git`;
const CONSOLE_URL = "https://console.windkeel.test";
const OIDC = "test-connect-oidc";
const SLACK_TEAM = "T0WINDKEEL1";
const SLACK_CHANNEL = "C0MAPPED1";
const LINEAR_ORG = "7c3a1f0e-2b4d-4e6f-9a8b-1c2d3e4f5a6b";
const JIRA_CLOUD = "cloud-acme";
const JIRA_SECRET = "atlassian-client-secret";
const WEBHOOK_SIGNING_KEY = "test-signing-key-0123456789abcdef0123456789abcdef";
const BOOTSTRAP = "test-bootstrap-token";
const SENTRY_UUID = "7a485448-a9e2-4c85-8a3c-4f44175783c9";
const SENTRY_SECRET = "sentry-client-secret-for-tests";
const SENTRY_TOKEN = "sntrys_fake_token_0123456789";

// The notifiers read the console URL per call, as a deployment's flow function does.
process.env.WINDKEEL_CONSOLE_URL = CONSOLE_URL;

const prUrl = (number) => `https://github.com/${OWNER}/${NAME}/pull/${number}`;

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
  mappings: [{ criterion: "AC1", status: "satisfied", evidence: ["ev-01"], reason: "the repo's own checks decide this one" }],
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
const FIXED_INDEX_JS = `console.log("hello");\nconsole.log("bye");\n`;

/**
 * One turn that gets it right. The repair loop is `e2e-github-loop`'s subject; here every run is
 * the shortest honest path to a verified PR — the repository's own `npm test` still decides it.
 * `start()` rewinds the script, so one adapter serves every run of a case.
 */
function makeWorker() {
  return new ScriptedWorkerAdapter([
    {
      apply: async (sandbox) => sandbox.writeFile("index.js", FIXED_INDEX_JS),
      events: [
        { type: "started", sessionId: "scripted-thread-1" },
        { type: "file_changed", path: "index.js", kind: "update" },
        { type: "completed", usage: { inputTokens: 100, outputTokens: 20 } },
      ],
      diff: { patch: '+console.log("bye");\n', filesChanged: ["index.js"], truncated: false },
      usage: { inputTokens: 100, outputTokens: 20 },
    },
  ]);
}

class MemoryEvidenceStorage {
  async putPackage() {}
  async deletePackage() {}
}

function defaultBranchOf(bare) {
  const result = spawnSync("git", ["--git-dir", bare, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" });
  return (result.stdout || "main").trim();
}

/** `FakeSandboxProvider`, cloning the local bare repository wherever the row says github.com. */
function mappedSandboxes(bare) {
  const inner = new FakeSandboxProvider();
  return {
    name: inner.name,
    capabilities: inner.capabilities,
    create: async (options) =>
      redirectPushes(
        await inner.create({ ...options, repoUrl: options.repoUrl === CLONE_URL ? bare : options.repoUrl }),
        CLONE_URL,
        bare,
      ),
    attach: (options) => inner.attach(options),
  };
}

/** Linear's GraphQL API: records every request, answers `commentCreate` with success. */
function fakeLinear() {
  const requests = [];
  return {
    requests,
    comments: () => requests.map((r) => r.body.variables?.input).filter((input) => input?.body),
    async fetch(url, init) {
      requests.push({ url, body: JSON.parse(init.body) });
      return Response.json({ data: { commentCreate: { success: true, comment: { id: `c${requests.length}` } } } });
    },
  };
}

after(async () => {
  await closeWorkflowRuntime();
});

/**
 * A migrated schema, the fixture repository, a running factory, the ingress's own enqueuer, and
 * every provider fake — with the notifiers registered exactly as a deployment registers them
 * (`registerDeploymentNotifiers`, each behind its `WINDKEEL_CONNECT_*`).
 */
async function withStack(fn) {
  const suffix = `${Date.now()}_${process.pid}_${counter++}`;
  const schema = `windkeel_m8e2e_${suffix}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const schemaUrl = `${schemaDbUrl}${schemaDbUrl.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  // Intake transactions, notifiers, the schedule tick's advisory lock and the polls below share it.
  const pool = new Pool({ connectionString: schemaDbUrl, max: 8, idleTimeoutMillis: 1_000, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "node check.js" }, { "check.js": CHECK_JS, "index.js": BASE_INDEX_JS });
  const defaultBranch = defaultBranchOf(remote.bare);
  const github = new FakeGitHubClient(
    { repositories: [{ owner: OWNER, name: NAME, defaultBranch, issues: [] }] },
    { resolveBranchHead: branchHeadsIn(remote.bare) },
  );

  const slack = fakeSlack();
  const linear = fakeLinear();
  const jira = new FakeJira().site(JIRA_CLOUD, { siteUrl: "https://acme.atlassian.net" });
  const sentry = new FakeSentry({ tokens: [SENTRY_TOKEN] });
  // The flow function's key pair: ingress seals the Sentry token with the public half (ADR-0034).
  const secretKeys = generateSecretKeyPair();
  const tokens = new FakeProviderTokenSource()
    .install("slack", "inst-slack", { tenantId: SLACK_TEAM, name: "Windkeel Test" })
    .install("linear", "inst-linear", { tenantId: LINEAR_ORG, name: "Acme" })
    .install("jira", "inst-jira", { tenantId: JIRA_CLOUD, name: "Acme" });
  /** The only HTTP client any provider code gets. Anything but the three fakes is a test failure. */
  const unexpected = [];
  const providerFetch = async (url, init) => {
    const host = new URL(url).host;
    if (host === "slack.com") return slack.fetch(url, init);
    if (host === "api.linear.app") return linear.fetch(url, init);
    if (host === "api.atlassian.com") return jira.fetch(url, init);
    if (host === "sentry.io") return sentry.fetch(url, init);
    unexpected.push(url);
    throw new Error(`no network in tests: ${url}`);
  };
  const logs = [];
  const log = (message, fields) => logs.push({ message, ...fields });

  const stacks = [];
  const enqueue = runEnqueuer({ connectionString: schemaDbUrl, applicationSchema: schema, backing: "vercel-workflow" });
  const startRun = (runId) => enqueue.startRun(runId);

  try {
    await seedFixtureRepository(pool, { cloneUrl: CLONE_URL, defaultBranch });
    const organizationId = (await pool.query("select id from organization where is_default")).rows[0].id;
    const operatorId = (await pool.query("select id from principal where is_bootstrap")).rows[0].id;

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
        policyVersion: "m8-e2e",
        codex: { binary: "codex", pinnedVersion: "0.0.0-e2e", allowVersionDrift: false },
        checkerEndpoints: [],
      },
      { applicationSchema: schema, sandboxes: mappedSandboxes(remote.bare), worker: makeWorker(), github },
    );
    stack.deps.config.fakeSecurity = join(repoRoot, "test", "fixtures", "no-scanners.json");
    stack.deps.config.checkerModels.fakes = {
      review: scripted("review", CLEAN_REVIEW),
      mapping: scripted("mapping", CLEAN_MAPPING),
      criteria: scripted("criteria", { criteria: [{ text: CRITERIA_TEXT }] }),
    };
    stack.deps.evidence = { storage: new MemoryEvidenceStorage(), bucket: "evidence" };
    stacks.push(stack);

    // What `buildAndPublish` does in the flow function, with the fakes in place of Connect and fetch.
    const registered = registerDeploymentNotifiers({
      pool,
      env: { WINDKEEL_CONNECT_SLACK: "slack", WINDKEEL_CONNECT_LINEAR: "linear", WINDKEEL_CONNECT_JIRA: "jira", WINDKEEL_CONNECT_SENTRY: "sealed" },
      tokenSource: tokens,
      fetch: providerFetch,
      sentryPrivateKeys: () => [secretKeys.privateKey],
      log,
    });
    assert.deepEqual([...registered].sort(), ["jira", "linear", "sentry", "slack"]);

    // The GitHub ingress, for the one thing only GitHub can say: a pull request was merged.
    const actions = windkeelActions({ github, enqueue });
    const githubDelivery = (event, payload, id) => {
      const rawBody = JSON.stringify(payload);
      return handleWebhook(
        {
          headers: { "x-github-event": event, "x-github-delivery": id, "x-hub-signature-256": signWebhookBody(GITHUB_SECRET, rawBody) },
          rawBody,
        },
        { secret: GITHUB_SECRET, pool, actions },
      );
    };
    const mergePullRequest = (number, id) =>
      githubDelivery(
        "pull_request",
        {
          action: "closed",
          installation: { id: 42 },
          sender: { login: OWNER },
          repository: {
            name: NAME,
            full_name: `${OWNER}/${NAME}`,
            owner: { login: OWNER },
            default_branch: defaultBranch,
            clone_url: CLONE_URL,
            fork: false,
          },
          pull_request: {
            number,
            merged: true,
            merged_at: new Date().toISOString(),
            head: { ref: "windkeel/whatever", repo: { full_name: `${OWNER}/${NAME}`, fork: false } },
            base: { repo: { full_name: `${OWNER}/${NAME}` } },
          },
        },
        id,
      );

    await fn({
      pool,
      github,
      slack,
      linear,
      jira,
      sentry,
      secretKeys,
      enqueue,
      tokens,
      providerFetch,
      startRun,
      organizationId,
      operatorId,
      mergePullRequest,
      logs,
      log,
    });
    assert.deepEqual(unexpected, [], "nothing tried to reach a host that is not faked");
  } finally {
    registerDeploymentNotifiers({ pool, env: {} }); // unregisters every one
    await endExecutions(pool).catch(() => {});
    for (const stack of stacks) await stack.stop().catch(() => {});
    await enqueue.stop().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

async function waitFor(fn, description, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`waitFor: ${description} never became true`);
}

const SETTLED = ["WAITING_FOR_HUMAN", "COMPLETED", "BLOCKED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED", "CANCELLED"];

/** The task's only run, once it has reached a verified draft PR. */
async function verifiedPullRequest(pool, taskId) {
  const run = await waitFor(async () => {
    const { rows } = await pool.query("select id from engineering_run where task_id = $1 order by created_at desc limit 1", [taskId]);
    if (!rows[0]) return null;
    const current = await getEngineeringRun(pool, rows[0].id);
    return current && SETTLED.includes(current.status) ? current : null;
  }, `task ${taskId}'s run to settle`);
  assert.equal(run.status, "WAITING_FOR_HUMAN", `the run ended ${run.status}: ${run.stopReason ?? ""}`);
  assert.equal(run.finalVerdict, "pass", "verified");
  assert.ok(run.prNumber, "with a pull request");
  return run;
}

async function pullRequests(github) {
  return github.listPullRequests({ repository: REF, state: "all" });
}

/** The task's creator: always an organization principal of kind `token`, never a person. */
async function actorOf(pool, taskId, organizationId) {
  const { rows } = await pool.query(
    `select p.id, p.kind, p.organization_id, p.system_purpose, p.is_bootstrap
       from engineering_task t join principal p on p.id = t.created_by_principal_id
      where t.id = $1`,
    [taskId],
  );
  assert.equal(rows.length, 1, "the task names its creator");
  const actor = rows[0];
  assert.equal(actor.kind, "token", "an automation's principal, not a user");
  assert.equal(actor.organization_id, organizationId, "confined to the task's organization");
  assert.equal(actor.is_bootstrap, false);
  return actor;
}

async function ledger(pool, source) {
  const { rows } = await pool.query(
    "select delivery_key, organization_id, intent, reason, engineering_task_id from intake_delivery where source = $1 order by received_at, delivery_key",
    [source],
  );
  return rows;
}

async function tasksOf(pool, sourceType) {
  const { rows } = await pool.query(
    "select id, title, source_reference, source_context, organization_id, repository_id, acceptance_criteria from engineering_task where source_type = $1 order by created_at",
    [sourceType],
  );
  return rows;
}

// ---------------------------------------------------------------------------------------------
// 1. Slack slash command ⇒ the thread gets "started" and then the draft-PR link
// ---------------------------------------------------------------------------------------------

function slashCommand({ text, channel = SLACK_CHANNEL, trigger }) {
  const form = new URLSearchParams({
    team_id: SLACK_TEAM,
    team_domain: "windkeel-test",
    channel_id: channel,
    channel_name: "eng",
    user_id: "U0ALICE1",
    user_name: "alice",
    command: "/windkeel",
    text,
    api_app_id: "A0WINDKEEL1",
    response_url: `https://hooks.slack.com/commands/${SLACK_TEAM}/1/abc`,
    trigger_id: trigger,
  });
  return {
    headers: { authorization: `Bearer ${OIDC}`, "content-type": "application/x-www-form-urlencoded" },
    rawBody: Buffer.from(form.toString()),
  };
}

test("Slack: a slash command becomes a verified draft PR, and the thread hears started then the PR link", { skip }, async () => {
  await withStack(async ({ pool, github, slack, startRun, organizationId }) => {
    const { connection } = await createConnection(pool, {
      organizationId,
      provider: "slack",
      installationId: "inst-slack",
      externalTenantId: SLACK_TEAM,
      externalTenantName: "Windkeel Test",
      createdByPrincipalId: null,
    });
    await addRoute(pool, organizationId, connection.id, {
      scopeKind: "slack_channel",
      scopeValue: SLACK_CHANNEL,
      repositoryId: FIXTURE_REPOSITORY_ID,
    });
    const source = createSlackIntakeSource({ verify: fakeConnectForwardVerifier(OIDC), startRun });
    const slash = (options) => runIntake(source, slashCommand(options), { pool });

    // An unmapped channel: answered, recorded with its reason, no task.
    const unmapped = await slash({ text: "Say goodbye too", channel: "C0ELSEWHERE", trigger: "trigger-unmapped" });
    assert.equal(unmapped.status, 200);
    assert.equal(unmapped.body.reason, "no_route");
    assert.match(wireResponse(unmapped).body.text, /not mapped to a repository/);

    const text = `Say goodbye too -- - [ ] ${CRITERIA_TEXT}`;
    const accepted = await slash({ text, trigger: "trigger-1" });
    assert.equal(accepted.status, 200);
    assert.deepEqual(wireResponse(accepted), { status: 200, body: { response_type: "ephemeral", text: "Starting…" } });

    const [task] = await tasksOf(pool, "slack");
    assert.equal(task.title, "Say goodbye too");
    assert.equal(task.source_reference, `slack:${SLACK_TEAM}:trigger-1`);
    assert.equal(task.acceptance_criteria.length, 1, "the command's own checklist");
    const actor = await actorOf(pool, task.id, organizationId);
    assert.equal(actor.system_purpose, "slack");

    const run = await verifiedPullRequest(pool, task.id);
    const pulls = await pullRequests(github);
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0].draft, true);
    assert.equal(pulls[0].number, run.prNumber);

    // The notifier: `started` opens the thread, "Verifying…" (#389) and then the hand-off — with the
    // verifier's verdict — land in it.
    const posts = await waitFor(() => (slack.posts().length >= 3 ? slack.posts() : null), "three Slack posts");
    assert.equal(posts.length, 3, "one root, one Verifying, one outcome — nothing else");
    assert.equal(posts[0].body.channel, SLACK_CHANNEL);
    assert.equal(posts[0].body.thread_ts, undefined, "the root starts the thread");
    assert.match(posts[0].body.text, /Task \*Say goodbye too\* started/);
    assert.match(posts[0].body.text, new RegExp(`${CONSOLE_URL}/runs/${run.id}`));
    assert.match(posts[1].body.text, /Verifying in an independent sandbox…/);
    assert.doesNotMatch(posts[1].body.text, /verified|ready/i, "nothing claims verified before the verdict");
    assert.equal(posts[2].body.channel, SLACK_CHANNEL);
    assert.equal(posts[2].body.thread_ts, "1700000200.000001", "the outcome replies in the thread the root started");
    assert.match(posts[2].body.text, /Verified ✓ 1\/1 criteria/);
    assert.ok(posts[2].body.text.includes(`<${prUrl(run.prNumber)}|draft PR #${run.prNumber}>`), posts[2].body.text);
    assert.match(posts[2].authorization, /^Bearer fake-slack-inst-slack-\d+$/);

    // Slack retrying the same command: a duplicate, still one task and one PR.
    const retried = await slash({ text, trigger: "trigger-1" });
    assert.equal(retried.body.duplicate, true);
    assert.deepEqual(wireResponse(retried).body, { response_type: "ephemeral", text: "Already on it." });

    assert.deepEqual(
      (await ledger(pool, "slack")).map((d) => [d.delivery_key, d.intent, d.reason, d.engineering_task_id]),
      [
        ["trigger-unmapped", "ignore", "no_route", null],
        ["trigger-1", "create_task:started", null, task.id],
      ],
    );
    assert.equal((await tasksOf(pool, "slack")).length, 1);
    assert.equal((await pullRequests(github)).length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Linear issue labelled `windkeel` ⇒ a start comment, then a comment with the PR link
// ---------------------------------------------------------------------------------------------

function linearFixture(name, overrides) {
  const payload = JSON.parse(readFileSync(join(repoRoot, "test/fixtures/linear", `${name}.json`), "utf8"));
  return { ...payload, webhookTimestamp: Date.now(), ...overrides };
}

function linearRequest(payload, delivery) {
  return {
    headers: { authorization: `Bearer ${OIDC}`, "linear-delivery": delivery, "content-type": "application/json" },
    rawBody: JSON.stringify(payload),
  };
}

test("Linear: an issue labelled windkeel becomes a verified draft PR, and the issue gets the PR link", { skip }, async () => {
  await withStack(async ({ pool, github, linear, tokens, providerFetch, startRun, organizationId }) => {
    const { connection } = await createConnection(pool, {
      organizationId,
      provider: "linear",
      installationId: "inst-linear",
      externalTenantId: LINEAR_ORG,
      externalTenantName: "Acme",
      createdByPrincipalId: null,
    });
    await addRoute(pool, organizationId, connection.id, { repositoryId: FIXTURE_REPOSITORY_ID });
    const source = createLinearIntakeSource({
      startRun,
      tokenSource: tokens,
      verifyForward: fakeConnectForwardVerifier(OIDC),
      fetch: providerFetch,
      consoleUrl: () => CONSOLE_URL,
      log: () => {},
    });
    const deliver = (payload, delivery) => runIntake(source, linearRequest(payload, delivery), { pool, log: () => {} });

    // A comment event: not an issue, recorded and answered with the reason.
    const comment = await deliver(linearFixture("comment-create"), "d-comment");
    assert.equal(comment.status, 200);
    assert.equal(comment.body.reason, "not_an_issue");

    const base = linearFixture("issue-create-with-label");
    const issue = {
      ...base,
      data: {
        ...base.data,
        title: "Say goodbye too",
        description: `Add a farewell line to index.js.\n\n- [ ] ${CRITERIA_TEXT}`,
        labelIds: [base.data.labels[0].id],
        labels: [base.data.labels[0]], // `windkeel` only: no risk label
      },
    };
    const created = await deliver(issue, "d-create");
    assert.equal(created.status, 200);
    assert.equal(created.body.intent, "create_task");

    const [task] = await tasksOf(pool, "linear");
    assert.equal(task.title, "Say goodbye too");
    assert.equal(task.source_reference, `linear:${LINEAR_ORG}:${base.data.id}`);
    assert.equal(task.acceptance_criteria.length, 1);
    assert.equal((await actorOf(pool, task.id, organizationId)).system_purpose, "linear");

    const run = await verifiedPullRequest(pool, task.id);
    assert.equal((await pullRequests(github)).length, 1);

    // The intake's start comment, then the notifier's hand-off comment, both on the issue.
    const comments = await waitFor(() => (linear.comments().length >= 3 ? linear.comments() : null), "three Linear comments");
    assert.equal(comments.length, 3);
    assert.ok(comments.every((c) => c.issueId === base.data.id));
    assert.match(comments[0].body, /started/i);
    assert.match(comments[1].body, /^Verifying in an independent sandbox…/);
    assert.match(comments[2].body, /^Verified ✓ 1\/1 criteria · draft PR /);
    assert.ok(comments[2].body.includes(prUrl(run.prNumber)), comments[2].body);

    // Re-labelled while the run is live: ignored `already_tasked`, no second run, no comment.
    const relabel = linearFixture("issue-update-label-added");
    const again = await deliver({ ...relabel, data: { ...relabel.data, id: base.data.id } }, "d-relabel");
    assert.equal(again.body.reason, "already_tasked");
    // Linear retrying the create delivery: a duplicate.
    assert.equal((await deliver(issue, "d-create")).body.duplicate, true);

    assert.deepEqual(
      (await ledger(pool, "linear")).map((d) => [d.intent, d.reason, d.engineering_task_id]),
      [
        ["ignore", "not_an_issue", null],
        ["create_task:started", null, task.id],
        ["ignore", "already_tasked", task.id],
      ],
    );
    const { rows: runs } = await pool.query("select count(*)::int as n from engineering_run where task_id = $1", [task.id]);
    assert.equal(runs[0].n, 1);
    assert.equal(linear.comments().length, 3);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Jira issue labelled `windkeel` ⇒ an acknowledgement, then an ADF comment with the PR link
// ---------------------------------------------------------------------------------------------

function jiraRequest(payload, id) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJiraWebhookJwt({ iss: "client-id", iat: now, exp: now + 180 }, JIRA_SECRET);
  return {
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", "x-atlassian-webhook-identifier": id },
    rawBody: Buffer.from(JSON.stringify(payload)),
  };
}

const jiraFixture = (name) => JSON.parse(readFileSync(join(repoRoot, "test", "fixtures", "jira", `${name}.json`), "utf8"));

test("Jira: an issue labelled windkeel becomes a verified draft PR, and the issue gets an ADF comment with the link", { skip }, async () => {
  await withStack(async ({ pool, github, jira, tokens, providerFetch, startRun, organizationId }) => {
    const { connection } = await createConnection(pool, {
      organizationId,
      provider: "jira",
      installationId: "inst-jira",
      externalTenantId: JIRA_CLOUD,
      externalTenantName: "Acme",
      createdByPrincipalId: null,
    });
    // What `registerJiraWebhooks` leaves behind (M8-8): the site's registered webhook.
    await pool.query(
      `insert into jira_webhook (connection_id, cloud_id, site_url, webhook_ids, jql, expires_at)
       values ($1, $2, 'https://acme.atlassian.net', '{1001}', 'project IN ("ENG")', now() + interval '30 days')`,
      [connection.id, JIRA_CLOUD],
    );
    await addRoute(pool, organizationId, connection.id, { repositoryId: FIXTURE_REPOSITORY_ID });
    const source = createJiraIntakeSource({
      startRun,
      tokens,
      fetch: providerFetch,
      secret: () => JIRA_SECRET,
      consoleUrl: () => CONSOLE_URL,
      log: () => {},
    });
    const deliver = (payload, id) => runIntake(source, jiraRequest(payload, id), { pool, log: () => {} });

    // An edit that did not add the label: recorded with its reason.
    const unrelated = await deliver(jiraFixture("issue_updated_unrelated"), "wh-unrelated");
    assert.equal(unrelated.status, 200);
    assert.equal(unrelated.body.intent, "ignore");
    const unrelatedReason = unrelated.body.reason;
    assert.ok(["label_not_added", "no_trigger_label"].includes(unrelatedReason), unrelatedReason);

    const base = jiraFixture("issue_created");
    const issue = {
      ...base,
      issue: {
        ...base.issue,
        fields: {
          ...base.issue.fields,
          summary: "Say goodbye too",
          labels: ["windkeel"],
          description: {
            type: "doc",
            version: 1,
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Add a farewell line to index.js." }] },
              { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Acceptance criteria" }] },
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: CRITERIA_TEXT }] }] }],
              },
            ],
          },
        },
      },
    };
    const created = await deliver(issue, "wh-create");
    assert.equal(created.status, 200);
    assert.equal(created.body.intent, "create_task");

    const [task] = await tasksOf(pool, "jira");
    assert.equal(task.title, "ENG-42: Say goodbye too");
    assert.equal(task.acceptance_criteria.length, 1);
    assert.equal((await actorOf(pool, task.id, organizationId)).system_purpose, "jira");

    const run = await verifiedPullRequest(pool, task.id);
    assert.equal((await pullRequests(github)).length, 1);

    const comments = await waitFor(
      () => (jira.commentsOn(JIRA_CLOUD, "ENG-42").length >= 3 ? jira.commentsOn(JIRA_CLOUD, "ENG-42") : null),
      "three Jira comments",
    );
    assert.equal(comments.length, 3, "the acknowledgement, Verifying, and the hand-off");
    for (const body of comments) assert.equal(body.type, "doc", "Jira comments are ADF documents");
    assert.match(adfToText(comments[0]), /started|on it/i);
    assert.match(adfToText(comments[1]), /Verifying in an independent sandbox…/);
    const handOff = adfToText(comments[2]);
    assert.match(handOff, /Verified ✓ 1\/1 criteria/);
    assert.ok(handOff.includes(prUrl(run.prNumber)), handOff);
    const link = JSON.stringify(comments[2]);
    assert.ok(link.includes(`"href":"${prUrl(run.prNumber)}"`), "the PR is a real ADF link mark");

    // Jira redelivering the same webhook: a duplicate.
    assert.equal((await deliver(issue, "wh-create")).body.duplicate, true);
    assert.deepEqual(
      (await ledger(pool, "jira")).map((d) => [d.intent, d.reason, d.engineering_task_id]),
      [
        ["ignore", unrelatedReason, null],
        ["create_task", null, task.id],
      ],
    );
    assert.equal(jira.commentsOn(JIRA_CLOUD, "ENG-42").length, 3);
  });
});

// ---------------------------------------------------------------------------------------------
// 3b. A Sentry issue alert (#389) ⇒ criteria approved by a human ⇒ verified draft PR ⇒ the
//     verdict, with the PR, as a comment on the Sentry issue
// ---------------------------------------------------------------------------------------------

const sentryFixture = (name) => JSON.parse(readFileSync(join(repoRoot, "test", "fixtures", "sentry", `${name}.json`), "utf8"));

function sentryRequest(payload, id, resource = "event_alert") {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return {
    headers: {
      "content-type": "application/json",
      "sentry-hook-resource": resource,
      "sentry-hook-timestamp": String(Math.floor(Date.now() / 1000)),
      "sentry-hook-signature": signSentryWebhook(SENTRY_SECRET, rawBody),
      "request-id": id,
    },
    rawBody,
  };
}

test("Sentry: an alert becomes a verified draft PR, and the Sentry issue gets the verdict and the PR", { skip }, async () => {
  await withStack(async ({ pool, github, sentry, secretKeys, enqueue, startRun, organizationId }) => {
    const { connection } = await createConnection(pool, {
      organizationId,
      provider: "sentry",
      installationId: SENTRY_UUID,
      externalTenantId: SENTRY_UUID,
      externalTenantName: "acme-shop",
      createdByPrincipalId: null,
    });
    // What `POST /v1/integrations` does with the token on ingress: seal it, unable to open it.
    await putSentryCredential(pool, {
      organizationId,
      connectionId: connection.id,
      publicKey: secretKeys.publicKey,
      token: SENTRY_TOKEN,
      createdByPrincipalId: null,
    });
    await addRoute(pool, organizationId, connection.id, { scopeKind: "sentry_project", scopeValue: "checkout-web", repositoryId: FIXTURE_REPOSITORY_ID });
    const source = createSentryIntakeSource({ startRun, secret: () => SENTRY_SECRET });
    const deliver = (payload, id, resource) => runIntake(source, sentryRequest(payload, id, resource), { pool, log: () => {} });

    // A resolved metric alert: recorded with its reason, no task.
    const resolved = await deliver({ ...sentryFixture("metric_alert_critical"), action: "resolved" }, "req-resolved", "metric_alert");
    assert.equal(resolved.body.reason, "sentry_resource_not_acted_on:metric_alert.resolved");

    const alert = sentryFixture("event_alert");
    const created = await deliver(alert, "req-1");
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.intent, "create_task");

    const [task] = await tasksOf(pool, "sentry");
    assert.match(task.title, /^Fix Sentry issue CHECKOUT-WEB-1A: TypeError/);
    assert.equal(task.source_reference, `sentry:${SENTRY_UUID}/4100000001`);
    assert.equal((await actorOf(pool, task.id, organizationId)).system_purpose, "sentry");

    // No criteria in an alert: generated, then held for a human (ADR-0012) — never pre-approved.
    const { rows: [first] } = await pool.query("select id from engineering_run where task_id = $1", [task.id]);
    await waitFor(async () => (await getEngineeringRun(pool, first.id))?.status === "WAITING_FOR_APPROVAL", "the run to hold for approval");
    await waitFor(() => sentry.commentsOn("4100000001").length >= 2, "started and the approval request");
    await enqueue.signal(first.id, { type: "approval_granted", actor: "operator" });

    const run = await verifiedPullRequest(pool, task.id);
    assert.equal((await pullRequests(github)).length, 1);

    const comments = await waitFor(
      () => (sentry.commentsOn("4100000001").length >= 4 ? sentry.commentsOn("4100000001") : null),
      "four Sentry comments",
    );
    assert.equal(comments.length, 4);
    assert.match(comments[0], new RegExp(`^Windkeel picked up this alert and started a run · ${CONSOLE_URL}/runs/${run.id}$`));
    assert.match(comments[1], /approve them before it continues/);
    assert.match(comments[2], /^Verifying in an independent sandbox…/);
    assert.equal(comments[3], `Verified ✓ 1/1 criteria · draft PR ${prUrl(run.prNumber)} · ${CONSOLE_URL}/runs/${run.id}`);
    for (const text of comments) assert.doesNotMatch(text, /\bfixed\b|resolved/i, "Windkeel never says the issue is fixed");
    assert.ok(sentry.comments.every((c) => c.authorization === `Bearer ${SENTRY_TOKEN}`), "the sealed token, opened in the flow function");

    // Sentry redelivering, and the rule re-firing for the same issue: still one task, one PR.
    assert.equal((await deliver(alert, "req-1")).body.duplicate, true);
    assert.equal((await deliver(alert, "req-2")).body.reason, "duplicate");
    assert.deepEqual(
      (await pool.query("select source, intent, reason from intake_delivery where source = 'sentry' order by received_at, delivery_key")).rows,
      [
        { source: "sentry", intent: "ignore", reason: "sentry_resource_not_acted_on:metric_alert.resolved" },
        { source: "sentry", intent: "create_task", reason: null },
        { source: "sentry", intent: "ignore", reason: "duplicate" },
      ],
    );
    assert.equal((await tasksOf(pool, "sentry")).length, 1);
    assert.equal((await pullRequests(github)).length, 1);
    assert.equal(sentry.commentsOn("4100000001").length, 4);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. A signed webhook endpoint ⇒ task; the replayed delivery ⇒ duplicate, still one PR
// ---------------------------------------------------------------------------------------------

function api(pool, startRun) {
  const deps = { pool, control: { enqueue: startRun }, webhookSigningKey: () => WEBHOOK_SIGNING_KEY };
  const auth = { token: BOOTSTRAP, subject: "operator" };
  return (method, path, { body, bearer = BOOTSTRAP, key } = {}) =>
    handleApiRequest(deps, auth, {
      method,
      path,
      query: { get: () => undefined },
      headers: { authorization: `Bearer ${bearer}`, ...(key === undefined ? {} : { "idempotency-key": key }) },
      body,
    });
}

test("Signed webhook: a delivery becomes a verified draft PR; the replayed delivery is a duplicate", { skip }, async () => {
  await withStack(async ({ pool, github, startRun, organizationId }) => {
    const call = api(pool, startRun);
    const made = await call("POST", "/v1/webhook-endpoints", { body: { name: "pagerduty", repositoryId: FIXTURE_REPOSITORY_ID } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const { endpoint, secret } = made.body;

    const source = createWebhookIntakeSource({ signingKey: () => WEBHOOK_SIGNING_KEY, startRun });
    const rawBody = JSON.stringify({ title: "Say goodbye too", description: `Add a farewell line.\n\n- [ ] ${CRITERIA_TEXT}` });
    const timestamp = Math.floor(Date.now() / 1000);
    const request = () => ({
      target: endpoint.id,
      rawBody,
      headers: {
        "x-windkeel-timestamp": String(timestamp),
        "x-windkeel-signature": signWebhookPayload(secret, timestamp, rawBody),
        "x-windkeel-delivery": "incident-7",
      },
    });
    const deliver = () => runIntake(source, request(), { pool, log: () => {} }).then(wireResponse);

    const first = await deliver();
    assert.equal(first.status, 202, JSON.stringify(first.body));
    const { taskId, engineeringRunId } = first.body;
    const [task] = await tasksOf(pool, "webhook");
    assert.equal(task.id, taskId);
    assert.equal(task.source_reference, `webhook:${endpoint.id}:incident-7`);
    assert.equal((await actorOf(pool, taskId, organizationId)).system_purpose, "webhook");

    const run = await verifiedPullRequest(pool, taskId);
    assert.equal(run.id, engineeringRunId);

    // The sender retries the very same signed request after the PR exists.
    const replay = await deliver();
    assert.ok(replay.status < 300, JSON.stringify(replay));
    assert.equal(replay.body.duplicate, true);

    assert.deepEqual(
      (await ledger(pool, "webhook")).map((d) => [d.delivery_key, d.intent, d.reason, d.engineering_task_id]),
      [[`${endpoint.id}:incident-7`, "create_task:started", null, taskId]],
    );
    assert.equal((await tasksOf(pool, "webhook")).length, 1);
    assert.equal((await pullRequests(github)).length, 1, "still one PR");
  });
});

// ---------------------------------------------------------------------------------------------
// 5. POST /v1/tasks with an Idempotency-Key, twice ⇒ one task
// ---------------------------------------------------------------------------------------------

test("API: POST /v1/tasks with the same Idempotency-Key twice is one task and one verified draft PR", { skip }, async () => {
  await withStack(async ({ pool, github, startRun, organizationId }) => {
    const call = api(pool, startRun);
    // An automation calls the API as a service principal, never as a person.
    const sp = (await call("POST", "/v1/service-principals", { body: { name: "ci", role: "member" } })).body.servicePrincipal;
    const { secret } = (await call("POST", `/v1/service-principals/${sp.id}/tokens`, { body: { name: "ci" } })).body;

    const body = { repositoryId: FIXTURE_REPOSITORY_ID, title: "Say goodbye too", description: `- [ ] ${CRITERIA_TEXT}` };
    const first = await call("POST", "/v1/tasks", { bearer: secret, body, key: "deploy-42" });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    const second = await call("POST", "/v1/tasks", { bearer: secret, body, key: "deploy-42" });
    assert.equal(second.status, 202);
    assert.equal(second.body.taskId, first.body.taskId);
    assert.equal(second.body.engineeringRunId, first.body.engineeringRunId);
    assert.equal(second.headers["idempotent-replayed"], "true");

    const [task] = await tasksOf(pool, "api");
    assert.equal(task.id, first.body.taskId);
    const actor = await actorOf(pool, task.id, organizationId);
    assert.equal(actor.id, sp.id, "the service principal that called");
    assert.equal(actor.system_purpose, null, "a service principal, not a system actor");

    const run = await verifiedPullRequest(pool, task.id);
    assert.equal(run.id, first.body.engineeringRunId);

    const rows = await ledger(pool, "api");
    assert.equal(rows.length, 1);
    assert.match(rows[0].delivery_key, /:deploy-42$/);
    assert.equal(rows[0].engineering_task_id, task.id);
    assert.equal((await tasksOf(pool, "api")).length, 1);
    assert.equal((await pullRequests(github)).length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. A schedule `@weekly` across two slots ⇒ two tasks; downtime ⇒ coalesced
// ---------------------------------------------------------------------------------------------

test("Schedule: @weekly across two slots is two verified PRs; downtime coalesces, and an unmerged PR pauses it", { skip }, async () => {
  await withStack(async ({ pool, github, startRun, organizationId, operatorId, mergePullRequest }) => {
    const at = (s) => new Date(s);
    // Created on a Friday; `@weekly` fires Sundays at 00:00 UTC.
    const schedule = await createSchedule(
      pool,
      organizationId,
      {
        repositoryId: FIXTURE_REPOSITORY_ID,
        name: "farewell",
        cron: "@weekly",
        timezone: "UTC",
        title: "Say goodbye too ({{date}})",
        description: `Weekly {{schedule}} check.\n\n- [ ] ${CRITERIA_TEXT}`,
      },
      operatorId,
      at("2026-09-25T09:30:00Z"),
    );
    assert.equal(schedule.nextFireAt.toISOString(), "2026-09-27T00:00:00.000Z");
    const tick = async (now) => {
      const result = await fireDueSchedules(pool, at(now), { startRun, log: () => {} });
      assert.equal(result.kind, "ran");
      return result.result.fired;
    };

    // Slot 1.
    const [one] = await tick("2026-09-27T00:02:00Z");
    assert.equal(one.outcome.kind, "created");
    const run1 = await verifiedPullRequest(pool, one.outcome.taskId);
    const merged1 = await mergePullRequest(run1.prNumber, "merge-1");
    assert.equal(merged1.status, 200);
    await waitFor(async () => (await getEngineeringRun(pool, run1.id))?.status === "COMPLETED", "run 1 to complete on merge");

    // Slot 2, a week later: the previous run ended, so a second task.
    const [two] = await tick("2026-10-04T00:02:00Z");
    assert.equal(two.outcome.kind, "created");
    assert.notEqual(two.outcome.taskId, one.outcome.taskId);
    const run2 = await verifiedPullRequest(pool, two.outcome.taskId);
    assert.notEqual(run2.prNumber, run1.prNumber);

    // Downtime: three weeks with no tick. The missed slots coalesce; the latest one finds run 2's
    // PR still unmerged, so the schedule pauses rather than open a duplicate (docs/schedules.md).
    const [late] = await tick("2026-10-25T00:20:00Z");
    assert.equal(late.coalesced, 2);
    assert.equal(late.slot, "2026-10-25T00:00:00.000Z");
    assert.deepEqual(late.outcome, { kind: "ignored", reason: "previous_run_in_flight" });

    const tasks = await tasksOf(pool, "schedule");
    assert.deepEqual(
      tasks.map((t) => t.title),
      ["Say goodbye too (2026-09-27)", "Say goodbye too (2026-10-04)"],
    );
    for (const task of tasks) assert.equal((await actorOf(pool, task.id, organizationId)).system_purpose, "schedules");

    assert.deepEqual(
      (await ledger(pool, "schedule")).map((d) => [d.delivery_key, d.intent, d.reason]).sort(),
      [
        [slotKey(schedule.id, "2026-09-27T00:00:00.000Z"), "create_task", null],
        [slotKey(schedule.id, "2026-10-04T00:00:00.000Z"), "create_task", null],
        [slotKey(schedule.id, "2026-10-11T00:00:00.000Z"), "ignore", "coalesced"],
        [slotKey(schedule.id, "2026-10-18T00:00:00.000Z"), "ignore", "coalesced"],
        [slotKey(schedule.id, "2026-10-25T00:00:00.000Z"), "ignore", "previous_run_in_flight"],
      ].sort(),
    );
    const pulls = await pullRequests(github);
    assert.equal(pulls.length, 2, "one PR per slot that fired");
    const row = (await pool.query("select next_fire_at from schedule where id = $1", [schedule.id])).rows[0];
    assert.equal(row.next_fire_at.toISOString(), "2026-11-01T00:00:00.000Z");
  });
});
