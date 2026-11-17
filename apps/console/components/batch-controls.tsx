"use client";

import { ConfirmAction } from "./confirm-action.tsx";
import type { ActionResult } from "../lib/action-result.ts";

export function BatchControls({
  controls,
  change,
}: {
  controls: Array<"pause" | "resume" | "cancel">;
  change: (action: "pause" | "resume" | "cancel") => Promise<ActionResult>;
}) {
  if (controls.length === 0) return null;
  return (
    <div className="console-actions" data-batch-controls>
      {controls.includes("pause") ? (
        <ConfirmAction
          label="Pause"
          question="Pause this batch?"
          consequence="No new run starts until you resume it. Runs already started carry on and are verified as usual."
          confirmLabel="Pause batch"
          intent="primary"
          run={() => change("pause")}
        />
      ) : null}
      {controls.includes("resume") ? (
        <ConfirmAction
          label="Resume"
          question="Resume this batch?"
          consequence="Waiting runs start again as slots free, within the batch's limits and spending cap."
          confirmLabel="Resume batch"
          intent="primary"
          run={() => change("resume")}
        />
      ) : null}
      {controls.includes("cancel") ? (
        <ConfirmAction
          label="Cancel batch"
          question="Cancel this batch?"
          consequence="Nothing more starts, and every run of it still working is cancelled. Verified pull requests already opened are left as they are. This can't be undone."
          confirmLabel="Cancel batch"
          run={() => change("cancel")}
        />
      ) : null}
    </div>
  );
}
