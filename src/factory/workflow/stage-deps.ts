import type { Pool } from "pg";
import type { SandboxProvider } from "../../sandbox/provider.js";
import type { EvidenceStorage } from "../evidence-storage.js";
import type { ModelPolicy } from "@windkeel/verification/providers/types.js";
import { priceWithOverrides } from "@windkeel/verification/providers/catalog.js";
import type { Signer } from "@windkeel/verification/attest/signer.js";
import type { WorkerAdapter, WorkerUsage } from "../../worker/adapter.js";
import type { WorkerRegistry } from "../../worker/registry.js";
import type { GitHubClient } from "../../github/client.js";
import type { SandboxGitCredentials } from "../../sandbox/git-credentials.js";
import type { SandboxRegistry } from "./sandbox-registry.js";
import type { WorkerSessionRegistry } from "./session-registry.js";
import type { RunModelConfig } from "../model-policy.js";
import type { HumanEditingDeps } from "./handlers/human-editing.js";
import type { EnvironmentSnapshotConfig } from "../worker-config.js";
import type { KnowledgeSettings } from "../knowledge.js";

export interface RepositoryTarget {
  url: string;
  baseRevision: string;
}

export interface ModelPricing {
  usdPerInputToken: number;
  usdPerOutputToken: number;
  usdPerCachedInputToken?: number;
  usdPerCacheWriteInputToken?: number;
}

export interface StageConfig {
  repository: RepositoryTarget;
  makerModel: string;
  modelApiDomain: string;
  modelKeyEnvVar: string;
  makerKeyEnvVars?: Partial<Record<string, string>> | undefined;
  secretPrivateKey?: string | undefined;
  secretPreviousPrivateKey?: string | undefined;
  modelPricing?: Partial<ModelPricing>;
  checkerPricing?: Partial<ModelPricing>;
  usdPerCpuMs: number;
  usdPerEgressByte: number;
  railsCheckIntervalMs: number;
  workspaceTtlMs: number;
  gitHost: string;
  gitAuthorName: string;
  gitAuthorEmail: string;

  policyVersion: string;
  makerVendor: string;
  checkerModels: ModelPolicy;
  approvalDeadlineSeconds?: number | undefined;
  installScanners: boolean;
  environmentSnapshots?: EnvironmentSnapshotConfig | undefined;
  makerBrowser?: boolean | undefined;
  makerScreenshotMax?: number | undefined;
  harnessInstall?: "verify" | "pinned" | undefined;
  fakeSecurity?: string | undefined;
  signer?: Signer | undefined;
  knowledge?: KnowledgeSettings | undefined;
}

export interface StageDeps {
  pool: Pool;
  sandboxes: SandboxProvider;
  workers: WorkerRegistry;
  defaultHarness?: string | undefined;
  registry: SandboxRegistry;
  sessions: WorkerSessionRegistry;
  config: StageConfig;
  github?: GitHubClient | undefined;
  gitCredentials?:
    | {
        broker: SandboxGitCredentials;
        host: string;
      }
    | undefined;
  evidence?: { storage: EvidenceStorage; bucket: string } | undefined;
  runModels?: ((engineeringRunId: string) => Promise<RunModelConfig | null>) | undefined;
  humanEditing?: HumanEditingDeps | undefined;
  afterRepairLoop?: ((deps: StageDeps, engineeringRunId: string) => Promise<void>) | undefined;
}

export type MakerStageDeps = StageDeps & {
  readonly worker: WorkerAdapter;
  readonly harnessVersion?: string | undefined;
};

export type WorkersDeps = Partial<Pick<StageDeps, "workers">> & { readonly worker?: WorkerAdapter | undefined };

export function pricingFor(
  model: string | null | undefined,
  overrides: Partial<ModelPricing> | undefined,
): ModelPricing | undefined {
  const price = priceWithOverrides(model, {
    ...(overrides?.usdPerInputToken === undefined ? {} : { input: overrides.usdPerInputToken }),
    ...(overrides?.usdPerOutputToken === undefined ? {} : { output: overrides.usdPerOutputToken }),
    ...(overrides?.usdPerCachedInputToken === undefined
      ? {}
      : { cachedInput: overrides.usdPerCachedInputToken }),
    ...(overrides?.usdPerCacheWriteInputToken === undefined
      ? {}
      : { cacheWriteInput: overrides.usdPerCacheWriteInputToken }),
  });
  if (!price) return undefined;
  return {
    usdPerInputToken: price.input,
    usdPerOutputToken: price.output,
    ...(price.cachedInput === undefined ? {} : { usdPerCachedInputToken: price.cachedInput }),
    ...(price.cacheWriteInput === undefined ? {} : { usdPerCacheWriteInputToken: price.cacheWriteInput }),
  };
}

export function modelCostUsd(
  usage: WorkerUsage | undefined,
  pricing: ModelPricing | undefined,
): number | null {
  if (!usage) return 0;
  if (!pricing) return null;
  const count = (value: number | undefined): number =>
    value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
  const inputTokens = count(usage.inputTokens);
  const outputTokens =
    usage.outputTokens !== undefined ? count(usage.outputTokens) : count(usage.reasoningOutputTokens);
  const cachedRate = pricing.usdPerCachedInputToken;
  const cachedTokens =
    cachedRate === undefined ? 0 : Math.min(count(usage.cachedInputTokens), inputTokens);
  const effectiveCachedRate = Math.min(cachedRate ?? 0, pricing.usdPerInputToken);
  const cacheWriteTokens = Math.min(count(usage.cacheWriteInputTokens), inputTokens - cachedTokens);
  const effectiveWriteRate = Math.max(pricing.usdPerCacheWriteInputToken ?? 0, pricing.usdPerInputToken);
  const usd =
    (inputTokens - cachedTokens - cacheWriteTokens) * pricing.usdPerInputToken +
    cachedTokens * effectiveCachedRate +
    cacheWriteTokens * effectiveWriteRate +
    outputTokens * pricing.usdPerOutputToken;
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}
