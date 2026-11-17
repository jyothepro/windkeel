import { checkIndependence } from "@windkeel/verification/providers/index.js";
import type { ModelEndpoint, ModelFetch, ModelPolicy } from "@windkeel/verification/providers/types.js";
import { redactSecrets } from "../log.js";
import { credentialProvider } from "../model-credential-providers.js";
import { ModelCredentialError, openModelCredential } from "../model-credentials.js";
import { allowLocalhostHttpFromEnv, parseBaseUrl } from "../model-endpoint-guard.js";
import {
  chosenCheckerIndex,
  endpointOf,
  makerIdentityOf,
  type KeySource,
  type RunModelChoice,
} from "../model-policy.js";
import { guardedModelFetch } from "../model-transport.js";
import { secretPrivateKeys } from "../worker-config.js";
import { checkerPolicyFromSnapshot, endpointWithOperatorKey, runModelsOf } from "./run-models.js";
import type { StageDeps } from "./stage-deps.js";
import { invalidateCredentialIfSealed, runOrganizationId } from "./stores/workflow-misc-store.js";

export class CheckerKeyError extends Error {
  override readonly name = "CheckerKeyError";
  readonly stopReason = "model_policy" as const;
}

export interface CheckerModelsInfo {
  keySource: KeySource;
  model: string | null;
  credentialId?: string;
}

type Deps = Pick<StageDeps, "pool" | "runModels" | "config">;

export interface CheckerModelsOptions {
  allowLocalhostHttp?: boolean;
}

interface Opened {
  choice: RunModelChoice;
  credentialId: string;
  organizationId: string;
  label: string;
  provider: string;
  value: string;
  sealed: string;
  keyStatus: number | null;
}

const REFUSED = new Set([401, 403]);
const EXHAUSTED = new Set([402, 429]);

export async function withCheckerModels<T>(
  deps: Deps,
  engineeringRunId: string,
  use: (policy: ModelPolicy, info: CheckerModelsInfo) => Promise<T>,
  options: CheckerModelsOptions = {},
): Promise<T> {
  const snapshot = await runModelsOf(deps, engineeringRunId);
  const operator = deps.config.checkerModels;
  if (!snapshot || snapshot.checker.every((choice) => choice.keySource === "orqon")) {
    const policy = snapshot ? checkerPolicyFromSnapshot(snapshot, operator) : operator;
    return use(policy, { keySource: "orqon", model: selectedModelOf(policy) });
  }

  const chosen = chosenCheckerIndex(snapshot);
  let opened: Opened | null = null;
  const endpoints: ModelEndpoint[] = [];
  for (const [index, choice] of snapshot.checker.entries()) {
    if (choice.keySource === "orqon") {
      endpoints.push(endpointWithOperatorKey(choice, operator.endpoints));
    } else if (index === chosen) {
      opened = await openCustomerKey(deps, engineeringRunId, choice);
      endpoints.push(customerEndpoint(opened, options));
    } else {
      endpoints.push(endpointOf(choice));
    }
  }
  const policy: ModelPolicy = {
    endpoints,
    ...(operator.fakes ? { fakes: operator.fakes } : {}),
    maker: makerIdentityOf(snapshot),
  };
  const choice = chosen >= 0 ? snapshot.checker[chosen]! : null;
  const info: CheckerModelsInfo = {
    keySource: choice?.keySource ?? "orqon",
    model: choice?.model ?? null,
    ...(choice?.keySource === "customer" && choice.credentialId ? { credentialId: choice.credentialId } : {}),
  };

  try {
    return await use(policy, info);
  } catch (error) {
    if (!opened) throw error;
    const failure = await keyFailure(deps, opened);
    if (failure) throw failure;
    throw scrubbed(error, opened.value);
  }
}

function selectedModelOf(policy: ModelPolicy): string | null {
  if (!policy.maker) return policy.endpoints[0]?.model ?? null;
  return checkIndependence(policy.maker, policy.endpoints).independent[0]?.endpoint.model ?? null;
}


async function openCustomerKey(deps: Deps, engineeringRunId: string, choice: RunModelChoice): Promise<Opened> {
  const label = choice.credentialLabel ?? choice.credentialId ?? "(unnamed)";
  const named = `model credential "${label}"`;
  const privateKeys = secretPrivateKeys(deps.config);
  if (!choice.credentialId) {
    throw new CheckerKeyError(`the checker's ${named} names no credential id (ADR-0026 §6)`);
  }
  if (privateKeys.length === 0) {
    throw new CheckerKeyError(
      `the checker is set to ${named}, and this deployment has no WINDKEEL_SECRET_PRIVATE_KEY to open it; ` +
        "it will not run on Windkeel's key instead (ADR-0026 §6)",
    );
  }
  const organizationId = await runOrganizationId(deps.pool, engineeringRunId);
  if (!organizationId) {
    throw new CheckerKeyError(`run ${engineeringRunId} has no organization to open ${named} in`);
  }

  let credential;
  let value: string;
  let sealed: string;
  try {
    ({ credential, value, sealed } = await openModelCredential(
      deps.pool,
      privateKeys,
      organizationId,
      choice.credentialId,
    ));
  } catch (error) {
    if (error instanceof ModelCredentialError || (error instanceof Error && error.name === "SealedSecretError")) {
      throw new CheckerKeyError(
        `the checker's ${named} could not be opened: ${error.message}; ` +
          "it will not run on Windkeel's key instead (ADR-0026 §6)",
      );
    }
    throw error;
  }
  if (credential.status === "invalid") {
    throw new CheckerKeyError(
      `the checker's ${named} has been marked invalid since this run started` +
        `${credential.statusReason ? ` (${credential.statusReason})` : ""}; rotate it and start a new run (ADR-0026 §6)`,
    );
  }
  if (credential.provider !== choice.provider) {
    throw new CheckerKeyError(
      `the checker's ${named} is for ${credential.provider}, but the run was frozen with ${choice.provider}`,
    );
  }
  return {
    choice,
    credentialId: credential.id,
    organizationId,
    label: credential.label,
    provider: credential.provider,
    value,
    sealed,
    keyStatus: null,
  };
}

function customerEndpoint(opened: Opened, options: CheckerModelsOptions): ModelEndpoint {
  const allowLocalhostHttp = options.allowLocalhostHttp ?? allowLocalhostHttpFromEnv();
  const named = `model credential "${opened.label}"`;
  const raw = opened.choice.baseUrl ?? credentialProvider(opened.provider)?.defaultBaseUrl ?? null;
  if (!raw) throw new CheckerKeyError(`the checker's ${named} has no base URL for ${opened.provider}`);
  let baseUrl: string;
  try {
    baseUrl = parseBaseUrl(raw, { allowLocalhostHttp }).toString().replace(/\/$/, "");
  } catch (error) {
    throw new CheckerKeyError(
      `the checker's ${named} points somewhere it may not: ${error instanceof Error ? error.message : "refused"}`,
    );
  }
  const transport = guardedModelFetch({ allowLocalhostHttp });
  const watched: ModelFetch = async (url, init) => {
    const response = await transport(url, init);
    if (REFUSED.has(response.status) || EXHAUSTED.has(response.status)) opened.keyStatus = response.status;
    return response;
  };
  return { ...endpointOf(opened.choice), apiKey: opened.value, baseUrl, fetch: watched };
}

async function keyFailure(deps: Deps, opened: Opened): Promise<CheckerKeyError | null> {
  const status = opened.keyStatus;
  if (status === null) return null;
  const named = `model credential "${opened.label}"`;
  if (REFUSED.has(status)) {
    await invalidateCredentialIfSealed(
      deps.pool,
      opened.credentialId,
      opened.organizationId,
      opened.sealed,
      `the provider refused the key (HTTP ${status}) during a checker call`,
    );
    return new CheckerKeyError(
      `${opened.provider} refused the checker's ${named} (HTTP ${status}); it is now marked invalid, ` +
        "and the run will not use another key (ADR-0026 §6)",
    );
  }
  return new CheckerKeyError(
    `the checker's ${named} is rate-limited or out of quota at ${opened.provider} (HTTP ${status}); ` +
      "retry the run later — it will not use another key (ADR-0026 §6)",
  );
}

function scrubbed(error: unknown, value: string): unknown {
  const scrub = (text: string) => redactSecrets(text.split(value).join("[redacted]"));
  if (error instanceof Error) {
    error.message = scrub(error.message);
    if (error.stack) error.stack = scrub(error.stack);
    return error;
  }
  return new Error(scrub(String(error)));
}
