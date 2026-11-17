import "@windkeel/verification/env-compat.js";
import type { ModelPricing, RepositoryTarget } from "./workflow/stage-deps.js";
import { isModelProvider, PROVIDERS, type ModelProvider } from "@windkeel/verification/providers/catalog.js";
import { CLAUDE_CODE_DESCRIPTOR, CODEX_DESCRIPTOR, descriptorVersion } from "../worker/descriptor.js";
import { DEFAULT_APPROVAL_DEADLINE_SECONDS } from "./rails.js";
import { DEFAULT_MAKER_SCREENSHOT_MAX } from "./maker-screenshots.js";

export class MissingConfigError extends Error {
  constructor(
    readonly variable: string,
    purpose: string,
  ) {
    super(`${variable} is not set — ${purpose}`);
    this.name = "MissingConfigError";
  }
}

export class InvalidConfigError extends Error {
  constructor(
    readonly variable: string,
    problem: string,
  ) {
    super(`${variable} is invalid — ${problem}`);
    this.name = "InvalidConfigError";
  }
}

export interface WorkerConfig {
  databaseUrl: string;
  poolDatabaseUrl?: string;
  repository: RepositoryTarget;
  makerModel: string;
  makerVendor: string;
  modelApiDomain: string;
  modelKeyEnvVar: string;
  secretPrivateKey?: string;
  secretPreviousPrivateKey?: string;
  modelPricing: Partial<ModelPricing>;
  checkerPricing: Partial<ModelPricing>;
  usdPerCpuMs: number;
  usdPerEgressByte: number;
  railsCheckIntervalMs: number;
  approvalDeadlineSeconds: number;
  retentionSweepIntervalMs: number;
  workspaceTtlMs: number;
  installScanners: boolean;
  environmentSnapshots?: EnvironmentSnapshotConfig;
  makerBrowser?: boolean;
  makerScreenshotMax?: number;
  harnessInstall?: "verify" | "pinned";
  gitHost: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  policyVersion: string;
  codex: {
    binary: string;
    pinnedVersion: string;
    allowVersionDrift: boolean;
  };
  claudeCode: {
    binary: string;
    pinnedVersion: string;
    allowVersionDrift: boolean;
  };
  makerKeyEnvVars: Partial<Record<ModelProvider, string>>;
  evidence:
    | {
        bucket: string;
        endpoint: string;
        region: string;
        accessKeyId: string;
        secretAccessKey: string;
      }
    | undefined;
  checkerEndpoints: Array<{ vendor: string; model: string; apiKey: string; baseUrl?: string }>;
}

export interface EnvironmentSnapshotConfig {
  enabled: boolean;
  forVerifier: boolean;
  ttlDays: number;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string, purpose: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new MissingConfigError(name, purpose);
  return value.trim();
}

function optional(env: Env, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function numeric(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidConfigError(name, `expected a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return value;
}


function pricingOverrides(env: Env, prefix: "WINDKEEL_USD_PER_" | "WINDKEEL_CHECKER_USD_PER_"): Partial<ModelPricing> {
  const field = (name: string): number | undefined => {
    const raw = env[`${prefix}${name}`];
    return raw === undefined || raw.trim() === "" ? undefined : numeric(env, `${prefix}${name}`, 0);
  };
  const input = field("INPUT_TOKEN");
  const output = field("OUTPUT_TOKEN");
  const cached = field("CACHED_INPUT_TOKEN");
  const cacheWrite = field("CACHE_WRITE_INPUT_TOKEN");
  return {
    ...(input === undefined ? {} : { usdPerInputToken: input }),
    ...(output === undefined ? {} : { usdPerOutputToken: output }),
    ...(cached === undefined ? {} : { usdPerCachedInputToken: cached }),
    ...(cacheWrite === undefined ? {} : { usdPerCacheWriteInputToken: cacheWrite }),
  };
}
function positiveNumeric(env: Env, name: string, fallback: number): number {
  const value = numeric(env, name, fallback);
  if (value === 0) {
    throw new InvalidConfigError(
      name,
      "expected a positive number of milliseconds; 0 would busy-loop. There is no way to " +
        "disable the sweep — ADR-0015's retention window is policy. Set a long interval if you " +
        "want it to run rarely.",
    );
  }
  return value;
}

function boolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new InvalidConfigError(name, `expected true or false, got ${JSON.stringify(raw)}`);
}

export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  const databaseUrl = required(
    env,
    "DATABASE_URL",
    "the worker's direct (session-mode) Postgres connection, per ADR-0008 §1",
  );
  const poolDatabaseUrl = optional(env, "DATABASE_POOL_URL", databaseUrl);
  const repositoryUrl = required(
    env,
    "WINDKEEL_REPOSITORY_URL",
    "the repository runs work against; in M4 this is container configuration because " +
      "EngineeringTask has no repository table behind it yet (that arrives with M6's intake)",
  );
  const modelKeyEnvVar = optional(env, "WINDKEEL_MODEL_KEY_ENV_VAR", "OPENAI_API_KEY");

  required(
    env,
    modelKeyEnvVar,
    "the maker's model key. It is attached to egress by the credential broker (ADR-0014 §1) " +
      "and is never injected into a sandbox, which sees only CODEX_API_KEY_PLACEHOLDER",
  );

  const evidenceBucket = env["S3_BUCKET"]?.trim();
  const evidence = evidenceBucket
    ? {
        bucket: evidenceBucket,
        endpoint: required(env, "S3_ENDPOINT", "the S3-compatible evidence store (ADR-0008 §2)"),
        region: optional(env, "S3_REGION", "us-east-1"),
        accessKeyId: required(env, "S3_ACCESS_KEY_ID", "credentials for the evidence store"),
        secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY", "credentials for the evidence store"),
      }
    : undefined;

  const checkerEndpoints = operatorCheckerEndpoints(env);

  return {
    databaseUrl,
    poolDatabaseUrl,
    repository: {
      url: repositoryUrl,
      baseRevision: optional(env, "WINDKEEL_REPOSITORY_BASE_REVISION", "HEAD"),
    },
    makerModel: optional(env, "WINDKEEL_MAKER_MODEL", "gpt-5-codex"),
    makerVendor: optional(env, "WINDKEEL_MAKER_VENDOR", "openai"),
    modelApiDomain: optional(env, "WINDKEEL_MODEL_API_DOMAIN", "api.openai.com"),
    modelKeyEnvVar,
    ...(env["WINDKEEL_SECRET_PRIVATE_KEY"]?.trim()
      ? { secretPrivateKey: env["WINDKEEL_SECRET_PRIVATE_KEY"].trim() }
      : {}),
    ...(env["WINDKEEL_SECRET_PREVIOUS_PRIVATE_KEY"]?.trim()
      ? { secretPreviousPrivateKey: env["WINDKEEL_SECRET_PREVIOUS_PRIVATE_KEY"].trim() }
      : {}),
    modelPricing: pricingOverrides(env, "WINDKEEL_USD_PER_"),
    checkerPricing: pricingOverrides(env, "WINDKEEL_CHECKER_USD_PER_"),
    usdPerCpuMs: numeric(env, "WINDKEEL_USD_PER_CPU_MS", 0.000_000_0128),
    usdPerEgressByte: numeric(env, "WINDKEEL_USD_PER_EGRESS_BYTE", 0.000_000_000_15),
    railsCheckIntervalMs: numeric(env, "WINDKEEL_RAILS_CHECK_INTERVAL_MS", 60_000),
    approvalDeadlineSeconds: positiveNumeric(
      env,
      "WINDKEEL_APPROVAL_DEADLINE_SECONDS",
      DEFAULT_APPROVAL_DEADLINE_SECONDS,
    ),
    retentionSweepIntervalMs: positiveNumeric(
      env,
      "WINDKEEL_RETENTION_SWEEP_INTERVAL_MS",
      24 * 60 * 60 * 1000,
    ),
    workspaceTtlMs: numeric(env, "WINDKEEL_WORKSPACE_TTL_MS", 4 * 60 * 60 * 1000),
    installScanners: boolean(env, "WINDKEEL_INSTALL_SCANNERS", true),
    environmentSnapshots: {
      enabled: boolean(env, "WINDKEEL_ENVIRONMENT_SNAPSHOTS", false),
      forVerifier: boolean(env, "WINDKEEL_SNAPSHOT_FOR_VERIFIER", true),
      ttlDays: positiveNumeric(env, "WINDKEEL_SNAPSHOT_TTL_DAYS", 14),
    },
    ...makerBrowserFromEnv(env),
    harnessInstall: harnessInstallFromEnv(env),
    gitHost: optional(env, "WINDKEEL_GIT_HOST", "github.com"),
    gitAuthorName: optional(env, "WINDKEEL_GIT_AUTHOR_NAME", "Windkeel Factory"),
    gitAuthorEmail: optional(env, "WINDKEEL_GIT_AUTHOR_EMAIL", "factory@windkeel.invalid"),
    policyVersion: optional(env, "WINDKEEL_POLICY_VERSION", "v0"),
    codex: {
      binary: optional(env, "WINDKEEL_CODEX_BINARY", CODEX_DESCRIPTOR.binary),
      pinnedVersion: optional(env, CODEX_DESCRIPTOR.versionEnvVar, CODEX_DESCRIPTOR.pinnedVersion),
      allowVersionDrift: boolean(env, CODEX_DESCRIPTOR.allowDriftEnvVar, false),
    },
    claudeCode: {
      binary: optional(env, "WINDKEEL_CLAUDE_CODE_BINARY", CLAUDE_CODE_DESCRIPTOR.binary),
      pinnedVersion: descriptorVersion(CLAUDE_CODE_DESCRIPTOR, env).version,
      allowVersionDrift: boolean(env, CLAUDE_CODE_DESCRIPTOR.allowDriftEnvVar, false),
    },
    makerKeyEnvVars: makerKeyEnvVars(env),
    evidence,
    checkerEndpoints,
  };
}

function operatorCheckerEndpoints(env: Env): WorkerConfig["checkerEndpoints"] {
  const available: Record<string, WorkerConfig["checkerEndpoints"][number]> = {};
  if (env["ANTHROPIC_API_KEY"]?.trim()) {
    available["anthropic"] = {
      vendor: "anthropic",
      model: optional(env, "WINDKEEL_REVIEW_MODEL", "claude-sonnet-4-5"),
      apiKey: env["ANTHROPIC_API_KEY"].trim(),
    };
  }
  if (env["WINDKEEL_CHECKER_OPENAI_API_KEY"]?.trim()) {
    available["openai"] = {
      vendor: "openai",
      model: optional(env, "WINDKEEL_CHECKER_OPENAI_MODEL", "gpt-5"),
      apiKey: env["WINDKEEL_CHECKER_OPENAI_API_KEY"].trim(),
    };
  }
  const order = optional(env, "WINDKEEL_CHECKER_VENDORS", "anthropic,openai")
    .split(",")
    .map((vendor) => vendor.trim())
    .filter((vendor) => vendor !== "");
  for (const vendor of order) {
    if (vendor !== "anthropic" && vendor !== "openai") {
      throw new InvalidConfigError("WINDKEEL_CHECKER_VENDORS", `unknown checker vendor ${JSON.stringify(vendor)}; expected anthropic, openai`);
    }
  }
  return [...new Set(order)].flatMap((vendor) => (available[vendor] ? [available[vendor]] : []));
}

function makerKeyEnvVars(env: Env): Partial<Record<ModelProvider, string>> {
  const out: Partial<Record<ModelProvider, string>> = {};
  for (const provider of Object.keys(PROVIDERS)) {
    if (!isModelProvider(provider) || !PROVIDERS[provider].egressHost) continue;
    const name = `WINDKEEL_MAKER_KEY_ENV_VAR_${provider.toUpperCase().replace(/-/g, "_")}`;
    const value = env[name]?.trim();
    if (!value) continue;
    required(env, value, `the operator's ${provider} maker key named by ${name} (ADR-0027 §4)`);
    out[provider] = value;
  }
  return out;
}

export function harnessInstallFromEnv(env: Env = process.env): "verify" | "pinned" {
  const raw = (env["WINDKEEL_HARNESS_INSTALL"] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "verify") return "verify";
  if (raw === "pinned") return "pinned";
  throw new InvalidConfigError("WINDKEEL_HARNESS_INSTALL", `expected "verify" or "pinned", got ${JSON.stringify(env["WINDKEEL_HARNESS_INSTALL"])}`);
}

export function makerBrowserFromEnv(env: Env = process.env): { makerBrowser: boolean; makerScreenshotMax: number } {
  const max = numeric(env, "WINDKEEL_MAKER_SCREENSHOT_MAX", DEFAULT_MAKER_SCREENSHOT_MAX);
  if (!Number.isInteger(max) || max < 1) {
    throw new InvalidConfigError("WINDKEEL_MAKER_SCREENSHOT_MAX", `expected a positive integer, got ${JSON.stringify(env["WINDKEEL_MAKER_SCREENSHOT_MAX"])}`);
  }
  return { makerBrowser: boolean(env, "WINDKEEL_MAKER_BROWSER", true), makerScreenshotMax: max };
}

export function configWarnings(config: WorkerConfig, harnesses: readonly string[] = []): string[] {
  const warnings: string[] = [];
  if (!config.evidence) {
    warnings.push(
      "S3_BUCKET is unset: verifications will run and record a verdict, but no evidence " +
        "package will be stored and VerificationRun.evidence_package_ref will stay null.",
    );
  }
  if (config.checkerEndpoints.length === 0) {
    warnings.push(
      "no checker model endpoint is configured (ANTHROPIC_API_KEY): the review and mapping " +
        "stages will report themselves skipped rather than silently passing.",
    );
  }
  if (config.codex.allowVersionDrift) {
    warnings.push(
      `WINDKEEL_ALLOW_CODEX_VERSION_DRIFT is on: a codex whose version is not ` +
        `${config.codex.pinnedVersion} will be driven anyway and the mismatch recorded as a ` +
        "diagnostic. The JSONL schema is the only stability contract this adapter has (ADR-0006).",
    );
  }
  if (
    config.checkerEndpoints.length > 0 &&
    config.checkerEndpoints.every((e) => e.vendor === config.makerVendor)
  ) {
    warnings.push(
      `a checker endpoint uses the maker's vendor (${config.makerVendor}); ADR-0010 requires ` +
        "independence and selectGateway will refuse it at verification time.",
    );
  }
  for (const harness of config.checkerEndpoints.length > 0 ? harnesses : []) {
    const makerVendors = harness === "claude-code" ? ["anthropic"] : harness === "codex" ? [config.makerVendor] : [];
    for (const vendor of makerVendors) {
      if (config.checkerEndpoints.some((e) => e.vendor !== vendor)) continue;
      warnings.push(
        `the ${harness} harness is enabled and its maker vendor is ${vendor}, but no operator ` +
          `checker endpoint is another vendor's: runs of it on operator defaults have no independent ` +
          "checker and fail intake (ADR-0027 §4). Configure a second checker vendor " +
          "(WINDKEEL_CHECKER_OPENAI_API_KEY or ANTHROPIC_API_KEY) or an organization checker policy.",
      );
    }
  }
  return warnings;
}

export function secretPrivateKeys(config: {
  secretPrivateKey?: string | undefined;
  secretPreviousPrivateKey?: string | undefined;
}): string[] {
  return [config.secretPrivateKey, config.secretPreviousPrivateKey].filter(
    (key): key is string => typeof key === "string" && key !== "",
  );
}

export function secretPrivateKeysFromEnv(env: Env = process.env): string[] {
  return secretPrivateKeys({
    ...(env["WINDKEEL_SECRET_PRIVATE_KEY"]?.trim()
      ? { secretPrivateKey: env["WINDKEEL_SECRET_PRIVATE_KEY"].trim() }
      : {}),
    ...(env["WINDKEEL_SECRET_PREVIOUS_PRIVATE_KEY"]?.trim()
      ? { secretPreviousPrivateKey: env["WINDKEEL_SECRET_PREVIOUS_PRIVATE_KEY"].trim() }
      : {}),
  });
}
