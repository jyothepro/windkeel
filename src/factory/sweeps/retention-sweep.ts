import type { Pool } from "pg";
import { runRetentionSweep, type RetentionSweepResult } from "../evidence-retention.js";
import { CAPTURE_RETENTION_DAYS, runCaptureRetentionSweep } from "../capture-retention.js";
import { MAKER_SCREENSHOT_RETENTION_DAYS, runScreenshotRetentionSweep } from "../maker-screenshot-retention.js";
import type { EvidenceStorage } from "../evidence-storage.js";
import { withSweepLock } from "./advisory-lock.js";

const EVIDENCE_RETENTION_SWEEP = "evidence-retention";

export type RetentionTick =
  | { kind: "skipped"; reason: string }
  | { kind: "contended"; reason: string }
  | ({ kind: "swept" } & RetentionSweepResult & {
      capturePrunedRunIds: string[];
      makerScreenshotRunIds: string[];
      makerScreenshotsPruned: number;
      makerScreenshotsSkipped?: string;
    });

export interface RetentionSchedulerDeps {
  pool: Pool;
  storage: EvidenceStorage | undefined;
  intervalMs: number;
  log: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
  captureRetentionDays?: number;
  makerScreenshotBucket?: string | undefined;
  makerScreenshotRetentionDays?: number;
}

export interface RetentionScheduler {
  start(): void;
  stop(): Promise<void>;
  sweepOnce(): Promise<RetentionTick>;
}

export function createRetentionScheduler(deps: RetentionSchedulerDeps): RetentionScheduler {
  const now = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<RetentionTick> | null = null;
  let stopping = new AbortController();

  async function sweepOnce(): Promise<RetentionTick> {
    if (!deps.storage) {
      return {
        kind: "skipped",
        reason:
          "S3_BUCKET is unset, so no evidence package was ever stored and " +
          "verification_run.evidence_package_ref is always null. ADR-0015 has nothing to " +
          "enforce here — this is not a sweep that found nothing to do.",
      };
    }

    const outcome = await withSweepLock(deps.pool, EVIDENCE_RETENTION_SWEEP, async () => {
      const at = now();
      const evidence = await runRetentionSweep(deps.pool, deps.storage!, at, undefined, { signal: stopping.signal });
      const none = { makerScreenshotRunIds: [] as string[], makerScreenshotsPruned: 0 };
      if (evidence.interrupted) return { ...evidence, capturePrunedRunIds: [], ...none };
      const captures = await runCaptureRetentionSweep(
        deps.pool,
        deps.storage!,
        at,
        deps.captureRetentionDays ?? CAPTURE_RETENTION_DAYS,
        { signal: stopping.signal },
      );
      const swept = { prunedIds: evidence.prunedIds, capturePrunedRunIds: captures.prunedRunIds };
      if (captures.interrupted) return { ...swept, ...none, interrupted: true };
      if (!deps.makerScreenshotBucket) {
        return {
          ...swept,
          ...none,
          makerScreenshotsSkipped: "no evidence bucket was given, so maker-browser/ objects cannot be addressed",
          interrupted: false,
        };
      }
      const screenshots = await runScreenshotRetentionSweep(
        deps.pool,
        deps.storage!,
        deps.makerScreenshotBucket,
        at,
        deps.makerScreenshotRetentionDays ?? MAKER_SCREENSHOT_RETENTION_DAYS,
        { signal: stopping.signal },
      );
      return {
        ...swept,
        makerScreenshotRunIds: screenshots.prunedRunIds,
        makerScreenshotsPruned: screenshots.screenshotsPruned,
        interrupted: screenshots.interrupted,
      };
    });
    if (outcome.kind === "contended") return { kind: "contended", reason: outcome.reason };
    return { kind: "swept", ...outcome.result };
  }

  async function tick(): Promise<RetentionTick> {
    const result = await sweepOnce();
    if (result.kind === "swept") {
      deps.log("retention sweep completed", {
        pruned: result.prunedIds.length,
        capturesPruned: result.capturePrunedRunIds.length,
        makerScreenshotsPruned: result.makerScreenshotsPruned,
        ...(result.makerScreenshotsSkipped ? { makerScreenshotsSkipped: result.makerScreenshotsSkipped } : {}),
        interrupted: result.interrupted,
      });
    } else {
      deps.log(`retention sweep ${result.kind}`, { reason: result.reason });
    }
    return result;
  }

  return {
    start(): void {
      if (timer) return;
      stopping = new AbortController();
      const run = (): void => {
        if (inFlight) return;
        inFlight = tick()
          .catch((error): RetentionTick => {
            deps.log("retention sweep failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            return { kind: "skipped", reason: "the sweep threw; see the logged error" };
          })
          .finally(() => {
            inFlight = null;
          });
      };
      run();
      timer = setInterval(run, deps.intervalMs);
      timer.unref();
    },

    async stop(): Promise<void> {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      stopping.abort();
      await inFlight?.catch(() => {});
    },

    sweepOnce,
  };
}
