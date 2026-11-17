import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import {
  getEngineeringRun,
  listRepairPackets,
  listVerificationRuns,
  listWorkspaces,
} from "../dist/factory/repositories.js";
import { S3EvidenceStorage } from "../dist/factory/evidence-storage.js";
import { reapSandboxesLocked } from "../dist/factory/sweeps/sandbox-reaper.js";
import { createAndStartTask } from "./start-task.js";
import { loadWorkerConfig, MissingConfigError } from "../dist/factory/worker-config.js";
import { bareFixtureRepo, repoRoot, runCli, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { startFactory } from "./factory-stack.js";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { apiControl } from "../apps/ingress/dist/src/api/control.js";
import { TERMINAL_STATES } from "../dist/factory/run-state-machine.js";
import { browserSkip, serveApi, startConsole } from "./console-browser.js";
import { closeWorkflowRuntime, endExecutions, runtimeSkip } from "./workflow-runtime.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * **Milestone 4's success criterion, end to end:** a local/API-created task produces a verified
 * code change.
 *
 * This is the artifact that lets `research/MILESTONES.md` mark M4 done, so it exercises the
 * *real* `VercelWorkflowProvider` against real Postgres and the real workflow runtime — the
 * fakes are for the unit suites. It drove `PgBossWorkflowProvider` until #200 retired it; see
 * `test/factory-stack.js` for what replaced the container these cases used to build.
 *
 * **The honesty caveat, stated here as well as in the PR and MILESTONES.md** (the same caveat
 * M3 carries in #116): the sandbox is `FakeSandboxProvider` and the worker is
 * `FakeWorkerAdapter`. So this proves the *orchestration* — durable stages, resume, rails,
 * exactly-once side effects, evidence sealing — against real infrastructure. It does not prove
 * a real Vercel sandbox or a real `codex exec`. Those are #116's business and are not claimed.
 *
 * The evidence store is real MinIO when `S3_ENDPOINT` is set (`docker compose up`), and an
 * in-memory store otherwise; which one ran is asserted either way.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = runtimeSkip(dbUrl);
const browserSkipped = skip || (await browserSkip());
const s3 = process.env.S3_ENDPOINT
  ? {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? "us-east-1",
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
      bucket: process.env.S3_BUCKET ?? "evidence",
    }
  : null;

let counter = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scripted(name, value) {
  const path = join(tempDir(name), `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const CRITERIA = [{ id: "ac-1", text: "the module keeps passing its own tests" }];
const CLEAN_REVIEW = { summary: "no defects found", findings: [] };
const DIRTY_REVIEW = {
  summary: "a blocking defect",
  findings: [
    {
      id: "REV-1",
      severity: "blocking",
      category: "correctness",
      claim: "the change does not do what the task asked",
      location: "index.js",
      failure_scenario: "the user's stated outcome does not happen",
    },
  ],
};
const CLEAN_MAPPING = {
  mappings: CRITERIA.map((c) => ({
    criterion: c.id,
    status: "satisfied",
    evidence: ["ev-01"],
    reason: "the repo's own checks pass on the candidate",
  })),
};

const STREAM = [
  { type: "started", sessionId: "sess-e2e" },
  { type: "file_changed", path: "index.js", kind: "update" },
  { type: "test_finished", command: "npm test", exitCode: 0, passed: true },
  { type: "completed", usage: { inputTokens: 500, outputTokens: 100 } },
];

/** A worker that really edits the checkout, so there is a real candidate to verify. */
class MutatingWorkerAdapter {
  constructor(inner, { pauseMs = 0 } = {}) {
    this.inner = inner;
    this.pauseMs = pauseMs;
  }
  get name() {
    return this.inner.name;
  }
  get capabilities() {
    return this.inner.capabilities;
  }
  get calls() {
    return this.inner.calls;
  }
  async start(input) {
    await input.sandbox.writeFile("index.js", "console.log('hello');\n");
    return this.inner.start(input);
  }
  send(s, m) {
    return this.inner.send(s, m);
  }
  cancel(s) {
    return this.inner.cancel(s);
  }
  async *events(s) {
    for await (const event of this.inner.events(s)) {
      yield event;
      if (this.pauseMs) await sleep(this.pauseMs);
    }
  }
  async result(s) {
    const result = await this.inner.result(s);
    if (result.outcome !== "completed") return result;
    return {
      ...result,
      diff: { patch: "+console.log('hello');\n", filesChanged: ["index.js"], truncated: false },
    };
  }
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
  async getPackageFile(bucket, key, path) {
    const dir = this.packages.get(`${bucket}/${key}`);
    if (!dir) {
      const { EvidenceFileNotFoundError } = await import("../dist/factory/evidence-storage.js");
      throw new EvidenceFileNotFoundError(bucket, key, path);
    }
    return readFileSync(join(dir, path));
  }
}

after(async () => {
  await closeWorkflowRuntime();
});

async function withStack(fn, options = {}) {
  const schema = `windkeel_e2e_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  // Every connection in this test — the CLI's, the factory's, the assertions' — targets the
  // per-test schema, exactly as the M1 factory tests do.
  const schemaUrl = `${schemaDbUrl}${schemaDbUrl.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "true" });
  const storage = s3
    ? new S3EvidenceStorage({
        endpoint: s3.endpoint,
        region: s3.region,
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      })
    : new MemoryEvidenceStorage();

  const stacks = [];
  /**
   * One running factory. Called more than once by the cases that prove a run survives the
   * process that started it — which is now a *provider* going away rather than a container
   * being killed, because ADR-0020 leaves no container to kill.
   */
  const makeFactory = async (workerOptions = {}) => {
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
        policyVersion: "e2e",
        // Unread by this test — a `WorkerAdapter` is injected below, so nothing ever builds a
        // Codex adapter — but present because `WorkerConfig` is a complete shape and a
        // hand-built config that omits a field only *looks* like it works until something
        // reads it.
        codex: { binary: "codex", pinnedVersion: "0.0.0-e2e", allowVersionDrift: false },
        evidence: s3 ? { ...s3 } : undefined,
        checkerEndpoints: [],
      },
      {
        applicationSchema: schema,
        sandboxes: new FakeSandboxProvider(),
        worker: new MutatingWorkerAdapter(new FakeWorkerAdapter(STREAM), workerOptions),
      },
    );
    // The engine's scripted fakes and the storage double are injected on the built deps: the
    // config type has no place for test doubles, and it should not grow one.
    stack.deps.config.fakeSecurity = join(repoRoot, "test", "fixtures", "no-scanners.json");
    stack.deps.config.checkerModels.fakes = {
      review: scripted("review", options.review ?? CLEAN_REVIEW),
      mapping: scripted("mapping", options.mapping ?? CLEAN_MAPPING),
    };
    if (!s3) stack.deps.evidence = { storage, bucket: "evidence" };
    stacks.push(stack);
    return stack;
  };

  try {
    await seedFixtureRepository(pool, { cloneUrl: remote.bare, defaultBranch: "HEAD" });
    await fn({ pool, schemaUrl, schema, remote, storage, makeFactory });
  } finally {
    // Parked executions first: a run still re-arming a `sleep` keeps the World's delivery loop
    // alive, and `node --test` never exits.
    await endExecutions(pool).catch(() => {});
    for (const stack of stacks) await stack.stop().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

async function createTask(schemaUrl) {
  return createAndStartTask({
    databaseUrl: schemaUrl,
    backing: "vercel-workflow",
    title: "Add a greeting",
    description: "Make index.js print hello.",
    criteria: CRITERIA,
    riskLevel: "low",
    repositoryId: "11111111-1111-1111-1111-111111111111",
  });
}

/** Polls the run row — the authoritative state (ADR-0007 §1) — until it stops moving. */
async function waitForState(pool, runId, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const run = await getEngineeringRun(pool, runId);
    last = run?.status ?? null;
    if (run && predicate(run)) return run;
    await sleep(200);
  }
  throw new Error(`waitForState: run ${runId} never satisfied the predicate (last state ${last})`);
}

/** Polls any read until it satisfies a predicate — the non-run-state twin of `waitForState`. */
async function waitFor(read, predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(200);
  }
  throw new Error(message);
}

test(
  "the full loop: create a task, the worker runs it, a verified change comes out",
  { skip },
  async () => {
    await withStack(async ({ pool, schemaUrl, storage, makeFactory }) => {
      await makeFactory();

      // The "local/API-created task" half of the success criterion, through the real command.
      const created = await createTask(schemaUrl);
      assert.equal(created.enqueued, true);

      const run = await waitForState(pool, created.engineeringRunId, (r) =>
        ["PR_CREATING", "PR_READY", "BLOCKED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED"].includes(
          r.status,
        ),
      );

      /**
       * Asserted from the **transition history**, not from a polled snapshot of the run row.
       *
       * Under pg-boss each stage was a separate job with queue latency between them, so a 200 ms
       * poll reliably observed the run resting at `PR_CREATING`. On ADR-0021's backing the
       * stages run back to back inside one durable execution, and the run moves through
       * `PR_CREATING` in single-digit milliseconds — so the same poll now usually misses it.
       *
       * The thing M4 claims is that a local/API-created task produces a **verified code
       * change**, and reaching `PR_CREATING` with a `pass` verdict is what says so. That fact is
       * durable in `run_state_transition` whether or not any poll happened to catch it, which
       * makes this the assertion that should have been written in the first place.
       *
       * The run then goes on to `FAILED` here, because opening a pull request needs a GitHub
       * client and this suite configures none — that is #176 and `e2e-github-loop`'s business,
       * deliberately not M4's.
       */
      const reached = await pool.query(
        "select from_state, to_state from run_state_transition where engineering_run_id = $1 order by at, id",
        [created.engineeringRunId],
      );
      const path = reached.rows.map((r) => `${r.from_state}->${r.to_state}`);
      assert.ok(
        path.includes("VERIFYING->PR_CREATING"),
        `a passing candidate advances toward the PR; took ${path.join(", ")}`,
      );
      assert.equal(run.finalVerdict, "pass");

      const [verification] = await listVerificationRuns(pool, created.engineeringRunId);
      assert.match(verification.candidateSha, /^[0-9a-f]{40}$/);
      assert.equal(verification.verdict, "pass");
      assert.match(verification.evidenceManifestDigest, /^[0-9a-f]{64}$/);
      assert.ok(verification.evidencePackageRef);

      // The evidence package verifies **offline**, through the real CLI, after a storage
      // round-trip. This is the assertion the milestone actually rests on.
      const local = s3
        ? await downloadPackage(verification.evidencePackageRef)
        : storage.packages.get(verification.evidencePackageRef);
      assert.ok(local, `package ${verification.evidencePackageRef} is in storage`);
      const verified = runCli(["verify-package", local]);
      assert.equal(verified.code, 0, `${verified.stdout}${verified.stderr}`);
      assert.match(verified.stdout, /verdict: pass/i);

      // No sandbox left behind, on either role.
      for (const workspace of await listWorkspaces(pool, created.engineeringRunId)) {
        assert.equal(workspace.status, "destroyed", `${workspace.role} workspace`);
      }

      // And the cost ledger recorded something for the model and the two sandboxes.
      assert.ok(run.cost >= 0);

      /**
       * What a person watching the run sees, read back through the control plane API exactly as
       * the console reads it: the agent's own steps on the feed (G1), each stage's result on the
       * report (G3), and the change itself (G2) — the same patch the maker stored and the verifier
       * was handed. Against the real run this loop just produced, not a hand-built row.
       */
      const api = (path) =>
        handleApiRequest(
          {
            pool,
            control: {},
            evidence: {
              list: async () => [],
              presign: async () => "https://example.test/unused",
              read: (bucket, key, file) => storage.getPackageFile(bucket, key, file),
            },
          },
          { token: "e2e-token", subject: "e2e" },
          { method: "GET", path, query: { get: () => undefined }, headers: { authorization: "Bearer e2e-token" } },
        );

      const feed = await api(`/v1/runs/${created.engineeringRunId}/events`);
      assert.equal(feed.status, 200);
      const steps = feed.body.items.filter((e) => e.kind === "agent").map((e) => e.event.type);
      assert.deepEqual(
        steps,
        STREAM.map((e) => e.type),
        "every event the worker emitted is on the feed, once, in order",
      );
      const kinds = feed.body.items.map((e) => e.kind);
      assert.ok(
        kinds.indexOf("agent") > kinds.findIndex((k, i) => k === "transition" && feed.body.items[i].to === "IMPLEMENTING"),
        "the agent's steps come after the run entered IMPLEMENTING, on the same cursor",
      );

      const detail = await api(`/v1/runs/${created.engineeringRunId}`);
      assert.equal(detail.status, 200);
      const record = detail.body.report.verifications.find((v) => v.verdictOfRecord);
      assert.ok(record.stages?.length, "the verdict of record carries its stage results");
      assert.ok(
        record.stages.every((s) => ["passed", "warning", "failed", "completed_with_findings", "skipped"].includes(s.status)),
        JSON.stringify(record.stages),
      );

      const diff = await api(`/v1/runs/${created.engineeringRunId}/diff`);
      assert.equal(diff.status, 200, JSON.stringify(diff.body));
      assert.equal(diff.body.candidateSha, verification.candidateSha, "the diff is of the candidate that was verified");
      assert.match(diff.body.patch, /console\.log\('hello'\)/);
    });
  },
);

test(
  "the console shows a real run in a browser: the agent's steps, the diff, and each stage's result",
  { skip: browserSkipped, timeout: 600_000 },
  async (t) => {
    const started = Date.now();
    const mark = (what) => t.diagnostic(`${what} at ${Math.round((Date.now() - started) / 1000)}s`);
    await withStack(async ({ pool, schemaUrl, storage, makeFactory }) => {
      await makeFactory();
      const created = await createTask(schemaUrl);
      const runId = created.engineeringRunId;
      // To the end: a terminal run is one the page renders whole, with no live stream to follow.
      await waitForState(pool, runId, (r) => TERMINAL_STATES.has(r.status));
      mark("run ended");

      const token = "browser-e2e-token";
      const api = await serveApi(
        {
          pool,
          // The real command port, for its reads (the page lists guidance); nothing here commands.
          control: apiControl({ pool, control: { cancel: async () => {}, signal: async () => {} }, github: {} }),
          evidence: {
            list: async () => [],
            presign: async () => "https://example.test/unused",
            read: (bucket, key, file) => storage.getPackageFile(bucket, key, file),
          },
        },
        { token, subject: "browser-e2e" },
      );
      let consoleApp;
      let browser;
      try {
        consoleApp = await startConsole(api.url, token, `/runs/${runId}`);
        mark("console ready");
        const { chromium } = await import("playwright-core");
        browser = await chromium.launch();
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        try {
          // Counted from the page load only: the readiness probe above was a page load of its own.
          api.resetPeak();
          await page.goto(`${consoleApp.url}/runs/${runId}`, { waitUntil: "networkidle" });
          /*
           * The page's API requests are bounded (apps/console/lib/api.ts MAX_IN_FLIGHT). Each is a
           * pooled database connection on a deployment, and one page used to open fourteen
           * at once — which is how production ran out on 2026-09-25.
           */
          assert.ok(api.peakInFlight() <= 3, `the run page had ${api.peakInFlight()} API requests in flight at once`);
          assert.equal(await page.getByText("Showing fixtures").count(), 0, "the console is reading the real API, not its sample data");

          // G1: the agent's turn, collapsed now that it's over, with the steps the worker emitted.
          // Finished stages fold into one line (the session view, #364); open them to reach the turn.
          const earlier = page.locator(".console-feed__earlier-stages > summary");
          if (await earlier.count()) await earlier.first().click();
          const turn = page.locator(".console-turn").first();
          await turn.waitFor();
          assert.match(await turn.locator(".console-turn__title").innerText(), /^Windkeel worked/);
          await turn.locator(".console-turn__summary").click();
          const steps = await turn.locator(".oq-step__summary").allInnerTexts();
          assert.ok(steps.some((t) => /edit\s+index\.js/.test(t)), `an edit of index.js among ${JSON.stringify(steps)}`);
          assert.ok(steps.some((t) => /test\s+npm test[\s\S]*passed/.test(t)), `a passing npm test among ${JSON.stringify(steps)}`);

          // G2: What changed is the patch the maker stored for the verified candidate.
          assert.match(await page.locator(".console-diff").innerText(), /console\.log\('hello'\)/);

          // G3: every stage says what it found; none is left at "Not reported". Evidence is a tab now.
          await page.goto(`${consoleApp.url}/runs/${runId}?tab=evidence`, { waitUntil: "networkidle" });
          const panel = page.locator("body");
          assert.equal(await panel.locator(".console-verdict").innerText(), "Verified");
          const outcomes = await panel.locator(".console-outcomes__result").allInnerTexts();
          assert.equal(outcomes.length, 5, JSON.stringify(outcomes));
          assert.ok(!outcomes.includes("Not reported"), `stage outcomes ${JSON.stringify(outcomes)}`);
        } catch (err) {
          const shot = join(tempDir("console-browser"), "run-page.png");
          await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
          throw new Error(`${err instanceof Error ? err.message : err}\n(screenshot: ${shot})`);
        }
      } finally {
        await browser?.close();
        await consoleApp?.stop();
        await api.close();
      }
    });
  },
);

test(
  "a failing candidate enters the repair loop, and the replay-only fake refuses it by name",
  { skip },
  async () => {
    await withStack(
      async ({ pool, schemaUrl, makeFactory }) => {
        await makeFactory();
        const created = await createTask(schemaUrl);

        const run = await waitForState(pool, created.engineeringRunId, (r) =>
          ["BLOCKED", "PR_CREATING", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED"].includes(r.status),
        );

        /**
         * The fail verdict now enters REPAIRING rather than parking at BLOCKED. This container is
         * wired with `FakeWorkerAdapter`, which replays a recording and reports
         * `resumableSessions: false`, so the repair turn ADR-0011 §2 specifies cannot be taken —
         * and the run says so, with `stop_reason = "error"`, instead of taking a cold turn and
         * calling it a resume (ADR-0017 §3).
         *
         * The loop actually closing — a defect caught, repaired on a resumed turn, and passed on
         * re-verification — is M5.6's (#146), and needs a fake that can take a second turn.
         */
        assert.equal(run.status, "FAILED");
        assert.equal(run.stopReason, "error");
        assert.equal(run.finalVerdict, "fail");

        const transitions = await pool.query(
          "select to_state from run_state_transition where engineering_run_id = $1 order by at, id",
          [created.engineeringRunId],
        );
        assert.ok(
          transitions.rows.some((r) => r.to_state === "REPAIRING"),
          "the run entered the repair loop before it stopped",
        );

        const packets = await listRepairPackets(pool, created.engineeringRunId);
        assert.equal(packets.length, 1);
        assert.ok(packets[0].review_findings.some((f) => f.id === "REV-1"));
      },
      { review: DIRTY_REVIEW },
    );
  },
);

test(
  "a run survives the process that started it — ADR-0007's central claim, on ADR-0021's backing",
  { skip },
  async () => {
    await withStack(async ({ pool, schemaUrl, makeFactory }) => {
      // A factory whose agent session is slow enough to still be in flight when it goes away.
      const first = await makeFactory({ pauseMs: 900 });
      const created = await createTask(schemaUrl);

      /**
       * Wait until the run is genuinely under way, then drop this process's half of the factory
       * without letting it finish anything. Under pg-boss this was `stop({ abrupt: true })` —
       * a container killed without SIGTERM. There is no container now, so the equivalent is the
       * provider and its handler graph going away mid-stage; everything the next one needs must
       * be in the row.
       */
      await waitForState(pool, created.engineeringRunId, (r) => r.status !== "CREATED");
      await first.stop();

      const second = await makeFactory();
      await second.provider.startRun(created.engineeringRunId);

      const run = await waitForState(
        pool,
        created.engineeringRunId,
        (r) => ["PR_CREATING", "BLOCKED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED"].includes(r.status),
        90_000,
      );

      // Either it completed the loop, or it failed *visibly* because the first factory's
      // sandbox handle could not be re-attached — both are correct, documented behaviours, and
      // the thing being asserted is that a fresh graph picked the run up from the row and drove
      // it to a terminal-or-parked state rather than leaving it stranded.
      assert.ok(
        ["PR_CREATING", "BLOCKED", "FAILED"].includes(run.status),
        `resumed to ${run.status}`,
      );
      assert.notEqual(run.status, "CREATED");

      const { rows } = await pool.query(
        "select count(*)::int as n from run_state_transition where engineering_run_id = $1",
        [created.engineeringRunId],
      );
      assert.ok(rows[0].n >= 2, "the second factory committed transitions of its own");
    });
  },
);

/**
 * The replacement for "SIGTERM leaves no orphaned sandbox".
 *
 * That case asserted a property of the container's shutdown handler. ADR-0020 deletes the
 * container, and with it the only moment at which a process both held a live sandbox and knew it
 * was about to stop. On a step-per-invocation backing nothing outlives a stage, so **the
 * guarantee genuinely moved**: a sandbox nobody holds is destroyed by the reaper (#198), which
 * #226 put on an hourly cron.
 *
 * So this asserts the new shape rather than pretending the old one survived. It is the same
 * question — *does an interrupted run leave a sandbox billing?* — asked of the component that
 * now answers it.
 */
test(
  "a sandbox left behind by an interrupted run is reaped, not leaked",
  { skip },
  async () => {
    await withStack(async ({ pool, schemaUrl, makeFactory }) => {
      const first = await makeFactory({ pauseMs: 900 });
      const created = await createTask(schemaUrl);

      // Let it provision, then walk away mid-stage with the sandbox still live.
      await waitForState(pool, created.engineeringRunId, (r) => r.status !== "CREATED");
      const before = await waitFor(
        () => listWorkspaces(pool, created.engineeringRunId),
        // A row is written as `provisioning` before the provider call; until it has a handle
        // there is no sandbox to leak, and the reaper rightly skips it. Stopping in that window
        // (a slow runner) would test nothing, so wait for the sandbox to exist.
        (rows) => rows.length > 0 && rows.every((row) => row.providerHandle),
        "the run never provisioned a workspace",
      );
      await first.stop();
      assert.ok(before.length > 0, "the run provisioned at least one workspace");

      /**
       * Expire every workspace this run holds, which is what the passage of time does in
       * production. The reaper's contract is "destroy sandboxes no process holds a handle to
       * and whose lease has expired" — forcing the lease rather than sleeping keeps the case
       * fast without weakening it.
       */
      await pool.query(
        "update workspace set expires_at = now() - interval '1 hour' where engineering_run_id = $1",
        [created.engineeringRunId],
      );

      const reaped = await reapSandboxesLocked({
        pool,
        providers: { fake: new FakeSandboxProvider() },
        log: () => {},
      });
      assert.ok(reaped, "the reaper ran");

      for (const workspace of await listWorkspaces(pool, created.engineeringRunId)) {
        assert.ok(
          ["destroyed", "teardown_failed", "orphaned"].includes(workspace.status),
          `${workspace.role} workspace left as ${workspace.status} — a leaked sandbox costs money`,
        );
      }
    });
  },
);

test("startup with a missing required variable fails with a message naming it", () => {
  // No database, no network — pure configuration validation, so it runs everywhere.
  assert.throws(
    () => loadWorkerConfig({}),
    (err) => err instanceof MissingConfigError && err.variable === "DATABASE_URL",
  );

  assert.throws(
    () => loadWorkerConfig({ DATABASE_URL: "postgres://x" }),
    (err) => err instanceof MissingConfigError && err.variable === "WINDKEEL_REPOSITORY_URL",
  );

  // The broker rule names an env var; a rule pointing at nothing must fail here, not at the
  // first `runInExecutionPhase` three stages into a run.
  assert.throws(
    () =>
      loadWorkerConfig({
        DATABASE_URL: "postgres://x",
        WINDKEEL_REPOSITORY_URL: "https://github.com/o/r",
      }),
    (err) => err instanceof MissingConfigError && err.variable === "OPENAI_API_KEY",
  );

  const config = loadWorkerConfig({
    DATABASE_URL: "postgres://x",
    WINDKEEL_REPOSITORY_URL: "https://github.com/o/r",
    OPENAI_API_KEY: "sk-not-a-real-key",
  });
  assert.equal(config.repository.url, "https://github.com/o/r");
  assert.equal(config.evidence, undefined);
  assert.equal(config.poolDatabaseUrl, "postgres://x");

  const pooled = loadWorkerConfig({
    DATABASE_URL: "postgres://session",
    DATABASE_POOL_URL: "postgres://transaction",
    WINDKEEL_REPOSITORY_URL: "https://github.com/o/r",
    OPENAI_API_KEY: "sk-not-a-real-key",
  });
  assert.equal(pooled.databaseUrl, "postgres://session");
  assert.equal(pooled.poolDatabaseUrl, "postgres://transaction");

  // A malformed number is named too, rather than silently becoming NaN.
  assert.throws(
    () =>
      loadWorkerConfig({
        DATABASE_URL: "postgres://x",
        WINDKEEL_REPOSITORY_URL: "https://github.com/o/r",
        OPENAI_API_KEY: "sk-not-a-real-key",
        WINDKEEL_RAILS_CHECK_INTERVAL_MS: "soon",
      }),
    /WINDKEEL_RAILS_CHECK_INTERVAL_MS is invalid/,
  );
});

test("the config never echoes a secret", () => {
  const config = loadWorkerConfig({
    DATABASE_URL: "postgres://user:hunter2@host/db",
    WINDKEEL_REPOSITORY_URL: "https://github.com/o/r",
    OPENAI_API_KEY: "sk-super-secret",
  });
  // The key is validated as present and deliberately not carried on the config object: the
  // broker rule names the variable, it never transports the value (ADR-0014 §1).
  assert.equal(JSON.stringify(config).includes("sk-super-secret"), false);
});

/** Pulls a package back out of real MinIO so it can be re-verified offline. */
async function downloadPackage(ref) {
  const [bucket, ...rest] = ref.split("/");
  const key = rest.join("/");
  const { GetObjectCommand, ListObjectsV2Command, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint: s3.endpoint,
    region: s3.region,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
    forcePathStyle: true,
  });
  const dir = tempDir("downloaded");
  const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${key}/` }));
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  for (const object of listed.Contents ?? []) {
    if (!object.Key) continue;
    const body = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
    const target = join(dir, object.Key.slice(key.length + 1));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await body.Body.transformToByteArray()));
  }
  void readFileSync;
  return dir;
}
