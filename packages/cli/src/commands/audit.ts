import type { WindkeelApi } from "../client/api.js";
import type { RemoteIo } from "./remote.js";

export const AUDIT_USAGE =
  "usage: windkeel audit export [--since <date|time>] [--until <date|time>] [--format jsonl|csv] [--action <action|prefix*>] [--org <id>]\n" +
  "       windkeel audit verify [--json]\n" +
  "  export: the account's events (an account role with audit.read), or one organization's with --org.\n" +
  "  --since is inclusive and --until exclusive; a bare date (2026-10-01) is midnight UTC.\n";

export type AuditAction =
  | { kind: "export"; since?: string; until?: string; format: "jsonl" | "csv"; action?: string; org?: string; write: (chunk: string) => void }
  | { kind: "verify"; json?: boolean };

export function auditTime(raw: string | undefined): string | undefined | Error {
  if (raw === undefined) return undefined;
  const value = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Error(`not a date or time: ${raw}`) : parsed.toISOString();
}

export async function auditCommand(api: WindkeelApi, io: RemoteIo, action: AuditAction): Promise<number> {
  if (action.kind === "verify") {
    const verdict = await api.verifyAudit();
    if (action.json) {
      io.out(JSON.stringify(verdict, null, 2));
    } else if (verdict.ok) {
      io.out(`audit chain intact: ${verdict.checked} event(s) verified`);
    } else {
      io.out(`audit chain BROKEN at seq ${verdict.brokenAt?.seq} (${verdict.brokenAt?.reason}), after ${verdict.checked} good event(s)`);
    }
    return verdict.ok ? 0 : 1;
  }
  const after = auditTime(action.since);
  const before = auditTime(action.until);
  for (const t of [after, before]) {
    if (t instanceof Error) {
      io.err(`windkeel audit: ${t.message}`);
      return 2;
    }
  }
  let cursor: string | undefined;
  let total = 0;
  for (;;) {
    const part = await api.exportAuditPart(
      {
        format: action.format,
        ...(after ? { after: after as string } : {}),
        ...(before ? { before: before as string } : {}),
        ...(action.action ? { action: action.action } : {}),
        ...(cursor ? { cursor } : {}),
      },
      action.org,
    );
    action.write(part.body);
    total += part.count;
    if (!part.nextCursor) break;
    cursor = part.nextCursor;
  }
  io.err(`exported ${total} audit event(s)`);
  return 0;
}
