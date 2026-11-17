

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { getRun, start } from "workflow/api";
import type { World } from "@workflow/world";
import type { Log } from "../stage-wiring.js";
import { getEngineeringRun } from "../repositories.js";
import { TERMINAL_STATES } from "../run-state-machine.js";
import { assertBackingOwnsRun } from "./backing.js";
import { claimBindingForStart, deleteUnstartedBinding, setBindingHandle } from "./stores/workflow-run-binding-store.js";
import { PostgresRunStateStore } from "./run-state-store.js";
import { STAGE_RUNNER_KEY, type StageRunner } from "./vercel-flow.js";
import { UnknownRunError, type StartRunResult, type WorkflowProvider } from "./provider.js";
import { VERCEL_WORKFLOW_PROVIDER_NAME, VercelWorkflowProviderCore } from "./vercel-provider-core.js";

export { VERCEL_WORKFLOW_PROVIDER_NAME };

export const WINDKEEL_RUN_WORKFLOW_ID = "workflow//./factory/workflow/vercel-flow//orqonRunFlow";

export const MODEL_CREDENTIAL_VALIDATION_WORKFLOW_ID =
  "workflow//./factory/workflow/credential-flow//orqonValidateModelCredentialFlow";

export async function startModelCredentialValidation(
  organizationId: string,
  credentialId: string,
  options: { world?: World } = {},
): Promise<{ executionId: string }> {
  const execution = await start(
    { workflowId: MODEL_CREDENTIAL_VALIDATION_WORKFLOW_ID },
    [organizationId, credentialId],
    options.world ? { world: options.world } : {},
  );
  return { executionId: execution.runId };
}

export const MERGE_PULL_REQUEST_WORKFLOW_ID = "workflow//./factory/workflow/merge-flow//orqonMergePullRequestFlow";

export async function startPullRequestMerge(
  runMergeId: string,
  options: { world?: World } = {},
): Promise<{ executionId: string }> {
  const execution = await start(
    { workflowId: MERGE_PULL_REQUEST_WORKFLOW_ID },
    [runMergeId],
    options.world ? { world: options.world } : {},
  );
  return { executionId: execution.runId };
}

export const ENVIRONMENT_SNAPSHOT_WORKFLOW_ID =
  "workflow//./factory/workflow/environment-flow//orqonBuildEnvironmentSnapshotFlow";

export async function startEnvironmentSnapshotBuild(
  organizationId: string,
  repositoryId: string,
  options: { world?: World } = {},
): Promise<{ executionId: string }> {
  const execution = await start(
    { workflowId: ENVIRONMENT_SNAPSHOT_WORKFLOW_ID },
    [organizationId, repositoryId],
    options.world ? { world: options.world } : {},
  );
  return { executionId: execution.runId };
}

export const SLACK_MENTION_FEEDBACK_WORKFLOW_ID =
  "workflow//./factory/workflow/slack-feedback-flow//orqonSlackMentionFeedbackFlow";

export async function startSlackMentionFeedback(
  deliveryKey: string,
  options: { world?: World } = {},
): Promise<{ executionId: string }> {
  const execution = await start(
    { workflowId: SLACK_MENTION_FEEDBACK_WORKFLOW_ID },
    [deliveryKey],
    options.world ? { world: options.world } : {},
  );
  return { executionId: execution.runId };
}

export interface VercelWorkflowProviderConfig {

  connectionString: string;

  applicationSchema?: string;

  world?: World;

  waitSleepMs?: number;

  maxTicks?: number;

  log?: Log;
  retrySleepMs?: number;
  maxAttempts?: number;

  wakeWindowMs?: number;

  poolMax?: number;

  onPool?: (pool: Pool) => void;
}

const DEFAULT_POOL_MAX = 4;

function publishRunner(owner: object, runner: StageRunner | null): void {
  const g = globalThis as Record<symbol, unknown>;
  if (runner) {
    if (g[STAGE_RUNNER_KEY] === undefined) {
      g[STAGE_RUNNER_KEY] = runner;
      runnerOwner = owner;
    }
    return;
  }

  if (runnerOwner === owner) {
    g[STAGE_RUNNER_KEY] = undefined;
    runnerOwner = null;
  }
}

let runnerOwner: object | null = null;

export class VercelWorkflowProvider extends VercelWorkflowProviderCore implements WorkflowProvider {

  async start(): Promise<void> {
    if (this.started) return;
    this.pool = new Pool({
      connectionString: this.config.connectionString,
      max: this.config.poolMax ?? DEFAULT_POOL_MAX,
      idleTimeoutMillis: 10_000,
      ...(this.config.applicationSchema
        ? { options: `-c search_path=${this.config.applicationSchema}` }
        : {}),
    });
    this.config.onPool?.(this.pool);
    this.store = new PostgresRunStateStore(this.pool);
    publishRunner(this, {
      tick: (runId, attempt, executionToken) => this.runTick(runId, attempt, executionToken),
      exhausted: (runId, executionToken) => this.recordTickBudgetExhausted(runId, executionToken),
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    publishRunner(this, null);
    await this.pool?.end();
    this.pool = null;
    this.store = null;
  }

  async startRun(engineeringRunId: string): Promise<StartRunResult> {
    const pool = this.requirePool();
    const run = await getEngineeringRun(pool, engineeringRunId);
    if (!run) throw new UnknownRunError(engineeringRunId);

    if (TERMINAL_STATES.has(run.status)) {
      return { engineeringRunId, state: run.status, enqueued: false };
    }

    await assertBackingOwnsRun(pool, engineeringRunId, this.name);

    const existing = await this.binding(engineeringRunId);
    if (existing) {
      const adoptable =
        existing.phase === "finished" &&
        (this.handlers.has(run.status) || (await this.hasPendingSignal(engineeringRunId)));
      if (!adoptable) return { engineeringRunId, state: run.status, enqueued: false };
    }

    const executionToken = randomUUID();
    const rowCount = await claimBindingForStart(pool, engineeringRunId, this.name, executionToken);
    if (rowCount === 0) {

      return { engineeringRunId, state: run.status, enqueued: false };
    }

    let execution;
    try {
      execution = await this.startExecution(engineeringRunId, executionToken);
    } catch (err) {

      await deleteUnstartedBinding(pool, engineeringRunId).catch(() => {});
      throw err;
    }

    await setBindingHandle(pool, engineeringRunId, execution.runId);
    return { engineeringRunId, state: run.status, enqueued: true };
  }

  protected async startExecution(engineeringRunId: string, executionToken: string) {
    return await start(
      { workflowId: WINDKEEL_RUN_WORKFLOW_ID },
      [
        engineeringRunId,
        {
          waitSleepMs: this.waitSleepMs,
          retrySleepMs: this.retrySleepMs,
          ...(this.maxTicks === undefined ? {} : { maxTicks: this.maxTicks }),
          executionToken,
        },
      ],
      this.config.world ? { world: this.config.world } : {},
    );
  }

  protected async executionHasEnded(executionHandle: string): Promise<boolean> {
    if (executionHandle === "") return false;
    try {
      const status = await getRun(executionHandle).status;
      return status === "completed" || status === "failed" || status === "cancelled";
    } catch {
      return false;
    }
  }

  protected async wake(engineeringRunId: string): Promise<boolean> {
    const deadline = Date.now() + this.wakeWindowMs;
    for (let pause = 5; ; pause = Math.min(pause * 2, 200)) {
      const binding = await this.binding(engineeringRunId);

      if (!binding || binding.phase === "finished") return false;
      if (binding.executionHandle === "") return true;
      let stopped: number;
      try {
        ({ stoppedCount: stopped } = await getRun(binding.executionHandle).wakeUp());
      } catch {

        return false;
      }
      if (stopped > 0 || binding.phase !== "waiting") return true;

      if (await this.executionHasEnded(binding.executionHandle)) return false;
      if (Date.now() >= deadline) {
        this.log("woke nothing: the run says waiting but never journalled a sleep to interrupt", {
          engineeringRunId,
          windowMs: this.wakeWindowMs,
          hint: "the signal is durable and is read on the run's next tick, at most WAIT_SLEEP_MS away",
        });
        return true;
      }
      await delay(pause);
    }
  }
}
