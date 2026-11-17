import type { Pool, PoolClient } from "pg";
import { TERMINAL_STATES } from "./criteria-gate.js";
import type { EngineeringRun } from "./repositories.js";
import type { RunSignal } from "./workflow/provider.js";
import { recordRunAuditEvent } from "./audit-log.js";
import { selectRunRowForPullRequest } from "./stores/run-store.js";

type Queryable = Pool | PoolClient;

const PR_CLOSED_SIGNAL = "pull_request.closed";

export interface PullRequestClosedInput {
  repositoryId: string;
  pullNumber: number;
  merged: boolean;
  mergedAt?: string | null;
  sender?: string | undefined;
}

export interface PullRequestSignaller {
  signal(engineeringRunId: string, signal: RunSignal): Promise<unknown>;
}

export type PullRequestClosedOutcome =
  | { kind: "signalled"; engineeringRunId: string; merged: boolean }
  | { kind: "ignored"; reason: string };

export interface PullRequestClosedResult {
  outcome: PullRequestClosedOutcome;
  afterCommit: () => Promise<void>;
}

export async function runForPullRequest(
  db: Queryable,
  repositoryId: string,
  pullNumber: number,
): Promise<EngineeringRun | null> {
  const row = await selectRunRowForPullRequest(db, repositoryId, pullNumber);
  if (!row) return null;
  return { ...(row as unknown as EngineeringRun), id: row.id as string, status: row.status as EngineeringRun["status"] };
}

export async function applyPullRequestClosed(
  deps: { db: Queryable; control: PullRequestSignaller },
  input: PullRequestClosedInput,
): Promise<PullRequestClosedResult> {
  const nothing = async (): Promise<void> => {};
  const run = await runForPullRequest(deps.db, input.repositoryId, input.pullNumber);
  if (!run) {
    return {
      outcome: { kind: "ignored", reason: `no Windkeel run opened pull request #${input.pullNumber}` },
      afterCommit: nothing,
    };
  }
  if (TERMINAL_STATES.has(run.status)) {
    return {
      outcome: { kind: "ignored", reason: `run ${run.id} is already ${run.status}` },
      afterCommit: nothing,
    };
  }
  await recordRunAuditEvent(deps.db, run.id, {
    actor: { principalId: null, text: input.sender ?? "github", kind: "github" },
    action: input.merged ? "run.merged" : "run.pr_closed",
    detail: { via: "github", pullNumber: input.pullNumber, mergedAt: input.mergedAt ?? null },
  });
  return {
    outcome: { kind: "signalled", engineeringRunId: run.id, merged: input.merged },
    afterCommit: async () => {
      await deps.control.signal(run.id, {
        type: "external_event",
        source: "github",
        name: PR_CLOSED_SIGNAL,
        payload: {
          merged: input.merged,
          pullNumber: input.pullNumber,
          mergedAt: input.mergedAt ?? null,
        },
      });
    },
  };
}
