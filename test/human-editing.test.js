import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { FakeHumanWorkspaceProvider } from "../dist/sandbox/human-workspace.js";
import { getEngineeringRun, insertEngineeringRun, insertEngineeringTask, listWorkspaces } from "../dist/factory/repositories.js";
import { advanceRun } from "../dist/factory/run-service.js";
import { recordCost } from "../dist/factory/cost-ledger.js";
import { listGuidance, recordGuidance } from "../dist/factory/run-guidance.js";
import {
  humanCycles,
  liveHumanSession,
  listHumanSessions,
  pendingHandback,
  queueHumanIntent,
  requestHumanSession,
  runCandidateHistory,
  setTaskSessionMode,
  TAKEOVER_MISSED_BOUNDARY,
} from "../dist/factory/human-session.js";
import { PostgresRunStateStore } from "../dist/factory/workflow/run-state-store.js";
import { SandboxRegistry } from "../dist/factory/workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "../dist/factory/workflow/session-registry.js";
import { createProvisioningHandler } from "../dist/factory/workflow/handlers/provisioning.js";
import { createImplementingHandler } from "../dist/factory/workflow/handlers/implementing.js";
import { createHumanEditingHandler } from "../dist/factory/workflow/handlers/human-editing.js";
import { createWaitingForHumanHandler } from "../dist/factory/workflow/handlers/pr-creating.js";
import { authorFor, createVerifyingHandler, runCandidates } from "../dist/factory/workflow/handlers/verifying.js";
import { insertVerificationRun, updateVerificationRun } from "../dist/factory/repositories.js";
import { bareFixtureRepo, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * HUMAN_EDITING in the workflow (ADR-0029 §3, #369), stage by stage against real git and the fake
 * sandboxes: a takeover honoured at the turn boundary and never mid-turn; the human workspace
 * provisioned, slept, expired and cancelled; submit and hand back through the bundle-out push
 * path; *Make changes* from WAITING_FOR_HUMAN; Pair mode; the spend cap; provenance.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const PERSON = { id: 583231, login: "octocat" };
const WINDKEEL_EMAIL = "factory@windkeel.invalid";
let counter = 0;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

/**
 * A resumable worker whose turns are scripted. `poll` reports the turn running until `endTurn()`,
 * so "a takeover waits for the boundary" is observable. Turn 2 (after a hand back) edits a file.
 */
class TurnWorker {
  constructor() {
    this.name = "fake-turns";
    this.capabilities = { resumableSessions: true, reattachableSessions: false, reattachedSessionsAcceptNewTurns: true };
    this.sends = [];
    this.turn = 1;
    this.running = true;
    this.holdTurn = false;
  }
  async start(input) {
    this.sandbox = input.sandbox;
    await input.sandbox.writeFile("index.js", "console.log('maker');\n");
    this.running = true;
    return { id: "session-1" };
  }
  reference() {
    return { id: "session-1", workerType: this.name, adapterState: {} };
  }
  async attach() {
    return { id: "session-1" };
  }
  async send(_session, message) {
    this.sends.push(message);
    this.turn += 1;
    this.running = true;
    await this.sandbox.writeFile("agent-after-handback.js", "// resumed\n");
  }
  async cancel() {}
  async poll() {
    if (this.holdTurn) return { events: [{ type: "started", sessionId: "s" }], turnEnded: false };
    return { events: [{ type: "completed", usage: { inputTokens: 1, outputTokens: 1 } }], turnEnded: true };
  }
  async *events() {}
  async result() {
    const files = this.turn === 1 ? ["index.js"] : ["agent-after-handback.js"];
    return { outcome: "completed", diff: { patch: `+${files[0]}\n`, filesChanged: files, truncated: false }, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

async function withRun(fn, options = {}) {
  const schema = `windkeel_human_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "true" });
  const registry = new SandboxRegistry();
  const workspaces = new FakeHumanWorkspaceProvider();
  const worker = new TurnWorker();
  const tokenLog = [];
  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    await pool.query("update principal set github_user_id = $1, github_login = $2 where is_bootstrap", [PERSON.id, PERSON.login]);
    const principalId = (await pool.query("select id from principal where is_bootstrap")).rows[0].id;
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "local",
      sourceReference: "ia-369",
      title: "Greet",
      description: "Make index.js print hello.",
      acceptanceCriteria: [{ id: "ac-1", text: "it greets" }],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    if (options.pair) await setTaskSessionMode(pool, task.id, "pair", principalId);
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: options.spendCapUsd ?? 10_000, wallClockCapSeconds: 7200 });
    for (const to of ["CLASSIFYING", "PLANNING", "PROVISIONING"]) await advanceRun(pool, run.id, to, "test seed");

    let now = options.now ?? null;
    const deps = {
      pool,
      sandboxes: new FakeSandboxProvider(),
      worker,
      registry,
      sessions: new WorkerSessionRegistry(),
      humanEditing: {
        workspaces,
        pushTokens: {
          async mint(request) {
            tokenLog.push(`mint ${request.purpose}`);
            return { username: "x-access-token", token: "ghs_jit", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
          },
          async revoke() {
            tokenLog.push("revoke");
          },
        },
        now: () => now ?? new Date(),
      },
      config: {
        repository: { url: remote.bare, baseRevision: "HEAD" },
        makerModel: "gpt-5-codex",
        makerVendor: "openai",
        modelApiDomain: "api.openai.com",
        modelKeyEnvVar: "OPENAI_API_KEY",
        modelPricing: { usdPerInputToken: 0, usdPerOutputToken: 0 },
        usdPerCpuMs: 0,
        usdPerEgressByte: 0,
        railsCheckIntervalMs: 60_000,
        workspaceTtlMs: 600_000,
        gitHost: "github.com",
        gitAuthorName: "Windkeel Factory",
        gitAuthorEmail: WINDKEEL_EMAIL,
        policyVersion: "test",
        checkerModels: { endpoints: [], maker: { vendor: "openai", model: "gpt-5-codex" } },
      },
    };
    const store = new PostgresRunStateStore(pool);
    let cancel = false;
    const handlers = {
      PROVISIONING: createProvisioningHandler(deps),
      IMPLEMENTING: createImplementingHandler(deps),
      HUMAN_EDITING: createHumanEditingHandler(deps),
      WAITING_FOR_HUMAN: createWaitingForHumanHandler(deps),
      VERIFYING: createVerifyingHandler(deps),
    };
    /** One stage delivery without committing its outcome: the window a race lands in. */
    const handleOnly = async () => {
      const state = (await getEngineeringRun(pool, run.id)).status;
      return handlers[state].handle({
        engineeringRunId: run.id,
        state,
        attempt: 1,
        isCancellationRequested: async () => cancel,
        takeSignals: async () => [],
        runs: store,
      });
    };
    const commit = async (outcome) => {
      if (outcome.kind === "transition") await store.commit(run.id, outcome.to, outcome.reason ?? null, outcome.stopReason ?? null);
      return outcome;
    };
    const deliver = async () => commit(await handleOnly());
    const state = async () => (await getEngineeringRun(pool, run.id)).status;
    const takeOver = (origin = "takeover", requestedFrom = "IMPLEMENTING") =>
      requestHumanSession(pool, {
        engineeringRunId: run.id,
        principalId,
        actor: PERSON.login,
        githubUserId: PERSON.id,
        githubLogin: PERSON.login,
        displayName: "The Octocat",
        origin,
        requestedFrom,
      });
    const branchHead = async () => {
      const [maker] = await listWorkspaces(pool, run.id);
      return git(remote.bare, "rev-parse", `refs/heads/${maker.workingBranch}`);
    };
    await deliver(); // PROVISIONING -> IMPLEMENTING
    assert.equal(await state(), "IMPLEMENTING");
    await fn({
      pool,
      run,
      deps,
      worker,
      workspaces,
      tokenLog,
      remote,
      deliver,
      handleOnly,
      commit,
      state,
      takeOver,
      branchHead,
      principalId,
      setNow: (value) => {
        now = value;
      },
      requestCancellation: () => {
        cancel = true;
      },
    });
  } finally {
    for (const [, handle] of registry.entries()) await handle.destroy().catch(() => {});
    workspaces.cleanup();
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

/** Takes the run to HUMAN_EDITING with a ready workspace. */
async function toReadyWorkspace(ctx) {
  await ctx.takeOver();
  assert.equal((await ctx.deliver()).to, "HUMAN_EDITING");
  await ctx.deliver(); // provisions
  const session = await liveHumanSession(ctx.pool, ctx.run.id);
  assert.equal(session.state, "ready");
  return session;
}

test("a takeover is honoured at the turn boundary, never mid-turn; guidance waits for the hand back", { skip }, async () => {
  await withRun(async (ctx) => {
    ctx.worker.holdTurn = true;
    await ctx.takeOver();
    await recordGuidance(ctx.pool, { engineeringRunId: ctx.run.id, actor: "op", actorPrincipalId: null, message: "use tabs" });

    const midTurn = await ctx.deliver();
    assert.equal(midTurn.kind, "poll", "mid-turn: the takeover waits");
    assert.equal(await ctx.state(), "IMPLEMENTING");

    ctx.worker.holdTurn = false;
    const boundary = await ctx.deliver();
    assert.equal(boundary.kind, "transition");
    assert.equal(boundary.to, "HUMAN_EDITING", boundary.reason);
    assert.match(boundary.reason, /took over at a turn boundary/);
    assert.equal(ctx.worker.sends.length, 0, "no guidance turn started at the takeover boundary");
    assert.equal((await listGuidance(ctx.pool, ctx.run.id, "HUMAN_EDITING"))[0].state, "queued");

    const session = await liveHumanSession(ctx.pool, ctx.run.id);
    assert.equal(session.seedSha, await ctx.branchHead(), "the seed is the maker's captured candidate on the branch");
    const [maker] = await listWorkspaces(ctx.pool, ctx.run.id);
    assert.equal(maker.status, "ready", "the maker sandbox is held while HUMAN_EDITING (ADR-0017 as amended)");
  });
});

test("submit: one commit as the person on the seed, pushed by the host with a revoked JIT token, then VERIFYING; provenance is mixed", { skip }, async () => {
  await withRun(async (ctx) => {
    const session = await toReadyWorkspace(ctx);
    const fake = ctx.workspaces.created[0];
    assert.equal(git(fake.checkoutPath, "rev-parse", "HEAD"), session.seedSha);
    writeFileSync(join(fake.checkoutPath, "human.js"), "// the person's change\n");

    assert.ok(await queueHumanIntent(ctx.pool, session.id, "submit"));
    const outcome = await ctx.deliver();
    assert.equal(outcome.to, "VERIFYING", outcome.reason);

    const head = await ctx.branchHead();
    assert.notEqual(head, session.seedSha);
    assert.equal(git(ctx.remote.bare, "log", "-1", "--format=%P", head), session.seedSha, "parent = seed");
    assert.equal(git(ctx.remote.bare, "log", "-1", "--format=%ae", head), `${PERSON.id}+${PERSON.login}@users.noreply.github.com`);
    assert.notEqual(git(ctx.remote.bare, "log", "-1", "--format=%ae", head), WINDKEEL_EMAIL, "never WINDKEEL_GIT_AUTHOR_EMAIL");
    assert.deepEqual(ctx.tokenLog.map((l) => l.split(" ")[0]), ["mint", "revoke"], "minted for the push, revoked after it");
    assert.ok(!fake.contains("ghs_jit").files.length && !fake.contains("ghs_jit").envs.length, "the push token never entered the workspace");

    const [ended] = await listHumanSessions(ctx.pool, ctx.run.id);
    assert.equal(ended.outcome, "submitted");
    assert.deepEqual(ended.commits.map((c) => [c.sha, c.parentSha, c.kind]), [[head, session.seedSha, "submit"]]);
    assert.ok(fake.destroyed, "the human workspace is deleted when the run leaves HUMAN_EDITING");
    assert.deepEqual(await humanCycles(ctx.pool, ctx.run.id), { used: 1, cap: 10 });

    // VERIFYING verifies the person's candidate; the package names who wrote it.
    const shas = await runCandidates(ctx.pool, ctx.run.id);
    assert.equal(shas.at(-1), head, "the verifier gets the person's commit, through git");
    const history = await runCandidateHistory(ctx.pool, ctx.run.id);
    assert.deepEqual(history.map((c) => [c.commitAuthor, c.provenance]), [["maker", "maker"], ["person", "mixed"]]);
    const author = authorFor(history, head, { login: "fake-turns", agent: "fake-turns/gpt-5-codex" });
    assert.equal(author.provenance, "mixed");
    assert.equal(author.login, PERSON.login);
    assert.equal(author.agent, "fake-turns/gpt-5-codex", "independence is still judged against the maker");
    assert.deepEqual(author.commits.map((c) => c.by), ["maker", "person"]);
    const makerOnly = authorFor(history, shas[0], { login: "fake-turns", agent: "fake-turns/gpt-5-codex" });
    assert.deepEqual(makerOnly, { login: "fake-turns", kind: "agent", agent: "fake-turns/gpt-5-codex" }, "a maker-only candidate reads as before");
  });
});

test("hand back: the maker fetches the person's commit and resumes with a turn that says what changed", { skip }, async () => {
  await withRun(async (ctx) => {
    const session = await toReadyWorkspace(ctx);
    const fake = ctx.workspaces.created[0];
    writeFileSync(join(fake.checkoutPath, "human.js"), "// the person's change\n");
    await recordGuidance(ctx.pool, { engineeringRunId: ctx.run.id, actor: "op", actorPrincipalId: null, message: "keep it short" });
    await queueHumanIntent(ctx.pool, session.id, "handback");

    const back = await ctx.deliver();
    assert.equal(back.to, "IMPLEMENTING", back.reason);
    const personSha = await ctx.branchHead();
    const [maker] = await listWorkspaces(ctx.pool, ctx.run.id);
    const makerHandle = ctx.deps.registry.get(maker.id);
    assert.equal(git(makerHandle.checkoutPath, "rev-parse", "HEAD"), personSha, "the maker's checkout is at the person's commit");
    assert.ok(await pendingHandback(ctx.pool, ctx.run.id));

    const resumed = await ctx.deliver();
    assert.equal(resumed.to, "VERIFYING", resumed.reason);
    assert.equal(ctx.worker.sends.length, 1, "one resumed turn on the held session");
    assert.match(ctx.worker.sends[0].text, new RegExp(personSha), "the turn names the person's commit");
    assert.match(ctx.worker.sends[0].text, /keep it short/, "queued guidance rides the resume turn");
    assert.equal(await pendingHandback(ctx.pool, ctx.run.id), null);
    const head = await ctx.branchHead();
    assert.equal(git(ctx.remote.bare, "log", "-1", "--format=%P", head), personSha, "the agent built on the person's commit");
    const history = await runCandidateHistory(ctx.pool, ctx.run.id);
    assert.deepEqual(history.map((c) => c.commitAuthor), ["maker", "person", "maker"]);
    assert.equal(history.at(-1).provenance, "mixed");
  });
});

test("a submit refused because the branch moved leaves the workspace for another try; the token is still revoked", { skip }, async () => {
  await withRun(async (ctx) => {
    const session = await toReadyWorkspace(ctx);
    writeFileSync(join(ctx.workspaces.created[0].checkoutPath, "human.js"), "x\n");
    // Something else advanced the run branch.
    const [maker] = await listWorkspaces(ctx.pool, ctx.run.id);
    const tree = git(ctx.remote.bare, "rev-parse", `${session.seedSha}^{tree}`);
    const moved = git(ctx.remote.bare, "-c", "user.name=x", "-c", "user.email=x@y", "commit-tree", tree, "-p", session.seedSha, "-m", "moved");
    git(ctx.remote.bare, "update-ref", `refs/heads/${maker.workingBranch}`, moved);

    await queueHumanIntent(ctx.pool, session.id, "submit");
    const outcome = await ctx.deliver();
    assert.equal(outcome.kind, "wait");
    assert.equal(await ctx.state(), "HUMAN_EDITING");
    const after = await liveHumanSession(ctx.pool, ctx.run.id);
    assert.equal(after.state, "ready");
    assert.equal(after.intent, null);
    assert.match(after.error, /moved since the workspace was seeded/);
    assert.equal(git(ctx.remote.bare, "rev-parse", `refs/heads/${maker.workingBranch}`), moved, "nothing was pushed");
    assert.deepEqual(ctx.tokenLog.map((l) => l.split(" ")[0]), ["mint", "revoke"]);
    assert.ok(!ctx.workspaces.created[0].destroyed, "the person's files survive the refusal");
  });
});

test("the workspace sleeps after 30 idle minutes and is deleted at 24 h (the run is BLOCKED, not failed)", { skip }, async () => {
  await withRun(async (ctx) => {
    const session = await toReadyWorkspace(ctx);
    const fake = ctx.workspaces.created[0];
    ctx.setNow(new Date(session.startedAt.getTime() + 31 * 60_000));
    assert.equal((await ctx.deliver()).kind, "wait");
    assert.equal((await liveHumanSession(ctx.pool, ctx.run.id)).state, "sleeping");
    assert.ok(fake.events.includes("slept"));

    ctx.setNow(new Date(session.startedAt.getTime() + 25 * 60 * 60_000));
    const expired = await ctx.deliver();
    assert.equal(expired.to, "BLOCKED");
    assert.match(expired.reason, /24 hours/);
    assert.ok(fake.destroyed);
    assert.equal((await listHumanSessions(ctx.pool, ctx.run.id))[0].outcome, "expired");
  });
});

test("cancel while editing deletes the workspace and ends the session", { skip }, async () => {
  await withRun(async (ctx) => {
    await toReadyWorkspace(ctx);
    ctx.requestCancellation();
    const outcome = await ctx.deliver();
    assert.equal(outcome.kind, "settled");
    assert.ok(ctx.workspaces.created[0].destroyed);
    assert.equal((await listHumanSessions(ctx.pool, ctx.run.id))[0].outcome, "cancelled");
  });
});

test("the spend cap still applies while a person edits: the run is CANCELLED with stop reason spend_cap", { skip }, async () => {
  await withRun(
    async (ctx) => {
      await toReadyWorkspace(ctx);
      await recordCost(ctx.pool, { engineeringRunId: ctx.run.id, stageType: "workspace", stageId: ctx.run.id, kind: "sandbox", usd: 5 });
      const outcome = await ctx.deliver();
      assert.equal(outcome.to, "CANCELLED");
      assert.equal(outcome.stopReason, "spend_cap");
      assert.ok(ctx.workspaces.created[0].destroyed);
    },
    { spendCapUsd: 1 },
  );
});

test("Make changes on a verified PR: WAITING_FOR_HUMAN -> HUMAN_EDITING seeded from the PR's head", { skip }, async () => {
  await withRun(async (ctx) => {
    await ctx.deliver(); // IMPLEMENTING -> VERIFYING (no takeover)
    assert.equal(await ctx.state(), "VERIFYING");
    for (const to of ["PR_CREATING", "PR_READY", "WAITING_FOR_HUMAN"]) await advanceRun(ctx.pool, ctx.run.id, to, "test");
    assert.equal((await ctx.deliver()).kind, "wait", "an open PR with nothing requested waits");
    await ctx.takeOver("make_changes", "WAITING_FOR_HUMAN");
    const outcome = await ctx.deliver();
    assert.equal(outcome.to, "HUMAN_EDITING");
    assert.equal((await liveHumanSession(ctx.pool, ctx.run.id)).seedSha, await ctx.branchHead());
  });
});

test("Pair mode stops after the first implementing turn, before anything is verified", { skip }, async () => {
  await withRun(
    async (ctx) => {
      const outcome = await ctx.deliver();
      assert.equal(outcome.to, "HUMAN_EDITING", outcome.reason);
      assert.match(outcome.reason, /Pair mode/);
      const session = await liveHumanSession(ctx.pool, ctx.run.id);
      assert.equal(session.origin, "pair");
      assert.equal(session.githubLogin, PERSON.login);
    },
    { pair: true },
  );
});

test("a human workspace never reads a repository secret: no private key, no secret row, nothing in the install's environment", { skip }, async () => {
  await withRun(async (ctx) => {
    await ctx.takeOver();
    assert.equal((await ctx.deliver()).to, "HUMAN_EDITING");
    // From here on, any reach for the secrets is recorded.
    const reads = [];
    Object.defineProperty(ctx.deps.config, "secretPrivateKey", {
      configurable: true,
      get() {
        reads.push("secretPrivateKey");
        return "MC4CAQAwBQYDK2VuBCIEIPRIVATE";
      },
    });
    const query = ctx.pool.query.bind(ctx.pool);
    ctx.pool.query = (text, ...rest) => {
      if (typeof text === "string" && /repository_secret/.test(text)) reads.push(text);
      return query(text, ...rest);
    };
    try {
      await ctx.deliver(); // provisions the human workspace
    } finally {
      ctx.pool.query = query;
    }
    const session = await liveHumanSession(ctx.pool, ctx.run.id);
    assert.equal(session.state, "ready", session.error ?? "");
    assert.deepEqual(reads, [], "no secret is opened, or even looked up, for a human workspace");
    const fake = ctx.workspaces.created[0];
    const install = fake.execs.find((e) => e.command === "npm" || /install|ci/.test(e.args.join(" ")));
    if (install) assert.ok(!Object.keys(install.env).some((k) => /TOKEN|SECRET|NPM_/.test(k)), "nothing secret-shaped in the install env");
    assert.match(session.installNote, /Installed without repository secrets — private dependencies may be missing/, "the session says so");
  });
});

test("a takeover accepted after the boundary read is expired when the turn's transition commits — with a reason — and blocks nothing", { skip }, async () => {
  await withRun(async (ctx) => {
    // The stage reads "no takeover" and decides VERIFYING ...
    const outcome = await ctx.handleOnly();
    assert.equal(outcome.to, "VERIFYING");
    // ... the API accepts a takeover in the window before the transition commits ...
    await ctx.takeOver();
    // ... and the commit, under the same row lock, expires it.
    await ctx.commit(outcome);
    assert.equal(await ctx.state(), "VERIFYING");
    assert.equal(await liveHumanSession(ctx.pool, ctx.run.id), null, "no live session is left to block a later one");
    const [expired] = await listHumanSessions(ctx.pool, ctx.run.id);
    assert.deepEqual([expired.state, expired.outcome], ["ended", "expired"]);
    assert.equal(expired.error, TAKEOVER_MISSED_BOUNDARY);
    assert.match(expired.error, /turn ended before Windkeel could stop — take over again/);
    // A later Make changes is not refused as already_editing.
    for (const to of ["PR_CREATING", "PR_READY", "WAITING_FOR_HUMAN"]) await advanceRun(ctx.pool, ctx.run.id, to, "test");
    await ctx.takeOver("make_changes", "WAITING_FOR_HUMAN");
    assert.equal((await ctx.deliver()).to, "HUMAN_EDITING");
  });
});

test("a submit lands, the worker dies before recording it; the redelivery sees its own SHA at the head and completes", { skip }, async () => {
  await withRun(async (ctx) => {
    const session = await toReadyWorkspace(ctx);
    writeFileSync(join(ctx.workspaces.created[0].checkoutPath, "human.js"), "// the person's change\n");
    await queueHumanIntent(ctx.pool, session.id, "submit");

    // The push lands, then the worker dies before the session records it: the first `commits`
    // update throws once (after the push), as a crash at that point would.
    const query = ctx.pool.query.bind(ctx.pool);
    let crashed = false;
    ctx.pool.query = (text, values, ...rest) => {
      if (!crashed && typeof text === "string" && /update human_session set commits/.test(text)) {
        crashed = true;
        return Promise.reject(new Error("worker died"));
      }
      return query(text, values, ...rest);
    };
    await assert.rejects(ctx.deliver(), /worker died/);
    ctx.pool.query = query;
    const landed = await ctx.branchHead();
    assert.notEqual(landed, session.seedSha, "the push had landed");
    const mid = await liveHumanSession(ctx.pool, ctx.run.id);
    assert.equal(mid.pushSha, landed, "the verified SHA was recorded before the push");
    assert.deepEqual(mid.commits, [], "but the session never recorded the commit");

    const redelivered = await ctx.deliver();
    assert.equal(redelivered.to, "VERIFYING", redelivered.reason);
    assert.equal(await ctx.branchHead(), landed, "nothing new was pushed");
    const [ended] = await listHumanSessions(ctx.pool, ctx.run.id);
    assert.equal(ended.outcome, "submitted");
    assert.deepEqual(ended.commits.map((c) => c.sha), [landed]);
  });
});

test("a Make changes candidate that fails verification stops at BLOCKED, not REPAIRING with no maker to repair in", { skip }, async () => {
  await withRun(async (ctx) => {
    await ctx.deliver(); // IMPLEMENTING -> VERIFYING
    for (const to of ["PR_CREATING", "PR_READY", "WAITING_FOR_HUMAN"]) await advanceRun(ctx.pool, ctx.run.id, to, "test");
    // The maker ended when the pull request opened.
    await ctx.pool.query("update workspace set status = 'destroyed' where engineering_run_id = $1", [ctx.run.id]);
    await ctx.takeOver("make_changes", "WAITING_FOR_HUMAN");
    assert.equal((await ctx.deliver()).to, "HUMAN_EDITING");
    await ctx.deliver(); // provisions
    const session = await liveHumanSession(ctx.pool, ctx.run.id);
    writeFileSync(join(ctx.workspaces.created[0].checkoutPath, "human.js"), "// breaks the build\n");
    await queueHumanIntent(ctx.pool, session.id, "submit");
    assert.equal((await ctx.deliver()).to, "VERIFYING");

    // The verifier judged the person's candidate: fail, with repair budget left.
    const head = await ctx.branchHead();
    const verification = await insertVerificationRun(ctx.pool, { engineeringRunId: ctx.run.id, candidateSha: head, policyVersion: "test" });
    await updateVerificationRun(ctx.pool, verification.id, { verdict: "fail", startedAt: new Date(), completedAt: new Date() });
    const outcome = await ctx.deliver();
    assert.equal(outcome.to, "BLOCKED", outcome.reason);
    assert.match(outcome.reason, /no agent session to repair them/);
  });
});
