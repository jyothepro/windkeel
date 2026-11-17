import "../src/env-compat.js";
import { Pool } from "pg";
import { loadWorkerConfig } from "@windkeel/factory/runs";
import { defaultLog as log, describeError } from "@windkeel/factory/intake";
import { fireDueSchedules } from "@windkeel/factory/schedules";
import { dispatchBatches } from "@windkeel/factory/batches";
import { runEnqueuer } from "../src/windkeel-actions.js";
import { authorisedCron } from "../src/cron-route.js";
import { schemaRefusal } from "../src/schema-gate.js";

export const TICK_FAILED_BODY = { ok: false, error: "schedule tick failed" } as const;

export default async function handler(
  req: { headers: Record<string, string | string[] | undefined> },
  res: {
    status: (code: number) => typeof res;
    json: (body: unknown) => void;
  },
): Promise<void> {
  if (!authorisedCron(req.headers["authorization"])) {
    res.status(401).json({ ok: false });
    return;
  }

  let pool: Pool | undefined;
  let runs: ReturnType<typeof runEnqueuer> | undefined;
  try {
    const config = loadWorkerConfig();
    pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
    const refusal = await schemaRefusal(pool);
    if (refusal) {
      log("schedule tick refused", { code: refusal.code, pending: refusal.pending });
      res.status(503).json(refusal);
      return;
    }
    const enqueuer = runEnqueuer({ connectionString: config.poolDatabaseUrl ?? config.databaseUrl });
    runs = enqueuer;
    const outcome = await fireDueSchedules(pool, new Date(), {
      startRun: (runId) => enqueuer.startRun(runId),
      log,
    });
    log("schedule tick", {
      outcome: outcome.kind,
      ...(outcome.kind === "ran"
        ? { fired: outcome.result.fired.length, stoppedEarly: outcome.result.stoppedEarly }
        : {}),
    });
    let batches: { outcome: string; organizations?: number; started?: number } = { outcome: "failed" };
    try {
      const dispatched = await dispatchBatches(pool, { startRun: (runId) => enqueuer.startRun(runId), log });
      batches =
        dispatched.kind === "ran"
          ? {
              outcome: "ran",
              organizations: dispatched.result.length,
              started: dispatched.result.reduce((n, o) => n + o.batches.reduce((m, b) => m + b.started.length, 0), 0),
            }
          : { outcome: dispatched.kind };
      log("batch dispatch", batches);
    } catch (err) {
      log("batch dispatch failed", describeError(err));
    }
    res.status(200).json({ ok: true, ...outcome, batches });
  } catch (err) {
    log("schedule tick failed", describeError(err));
    res.status(500).json(TICK_FAILED_BODY);
  } finally {
    await runs?.stop().catch(() => {});
    await pool?.end().catch(() => {});
  }
}
