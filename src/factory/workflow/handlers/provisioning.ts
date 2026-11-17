import { enforceSpendAndTimeRails } from "../../rails-gate.js";
import { MakerRouteError, makerDepsFor, makerRouteFor } from "../maker-route.js";
import { HARNESS_DESCRIPTORS } from "../../../worker/descriptor.js";
import type { HarnessInstallSpec } from "../../../sandbox/harness-install.js";
import { assertProvisionable } from "../../criteria-gate.js";
import {
  getEngineeringRun,
  getEngineeringTask,
  listWorkspaces,
  updateWorkspace,
  type EngineeringTask,
} from "../../repositories.js";
import { provisionWorkspace } from "../../workspace-service.js";
import { resolveRepositoryTarget } from "../repository-target.js";
import { gitCredentialsFor } from "./candidate-capture.js";
import { acquireWorkspaceHandle } from "./attach-workspace.js";
import { installSecretsFor } from "./install-secrets.js";
import { environmentFor, requestBuildAfter } from "./environment.js";
import { recordDigest } from "../knowledge-flow.js";
import type { StageContext, StageHandler, StageOutcome } from "../provider.js";
import type { StageDeps } from "../stage-deps.js";

export { makerWorkspaceOf, missingMakerReason } from "./maker-workspace.js";
import { makerWorkspaceOf } from "./maker-workspace.js";

async function taskForRun(pool: StageDeps["pool"], engineeringRunId: string): Promise<EngineeringTask> {
  const run = await getEngineeringRun(pool, engineeringRunId);
  if (!run) throw new Error(`provisioning: engineering_run ${engineeringRunId} not found`);
  const task = await getEngineeringTask(pool, run.taskId);
  if (!task) throw new Error(`provisioning: engineering_task for run ${engineeringRunId} not found`);
  return task;
}

export function createProvisioningHandler(deps: StageDeps): StageHandler {
  return {
    state: "PROVISIONING",
    name: "provisioning",
    async handle(context: StageContext): Promise<StageOutcome> {
      const { pool, sandboxes, registry, config } = deps;

      const existing = makerWorkspaceOf(await listWorkspaces(pool, context.engineeringRunId));
      if (existing) {
        const handle = await acquireWorkspaceHandle({ sandboxes, registry }, existing);
        if (handle) {
          return {
            kind: "transition",
            to: "IMPLEMENTING",
            reason: `adopted existing maker workspace ${existing.id}`,
          };
        }
        await updateWorkspace(pool, existing.id, { status: "orphaned" });
        return {
          kind: "transition",
          to: "FAILED",
          reason:
            `maker workspace ${existing.id} was provisioned by a process that is gone and its ` +
            "sandbox could not be re-attached, so the run cannot continue. The sandbox is " +
            "reclaimed at Workspace.expires_at.",
          stopReason: "error",
        };
      }

      const gateTask = await taskForRun(pool, context.engineeringRunId);
      try {
        assertProvisionable({
          status: context.state,
          acceptance_criteria: gateTask.acceptanceCriteria,
          criteria_provenance: gateTask.criteriaProvenance,
          criteria_approved_at: gateTask.criteriaApprovedAt,
        });
      } catch (error) {
        return {
          kind: "transition",
          to: "FAILED",
          reason: error instanceof Error ? error.message : String(error),
          stopReason: "error",
        };
      }

      const rails = await enforceSpendAndTimeRails(pool, context.engineeringRunId);
      if (rails.stopped) {
        return { kind: "settled", observed: context.state, note: `rails: ${rails.reason}` };
      }

      if (await context.isCancellationRequested()) {
        return { kind: "settled", observed: context.state, note: "cancellation observed" };
      }

      let maker;
      try {
        maker = await makerRouteFor(deps, context.engineeringRunId);
      } catch (error) {
        if (!(error instanceof MakerRouteError)) throw error;
        return { kind: "transition", to: "FAILED", reason: error.message, stopReason: "model_policy" };
      }
      const customerKey = maker.keySource === "customer";

      const target = await resolveRepositoryTarget(pool, context.engineeringRunId, config.repository);
      const gitCredentials = await gitCredentialsFor(deps, context.engineeringRunId);
      const installSecrets = await installSecretsFor(deps, context.engineeringRunId);
      const environment = await environmentFor(deps, context.engineeringRunId, "maker");

      const harnessInstall = config.harnessInstall === "pinned" ? await pinnedHarnessFor(deps, context.engineeringRunId) : undefined;

      const { workspace, handle, environment: provisioned, harness } = await provisionWorkspace(pool, sandboxes, {
        engineeringRunId: context.engineeringRunId,
        role: "maker",
        repository: target.url,
        baseSha: target.baseRevision,
        expiresAt: new Date(Date.now() + config.workspaceTtlMs),
        ...(gitCredentials ? { gitCredentials } : {}),
        ...(installSecrets ? { installSecrets } : {}),
        ...(customerKey ? { operatorModelKey: false } : {}),
        ...(environment ? { environment } : {}),
        makerBrowser: config.makerBrowser !== false,
        ...(harnessInstall ? { harnessInstall } : {}),
      });
      registry.put(workspace.id, handle);
      await requestBuildAfter(deps, context.engineeringRunId, "maker", provisioned);

      if (!customerKey) await handle.applyCredentialBrokerRules(maker.route.credentialRules);

      await recordDigest(deps, context.engineeringRunId, gateTask, handle);

      return {
        kind: "transition",
        to: "IMPLEMENTING",
        reason: `maker workspace ${workspace.id} ready${harness && harness.status !== "present" ? `; ${harness.harness} ${harness.status}: ${harness.detail}` : ""}`,
      };
    },
  };
}

async function pinnedHarnessFor(deps: StageDeps, engineeringRunId: string): Promise<HarnessInstallSpec | undefined> {
  const { worker, harnessVersion } = await makerDepsFor(deps, engineeringRunId);
  const descriptor = HARNESS_DESCRIPTORS.get(worker.name);
  const version = harnessVersion ?? worker.version;
  if (!descriptor || !version) return undefined;
  return { harness: descriptor.id, binary: descriptor.binary, version, installSpec: descriptor.installSpec };
}
