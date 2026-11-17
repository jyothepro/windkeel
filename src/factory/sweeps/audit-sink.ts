import type { Pool } from "pg";
import type { Log } from "../stage-wiring.js";
import { readAuditEventsAscending } from "../audit-log.js";
import { signHmacSha256 } from "../../intake/hmac.js";
import { withSweepLock, type LockOutcome } from "./advisory-lock.js";
import { recordSinkFailure, recordSinkSuccess, selectAccountsBehindSink } from "./stores/audit-sweep-store.js";

const AUDIT_SINK_SWEEP = "audit-sink";
const AUDIT_SINK_BATCH = 500;
const SINK_TIMEOUT_MS = 10_000;

export interface AuditSinkConfig {
  url: string;
  secret: string;
}

export function auditSinkFromEnv(env: NodeJS.ProcessEnv = process.env): AuditSinkConfig | null {
  const url = env["WINDKEEL_AUDIT_WEBHOOK_URL"]?.trim();
  const secret = env["WINDKEEL_AUDIT_WEBHOOK_SECRET"]?.trim();
  if (!url && !secret) return null;
  if (!url || !secret) throw new Error("set both WINDKEEL_AUDIT_WEBHOOK_URL and WINDKEEL_AUDIT_WEBHOOK_SECRET, or neither");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
    throw new Error("WINDKEEL_AUDIT_WEBHOOK_URL must be https");
  }
  return { url, secret };
}

export interface AuditSinkDeps {
  pool: Pool;
  sink: AuditSinkConfig;
  fetchImpl?: typeof fetch;
  batchSize?: number;
  now?: () => Date;
  log?: Log;
}

export interface AuditSinkResult {
  accounts: number;
  sent: number;
  failed: number;
}

function signAuditDelivery(secret: string, timestamp: number, body: string): string {
  return signHmacSha256({ secret, body: `${timestamp}.${body}`, prefix: "sha256=", encoding: "hex" });
}

export async function forwardAuditEvents(deps: AuditSinkDeps): Promise<AuditSinkResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const batchSize = deps.batchSize ?? AUDIT_SINK_BATCH;
  const now = deps.now ?? (() => new Date());
  const pending = await selectAccountsBehindSink(deps.pool);
  const result: AuditSinkResult = { accounts: pending.length, sent: 0, failed: 0 };
  for (const row of pending) {
    const accountId = row["id"] as string;
    const events = await readAuditEventsAscending(deps.pool, { accountId }, Number(row["last_seq"]), batchSize);
    if (events.length === 0) continue;
    const body = JSON.stringify({ accountId, events });
    const timestamp = Math.floor(now().getTime() / 1000);
    let error: string | null = null;
    try {
      const response = await fetchImpl(deps.sink.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "windkeel-audit-sink",
          "x-windkeel-timestamp": String(timestamp),
          "x-windkeel-signature": signAuditDelivery(deps.sink.secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
      });
      if (!response.ok) error = `the receiver answered HTTP ${response.status}`;
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : "delivery failed";
    }
    if (error === null) {
      await recordSinkSuccess(deps.pool, accountId, events[events.length - 1]!.seq);
      result.sent += events.length;
    } else {
      await recordSinkFailure(deps.pool, accountId, Number(row["last_seq"]), error);
      result.failed += 1;
      deps.log?.("audit sink delivery failed", { accountId, error });
    }
  }
  return result;
}

export async function forwardAuditEventsLocked(deps: AuditSinkDeps): Promise<LockOutcome<AuditSinkResult>> {
  return withSweepLock(deps.pool, AUDIT_SINK_SWEEP, () => forwardAuditEvents(deps));
}
