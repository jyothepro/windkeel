import { listWorkspaces } from "../../repositories.js";
import { chargeSandboxUsage, teardownWorkspace } from "../../workspace-service.js";
import type { StageOutcome } from "../provider.js";
import { clearSessionBinding } from "../session-binding.js";
import type { StageDeps } from "../stage-deps.js";

const LIVE_STATUSES = new Set(["ready", "provisioning"]);

export interface StageResult {
  outcome: StageOutcome;
  repairLoopContinues: boolean;
}

export function ends(outcome: StageOutcome): StageResult {
  return { outcome, repairLoopContinues: false };
}

export function continues(outcome: StageOutcome): StageResult {
  return { outcome, repairLoopContinues: true };
}

export async function settleStage(
  deps: StageDeps,
  engineeringRunId: string,
  result: StageResult,
): Promise<StageOutcome> {
  if (result.repairLoopContinues) {
    await teardownRoles(deps, engineeringRunId, new Set(["verifier"]));
    await chargeKeptAliveSandboxes(deps, engineeringRunId);
  } else {
    await endRepairLoop(deps, engineeringRunId);
  }
  return result.outcome;
}

export async function endRepairLoop(deps: StageDeps, engineeringRunId: string): Promise<void> {
  deps.sessions.forget(engineeringRunId);
  await clearSessionBinding(deps.pool, engineeringRunId);
  try {
    await teardownRoles(deps, engineeringRunId, new Set(["maker", "verifier"]));
  } finally {
    await deps.afterRepairLoop?.(deps, engineeringRunId);
  }
}

async function teardownRoles(
  deps: StageDeps,
  engineeringRunId: string,
  roles: Set<string>,
): Promise<void> {
  const { pool, registry, config } = deps;
  const failures: string[] = [];
  for (const workspace of await listWorkspaces(pool, engineeringRunId)) {
    if (!roles.has(workspace.role)) continue;
    if (!LIVE_STATUSES.has(workspace.status)) continue;
    const handle = registry.get(workspace.id);
    if (!handle) continue;
    try {
      await teardownWorkspace(
        pool,
        handle,
        workspace.id,
        engineeringRunId,
        config.usdPerCpuMs,
        config.usdPerEgressByte,
      );
    } catch (error) {
      failures.push(`${workspace.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      registry.forget(workspace.id);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `teardown failed for ${failures.length} workspace(s) of run ${engineeringRunId}: ${failures.join("; ")}`,
    );
  }
}

async function chargeKeptAliveSandboxes(deps: StageDeps, engineeringRunId: string): Promise<void> {
  const { pool, registry, config } = deps;
  for (const workspace of await listWorkspaces(pool, engineeringRunId)) {
    if (!LIVE_STATUSES.has(workspace.status)) continue;
    const handle = registry.get(workspace.id);
    if (!handle) continue;
    await chargeSandboxUsage(pool, handle, workspace.id, engineeringRunId, {
      usdPerCpuMs: config.usdPerCpuMs,
      usdPerEgressByte: config.usdPerEgressByte,
    });
  }
}
