
import { selectSecurityControlCounts } from "../stores/doctor-store.js";
import { type WorkerConfig } from "../../factory/worker-config.js";
import { type CheckResult, type DoctorEnvironment, pass, skip } from "./report.js";

export const SECURITY_CHECK = { id: "security-controls", title: "Security controls (SOC2-supporting, #393)" };

export async function checkSecurityControls(environment: DoctorEnvironment, config: WorkerConfig): Promise<CheckResult> {
  const pool = await environment.connect(config.databaseUrl);
  try {
    let row: Record<string, number | null>;
    try {
      const { rows } = await selectSecurityControlCounts(pool);
      row = (rows[0] ?? {}) as Record<string, number | null>;
    } catch (error) {

      if ((error as { code?: unknown })?.code === "42P01") {
        return skip(SECURITY_CHECK.id, SECURITY_CHECK.title, "the audit_event table does not exist yet", [
          "Apply the migrations (see the Postgres check above); the audit log starts recording then.",
        ]);
      }
      throw error;
    }
    const n = (key: string) => Number(row[key] ?? 0);
    const warnings: string[] = [];
    if (environment.env["WINDKEEL_API_TOKEN"]) {
      warnings.push(
        "Warning: WINDKEEL_API_TOKEN (the break-glass operator token) is set" +
          (n("bootstrap_events") > 0 ? ` and acted ${n("bootstrap_events")} time(s) in the last 30 days` : "") +
          ". No account policy narrows it; once people have their own tokens, unset it and keep it for recovery.",
      );
    } else if (n("bootstrap_events") > 0) {
      warnings.push(`Warning: the bootstrap operator acted ${n("bootstrap_events")} time(s) in the last 30 days.`);
    }
    if (n("tokens_without_expiry") > 0) {
      warnings.push(
        `Warning: ${n("tokens_without_expiry")} live token(s) never expire. An account can require expiry ` +
          "(PUT /v1/account/security-policy { requireTokenExpiry, maxTokenTtlDays }).",
      );
    }
    const sinkUrl = environment.env["WINDKEEL_AUDIT_WEBHOOK_URL"]?.trim();
    if (sinkUrl && !environment.env["WINDKEEL_AUDIT_WEBHOOK_SECRET"]?.trim()) {
      warnings.push("Warning: WINDKEEL_AUDIT_WEBHOOK_URL is set without WINDKEEL_AUDIT_WEBHOOK_SECRET, so nothing is forwarded.");
    }
    if (n("sink_failing") > 0) {
      warnings.push(
        `Warning: the audit sink is failing for ${n("sink_failing")} account(s); events are kept and resent once ` +
          "the receiver answers 2xx (audit_sink_cursor.last_error says why).",
      );
    }
    const details = [...warnings];
    if (n("verified_recent") > 0) {
      details.push(
        `${n("unsigned_recent")} of ${n("verified_recent")} verification(s) in the last 30 days produced an unsigned ` +
          "evidence package (ADR-0022: tamper-evident, no provenance).",
      );
    }
    details.push(sinkUrl ? "Audit events are forwarded to WINDKEEL_AUDIT_WEBHOOK_URL." : "No audit sink is configured; the log is in Postgres only.");
    return pass(
      SECURITY_CHECK.id,
      SECURITY_CHECK.title,
      warnings.length === 0 ? "no break-glass use, no undated tokens, no failing sink" : `${warnings.length} warning(s)`,
      details,
    );
  } finally {
    await pool.end();
  }
}
