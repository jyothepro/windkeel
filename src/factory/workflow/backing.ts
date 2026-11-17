import type { Pool } from "pg";
import { countLiveBindingsByProvider, selectBindingProviderPhase, upsertBackingBinding } from "./stores/workflow-run-binding-store.js";

export type WorkflowBacking = "vercel-workflow";

export const WORKFLOW_BACKINGS: readonly WorkflowBacking[] = ["vercel-workflow"];

export const DEFAULT_WORKFLOW_BACKING: WorkflowBacking = "vercel-workflow";

export const WORKFLOW_BACKING_ENV = "WINDKEEL_WORKFLOW_BACKING";

const RETIRED_BACKINGS: Record<string, string> = {
  "pg-boss": "retired in #200; ADR-0021 supersedes ADR-0007 and Vercel Workflow carries every run",
};

export class UnknownWorkflowBackingError extends Error {
  constructor(value: string) {
    const retired = RETIRED_BACKINGS[value.trim()];
    super(
      retired
        ? `${WORKFLOW_BACKING_ENV}=${JSON.stringify(value)} names a backing that no longer ` +
          `exists — ${retired}. Unset the variable, or set it to ` +
          `${JSON.stringify(DEFAULT_WORKFLOW_BACKING)}.`
        : `${WORKFLOW_BACKING_ENV}=${JSON.stringify(value)} is not a known backing. ` +
          `Expected one of: ${WORKFLOW_BACKINGS.join(", ")}.`,
    );
    this.name = "UnknownWorkflowBackingError";
  }
}

export function resolveWorkflowBacking(
  env: Record<string, string | undefined> = process.env,
): { backing: WorkflowBacking; explicit: boolean } {
  const raw = env[WORKFLOW_BACKING_ENV];
  if (raw === undefined || raw === "") return { backing: DEFAULT_WORKFLOW_BACKING, explicit: false };
  const trimmed = raw.trim();
  if (!(WORKFLOW_BACKINGS as readonly string[]).includes(trimmed)) {
    throw new UnknownWorkflowBackingError(raw);
  }
  return { backing: trimmed as WorkflowBacking, explicit: true };
}

export class RunBackingConflictError extends Error {
  constructor(
    readonly engineeringRunId: string,
    readonly boundTo: string,
    readonly attemptedBy: string,
  ) {
    super(
      `workflow: run ${engineeringRunId} is already being carried by "${boundTo}" and ` +
        `"${attemptedBy}" was asked to start it. Two machineries driving one run's stages is ` +
        `not a mode. With one backing this means a run started before #200 retired pg-boss; ` +
        `it cannot be adopted, and it has to finish or be cancelled where it is.`,
    );
    this.name = "RunBackingConflictError";
  }
}

export async function assertBackingOwnsRun(
  pool: Pool,
  engineeringRunId: string,
  backing: string,
): Promise<void> {
  let rows: Array<{ provider: string; phase: string }>;
  try {
    rows = await selectBindingProviderPhase(pool, engineeringRunId);
  } catch {
    return;
  }
  const bound = rows[0];
  if (!bound || bound.phase === "finished") return;
  if (bound.provider !== backing) {
    throw new RunBackingConflictError(engineeringRunId, bound.provider, backing);
  }
}

export async function recordBacking(
  pool: Pool,
  engineeringRunId: string,
  backing: string,
  executionHandle: string,
): Promise<void> {
  await upsertBackingBinding(pool, engineeringRunId, backing, executionHandle).catch(() => {});
}

export async function backingCensus(pool: Pool): Promise<Record<string, number>> {
  const rows = await countLiveBindingsByProvider(pool);
  return Object.fromEntries(rows.map((r) => [r.provider, r.n]));
}
