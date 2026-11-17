

import type { RunState } from "../run-state-machine.js";
import type { WorkflowProviderCapabilities } from "./provider.js";

export const VERCEL_WORKFLOW_PROVIDER_NAME = "vercel-workflow";

export const WAIT_SLEEP_MS = 300_000;

export const RETRY_SLEEP_MS = 2_000;

export const WAKE_WINDOW_MS = 5_000;

export const MAX_ATTEMPTS = 3;

export const LOGGED_END_STATES: ReadonlySet<RunState> = new Set<RunState>(["FAILED", "MAX_REPAIR_ATTEMPTS_REACHED", "BLOCKED"]);

export const LOGGED_TEXT_MAX_CHARS = 4_000;

export const VERCEL_WORKFLOW_CAPABILITIES: Readonly<WorkflowProviderCapabilities> = {

  durableAcrossRestart: true,

  retriesFailedStages: true,

  reclaimsExpiredJobs: false,
};
