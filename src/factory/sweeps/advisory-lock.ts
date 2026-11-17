

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { advisoryUnlock, currentSchema, tryAdvisoryLock } from "./stores/advisory-lock-store.js";

export const WINDKEEL_ADVISORY_NAMESPACE = 0x0_71_9f_01;

export function sweepLockKey(sweep: string, schema: string): number {
  return createHash("sha256").update(`orqon:${sweep}:${schema}`).digest().readInt32BE(0);
}

export type LockOutcome<T> = { kind: "contended"; reason: string } | { kind: "ran"; result: T };

export async function withSweepLock<T>(
  pool: Pool,
  sweep: string,
  body: () => Promise<T>,
): Promise<LockOutcome<T>> {

  const client = await pool.connect();
  let held = false;
  let lockKey = 0;
  try {
    lockKey = sweepLockKey(sweep, (await currentSchema(client)) ?? "public");
    held = await tryAdvisoryLock(client, WINDKEEL_ADVISORY_NAMESPACE, lockKey);
    if (!held) {
      return {
        kind: "contended",
        reason:
          `another process holds the "${sweep}" advisory lock and is sweeping now. ` +
          "This tick did nothing, deliberately.",
      };
    }
    return { kind: "ran", result: await body() };
  } finally {
    if (held) {
      await advisoryUnlock(client, WINDKEEL_ADVISORY_NAMESPACE, lockKey).catch(() => {

      });
    }
    client.release();
  }
}
