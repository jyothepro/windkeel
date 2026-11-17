/**
 * The deployable artifact, and the three things about it that fail silently (#213).
 *
 * `test/workflow-vercel.test.js` proves `VercelWorkflowProvider` against the real runtime, but
 * against a *local* World reached over loopback. Everything here is about the other half: the
 * `.vercel/output` directory an operator actually deploys, and whether it is wired such that a
 * run started against it would execute.
 *
 * Each assertion below corresponds to a failure that a deployment would not report. The bundle
 * deploys, the routes answer, the webhook works — and runs quietly never start, or start and
 * never advance. None of that is visible without reading the emitted config, so this reads it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveWorkflowTargetWorld } from "@workflow/utils";
import {
  ENVIRONMENT_SNAPSHOT_WORKFLOW_ID,
  MERGE_PULL_REQUEST_WORKFLOW_ID,
  MODEL_CREDENTIAL_VALIDATION_WORKFLOW_ID,
  WINDKEEL_RUN_WORKFLOW_ID,
  SLACK_MENTION_FEEDBACK_WORKFLOW_ID,
} from "../dist/factory/workflow/vercel.js";
import {
  checkVercelDeployment,
  resolveTargetWorld,
  DEPLOYMENT_URL_ENV,
} from "../dist/factory/workflow/vercel-deployment.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * This suite **runs** the build, which starts by deleting its output directory. Two other
 * suites read the default one (`sweep-cron`, `deployment-preflight`), and `node --test` runs
 * files concurrently — so building into the shared path made them fail intermittently against a
 * directory that had just been removed.
 *
 * So this builds into a directory of its own. The properties under test are about what the
 * script emits, not about where, and the default path stays untouched for the readers.
 */
const outputDir = join(tmpdir(), `windkeel-vercel-output-${process.pid}`);
const workflowDir = join(outputDir, "functions/.well-known/workflow/v1");

/**
 * Builds once for the whole file. It costs a few seconds, and there is no cheaper way to know:
 * the properties this file is about exist only in the emitted directory, and a fixture checked
 * into the repo would be a copy of the answer rather than the answer.
 */
test("the deployment build emits a Vercel Build Output API directory", () => {
  execFileSync("npm", ["run", "-w", "@windkeel/ingress", "build:vercel"], {
    cwd: repoRoot,
    stdio: "pipe",
    env: { ...process.env, WINDKEEL_VERCEL_OUTPUT_DIR: outputDir },
  });
  assert.ok(existsSync(join(outputDir, "config.json")), "no .vercel/output/config.json");
});

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * The failure the issue names: "a mismatched workflow id surfaces in production as 'runs stopped
 * starting', which is exactly the failure an operator cannot diagnose."
 *
 * The id is derived from the workflow file's path relative to the *build's working directory*,
 * so it moves when the file moves, when the function is renamed, and — least obviously — when
 * the build's working directory changes. The first version of `build-vercel-output.mjs` built
 * from `apps/ingress` and emitted `workflow//./src/factory/...`; nothing but a check like this
 * would have caught it before a deployment.
 */
test("the deployed bundle registers exactly the workflow id that startRun names", () => {
  const manifest = readJson(join(workflowDir, "manifest.json"));
  const ids = Object.values(manifest.workflows ?? {}).flatMap((entries) =>
    Object.values(entries).map((entry) => entry.workflowId),
  );
  // The run flow, the one-step model-credential check the API starts (M9-2, #320), the one-step
  // merge as the person (#371), the one-step ignored-mention feedback (#312), and the one-step
  // environment snapshot build (#387).
  assert.deepEqual(
    [...ids].sort(),
    [
      ENVIRONMENT_SNAPSHOT_WORKFLOW_ID,
      MERGE_PULL_REQUEST_WORKFLOW_ID,
      MODEL_CREDENTIAL_VALIDATION_WORKFLOW_ID,
      WINDKEEL_RUN_WORKFLOW_ID,
      SLACK_MENTION_FEEDBACK_WORKFLOW_ID,
    ].sort(),
  );
});

/**
 * **The one that makes hand-written routes impossible.**
 *
 * The Vercel Queue System discovers the flow function as a consumer through this subscription in
 * its `.vc-config.json`. A function declared the ordinary way — `api/flow.ts` plus a rewrite —
 * cannot express it, so it would deploy, answer an HTTP probe, and never be dispatched to. That
 * is why this build goes through the SDK's own builder rather than through `vercel.json`.
 */
test("the flow function subscribes to the workflow queue topic", () => {
  const config = readJson(join(workflowDir, "flow.func/.vc-config.json"));
  assert.deepEqual(config.experimentalTriggers, [
    {
      type: "queue/v2beta",
      topic: "__wkf_workflow_*",
      consumer: "default",
      retryAfterSeconds: 5,
      initialDelaySeconds: 0,
    },
  ]);
});

/**
 * A Workflow **step** runs inside this function, and `session-turn.ts`'s poll arithmetic is built
 * on the step not being the binding constraint — the waiting happens in `sleep`, outside any
 * step, which is what makes a run's duration unbounded. Capping this at, say, the webhook's 30s
 * would silently shorten the longest agent turn a stage can drive, and the symptom would be
 * stages timing out for no visible reason.
 */
test("the flow function takes the longest step duration the plan allows", () => {
  const config = readJson(join(workflowDir, "flow.func/.vc-config.json"));
  assert.equal(config.maxDuration, "max");
});

/**
 * `api/webhook.ts` is untouched in behaviour, and these are the two properties of it that the
 * move to the Build Output API could have silently dropped — because both used to be expressed
 * in `vercel.json`, which the Build Output API ignores.
 *
 * `shouldAddHelpers: false` is the load-bearing one. The handler verifies GitHub's HMAC against
 * the **raw** request stream; a helper that parses the body first breaks verification silently,
 * because re-serialising a parsed object does not reproduce the bytes GitHub signed. Every
 * delivery would look forged.
 */
test("the GitHub webhook keeps its cap and its unparsed body", () => {
  const config = readJson(join(outputDir, "functions/api/webhook.func/.vc-config.json"));
  assert.equal(config.maxDuration, 30);
  assert.equal(config.shouldAddHelpers, false);
});

/**
 * #337: each function compares `schema_migrations` with the migrations beside its bundle. A
 * function built without them would report its schema `unverifiable` and fail health on a current
 * database, so every one must carry the whole directory.
 */
test("every api function carries the migrations it was built with", () => {
  const expected = readdirSync(join(repoRoot, "migrations")).filter((n) => n.endsWith(".sql")).sort();
  const functionsDir = join(outputDir, "functions/api");
  const funcs = readdirSync(functionsDir).filter((n) => n.endsWith(".func"));
  assert.ok(funcs.includes("v1.func") && funcs.includes("webhook.func"));
  for (const func of funcs) {
    const bundled = readdirSync(join(functionsDir, func, "migrations")).sort();
    assert.deepEqual(bundled, expected, `${func} is missing migrations`);
  }
});

/** What `windkeel doctor` reads. Useless if it does not describe the bundle beside it. */
test("the deployment descriptor states the workflow id and the World", () => {
  const descriptor = readJson(join(outputDir, "static/.well-known/windkeel/deployment.json"));
  assert.deepEqual(
    [...descriptor.workflowIds].sort(),
    [
      ENVIRONMENT_SNAPSHOT_WORKFLOW_ID,
      MERGE_PULL_REQUEST_WORKFLOW_ID,
      MODEL_CREDENTIAL_VALIDATION_WORKFLOW_ID,
      WINDKEEL_RUN_WORKFLOW_ID,
      SLACK_MENTION_FEEDBACK_WORKFLOW_ID,
    ].sort(),
  );
  assert.equal(descriptor.targetWorld, "vercel");
});

/**
 * The build script cannot import the constant — it runs before and independently of the
 * TypeScript build — so it carries a copy. This is what keeps the copy honest.
 */
test("the build script's copy of the workflow id matches the source of truth", () => {
  const source = readFileSync(join(repoRoot, "apps/ingress/build-vercel-output.mjs"), "utf8");
  const match = source.match(/const WINDKEEL_RUN_WORKFLOW_ID = "([^"]+)"/);
  assert.ok(match, "build-vercel-output.mjs no longer declares WINDKEEL_RUN_WORKFLOW_ID");
  assert.equal(match[1], WINDKEEL_RUN_WORKFLOW_ID);
  const merge = source.match(/const MERGE_PULL_REQUEST_WORKFLOW_ID = "([^"]+)"/);
  assert.ok(merge, "build-vercel-output.mjs no longer declares MERGE_PULL_REQUEST_WORKFLOW_ID");
  assert.equal(merge[1], MERGE_PULL_REQUEST_WORKFLOW_ID);
  const environment = source.match(/const ENVIRONMENT_SNAPSHOT_WORKFLOW_ID =\s*"([^"]+)"/);
  assert.ok(environment, "build-vercel-output.mjs no longer declares ENVIRONMENT_SNAPSHOT_WORKFLOW_ID");
  assert.equal(environment[1], ENVIRONMENT_SNAPSHOT_WORKFLOW_ID);
  const feedback = source.match(/const SLACK_MENTION_FEEDBACK_WORKFLOW_ID =\s*"([^"]+)"/);
  assert.ok(feedback, "build-vercel-output.mjs no longer declares SLACK_MENTION_FEEDBACK_WORKFLOW_ID");
  assert.equal(feedback[1], SLACK_MENTION_FEEDBACK_WORKFLOW_ID);
});

// --- the doctor check ------------------------------------------------------------------------

/**
 * `resolveTargetWorld` is a reimplementation of the SDK's resolver, because importing it would
 * put a `@workflow/*` specifier in a file outside the Vercel surface. A reimplementation that
 * drifts is worse than the import it replaced, so it is pinned to the real one here — where the
 * import is allowed, because tests are not `src/`.
 */
test("the World resolver agrees with the SDK's own, case for case", () => {
  for (const env of [
    {},
    { VERCEL_DEPLOYMENT_ID: "dpl_123" },
    { WORKFLOW_TARGET_WORLD: "local" },
    { WORKFLOW_TARGET_WORLD: "@workflow/world-postgres" },
    { WORKFLOW_TARGET_WORLD: "vercel", VERCEL_DEPLOYMENT_ID: "dpl_123" },
    { WORKFLOW_TARGET_WORLD: "local", VERCEL_DEPLOYMENT_ID: "dpl_123" },
  ]) {
    assert.equal(resolveTargetWorld(env), resolveWorkflowTargetWorld(env), JSON.stringify(env));
  }
});

const descriptorResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

test("with no deployment URL the check skips, and says why a laptop cannot start a run", async () => {
  const verdict = await checkVercelDeployment({});
  assert.equal(verdict.status, "skip");
  assert.match(verdict.details.join(" "), /not inside a deployment/);
  assert.match(verdict.details.join(" "), /`windkeel task` cannot start one/);
});

test("a deployment serving the right workflow id passes", async () => {
  const verdict = await checkVercelDeployment(
    { [DEPLOYMENT_URL_ENV]: "https://windkeel.example", VERCEL_DEPLOYMENT_ID: "dpl_1" },
    async () => descriptorResponse({ workflowIds: [WINDKEEL_RUN_WORKFLOW_ID], targetWorld: "vercel" }),
  );
  assert.equal(verdict.status, "pass");
});

/** The "runs stopped starting" failure, caught from outside rather than from the build. */
test("a deployment serving a different workflow id fails, and prints both", async () => {
  const verdict = await checkVercelDeployment(
    { [DEPLOYMENT_URL_ENV]: "https://windkeel.example", VERCEL_DEPLOYMENT_ID: "dpl_1" },
    async () =>
      descriptorResponse({ workflowIds: ["workflow//./src/factory/workflow/vercel-flow//orqonRunFlow"] }),
  );
  assert.equal(verdict.status, "fail");
  assert.match(verdict.details.join(" "), /workflow\/\/\.\/src\/factory/);
  assert.match(verdict.details.join(" "), /would fail to start/);
});

/**
 * A deployment that has no descriptor was not built by `build:vercel`, which means it has no
 * flow function either — it would accept runs and never execute them.
 */
test("a deployment without the descriptor fails rather than being assumed fine", async () => {
  const verdict = await checkVercelDeployment(
    { [DEPLOYMENT_URL_ENV]: "https://windkeel.example", VERCEL_DEPLOYMENT_ID: "dpl_1" },
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
  );
  assert.equal(verdict.status, "fail");
  assert.match(verdict.details.join(" "), /serves no flow function/);
});

test("a deployment built for another World fails, with the three ADRs that exclude it", async () => {
  const verdict = await checkVercelDeployment(
    { [DEPLOYMENT_URL_ENV]: "https://windkeel.example", VERCEL_DEPLOYMENT_ID: "dpl_1" },
    async () =>
      descriptorResponse({
        workflowIds: [WINDKEEL_RUN_WORKFLOW_ID],
        targetWorld: "@workflow/world-postgres",
      }),
  );
  assert.equal(verdict.status, "fail");
  assert.match(verdict.details.join(" "), /long-running Node server/);
});

test("an unreachable deployment is a failure, not a crash", async () => {
  const verdict = await checkVercelDeployment(
    { [DEPLOYMENT_URL_ENV]: "https://windkeel.example", VERCEL_DEPLOYMENT_ID: "dpl_1" },
    async () => {
      throw new Error("getaddrinfo ENOTFOUND windkeel.example");
    },
  );
  assert.equal(verdict.status, "fail");
  assert.match(verdict.details.join(" "), /ENOTFOUND/);
});

/**
 * The in-VM workspace server (#381). It reaches a human workspace from two deployed functions —
 * the API (`v1.func`) and the Workflow steps that provision one (`flow.func`) — and until #381
 * both read it from `research/spikes/` relative to `import.meta.url`, which in a bundle resolves
 * beside `index.mjs`, where no repository tree exists. Embedded now; this checks each bundle
 * carries every file's recorded hash. The content is covered by the launch-time check
 * (`serverManifest` refuses any file whose embedded content does not hash to that value), so a
 * hash present here and a launch that proceeds together mean the reviewed bytes shipped.
 */
test("the API and flow bundles carry every workspace server file, and neither points at research/", async () => {
  const { HUMAN_WORKSPACE_SERVER_FILES } = await import("../dist/sandbox/human-workspace-server-files.js");
  const bundles = {
    "api/v1.func": readFileSync(join(outputDir, "functions/api/v1.func/index.mjs"), "utf8"),
    "flow.func": ["index.mjs", "__step_registrations.mjs"]
      .map((f) => join(workflowDir, "flow.func", f))
      .filter(existsSync)
      .map((p) => readFileSync(p, "utf8"))
      .join("\n"),
  };
  for (const [name, code] of Object.entries(bundles)) {
    for (const file of HUMAN_WORKSPACE_SERVER_FILES) {
      assert.ok(code.includes(file.sha256), `${name} does not carry ${file.path} (${file.sha256})`);
    }
    assert.doesNotMatch(code, /spikes[\\/"', ]+human-workspace/, `${name} still points at the spike`);
  }
});
