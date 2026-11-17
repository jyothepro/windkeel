import type { Pool } from "pg";
import type { Log } from "../stage-wiring.js";
import { withSweepLock, type LockOutcome } from "./advisory-lock.js";
import { deleteIgnoredDeliveriesBefore } from "./stores/intake-delivery-retention-store.js";

const INTAKE_DELIVERY_RETENTION_SWEEP = "intake-delivery-retention";

const IGNORED_DELIVERY_RETENTION_DAYS = 30;

export interface IntakeDeliveryRetentionDeps {
  pool: Pool;
  retentionDays?: number;
  log?: Log;
}

export interface IntakeDeliveryRetentionResult {
  deleted: number;
}

async function pruneIgnoredDeliveries(
  deps: IntakeDeliveryRetentionDeps,
): Promise<IntakeDeliveryRetentionResult> {
  const days = deps.retentionDays ?? IGNORED_DELIVERY_RETENTION_DAYS;
  const deleted = await deleteIgnoredDeliveriesBefore(deps.pool, days);
  if (deleted > 0) deps.log?.("pruned ignored intake deliveries", { deleted, retentionDays: days });
  return { deleted };
}

export async function pruneIgnoredDeliveriesLocked(
  deps: IntakeDeliveryRetentionDeps,
): Promise<LockOutcome<IntakeDeliveryRetentionResult>> {
  return withSweepLock(deps.pool, INTAKE_DELIVERY_RETENTION_SWEEP, () => pruneIgnoredDeliveries(deps));
}
