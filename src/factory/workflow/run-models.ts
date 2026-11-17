import type { Pool, PoolClient } from "pg";
import { selectRunModelConfig } from "./stores/workflow-misc-store.js";
import type { ModelEndpoint, ModelPolicy } from "@windkeel/verification/providers/types.js";
import {
  makerIdentityOf,
  operatorProviderOf,
  type RunModelChoice,
  type RunModelConfig,
} from "../model-policy.js";
import { workerFor } from "../../worker/registry.js";
import type { StageDeps, WorkersDeps } from "./stage-deps.js";

export async function readRunModelConfig(
  db: Pool | PoolClient,
  engineeringRunId: string,
): Promise<RunModelConfig | null> {
  return ((await selectRunModelConfig(db, engineeringRunId)) as RunModelConfig | null | undefined) ?? null;
}

export function runModelsOf(
  deps: Pick<StageDeps, "pool" | "runModels">,
  engineeringRunId: string,
): Promise<RunModelConfig | null> {
  return deps.runModels ? deps.runModels(engineeringRunId) : readRunModelConfig(deps.pool, engineeringRunId);
}

export async function makerModelFor(
  deps: Pick<StageDeps, "pool" | "runModels" | "config"> & WorkersDeps,
  engineeringRunId: string,
): Promise<{ model: string; workerType: string }> {
  const snapshot = await runModelsOf(deps, engineeringRunId);
  return {
    model: snapshot?.maker.model ?? deps.config.makerModel,
    workerType: snapshot?.maker.harness?.id ?? snapshot?.maker.worker ?? workerFor(deps, snapshot).name,
  };
}

class ModelKeyUnavailableError extends Error {
  override readonly name = "ModelKeyUnavailableError";
}

export async function checkerModelsFor(
  deps: Pick<StageDeps, "pool" | "runModels" | "config">,
  engineeringRunId: string,
): Promise<ModelPolicy> {
  const snapshot = await runModelsOf(deps, engineeringRunId);
  return snapshot ? checkerPolicyFromSnapshot(snapshot, deps.config.checkerModels) : deps.config.checkerModels;
}

export function checkerPolicyFromSnapshot(snapshot: RunModelConfig, operator: ModelPolicy): ModelPolicy {
  return {
    endpoints: snapshot.checker.map((choice) => endpointWithOperatorKey(choice, operator.endpoints)),
    ...(operator.fakes ? { fakes: operator.fakes } : {}),
    maker: makerIdentityOf(snapshot),
  };
}

export function endpointWithOperatorKey(choice: RunModelChoice, operator: readonly ModelEndpoint[]): ModelEndpoint {
  if (choice.keySource !== "orqon") {
    throw new ModelKeyUnavailableError(
      `the checker is set to model credential "${choice.credentialLabel ?? choice.credentialId}", ` +
        "which this deployment cannot open yet; it will not run on Windkeel's key instead (ADR-0026 §6)",
    );
  }
  const match = operator.find(
    (endpoint) =>
      operatorProviderOf(endpoint) === choice.provider &&
      (choice.baseUrl === undefined || endpoint.baseUrl === undefined || endpoint.baseUrl === choice.baseUrl),
  );
  if (!match) {
    throw new ModelKeyUnavailableError(
      `this deployment holds no Windkeel-managed ${choice.provider} key for the checker's ` +
        `${choice.model} (ADR-0026 §6)`,
    );
  }
  return {
    ...match,
    vendor: choice.vendor,
    provider: choice.provider,
    model: choice.model,
    ...(choice.baseUrl ? { baseUrl: choice.baseUrl } : {}),
  };
}
