import { TERMINAL_STATES, type RunState } from "../run-state-machine.js";
import { getEngineeringRun } from "../repositories.js";
import { runRepositoryGranted } from "../tenancy.js";
import type { StageContext, StageHandler, StageOutcome } from "./provider.js";
import type { StageDeps } from "./stage-deps.js";

export const GRANT_REVOKED_REASON =
  "the organization no longer holds a grant on this run's repository, so the run cannot continue (ADR-0024 §2)";

export const LIVE_SESSION_STATES: ReadonlySet<RunState> = new Set(["IMPLEMENTING", "VERIFYING", "REPAIRING"]);

export function withRepositoryGrant(deps: Pick<StageDeps, "pool">, handler: StageHandler): StageHandler {
  const granted = (runId: string) => runRepositoryGranted(deps.pool, runId);
  return {
    state: handler.state,
    name: handler.name,
    async handle(context: StageContext): Promise<StageOutcome> {
      const cancelled: StageOutcome = { kind: "transition", to: "CANCELLED", reason: GRANT_REVOKED_REASON };
      let revoked = !(await granted(context.engineeringRunId));
      if (revoked && !LIVE_SESSION_STATES.has(context.state)) return cancelled;

      const outcome = await handler.handle({
        ...context,
        isCancellationRequested: async () => {
          if (await context.isCancellationRequested()) return true;
          if (!revoked) revoked = !(await granted(context.engineeringRunId));
          return revoked;
        },
      });
      if (!revoked) return outcome;
      if (outcome.kind === "transition" && TERMINAL_STATES.has(outcome.to)) return outcome;
      if (outcome.kind === "settled") {
        const run = await getEngineeringRun(deps.pool, context.engineeringRunId);
        if (!run || TERMINAL_STATES.has(run.status)) return outcome;
      }
      return cancelled;
    },
  };
}
