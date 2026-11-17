

import type { Pool } from "pg";
import { updateWorkspace } from "../repositories.js";
import { TERMINAL_STATES } from "../run-state-machine.js";
import type { SandboxProvider, SandboxRole } from "../../sandbox/provider.js";
import { withSweepLock, type LockOutcome } from "./advisory-lock.js";
import { bumpReapAttempts, selectReapableWorkspaces } from "./stores/run-sweep-store.js";

const SANDBOX_REAPER_SWEEP = "sandbox-reaper";

export const MAX_REAP_ATTEMPTS = 3;

export interface ReapableWorkspace {
  readonly id: string;
  readonly engineeringRunId: string;
  readonly role: SandboxRole;
  readonly sandboxProvider: string;
  readonly providerHandle: string;
  readonly status: string;

  readonly because: "run_terminal" | "expired" | "orphaned";
}

export async function listReapableWorkspaces(
  pool: Pool,
  now: Date,
  maxAttempts = MAX_REAP_ATTEMPTS,
): Promise<ReapableWorkspace[]> {
  const rows = await selectReapableWorkspaces(pool, TERMINAL_STATES, now, maxAttempts);
  return rows.map((row) => ({
    id: row.id as string,
    engineeringRunId: row.engineering_run_id as string,
    role: row.role as SandboxRole,
    sandboxProvider: row.sandbox_provider as string,
    providerHandle: row.provider_handle as string,
    status: row.status as string,
    because: row.because as ReapableWorkspace["because"],
  }));
}

export type ReapOutcome =
  | { workspaceId: string; kind: "destroyed"; because: ReapableWorkspace["because"] }

  | { workspaceId: string; kind: "already_gone"; because: ReapableWorkspace["because"] }

  | { workspaceId: string; kind: "unreattachable"; provider: string }
  | { workspaceId: string; kind: "failed"; error: string; attempts: number };

export interface ReapResult {
  readonly considered: number;
  readonly outcomes: ReapOutcome[];
}

export interface ReapDeps {
  pool: Pool;

  providers: Record<string, SandboxProvider>;
  now?: () => Date;
  maxAttempts?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export async function reapSandboxes(deps: ReapDeps): Promise<ReapResult> {
  const now = (deps.now ?? (() => new Date()))();
  const maxAttempts = deps.maxAttempts ?? MAX_REAP_ATTEMPTS;
  const log = deps.log ?? (() => {});

  const candidates = await listReapableWorkspaces(deps.pool, now, maxAttempts);
  const outcomes: ReapOutcome[] = [];

  for (const workspace of candidates) {
    const provider = deps.providers[workspace.sandboxProvider];
    if (!provider || !provider.capabilities.reattachable) {

      outcomes.push({
        workspaceId: workspace.id,
        kind: "unreattachable",
        provider: workspace.sandboxProvider,
      });
      continue;
    }

    try {
      const handle = await provider.attach({
        role: workspace.role,
        handleId: workspace.providerHandle,
      });
      await handle.destroy();
      await updateWorkspace(deps.pool, workspace.id, { status: "destroyed" });
      outcomes.push({ workspaceId: workspace.id, kind: "destroyed", because: workspace.because });
      log("reaped a sandbox", {
        workspaceId: workspace.id,
        engineeringRunId: workspace.engineeringRunId,
        because: workspace.because,
      });
    } catch (err) {

      if (isGone(err)) {
        await updateWorkspace(deps.pool, workspace.id, { status: "destroyed" });
        outcomes.push({
          workspaceId: workspace.id,
          kind: "already_gone",
          because: workspace.because,
        });
        continue;
      }
      const attempts = await bumpAttempts(deps.pool, workspace.id);
      const error = err instanceof Error ? err.message : String(err);
      await updateWorkspace(deps.pool, workspace.id, { status: "teardown_failed" });
      outcomes.push({ workspaceId: workspace.id, kind: "failed", error, attempts });
      log("could not reap a sandbox", {
        workspaceId: workspace.id,
        attempts,
        givingUp: attempts >= maxAttempts,
        error,
      });
    }
  }

  return { considered: candidates.length, outcomes };
}

export async function reapSandboxesLocked(deps: ReapDeps): Promise<LockOutcome<ReapResult>> {
  return withSweepLock(deps.pool, SANDBOX_REAPER_SWEEP, () => reapSandboxes(deps));
}

function isGone(err: unknown): boolean {
  return err instanceof Error && err.name === "SandboxGoneError";
}

async function bumpAttempts(pool: Pool, workspaceId: string): Promise<number> {
  return bumpReapAttempts(pool, workspaceId);
}
