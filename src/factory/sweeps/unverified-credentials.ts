import type { Pool } from "pg";
import type { Log } from "../stage-wiring.js";
import { withSweepLock, type LockOutcome } from "./advisory-lock.js";
import { selectUnverifiedCredentials } from "./stores/run-sweep-store.js";

const UNVERIFIED_CREDENTIALS_SWEEP = "unverified-model-credentials";

export const DEFAULT_MINIMUM_UNVERIFIED_AGE_MS = 15 * 60 * 1000;
const DEFAULT_MAXIMUM_UNVERIFIED_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_UNVERIFIED_BATCH = 25;

export interface UnverifiedCredentialsDeps {
  pool: Pool;
  startValidation(organizationId: string, credentialId: string): Promise<unknown>;
  minimumAgeMs?: number;
  maximumAgeMs?: number;
  batch?: number;
  log?: Log;
}

export interface UnverifiedCredentialsResult {
  examined: number;
  started: number;
  failed: number;
}

export async function restartUnverifiedCredentialChecks(deps: UnverifiedCredentialsDeps): Promise<UnverifiedCredentialsResult> {
  const log = deps.log ?? (() => {});
  const rows = await selectUnverifiedCredentials(
    deps.pool,
    deps.minimumAgeMs ?? DEFAULT_MINIMUM_UNVERIFIED_AGE_MS,
    deps.maximumAgeMs ?? DEFAULT_MAXIMUM_UNVERIFIED_AGE_MS,
    deps.batch ?? DEFAULT_UNVERIFIED_BATCH,
  );

  const result: UnverifiedCredentialsResult = { examined: rows.length, started: 0, failed: 0 };
  for (const row of rows) {
    try {
      await deps.startValidation(row.organization_id, row.id);
      result.started += 1;
    } catch (error) {
      result.failed += 1;
      log("could not restart a model credential check", {
        credentialId: row.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return result;
}

export async function restartUnverifiedCredentialChecksLocked(
  deps: UnverifiedCredentialsDeps,
): Promise<LockOutcome<UnverifiedCredentialsResult>> {
  return withSweepLock(deps.pool, UNVERIFIED_CREDENTIALS_SWEEP, () => restartUnverifiedCredentialChecks(deps));
}
