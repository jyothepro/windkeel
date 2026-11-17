import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { FakeGitHubClient } from "../dist/github/fake.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { ScriptedWorkerAdapter } from "../dist/worker/scripted.js";
import { getEngineeringRun, getEngineeringTaskBySource, listAgentRuns, listVerificationRuns, listWorkspaces } from "../dist/factory/repositories.js";
import { getRepositoryByFullName } from "../dist/factory/repository-entity.js";
import { harvestMakerScreenshots, listMakerScreenshots } from "../dist/factory/maker-screenshots.js";
import { makerScreenshotsMarker } from "../dist/github/maker-screenshots-comment.js";
import { stickyMarker } from "../dist/github/summary.js";
import { handleWebhook } from "../apps/ingress/dist/src/handler.js";
import { signWebhookBody } from "../apps/ingress/dist/src/signature.js";
import { windkeelActions, runEnqueuer } from "../apps/ingress/dist/src/windkeel-actions.js";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { bareFixtureRepo, branchHeadsIn, repoRoot, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { startFactory } from "./factory-stack.js";
import { closeWorkflowRuntime, endExecutions, runtimeSkip } from "./workflow-runtime.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * #392 end to end: a maker that takes a screenshot while it builds, through the real ingress, the
 * real workflow runtime and real Postgres, with `FakeSandboxProvider`, `FakeGitHubClient` and a
 * scripted worker (the same three seams as `e2e-github-loop.test.js`, and the same honesty caveat).
 *
 * What it holds: the screenshot is harvested (one `maker_screenshot` row, one `screenshot` event on
 * the run's feed), shown to people (a separate, labelled PR comment), and kept away from everything
 * that verifies — not in the candidate's tree (so the verifier's input is exactly the code change),
 * not in any evidence package, not in the PR body or the evidence comment. And the repository asked
 * for a browser the fake sandbox cannot give, so the feed says `browser_unavailable` and the run
 * carries on.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);
const SECRET = "webhook-secret-for-tests";
const OWNER = "jyothepro";
const NAME = "windkeel-fixture";
const REF = { owner: OWNER, name: NAME };
const TOKEN = "test-operator-token";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("the maker's view of the home page")]);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

function scripted(name, value) {
  const path = join(tempDir(name), `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const CRITERIA_TEXT = "`node index.js` prints the greeting and the farewell";
const CHECK_JS = `const { execFileSync } = require("node:child_process");
const out = execFileSync(process.execPath, ["index.js"], { encoding: "utf8" }).trim();
if (out !== "hello\\nbye") { console.error("got " + JSON.stringify(out)); process.exit(1); }
console.log("ok");
`;
const BASE_INDEX_JS = `console.log("hello");\n`;
const FIXED_INDEX_JS = `console.log("hello");\nconsole.log("bye");\n`;
const WINDKEEL_CONFIG = JSON.stringify({ makerBrowser: { enabled: true, startCommand: "node index.js", port: 3000 } });

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

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function defaultBranchOf(bare) {
  const result = spawnSync("git", ["--git-dir", bare, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" });
  return (result.stdout || "main").trim();
}

function issuePayload(remote) {
  return {
    action: "labeled",
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
      state: "open",
      locked: false,
      body: `Add a farewell line to index.js.\n\n- [ ] ${CRITERIA_TEXT}\n`,
      labels: [{ name: "windkeel" }],
      html_url: `https://github.com/${OWNER}/${NAME}/issues/7`,
      user: { login: "jyothepro" },
    },
  };
}

function delivery(event, payload, id) {
  const rawBody = JSON.stringify(payload);
  return {
    headers: { "x-github-event": event, "x-github-delivery": id, "x-hub-signature-256": signWebhookBody(SECRET, rawBody) },
    rawBody,
  };
}

after(async () => {
  await closeWorkflowRuntime();
});

const SETTLED = ["WAITING_FOR_HUMAN", "COMPLETED", "BLOCKED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED"];

async function waitFor(fn, description, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`waitFor: ${description} never became true`);
}

test("a maker screenshot is harvested, shown as unverified, and never reaches the candidate or the evidence", { skip }, async () => {
  const schema = `windkeel_mbe2e_${Date.now()}_${process.pid}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const schemaUrl = `${schemaDbUrl}${schemaDbUrl.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo(
    { test: "node check.js" },
    { "check.js": CHECK_JS, "index.js": BASE_INDEX_JS, "windkeel.config.json": WINDKEEL_CONFIG },
  );
  const github = new FakeGitHubClient(
    {
      repositories: [
        {
          owner: OWNER,
          name: NAME,
          defaultBranch: defaultBranchOf(remote.bare),
          issues: [{ number: 7, title: "Say goodbye too", labels: ["windkeel"] }],
          collaborators: { jyothepro: { permission: "admin", roleName: "admin" } },
        },
      ],
    },
    { resolveBranchHead: branchHeadsIn(remote.bare) },
  );
  const storage = new MemoryEvidenceStorage();
  const worker = new ScriptedWorkerAdapter([
    {
      apply: async (sandbox) => {
        await sandbox.writeFile("index.js", FIXED_INDEX_JS);
        mkdirSync(join(sandbox.checkoutPath, ".windkeel", "browser"), { recursive: true });
        await sandbox.writeFile(".windkeel/browser/001-home.png", PNG);
        await sandbox.writeFile(
          ".windkeel/browser/index.jsonl",
          `${JSON.stringify({ file: "001-home.png", name: "home", url: "http://localhost:3000/", title: "<img src=x onerror=alert(1)>", status: 200, consoleErrors: [] })}\n`,
        );
      },
      events: [
        { type: "started", sessionId: "scripted-thread-1" },
        { type: "file_changed", path: "index.js", kind: "update" },
        { type: "command_started", command: "windkeel-browse screenshot http://localhost:3000/ --name home" },
        { type: "completed", usage: { inputTokens: 500, outputTokens: 100 } },
      ],
      diff: { patch: '+console.log("bye");\n', filesChanged: ["index.js", ".windkeel/browser/001-home.png"], truncated: false },
      usage: { inputTokens: 500, outputTokens: 100 },
    },
  ]);

  let stack;
  const enqueue = runEnqueuer({ connectionString: schemaDbUrl, applicationSchema: schema, backing: "vercel-workflow" });
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
        policyVersion: "m-browser-e2e",
        codex: { binary: "codex", pinnedVersion: "0.0.0-e2e", allowVersionDrift: false },
        checkerEndpoints: [],
      },
      { applicationSchema: schema, sandboxes: new FakeSandboxProvider(), worker, github },
    );
    stack.deps.config.fakeSecurity = join(repoRoot, "test", "fixtures", "no-scanners.json");
    stack.deps.config.checkerModels.fakes = {
      review: scripted("review", { summary: "no defects found", findings: [] }),
      mapping: scripted("mapping", { mappings: [{ criterion: "AC1", status: "satisfied", evidence: ["ev-01"], reason: "the checks decide" }] }),
      criteria: scripted("criteria", { criteria: [{ text: CRITERIA_TEXT }] }),
    };
    stack.deps.evidence = { storage, bucket: "evidence" };

    const actions = windkeelActions({ github, enqueue });
    const response = await handleWebhook(delivery("issues", issuePayload(remote), "delivery-mb-1"), { secret: SECRET, pool, actions, permissions: github });
    assert.equal(response.status, 200);

    const repository = await getRepositoryByFullName(pool, OWNER, NAME);
    const runId = await waitFor(async () => {
      const task = await getEngineeringTaskBySource(pool, repository.id, "github_issue", `${OWNER}/${NAME}#7`);
      if (!task) return null;
      const { rows } = await pool.query("select id from engineering_run where task_id = $1", [task.id]);
      return rows[0]?.id ?? null;
    }, "a run to exist");
    const run = await waitFor(async () => {
      const current = await getEngineeringRun(pool, runId);
      return current && SETTLED.includes(current.status) ? current : null;
    }, "the run to settle");

    // --- the verdict is the code's, and the run went through ------------------------------
    assert.equal(run.status, "WAITING_FOR_HUMAN", run.statusReason ?? "");
    assert.equal(run.finalVerdict, "pass");
    const verifications = await listVerificationRuns(pool, runId);
    assert.equal(verifications.length, 1);

    // --- the screenshot was harvested, once, onto the feed --------------------------------
    const shots = await listMakerScreenshots(pool, runId);
    assert.equal(shots.length, 1);
    assert.equal(shots[0].sha256, PNG_SHA);
    assert.equal(shots[0].pageTitle, "<img src=x onerror=alert(1)>");
    assert.ok(storage.packages.has(`evidence/maker-browser/${runId}`));

    const deps = { pool, control: {} };
    const auth = { token: TOKEN, subject: "operator" };
    const api = (path) => handleApiRequest(deps, auth, { method: "GET", path, query: { get: () => undefined }, headers: { authorization: `Bearer ${TOKEN}` } });
    const feed = await api(`/v1/runs/${runId}/events`);
    assert.equal(feed.status, 200);
    const agentEvents = feed.body.items.filter((e) => e.kind === "agent").map((e) => e.event);
    const screenshotEvents = agentEvents.filter((e) => e.type === "screenshot");
    assert.equal(screenshotEvents.length, 1);
    assert.equal(screenshotEvents[0].screenshotId, shots[0].id);
    const unavailable = agentEvents.filter((e) => e.type === "browser_unavailable");
    assert.equal(unavailable.length, 1, "the repo asked for a browser the fake sandbox cannot give");
    assert.match(unavailable[0].reason, /isolatedFilesystem is false/);
    const listed = await api(`/v1/runs/${runId}/screenshots`);
    assert.equal(listed.body.items[0].evidence, false);

    // --- the candidate is the code change and nothing else ---------------------------------
    const [agentRun] = (await listAgentRuns(pool, runId)).filter((a) => a.role === "implementer");
    const candidate = agentRun.result.candidate;
    assert.deepEqual(candidate.filesChanged, ["index.js"]);
    const tree = spawnSync("git", ["--git-dir", remote.bare, "ls-tree", "-r", "--name-only", candidate.candidateSha], { encoding: "utf8" }).stdout;
    assert.doesNotMatch(tree, /\.windkeel/);
    // Byte-for-byte the tree a maker with no browser would have produced: base + the one edit.
    const control = tempDir("control");
    spawnSync("git", ["clone", "-q", remote.bare, control]);
    writeFileSync(join(control, "index.js"), FIXED_INDEX_JS);
    spawnSync("git", ["add", "-A"], { cwd: control });
    const controlTree = spawnSync("git", ["write-tree"], { cwd: control, encoding: "utf8" }).stdout.trim();
    const candidateTree = spawnSync("git", ["--git-dir", remote.bare, "rev-parse", `${candidate.candidateSha}^{tree}`], { encoding: "utf8" }).stdout.trim();
    assert.equal(candidateTree, controlTree, "the verifier's input is identical with or without the screenshot");
    assert.equal(verifications[0].candidateSha, candidate.candidateSha);

    // --- no evidence package carries it ----------------------------------------------------
    let evidenceFiles = 0;
    for (const [key, dir] of storage.packages) {
      if (key.startsWith("evidence/maker-browser/")) continue;
      for (const file of walk(dir)) {
        evidenceFiles++;
        const rel = relative(dir, file);
        assert.doesNotMatch(rel, /\.windkeel|maker-browser|001-home\.png/, `${key}/${rel}`);
        assert.notEqual(createHash("sha256").update(readFileSync(file)).digest("hex"), PNG_SHA, `${key}/${rel} is the screenshot`);
        assert.ok(!readFileSync(file, "utf8").includes(PNG_SHA), `${key}/${rel} references the screenshot`);
      }
    }
    assert.ok(evidenceFiles > 0, "the evidence package was stored and looked at");

    // --- people see it, labelled, apart from the verifier's surfaces ------------------------
    const pulls = await github.listPullRequests({ repository: REF, state: "all" });
    assert.equal(pulls.length, 1);
    assert.doesNotMatch(pulls[0].body, /screenshot/i, "the PR body stays the verifier's");
    const comments = github.commentsOn(REF, pulls[0].number);
    assert.equal(comments.length, 2, "the evidence comment and the maker's");
    const sticky = comments.find((c) => c.body.includes(stickyMarker(runId)));
    const makers = comments.find((c) => c.body.includes(makerScreenshotsMarker(runId)));
    assert.ok(sticky && makers && sticky !== makers);
    assert.doesNotMatch(sticky.body, /maker screenshot/i);
    assert.match(makers.body, /Maker screenshots — unverified, not verification evidence/);
    assert.match(makers.body, /maker agent/);
    assert.doesNotMatch(makers.body, /<img/, "the maker's title is neutralised, never markup");
    assert.match(makers.body, /http:\/\/localhost:3000\//);

    // --- a replayed harvest of the same files adds nothing ---------------------------------
    const replay = await new FakeSandboxProvider().create({ role: "maker", repoUrl: remote.bare });
    try {
      mkdirSync(join(replay.checkoutPath, ".windkeel", "browser"), { recursive: true });
      writeFileSync(join(replay.checkoutPath, ".windkeel", "browser", "001-home.png"), PNG);
      const again = await harvestMakerScreenshots(pool, { handle: replay, engineeringRunId: runId, agentRunId: agentRun.id, storage: { storage, bucket: "evidence" } });
      assert.deepEqual(again.uploaded, []);
      assert.equal((await listMakerScreenshots(pool, runId)).length, 1);
    } finally {
      await replay.destroy();
    }
    for (const workspace of await listWorkspaces(pool, runId)) {
      assert.ok(["destroyed", "teardown_failed"].includes(workspace.status));
    }
  } finally {
    await endExecutions(pool).catch(() => {});
    await stack?.stop().catch(() => {});
    await enqueue.stop().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
});
