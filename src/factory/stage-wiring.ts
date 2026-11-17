import "@windkeel/verification/env-compat.js";
import { Pool } from "pg";
import { toolInstalled, type ExecutionEnvironment } from "@windkeel/verification/exec/environment.js";
import { LocalExecutionEnvironment } from "@windkeel/verification/exec/local.js";
import { S3EvidenceStorage } from "./evidence-storage.js";
import { githubClientFromEnv } from "../github/rest.js";
import type { GitHubClient } from "../github/client.js";
import { SandboxGitCredentials } from "../sandbox/git-credentials.js";
import { FakeSandboxProvider } from "../sandbox/fake.js";
import { VercelSandboxProvider } from "../sandbox/vercel.js";
import type { SandboxProvider } from "../sandbox/provider.js";
import type { WorkerAdapter } from "../worker/adapter.js";
import { CodexWorkerAdapter, type CodexAdapterOptions } from "../worker/codex/adapter.js";
import { ClaudeCodeWorkerAdapter, type ClaudeCodeAdapterOptions } from "../worker/claude-code/adapter.js";
import { makerIneligibility, singleWorkerRegistry, type WorkerRegistry } from "../worker/registry.js";
import { enabledHarnesses, HARNESS_SHAPE } from "./harnesses.js";
import { SandboxRegistry } from "./workflow/sandbox-registry.js";
import { WorkerSessionRegistry } from "./workflow/session-registry.js";
import { createProvisioningHandler } from "./workflow/handlers/provisioning.js";
import { createImplementingHandler } from "./workflow/handlers/implementing.js";
import { createVerifyingHandler } from "./workflow/handlers/verifying.js";
import { createRepairingHandler } from "./workflow/handlers/repairing.js";
import { createPullRequestHandlers } from "./workflow/handlers/pr-creating.js";
import { createIntakeHandlers } from "./workflow/handlers/intake.js";
import { createHumanEditingHandler } from "./workflow/handlers/human-editing.js";
import { takeoverEnabled } from "./human-session.js";
import { githubPushTokenIssuer } from "./human-push.js";
import { FakeHumanWorkspaceProvider, type HumanWorkspaceProvider } from "../sandbox/human-workspace.js";
import { VercelHumanWorkspaceProvider } from "../sandbox/vercel-human-workspace.js";
import type { StageDeps } from "./workflow/stage-deps.js";
import { readRunModelConfig } from "./workflow/run-models.js";
import type { StageHandler, WorkflowProvider } from "./workflow/provider.js";
import { withRepositoryGrant } from "./workflow/repository-grant-gate.js";
import { learnAfterLoop } from "./workflow/knowledge-flow.js";
import type { WorkerConfig } from "./worker-config.js";

export type Log = (message: string, fields?: Record<string, unknown>) => void;

export type SandboxMode = "vercel" | "local";

export interface StageWiringOverrides {
  sandboxes?: SandboxProvider;
  worker?: WorkerAdapter;
  workers?: WorkerRegistry;
  github?: GitHubClient;
  log?: Log;
  poolMax?: number;
  humanWorkspaces?: HumanWorkspaceProvider;
}

export interface StageWiring {
  readonly deps: StageDeps;
  readonly pool: Pool;
  readonly registry: SandboxRegistry;
  readonly sessions: WorkerSessionRegistry;
  readonly sandboxMode: SandboxMode | null;
}

const SANDBOX_CREDENTIAL_ENV = {
  token: ["WINDKEEL_SANDBOX_TOKEN", "VERCEL_TOKEN"],
  teamId: ["WINDKEEL_SANDBOX_TEAM_ID", "VERCEL_TEAM_ID"],
  projectId: ["WINDKEEL_SANDBOX_PROJECT_ID", "VERCEL_PROJECT_ID"],
} as const;

function firstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

export function sandboxCredentialsFromEnv(): { token: string; teamId: string; projectId: string } | null {
  const token = firstEnv(SANDBOX_CREDENTIAL_ENV.token);
  const teamId = firstEnv(SANDBOX_CREDENTIAL_ENV.teamId);
  const projectId = firstEnv(SANDBOX_CREDENTIAL_ENV.projectId);
  if (process.env["VERCEL_DEPLOYMENT_ID"] && !process.env["WINDKEEL_SANDBOX_PROJECT_ID"]) {
    throw new Error(
      "WINDKEEL_SANDBOX_PROJECT_ID is unset and this process is inside a Vercel deployment, where " +
        "VERCEL_PROJECT_ID is the platform's own id for the deployment's project rather than " +
        "anything this factory configured. Set WINDKEEL_SANDBOX_PROJECT_ID (and WINDKEEL_SANDBOX_TOKEN " +
        "and WINDKEEL_SANDBOX_TEAM_ID) to the project sandboxes should be created in.",
    );
  }
  return token && teamId && projectId ? { token, teamId, projectId } : null;
}

export function buildSandboxProvider(
  config: WorkerConfig,
  log: Log,
): { provider: SandboxProvider; mode: SandboxMode } {
  const credentials = sandboxCredentialsFromEnv();
  if (credentials) {
    const { token, teamId, projectId } = credentials;
    return {
      mode: "vercel",
      provider: new VercelSandboxProvider({
        token,
        teamId,
        projectId,
        makerModelApiDomain: config.modelApiDomain,
        makerModelKeyEnvVar: config.modelKeyEnvVar,
        ...(config.environmentSnapshots?.enabled ? { environmentSnapshots: true } : {}),
      }),
    };
  }
  if (process.env["VERCEL_DEPLOYMENT_ID"]) {
    throw new Error(
      "this process is inside a Vercel deployment and its sandbox credentials are incomplete: " +
        "set WINDKEEL_SANDBOX_TOKEN and WINDKEEL_SANDBOX_TEAM_ID (with WINDKEEL_SANDBOX_PROJECT_ID). " +
        "Refusing to fall back to the local FakeSandboxProvider, which would run repository " +
        "code on this host with the deployment's own environment.",
    );
  }
  log("no Vercel credentials configured — using the local FakeSandboxProvider", {
    hermetic: true,
    note: "runs execute in a local temp clone, not an isolated sandbox (ADR-0016 local mode)",
  });
  return { mode: "local", provider: new FakeSandboxProvider() };
}

export function codexAdapterOptions(config: WorkerConfig): CodexAdapterOptions {
  return {
    binary: config.codex.binary,
    pinnedVersion: config.codex.pinnedVersion,
    allowVersionDrift: config.codex.allowVersionDrift,
    modelApiDomain: config.modelApiDomain,
    makerModelKeyEnvVar: config.modelKeyEnvVar,
  };
}

export function claudeCodeAdapterOptions(config: WorkerConfig): ClaudeCodeAdapterOptions {
  const keyEnvVar = config.makerKeyEnvVars.anthropic;
  return {
    binary: config.claudeCode.binary,
    pinnedVersion: config.claudeCode.pinnedVersion,
    allowVersionDrift: config.claudeCode.allowVersionDrift,
    modelApiDomain: "api.anthropic.com",
    ...(keyEnvVar ? { makerModelKeyEnvVar: keyEnvVar } : {}),
  };
}

export function buildWorkerRegistry(
  config: WorkerConfig,
  log: Log,
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkerRegistry {
  assertHarnessConfig(env);
  const workers = new Map<string, WorkerAdapter>();
  for (const { id } of enabledHarnesses(env)) {
    if (id === "codex") {
      workers.set(id, new CodexWorkerAdapter({
        ...codexAdapterOptions(config),
        onDiagnostic: (diagnostic) => log("codex diagnostic", { ...diagnostic }),
      }));
    } else if (id === "claude-code") {
      workers.set(id, new ClaudeCodeWorkerAdapter({
        ...claudeCodeAdapterOptions(config),
        onDiagnostic: (diagnostic) => log("claude-code diagnostic", { ...diagnostic }),
      }));
    } else {
      throw new Error(
        `WINDKEEL_MAKER_HARNESSES enables "${id}", which this build has no maker adapter for ` +
          "(it has codex and claude-code). Remove it, or deploy a build that has it (ADR-0027 §1).",
      );
    }
  }
  return assertEligibleMakers(workers);
}

function assertHarnessConfig(env: Readonly<Record<string, string | undefined>>): void {
  const listed = (env["WINDKEEL_MAKER_HARNESSES"] ?? "codex").split(",").map((id) => id.trim()).filter((id) => id !== "");
  const malformed = listed.filter((id) => !HARNESS_SHAPE.test(id));
  if (malformed.length > 0) {
    throw new Error(`WINDKEEL_MAKER_HARNESSES: ${malformed.map((id) => JSON.stringify(id)).join(", ")} is not a harness id (ADR-0027 §1)`);
  }
  const wanted = env["WINDKEEL_DEFAULT_MAKER_HARNESS"]?.trim();
  const enabled = listed.length > 0 ? listed : ["codex"];
  if (wanted && !enabled.includes(wanted)) {
    throw new Error(
      `WINDKEEL_DEFAULT_MAKER_HARNESS is "${wanted}", which WINDKEEL_MAKER_HARNESSES (${enabled.join(",")}) does not enable (ADR-0027 §1)`,
    );
  }
}

export function assertEligibleMakers(workers: WorkerRegistry): WorkerRegistry {
  for (const [id, adapter] of workers) {
    const missing = makerIneligibility(adapter.capabilities);
    if (missing.length > 0) {
      throw new Error(`the ${id} maker adapter is not eligible as a production maker (ADR-0027 §3): ${missing.join("; ")}`);
    }
  }
  return workers;
}

export async function assertCodexAvailableLocally(
  config: WorkerConfig,
  execEnv: ExecutionEnvironment = new LocalExecutionEnvironment(),
): Promise<void> {
  if (await toolInstalled(execEnv, config.codex.binary)) return;
  throw new Error(
    `WINDKEEL_CODEX_BINARY: "${config.codex.binary}" is not executable on this host. With no ` +
      "Vercel credentials the factory runs in ADR-0016 local mode, where the agent executes " +
      "here rather than in a microVM, so the binary must be installed locally (or set " +
      "VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID to run in a real sandbox, whose image " +
      "ships codex).",
  );
}

export function buildStageDeps(
  config: WorkerConfig,
  overrides: StageWiringOverrides = {},
): StageWiring {
  const log = overrides.log ?? (() => {});
  const pool = new Pool({
    connectionString: config.poolDatabaseUrl ?? config.databaseUrl,
    ...(overrides.poolMax === undefined ? {} : { max: overrides.poolMax }),
  });
  const registry = new SandboxRegistry();
  const sessions = new WorkerSessionRegistry();

  const built = overrides.sandboxes ? null : buildSandboxProvider(config, log);
  const sandboxes = overrides.sandboxes ?? built!.provider;

  const workers =
    overrides.workers ??
    (overrides.worker ? singleWorkerRegistry(overrides.worker) : buildWorkerRegistry(config, log));
  const defaultHarness = enabledHarnesses(process.env).find((harness) => harness.default)?.id;

  const githubClient =
    overrides.github ?? (process.env["GITHUB_APP_ID"] ? githubClientFromEnv() : null);

  const deps: StageDeps = {
    pool,
    afterRepairLoop: learnAfterLoop,
    sandboxes,
    workers,
    ...(defaultHarness ? { defaultHarness } : {}),
    registry,
    sessions,
    ...(githubClient ? { github: githubClient } : {}),
    ...(githubClient
      ? {
          gitCredentials: {
            broker: new SandboxGitCredentials(githubClient),
            host: config.gitHost,
          },
        }
      : {}),
    ...(config.evidence
      ? {
          evidence: {
            storage: new S3EvidenceStorage({
              endpoint: config.evidence.endpoint,
              region: config.evidence.region,
              accessKeyId: config.evidence.accessKeyId,
              secretAccessKey: config.evidence.secretAccessKey,
            }),
            bucket: config.evidence.bucket,
          },
        }
      : {}),
    config: {
      repository: config.repository,
      makerModel: config.makerModel,
      makerVendor: config.makerVendor,
      modelApiDomain: config.modelApiDomain,
      modelKeyEnvVar: config.modelKeyEnvVar,
      makerKeyEnvVars: config.makerKeyEnvVars,
      ...(config.secretPrivateKey ? { secretPrivateKey: config.secretPrivateKey } : {}),
      ...(config.secretPreviousPrivateKey
        ? { secretPreviousPrivateKey: config.secretPreviousPrivateKey }
        : {}),
      modelPricing: config.modelPricing,
      checkerPricing: config.checkerPricing,
      usdPerCpuMs: config.usdPerCpuMs,
      usdPerEgressByte: config.usdPerEgressByte,
      railsCheckIntervalMs: config.railsCheckIntervalMs,
      workspaceTtlMs: config.workspaceTtlMs,
      installScanners: config.installScanners,
      ...(config.environmentSnapshots ? { environmentSnapshots: config.environmentSnapshots } : {}),
      ...(config.makerBrowser !== undefined ? { makerBrowser: config.makerBrowser } : {}),
      ...(config.harnessInstall !== undefined ? { harnessInstall: config.harnessInstall } : {}),
      ...(config.makerScreenshotMax !== undefined ? { makerScreenshotMax: config.makerScreenshotMax } : {}),
      gitHost: config.gitHost,
      gitAuthorName: config.gitAuthorName,
      gitAuthorEmail: config.gitAuthorEmail,
      policyVersion: config.policyVersion,
      checkerModels: {
        endpoints: config.checkerEndpoints,
        maker: { vendor: config.makerVendor, model: config.makerModel },
      },
      approvalDeadlineSeconds: config.approvalDeadlineSeconds,
    },
    runModels: (engineeringRunId) => readRunModelConfig(pool, engineeringRunId),
    ...(takeoverEnabled()
      ? {
          humanEditing: {
            workspaces:
              overrides.humanWorkspaces ??
              (built?.mode === "vercel"
                ? new VercelHumanWorkspaceProvider(sandboxCredentialsFromEnv()!)
                : new FakeHumanWorkspaceProvider()),
            ...(githubClient ? { pushTokens: githubPushTokenIssuer(githubClient) } : {}),
          },
        }
      : {}),
  };

  return { deps, pool, registry, sessions, sandboxMode: built ? built.mode : null };
}

export function registerStageHandlers(provider: WorkflowProvider, deps: StageDeps): void {
  const register = (handler: StageHandler): void => provider.register(withRepositoryGrant(deps, handler));
  for (const handler of createIntakeHandlers(deps)) register(handler);
  register(createProvisioningHandler(deps));
  register(createImplementingHandler(deps));
  register(createVerifyingHandler(deps));
  register(createRepairingHandler(deps));
  for (const handler of createPullRequestHandlers(deps)) register(handler);
  register(createHumanEditingHandler(deps));
}
