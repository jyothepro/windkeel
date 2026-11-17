import { railFor, type RunState } from "../lib/run-states.ts";

const WAITING: ReadonlySet<RunState> = new Set(["WAITING_FOR_APPROVAL", "WAITING_FOR_HUMAN", "PR_READY", "BLOCKED", "HUMAN_EDITING"]);

export function StageRail({
  state,
  visited,
  repairs,
}: {
  state: RunState;
  visited: RunState[];
  repairs: { taken: number; cap: number };
}) {
  return (
    <ol className="console-rail" aria-label="Stages">
      {railFor(state, visited).map(({ step, status }) => (
        <li
          key={step}
          data-status={status === "current" && WAITING.has(state) ? "waiting" : status}
          aria-current={status === "current" ? "step" : undefined}
        >
          {status === "current" ? (
            WAITING.has(state) ? (
              <span className="oq-status oq-status--dot-only" data-run="waiting" aria-hidden="true" />
            ) : (
              <span className="oq-status oq-status--dot-only" data-verdict="running" aria-hidden="true" />
            )
          ) : null}
          {step}
          {step === "Repair" && repairs.taken > 0 ? ` ${repairs.taken}/${repairs.cap}` : null}
        </li>
      ))}
    </ol>
  );
}
