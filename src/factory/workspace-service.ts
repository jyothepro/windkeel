import type { Pool } from "pg";
import type { RepositoryRef } from "../github/client.js";
import { ensurePinnedHarness, type HarnessInstall, type HarnessInstallSpec } from "../sandbox/harness-install.js";
import {
  scrubCloneCredentials,
  type SandboxGitCredentials,
} from "../sandbox/git-credentials.js";
import type { SandboxHandle, SandboxProvider } from "../sandbox/provider.js";
import {
  detectEcosystems,
  installDependencies,
  installInputChanges,
  type DependencyInstall,
} from "../sandbox/dependencies.js";
import { redactDeep, secretRedactor } from "../sandbox/redact.js";
import { hardenedGit } from "../sandbox/git-hardening.js";
import { installPhasePolicy } from "../sandbox/network-phase.js";
import { hostsFromSecretValues } from "./repository-secrets.js";
import { installDeclaredTools, installScanners, type ToolInstall } from "../sandbox/system-tools.js";
import {
  loadConfig,
  loadConfigFrom,
  loadMakerBrowserConfig,
  revisionSource,
  type MakerBrowserConfig,
  type SystemToolSpec,
} from "@windkeel/verification/config.js";
import { mergePlaybookTools } from "@windkeel/verification/playbook-policy.js";
import {
  recordWorkspaceEnvironment,
  startServices,
  touchSnapshot,
  type RestorableSnapshot,
  type ServiceStart,
} from "./environment-snapshots.js";
import {
  excludeMakerBrowserOutput,
  installMakerBrowser,
  type MakerBrowserState,
} from "../sandbox/maker-browser/install.js";
import { insertWorkspace, updateWorkspace, type NewWorkspace, type Workspace } from "./repositories.js";
import { recordCost } from "./cost-ledger.js";
import { selectWorkspaceCharged } from "./stores/cost-store.js";

export interface SandboxRates {
  usdPerCpuMs: number;
  usdPerEgressByte: number;
}

export async function chargeSandboxUsage(
  pool: Pool,
  handle: SandboxHandle,
  workspaceId: string,
  engineeringRunId: string,
  rates: SandboxRates,
): Promise<number> {
  const usage = await handle.usage();
  const total = usage.activeCpuMs * rates.usdPerCpuMs + usage.networkEgressBytes * rates.usdPerEgressByte;

  const chargedRow = await selectWorkspaceCharged(pool, engineeringRunId, workspaceId);
  const charged = Number(chargedRow.charged);
  const delta = total - charged;

  const deltaMs = Math.max(0, Math.round(usage.wallClockMs) - Number(chargedRow.charged_ms));

  if (deltaMs === 0) {
    if (delta <= 0 && charged > 0) return 0;
    if (delta < 0) return 0;
  }
  const usd = Math.max(0, delta);

  await recordCost(pool, {
    engineeringRunId,
    stageType: "workspace",
    stageId: workspaceId,
    kind: "sandbox",
    usd,
    sandboxMs: deltaMs,
  });
  return usd;
}

export type ProvisionWorkspaceInput = Omit<
  NewWorkspace,
  "sandboxProvider" | "providerHandle" | "status" | "gitTokenExpiresAt"
> & {

  gitCredentials?: {
    broker: SandboxGitCredentials;
    repository: RepositoryRef;

    host: string;
  };

  installDependencies?: boolean;

  installSecrets?:
    | {
        values: Readonly<Record<string, string>>;

        unopenable: readonly string[];
      }
    | undefined;

  installDeclaredTools?: boolean;

  operatorModelKey?: boolean;

  installScanners?: boolean;

  extraTools?: SystemToolSpec[];

  candidateTree?: boolean;

  trustedBase?: string;

  environment?: { snapshot?: RestorableSnapshot | undefined } | undefined;

  makerBrowser?: boolean;

  harnessInstall?: HarnessInstallSpec;
};

export interface ProvisionedEnvironment {
  mode: "snapshot" | "cold";
  snapshotId?: string;
  snapshotKey?: string;

  installInputChanges?: string[] | null;
  services?: ServiceStart[];

  fallback?: string;
}

export interface ProvisionedWorkspace {
  workspace: Workspace;
  handle: SandboxHandle;

  dependencies?: DependencyInstall;

  tools?: ToolInstall[];

  scannerAssetDir?: string;

  environment?: ProvisionedEnvironment;

  makerBrowser?: MakerBrowserState;

  harness?: HarnessInstall;
}

export const MIN_SANDBOX_LIFETIME_MS = 5 * 60_000;
export const MAX_SANDBOX_LIFETIME_MS = 5 * 60 * 60_000;

export function sandboxLifetimeMs(expiresAt: Date | null | undefined, now = Date.now()): number {
  if (!expiresAt) return MIN_SANDBOX_LIFETIME_MS;
  const remaining = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(remaining)) return MIN_SANDBOX_LIFETIME_MS;
  return Math.min(MAX_SANDBOX_LIFETIME_MS, Math.max(MIN_SANDBOX_LIFETIME_MS, remaining));
}

export async function provisionWorkspace(
  pool: Pool,
  provider: SandboxProvider,
  input: ProvisionWorkspaceInput,
): Promise<ProvisionedWorkspace> {
  const workspace = await insertWorkspace(pool, {
    ...input,
    sandboxProvider: provider.name,
    status: "provisioning",
  });

  let handle: SandboxHandle;
  let dependencies: DependencyInstall | undefined;
  let tools: ToolInstall[] | undefined;
  let scannerAssetDir: string | undefined;
  let environment: ProvisionedEnvironment | undefined;
  let makerBrowser: MakerBrowserState | undefined;
  let harness: HarnessInstall | undefined;
  try {

    const credential = input.gitCredentials
      ? await input.gitCredentials.broker.forWorkspace(
          workspace.id,
          input.role,
          input.gitCredentials.repository,
        )
      : undefined;

    const createOptions = {
      role: input.role,
      repoUrl: input.repository,
      gitRevision: input.baseSha,

      timeoutMs: sandboxLifetimeMs(input.expiresAt),
      ...(credential ? { gitCredentials: credential } : {}),
      ...(input.operatorModelKey === false ? { operatorModelKey: false } : {}),
    };

    let restored: RestorableSnapshot | undefined;
    let fallback: string | undefined;
    const offered = input.environment?.snapshot;
    if (offered && provider.capabilities.snapshots) {
      try {
        handle = await provider.create({ ...createOptions, fromSnapshot: offered.providerSnapshotId });
        restored = offered;
      } catch (err) {
        fallback = `restoring snapshot ${offered.id} failed (${err instanceof Error ? err.message : String(err)}); provisioned cold`;
        handle = await provider.create(createOptions);
      }
    } else {
      if (offered) fallback = `the ${provider.name} provider cannot restore snapshots; provisioned cold`;
      handle = await provider.create(createOptions);
    }

    if (credential) await scrubCloneCredentials(handle, credential.token);

    if (restored) {
      const descends = await hardenedGit(
        (cmd, opts) => handle.exec(cmd, opts),
        ["merge-base", "--is-ancestor", restored.baseSha, "HEAD"],
        { cwd: handle.checkoutPath },
      );
      if (descends.status !== 0) {
        fallback =
          `snapshot ${restored.id} was built at ${restored.baseSha}, which is not an ancestor of the ` +
          `checkout; provisioned cold`;
        restored = undefined;
        await handle.destroy();
        handle = await provider.create(createOptions);
        if (credential) await scrubCloneCredentials(handle, credential.token);
      }
    }

    const createdAt = await hardenedGit((cmd, opts) => handle.exec(cmd, opts), ["rev-parse", "HEAD"], {
      cwd: handle.checkoutPath,
    });
    const createdSha = createdAt.stdout.trim();
    if (createdAt.status !== 0 || !/^[0-9a-f]{40}$/.test(createdSha)) {
      throw new Error(
        `provisionWorkspace: could not resolve the commit the ${input.role} sandbox was created at: ` +
          (createdAt.stderr.trim() || `exit ${createdAt.status}`),
      );
    }
    if (createdSha !== workspace.baseSha) {
      await updateWorkspace(pool, workspace.id, { baseSha: createdSha });
    }

    const ecosystems = await detectEcosystems(handle);

    let browserConfig: MakerBrowserConfig | undefined;
    if (input.role === "maker") {
      await excludeMakerBrowserOutput(handle);
      if (input.makerBrowser === true) {
        browserConfig = await loadMakerBrowserConfig(handle, handle.checkoutPath).catch(() => undefined);
      }
    }
    const browserOn = browserConfig?.enabled === true;
    const harnessSpec = input.role === "maker" ? input.harnessInstall : undefined;

    await handle.updateNetworkPolicy(
      installPhasePolicy({
        ecosystems,

        systemTools: input.installDeclaredTools !== false,
        scanners: input.installScanners === true,
        makerBrowser: browserOn,
        extraHosts: [
          ...(input.installSecrets ? hostsFromSecretValues(input.installSecrets.values) : []),

          ...(harnessSpec ? ["registry.npmjs.org"] : []),
        ],
      }),
    );

    if (harnessSpec) harness = await ensurePinnedHarness(handle, harnessSpec);

    let reinstallWithoutSecrets = false;
    if (restored) {
      const changed = await installInputChanges(handle, restored.baseSha, restored.keyPaths);
      environment = { mode: "snapshot", snapshotId: restored.id, snapshotKey: restored.cacheKey, installInputChanges: changed };
      if (changed && changed.length === 0 && input.installDependencies !== false) {
        dependencies = {
          command: null,
          status: "skipped",
          detail:
            `restored from environment snapshot ${restored.id} (built at ${restored.baseSha}); ` +
            "no install input differs from the snapshot, so the install did not run again",
        };
      }
      reinstallWithoutSecrets = changed !== null && changed.length > 0 && input.candidateTree === true;
    }

    if (input.installDependencies !== false && !dependencies) {
      dependencies = await installDependencies(handle, {
        ...(input.installSecrets && !reinstallWithoutSecrets
          ? {
              secrets: input.installSecrets.values,
              unopenableSecrets: input.installSecrets.unopenable,
            }
          : {}),
        ...(input.candidateTree ? { candidateTree: true, trustedBase: input.trustedBase } : {}),
      });
      if (reinstallWithoutSecrets && environment?.installInputChanges) {
        dependencies = {
          ...dependencies,
          detail:
            `${dependencies.detail} (reinstalled over environment snapshot ${environment.snapshotId}: the ` +
            `candidate changed ${environment.installInputChanges.join(", ")}; repository secrets were ` +
            "not given to this install — ADR-0031)",
        };
      }

      if (input.installSecrets) {
        dependencies = redactDeep(dependencies, secretRedactor(input.installSecrets.values));
      }
    }

    if (restored && environment) {
      const source = await revisionSource(handle, handle.checkoutPath, restored.baseSha);
      const setup = source ? (await loadConfigFrom(source).catch(() => null))?.setup : undefined;
      if (setup?.services.length) environment.services = await startServices(handle, setup.services);
    }
    if (input.environment && !environment) {
      environment = { mode: "cold", ...(fallback ? { fallback } : {}) };
    } else if (environment && fallback) {
      environment.fallback = fallback;
    }

    if (input.installDeclaredTools !== false || input.installScanners) {

      const isolated = provider.capabilities.isolatedFilesystem;
      tools = [];
      if (input.installScanners) {
        const scanners = await installScanners(handle, isolated);
        tools.push(...scanners.installs);
        scannerAssetDir = scanners.assetDir;
      }
      if (input.installDeclaredTools !== false) {
        const { tools: repoTools, rejectedTools: repoRejected } = await loadConfig(handle, handle.checkoutPath);
        const merged = mergePlaybookTools(repoTools, input.extraTools);
        const declared = merged.tools;
        const rejectedTools = [...repoRejected, ...merged.rejectedTools];
        tools.push(...(await installDeclaredTools(handle, declared, rejectedTools, isolated)));
      }
    }

    if (browserOn && browserConfig) {
      makerBrowser = await installMakerBrowser(handle, {
        isolated: provider.capabilities.isolatedFilesystem,
        startCommand: browserConfig.startCommand,
        port: browserConfig.port,
      });
      await updateWorkspace(pool, workspace.id, { makerBrowser });
    }

    if (credential && input.gitCredentials) {

      await updateWorkspace(pool, workspace.id, {
        gitTokenExpiresAt: new Date(credential.expiresAt),
      });
    }
  } catch (err) {
    await updateWorkspace(pool, workspace.id, { status: "failed" });
    throw err;
  }

  const ready = await updateWorkspace(pool, workspace.id, {
    providerHandle: handle.id,
    status: "ready",
  });
  if (environment) {
    await recordWorkspaceEnvironment(pool, workspace.id, environment.mode, environment.snapshotId ?? null);
    if (environment.snapshotId) await touchSnapshot(pool, environment.snapshotId);
  }
  return {
    workspace: ready,
    handle,
    ...(dependencies ? { dependencies } : {}),
    ...(tools ? { tools } : {}),
    ...(scannerAssetDir ? { scannerAssetDir } : {}),
    ...(environment ? { environment } : {}),
    ...(makerBrowser ? { makerBrowser } : {}),
    ...(harness ? { harness } : {}),
  };
}

export async function teardownWorkspace(
  pool: Pool,
  handle: SandboxHandle,
  workspaceId: string,
  engineeringRunId: string,
  usdPerCpuMs: number,
  usdPerEgressByte: number,
): Promise<void> {
  try {
    await handle.destroy();
  } catch (err) {
    await updateWorkspace(pool, workspaceId, { status: "teardown_failed" });
    throw err;
  }

  await chargeSandboxUsage(pool, handle, workspaceId, engineeringRunId, {
    usdPerCpuMs,
    usdPerEgressByte,
  });
  await updateWorkspace(pool, workspaceId, { status: "destroyed" });
}
