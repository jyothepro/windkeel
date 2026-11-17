import { readFile, readdir, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBaseBuilderConfig, VercelBuildOutputAPIBuilder } from "@workflow/builders";
import * as esbuild from "esbuild";

const ingressDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(ingressDir, "../..");
const workflowRoot = join(repoRoot, "src");
const builtOutput = join(workflowRoot, ".vercel/output");
const deployOutput = process.env["WINDKEEL_VERCEL_OUTPUT_DIR"] ?? join(ingressDir, ".vercel/output");

const WINDKEEL_RUN_WORKFLOW_ID = "workflow//./factory/workflow/vercel-flow//orqonRunFlow";

const MODEL_CREDENTIAL_VALIDATION_WORKFLOW_ID =
  "workflow//./factory/workflow/credential-flow//orqonValidateModelCredentialFlow";

const MERGE_PULL_REQUEST_WORKFLOW_ID = "workflow//./factory/workflow/merge-flow//orqonMergePullRequestFlow";

const ENVIRONMENT_SNAPSHOT_WORKFLOW_ID =
  "workflow//./factory/workflow/environment-flow//orqonBuildEnvironmentSnapshotFlow";

const SLACK_MENTION_FEEDBACK_WORKFLOW_ID =
  "workflow//./factory/workflow/slack-feedback-flow//orqonSlackMentionFeedbackFlow";

const WEBHOOK_MAX_DURATION_SECONDS = 30;

const SWEEP_MAX_DURATION_SECONDS = 300;
const SWEEP_SCHEDULE = "0 * * * *";
const SWEEP_PATH = "/api/sweep";

const PREFLIGHT_MAX_DURATION_SECONDS = 30;

const API_MAX_DURATION_SECONDS = 800;

const API_ROUTE_SOURCE = "^/v1/(.*)$";

const INTAKE_MAX_DURATION_SECONDS = 30;
const INTAKE_ROUTE_SOURCE = "^/api/intake/([a-z][a-z0-9_-]*)(?:/([A-Za-z0-9_-]{1,128}))?/?$";

const SCHEDULES_MAX_DURATION_SECONDS = 60;
const SCHEDULES_SCHEDULE = "*/5 * * * *";
const SCHEDULES_PATH = "/api/schedules";

class WindkeelIngressBuilder extends VercelBuildOutputAPIBuilder {
  constructor() {
    super({
      ...createBaseBuilderConfig({
        workingDir: workflowRoot,
        dirs: ["."],
        runtime: "nodejs22.x",
        sourcemap: false,
      }),
      buildTarget: "vercel-build-output-api",
    });
  }

  async build() {
    await super.build();
    await rm(deployOutput, { recursive: true, force: true });
    await mkdir(dirname(deployOutput), { recursive: true });
    await cp(builtOutput, deployOutput, { recursive: true });
    await rm(join(workflowRoot, ".vercel"), { recursive: true, force: true });
    await this.#buildIngressWebhook();
    await this.#buildIntake();
    await this.#buildSweepCron();
    await this.#buildSchedulesCron();
    await this.#buildPreflight();
    await this.#buildApi();
    await this.#bundleMigrations();
    await this.#copyStatic();
  }

  async #buildIngressWebhook() {
    const funcDir = join(deployOutput, "functions/api/webhook.func");
    await mkdir(funcDir, { recursive: true });
    await esbuild.build({
      entryPoints: [join(ingressDir, "api/webhook.ts")],
      outfile: join(funcDir, "index.mjs"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      external: ["pg-native"],
      banner: {
        js: [
          'import { createRequire as __createRequire } from "node:module";',
          "const require = __createRequire(import.meta.url);",
        ].join("\n"),
      },
      logLevel: "warning",
    });
    await this.createPackageJson(funcDir, "module");
    await this.createVcConfig(funcDir, {
      handler: "index.mjs",
      runtime: "nodejs22.x",
      maxDuration: WEBHOOK_MAX_DURATION_SECONDS,
      shouldAddHelpers: false,
    });
  }

  async #buildIntake() {
    const funcDir = join(deployOutput, "functions/api/intake.func");
    await mkdir(funcDir, { recursive: true });
    await esbuild.build({
      entryPoints: [join(ingressDir, "api/intake.ts")],
      outfile: join(funcDir, "index.mjs"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      external: ["pg-native"],
      banner: {
        js: [
          'import { createRequire as __createRequire } from "node:module";',
          "const require = __createRequire(import.meta.url);",
        ].join("\n"),
      },
      logLevel: "warning",
    });
    await this.createPackageJson(funcDir, "module");
    await this.createVcConfig(funcDir, {
      handler: "index.mjs",
      runtime: "nodejs22.x",
      maxDuration: INTAKE_MAX_DURATION_SECONDS,
      shouldAddHelpers: false,
    });
    await this.#declareIntakeRoute();
  }

  async #declareIntakeRoute() {
    const configPath = join(deployOutput, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const routes = (config.routes ?? []).filter((route) => route.src !== INTAKE_ROUTE_SOURCE);
    config.routes = [{ src: INTAKE_ROUTE_SOURCE, dest: "/api/intake?source=$1&target=$2" }, ...routes];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  async #buildSweepCron() {
    await this.#buildCronFunction({
      name: "sweep",
      maxDuration: SWEEP_MAX_DURATION_SECONDS,
      path: SWEEP_PATH,
      schedule: SWEEP_SCHEDULE,
    });
  }

  async #buildCronFunction({ name, maxDuration, path, schedule }) {
    const funcDir = join(deployOutput, `functions/api/${name}.func`);
    await mkdir(funcDir, { recursive: true });
    await esbuild.build({
      entryPoints: [join(ingressDir, `api/${name}.ts`)],
      outfile: join(funcDir, "index.mjs"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      external: ["pg-native"],
      banner: {
        js: [
          'import { createRequire as __createRequire } from "node:module";',
          "const require = __createRequire(import.meta.url);",
        ].join("\n"),
      },
      logLevel: "warning",
    });
    await this.createPackageJson(funcDir, "module");
    await this.createVcConfig(funcDir, {
      handler: "index.mjs",
      runtime: "nodejs22.x",
      maxDuration,
    });
    await this.#declareCron(path, schedule);
  }

  async #buildPreflight() {
    const funcDir = join(deployOutput, "functions/api/preflight.func");
    await mkdir(funcDir, { recursive: true });
    await esbuild.build({
      entryPoints: [join(ingressDir, "api/preflight.ts")],
      outfile: join(funcDir, "index.mjs"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      external: ["pg-native"],
      banner: {
        js: [
          'import { createRequire as __createRequire } from "node:module";',
          "const require = __createRequire(import.meta.url);",
        ].join("\n"),
      },
      logLevel: "warning",
    });
    await this.createPackageJson(funcDir, "module");
    await this.createVcConfig(funcDir, {
      handler: "index.mjs",
      runtime: "nodejs22.x",
      maxDuration: PREFLIGHT_MAX_DURATION_SECONDS,
    });
  }

  async #buildApi() {
    const funcDir = join(deployOutput, "functions/api/v1.func");
    await mkdir(funcDir, { recursive: true });
    await esbuild.build({
      entryPoints: [join(ingressDir, "api/v1.ts")],
      outfile: join(funcDir, "index.mjs"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      external: ["pg-native"],
      banner: {
        js: [
          'import { createRequire as __createRequire } from "node:module";',
          "const require = __createRequire(import.meta.url);",
        ].join("\n"),
      },
      logLevel: "warning",
    });
    await this.createPackageJson(funcDir, "module");
    await this.createVcConfig(funcDir, {
      handler: "index.mjs",
      runtime: "nodejs22.x",
      maxDuration: API_MAX_DURATION_SECONDS,
      supportsResponseStreaming: true,
    });
    await this.#declareApiRoute();
  }

  async #bundleMigrations() {
    const source = join(repoRoot, "migrations");
    const files = (await readdir(source)).filter((name) => name.endsWith(".sql"));
    if (files.length === 0) throw new Error(`no migrations found in ${source}`);
    const functionsDir = join(deployOutput, "functions/api");
    const funcs = (await readdir(functionsDir)).filter((name) => name.endsWith(".func"));
    for (const func of funcs) {
      const target = join(functionsDir, func, "migrations");
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
      for (const file of files) await cp(join(source, file), join(target, file));
    }
  }

  async #declareApiRoute() {
    const configPath = join(deployOutput, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const routes = (config.routes ?? []).filter((route) => route.src !== API_ROUTE_SOURCE);
    config.routes = [{ src: API_ROUTE_SOURCE, dest: "/api/v1" }, ...routes];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  async #declareCron(path, schedule) {
    const configPath = join(deployOutput, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const crons = (config.crons ?? []).filter((c) => c.path !== path);
    crons.push({ path, schedule });
    await writeFile(configPath, `${JSON.stringify({ ...config, crons }, null, 2)}\n`);
  }

  async #buildSchedulesCron() {
    await this.#buildCronFunction({
      name: "schedules",
      maxDuration: SCHEDULES_MAX_DURATION_SECONDS,
      path: SCHEDULES_PATH,
      schedule: SCHEDULES_SCHEDULE,
    });
  }

  async #copyStatic() {
    const staticDir = join(deployOutput, "static");
    await mkdir(staticDir, { recursive: true });
    await cp(join(ingressDir, "public"), staticDir, { recursive: true });
  }
}

async function assertWorkflowId() {
  const manifestPath = join(deployOutput, "functions/.well-known/workflow/v1/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const ids = Object.values(manifest.workflows ?? {}).flatMap((entries) =>
    Object.values(entries).map((entry) => entry.workflowId),
  );
  if (!ids.includes(WINDKEEL_RUN_WORKFLOW_ID)) {
    throw new Error(
      `The deployed bundle registers no workflow called ${WINDKEEL_RUN_WORKFLOW_ID}.\n` +
        `It registers: ${ids.length ? ids.join(", ") : "(nothing)"}\n` +
        "VercelWorkflowProvider.startRun names that id, so every run started against this " +
        "deployment would fail to start. The id is derived from the workflow file's specifier " +
        "relative to the build's working directory — see the header of this file.",
    );
  }
  if (!ids.includes(MODEL_CREDENTIAL_VALIDATION_WORKFLOW_ID)) {
    throw new Error(
      `The deployed bundle registers no workflow called ${MODEL_CREDENTIAL_VALIDATION_WORKFLOW_ID}.\n` +
        `It registers: ${ids.length ? ids.join(", ") : "(nothing)"}\n` +
        "The model-credential API starts that id after storing a credential; without it every " +
        "credential would stay unverified.",
    );
  }
  if (!ids.includes(MERGE_PULL_REQUEST_WORKFLOW_ID)) {
    throw new Error(
      `The deployed bundle registers no workflow called ${MERGE_PULL_REQUEST_WORKFLOW_ID}.\n` +
        `It registers: ${ids.length ? ids.join(", ") : "(nothing)"}\n` +
        "POST /v1/runs/{id}/merge starts that id; without it every merge from Windkeel would stay pending.",
    );
  }
  if (!ids.includes(ENVIRONMENT_SNAPSHOT_WORKFLOW_ID)) {
    throw new Error(
      `The deployed bundle registers no workflow called ${ENVIRONMENT_SNAPSHOT_WORKFLOW_ID}.\n` +
        `It registers: ${ids.length ? ids.join(", ") : "(nothing)"}\n` +
        "The environment rebuild API and the sweep start that id; without it no snapshot is ever built.",
    );
  }
  if (!ids.includes(SLACK_MENTION_FEEDBACK_WORKFLOW_ID)) {
    throw new Error(
      `The deployed bundle registers no workflow called ${SLACK_MENTION_FEEDBACK_WORKFLOW_ID}.\n` +
        `It registers: ${ids.length ? ids.join(", ") : "(nothing)"}\n` +
        "The Slack intake starts that id for an ignored mention; without it no mention gets feedback.",
    );
  }
  return ids;
}

async function writeDeploymentDescriptor(ids) {
  const dir = join(deployOutput, "static/.well-known/windkeel");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "deployment.json"),
    `${JSON.stringify(
      {
        workflowIds: ids,
        targetWorld: process.env["WORKFLOW_TARGET_WORLD"] ?? "vercel",
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

await rm(builtOutput, { recursive: true, force: true });
await new WindkeelIngressBuilder().build();
const ids = await assertWorkflowId();
await writeDeploymentDescriptor(ids);
console.log(`windkeel: Vercel Build Output API emitted; workflow id ${WINDKEEL_RUN_WORKFLOW_ID} present`);
