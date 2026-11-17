import { isModelProvider, PROVIDERS, type ModelProvider } from "@windkeel/verification/providers/catalog.js";
import { authHeaderFor, makerModelKeyRule, resolvedModelKeyRule } from "../../sandbox/credential-broker.js";
import type { WorkerModelRoute } from "../../worker/adapter.js";
import { harnessProviderRefusal } from "../../worker/descriptor.js";
import { HarnessUnavailableError, workerFor } from "../../worker/registry.js";
import type { KeySource } from "../model-policy.js";
import { getModelCredential, ModelCredentialError, openModelCredential } from "../model-credentials.js";
import { assertSafeBaseUrl, type EndpointGuardOptions } from "../model-endpoint-guard.js";
import { getEngineeringRun, getEngineeringTask } from "../repositories.js";
import { secretPrivateKeys } from "../worker-config.js";
import { runModelsOf } from "./run-models.js";
import type { MakerStageDeps, StageDeps, WorkersDeps } from "./stage-deps.js";
import { invalidateCredential } from "./stores/workflow-misc-store.js";

export interface MakerRoute {
  model: string;
  workerType: string;
  keySource: KeySource;
  credential?: { id: string; label: string; organizationId: string };
  route: WorkerModelRoute;
}

export class MakerRouteError extends Error {
  override readonly name: string = "MakerRouteError";
}

export class MakerCredentialUnavailableError extends MakerRouteError {
  override readonly name = "MakerCredentialUnavailableError";
}

export function makerRouteErrorOf(err: unknown): MakerRouteError | null {
  for (let current = err, depth = 0; current && depth < 5; depth++) {
    if (current instanceof MakerRouteError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

type RouteDeps = Pick<StageDeps, "pool" | "runModels" | "config"> & WorkersDeps;

export async function makerDepsFor(deps: StageDeps, engineeringRunId: string): Promise<MakerStageDeps> {
  const snapshot = await runModelsOf(deps, engineeringRunId);
  try {
    const worker = workerFor(deps, snapshot);
    const harnessVersion = snapshot?.maker.harness?.version;
    return { ...deps, worker, ...(harnessVersion ? { harnessVersion } : {}) };
  } catch (error) {
    if (error instanceof HarnessUnavailableError) throw new MakerRouteError(error.message, { cause: error });
    throw error;
  }
}

export async function makerRouteFor(
  deps: RouteDeps,
  engineeringRunId: string,
  guard: Pick<EndpointGuardOptions, "resolve"> = {},
): Promise<MakerRoute> {
  const { config } = deps;
  const snapshot = await runModelsOf(deps, engineeringRunId);
  let workerType: string;
  try {
    workerType = workerFor(deps, snapshot).name;
  } catch (error) {
    if (error instanceof HarnessUnavailableError) throw new MakerRouteError(error.message, { cause: error });
    throw error;
  }

  if (!snapshot) {
    return {
      model: config.makerModel,
      workerType,
      keySource: "orqon",
      route: {
        model: config.makerModel,
        provider: operatorMakerProvider(config.modelApiDomain),
        modelApiDomain: config.modelApiDomain,
        credentialRules: [makerModelKeyRule(config.modelApiDomain, config.modelKeyEnvVar)],
      },
    };
  }

  const maker = snapshot.maker;
  if (workerType === "codex" && maker.provider === "anthropic") {
    throw new MakerRouteError(
      `the maker is set to ${maker.model} on Anthropic's API, which Codex cannot call — it speaks ` +
        "OpenAI's wire format. Choose the Claude Code harness, route the model through OpenRouter, " +
        "or choose an OpenAI-compatible model for the maker (ADR-0026 §10, ADR-0027 §4)",
    );
  }
  const incompatible = harnessProviderRefusal(workerType, maker.provider);
  if (incompatible) throw new MakerRouteError(incompatible);
  const header = authHeaderFor(maker.provider);

  if (maker.keySource === "orqon") {
    const perProvider = maker.baseUrl ? undefined : config.makerKeyEnvVars?.[maker.provider];
    const providerHost = PROVIDERS[maker.provider]?.egressHost;
    if (perProvider && providerHost && providerHost !== config.modelApiDomain) {
      return {
        model: maker.model,
        workerType,
        keySource: "orqon",
        route: {
          model: maker.model,
          provider: maker.provider,
          modelApiDomain: providerHost,
          credentialRules: [makerModelKeyRule(providerHost, perProvider, header)],
        },
      };
    }
    const operator = operatorMakerProvider(config.modelApiDomain);
    const host = maker.baseUrl ? hostOf(maker.baseUrl) : maker.provider === operator ? config.modelApiDomain : PROVIDERS[maker.provider]?.egressHost;
    if (host !== config.modelApiDomain) {
      throw new MakerRouteError(
        `this deployment's Windkeel-managed maker key is for ${config.modelApiDomain}, and the run's ` +
          `maker is ${maker.model} on ${maker.provider}${maker.baseUrl ? ` at ${maker.baseUrl}` : ""}; ` +
          "it will not be sent there (ADR-0026 §6)",
      );
    }
    return {
      model: maker.model,
      workerType,
      keySource: "orqon",
      route: {
        model: maker.model,
        provider: maker.provider,
        ...(maker.baseUrl ? { baseUrl: maker.baseUrl } : {}),
        modelApiDomain: config.modelApiDomain,
        credentialRules: [makerModelKeyRule(config.modelApiDomain, config.modelKeyEnvVar, header)],
      },
    };
  }

  const credentialId = maker.credentialId;
  const named = `model credential "${maker.credentialLabel ?? credentialId ?? "(none)"}"`;
  if (!credentialId) {
    throw new MakerRouteError(`the maker is set to an organization key but names no credential (ADR-0026 §4)`);
  }
  const privateKeys = secretPrivateKeys(config);
  if (privateKeys.length === 0) {
    throw new MakerRouteError(
      `the maker is set to ${named}, and this deployment has no WINDKEEL_SECRET_PRIVATE_KEY to open ` +
        "it; it will not run on Windkeel's key instead (ADR-0026 §6)",
    );
  }
  const organizationId = await organizationOf(deps, engineeringRunId);
  const credential = await getModelCredential(deps.pool, organizationId, credentialId);
  if (!credential) {
    throw new MakerRouteError(`the maker's ${named} no longer exists (ADR-0026 §6)`);
  }
  const label = credential.label;
  if (credential.revokedAt !== null || credential.status === "revoked") {
    throw new MakerRouteError(`the maker's model credential "${label}" is revoked (ADR-0026 §6)`);
  }
  if (credential.status === "invalid") {
    throw new MakerRouteError(
      `the maker's model credential "${label}" is marked invalid` +
        `${credential.statusReason ? ` (${credential.statusReason})` : ""}; rotate it or choose ` +
        "another, it will not run on Windkeel's key instead (ADR-0026 §6)",
    );
  }

  const modelApiDomain = await egressHostFor(maker.provider, maker.baseUrl, named, guard);
  return {
    model: maker.model,
    workerType,
    keySource: "customer",
    credential: { id: credentialId, label, organizationId },
    route: {
      model: maker.model,
      provider: maker.provider,
      ...(maker.baseUrl ? { baseUrl: maker.baseUrl } : {}),
      modelApiDomain,
      credentialRules: [
        resolvedModelKeyRule(
          modelApiDomain,
          async () => {
            try {
              return (await openModelCredential(deps.pool, privateKeys, organizationId, credentialId)).value;
            } catch (err) {
              throw unavailable(err, label) ?? err;
            }
          },
          label,
          header,
        ),
      ],
    },
  };
}

function unavailable(err: unknown, label: string): MakerCredentialUnavailableError | null {
  let why: string | null = null;
  if (err instanceof ModelCredentialError) {
    why = err.code === "credential_revoked" ? "it was revoked" : "it no longer exists";
  } else if (err instanceof Error && err.name === "SealedSecretError") {
    why = `it could not be opened (${err.message})`;
  }
  if (why === null) return null;
  return new MakerCredentialUnavailableError(
    `the maker's model credential "${label}" became unusable during the run: ${why}; it will not ` +
      "run on Windkeel's key instead (ADR-0026 §6)",
  );
}

async function egressHostFor(
  provider: ModelProvider,
  baseUrl: string | undefined,
  named: string,
  guard: Pick<EndpointGuardOptions, "resolve">,
): Promise<string> {
  if (baseUrl) {
    try {
      return new URL(await assertSafeBaseUrl(baseUrl, guard)).hostname;
    } catch (err) {
      throw new MakerRouteError(
        `the maker's ${named} points at a base URL the maker may not reach: ` +
          `${err instanceof Error ? err.message : String(err)} (ADR-0026 §7)`,
      );
    }
  }
  const host = isModelProvider(provider) ? PROVIDERS[provider].egressHost : undefined;
  if (!host) {
    throw new MakerRouteError(`the maker's ${named} is for ${provider}, which needs a base URL and has none (ADR-0026 §7)`);
  }
  return host;
}

function operatorMakerProvider(modelApiDomain: string): ModelProvider {
  return (
    (Object.keys(PROVIDERS) as ModelProvider[]).find((p) => PROVIDERS[p].egressHost === modelApiDomain) ??
    "openai-compatible"
  );
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

async function organizationOf(deps: Pick<StageDeps, "pool">, engineeringRunId: string): Promise<string> {
  const run = await getEngineeringRun(deps.pool, engineeringRunId);
  const task = run ? await getEngineeringTask(deps.pool, run.taskId) : null;
  if (!task) throw new Error(`maker route: no task for run ${engineeringRunId}`);
  return task.organizationId;
}

export type MakerKeyFailure = "unauthorized" | "rate_limited";

export function classifyMakerFailure(error: string | undefined): MakerKeyFailure | null {
  if (!error) return null;
  if (/\b401\b|\bunauthori[sz]ed\b|invalid[_ ]api[_ ]key|incorrect api key/i.test(error)) return "unauthorized";
  if (/\b429\b|too many requests|rate[_ -]?limit|insufficient[_ ]quota|quota exceeded/i.test(error)) {
    return "rate_limited";
  }
  return null;
}

export async function makerKeyFailureReason(
  deps: Pick<StageDeps, "pool">,
  maker: MakerRoute,
  error: string | undefined,
): Promise<string | null> {
  if (maker.keySource !== "customer" || !maker.credential) return null;
  const failure = classifyMakerFailure(error);
  if (!failure) return null;
  const { id, label, organizationId } = maker.credential;
  const host = maker.route.modelApiDomain;
  if (failure === "unauthorized") {
    await invalidateCredential(deps.pool, id, organizationId, `${host} refused it (401) during a maker run`);
    return (
      `the maker's model credential "${label}" was refused by ${host} (401 Unauthorized) and is now ` +
      "marked invalid; rotate it or choose another. The run did not fall back to Windkeel's key (ADR-0026 §6)"
    );
  }
  return (
    `the maker's model credential "${label}" was rate-limited or out of quota at ${host} (429); ` +
    "retry the run later or raise the limit. The run did not fall back to Windkeel's key (ADR-0026 §6)"
  );
}
