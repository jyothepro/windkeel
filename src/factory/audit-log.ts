

import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./db/transaction.js";
import {
  hasAuditAnchor,
  insertAuditEventRow,
  lockAuditAccount,
  purgeAuditEventRows,
  selectAuditChainHead,
  selectAuditEventRows,
  selectAuditPurgeAnchor,
  selectCanonicalInet,
  selectOrganizationAccountId,
  selectRunOrganizationForAudit,
} from "./stores/audit-store.js";
export { withTransaction };

type Queryable = Pool | PoolClient;

export const AUDIT_ACTIONS = [

  "session.signed_in",
  "session.refused",
  "request.ip_denied",

  "token.created",
  "token.revoked",
  "service_principal.created",
  "service_principal.deleted",

  "member.role_changed",
  "member.removed",
  "invitation.created",
  "invitation.deleted",
  "invitation.accepted",

  "grant.created",
  "grant.deleted",
  "secret.set",
  "secret.deleted",

  "model_credential.created",
  "model_credential.rotated",
  "model_credential.revoked",
  "model_policy.set",
  "model_policy.deleted",
  "model_preset.created",
  "model_preset.updated",
  "model_preset.deleted",

  "integration.connected",
  "integration.disconnected",
  "integration_route.created",
  "integration_route.updated",
  "integration_route.deleted",
  "schedule.created",
  "schedule.updated",
  "schedule.deleted",
  "schedule.fired",
  "webhook_endpoint.created",
  "webhook_endpoint.updated",
  "webhook_endpoint.deleted",
  "webhook_endpoint.rotated",
  "merging.changed",

  "run.approved",
  "run.cancelled",
  "run.takeover_requested",
  "run.submitted",
  "run.handed_back",
  "run.merge_requested",
  "run.verified",
  "run.verification_failed",
  "run.merged",
  "run.merge_failed",
  "run.pr_closed",

  "role.created",
  "role.updated",
  "role.deleted",

  "policy.updated",
  "access_review.exported",
  "audit.exported",
  "audit.deleted",
  "audit.retention_swept",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const AUDIT_ACTOR_KINDS = ["user", "token", "github", "system", "scim"] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export class UnknownAuditActionError extends Error {
  override readonly name = "UnknownAuditActionError";
}

export class InvalidAuditCursorError extends Error {
  override readonly name = "InvalidAuditCursorError";
}

export interface AuditActor {
  principalId: string | null;

  text: string;
  kind: AuditActorKind;
}

export interface AuditRequestContext {
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
  requestId?: string | null | undefined;
}

export interface AuditContext {
  actor: AuditActor;
  request?: AuditRequestContext | undefined;
}

export interface AuditEventInput {

  accountId?: string | null | undefined;
  organizationId?: string | null | undefined;
  actor: AuditActor;
  action: AuditAction;
  target?: { type: string; id: string } | null | undefined;
  request?: AuditRequestContext | null | undefined;
  detail?: Record<string, unknown> | undefined;
}

export interface AuditEvent {
  id: string;
  accountId: string;
  seq: number;
  organizationId: string | null;
  actorPrincipalId: string | null;
  actorText: string;
  actorKind: AuditActorKind;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  detail: Record<string, unknown>;

  prevHash: string | null;
  hash: string;

  occurredAt: string;
}

export const SYSTEM_ACTOR: AuditActor = { principalId: null, text: "orqon", kind: "system" };

export const MAX_DETAIL_BYTES = 16 * 1024;
const DETAIL_PREVIEW_CHARS = 2_000;
const MAX_TEXT = { actor: 200, userAgent: 512, requestId: 200, target: 200 } as const;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

function truncateText(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

export function sanitizeDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  if (detail === undefined) return {};
  const json = JSON.stringify(detail, (_key, v: unknown) =>
    typeof v === "string" ? v.replace(/\u0000/g, "") : typeof v === "bigint" ? v.toString() : v,
  );
  if (json === undefined) return {};
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= MAX_DETAIL_BYTES) {
    const parsed = JSON.parse(json) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
  }
  return { truncated: true, bytes, preview: truncateText(json, DETAIL_PREVIEW_CHARS) };
}

function hashedFields(event: Omit<AuditEvent, "hash">): Record<string, unknown> {
  return {
    id: event.id,
    accountId: event.accountId,
    seq: event.seq,
    organizationId: event.organizationId,
    actorPrincipalId: event.actorPrincipalId,
    actorText: event.actorText,
    actorKind: event.actorKind,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    ip: event.ip,
    userAgent: event.userAgent,
    requestId: event.requestId,
    detail: event.detail,
    prevHash: event.prevHash,
    occurredAt: event.occurredAt,
  };
}

export function computeAuditHash(event: Omit<AuditEvent, "hash">): string {
  const digest = createHash("sha256");
  if (event.prevHash) digest.update(Buffer.from(event.prevHash, "hex"));
  digest.update(canonicalJson(hashedFields(event)), "utf8");
  return digest.digest("hex");
}

function rowToEvent(row: Record<string, unknown>): AuditEvent {
  const hex = (v: unknown) => (v === null || v === undefined ? null : (v as Buffer).toString("hex"));
  return {
    id: row["id"] as string,
    accountId: row["account_id"] as string,
    seq: Number(row["seq"]),
    organizationId: (row["organization_id"] as string | null) ?? null,
    actorPrincipalId: (row["actor_principal_id"] as string | null) ?? null,
    actorText: row["actor_text"] as string,
    actorKind: row["actor_kind"] as AuditActorKind,
    action: row["action"] as string,
    targetType: (row["target_type"] as string | null) ?? null,
    targetId: (row["target_id"] as string | null) ?? null,
    ip: (row["ip_text"] as string | null) ?? null,
    userAgent: (row["user_agent"] as string | null) ?? null,
    requestId: (row["request_id"] as string | null) ?? null,
    detail: (row["detail"] as Record<string, unknown>) ?? {},
    prevHash: hex(row["prev_hash"]),
    hash: hex(row["hash"])!,
    occurredAt: (row["occurred_at"] as Date).toISOString(),
  };
}

export async function recordAuditEvent(db: Queryable, input: AuditEventInput): Promise<AuditEvent> {
  if (!isAuditAction(input.action)) throw new UnknownAuditActionError(`unknown audit action ${JSON.stringify(input.action)}`);
  if (!(AUDIT_ACTOR_KINDS as readonly string[]).includes(input.actor.kind)) {
    throw new UnknownAuditActionError(`unknown actor kind ${JSON.stringify(input.actor.kind)}`);
  }
  return withTransaction(db, async (tx) => {
    let accountId = input.accountId ?? null;
    if (!accountId) {
      if (!input.organizationId) throw new Error("an audit event needs an account or an organization");
      accountId = await selectOrganizationAccountId(tx, input.organizationId);
      if (!accountId) throw new Error("an audit event names an organization that does not exist");
    }
    await lockAuditAccount(tx, accountId);
    const prev = await selectAuditChainHead(tx, accountId);
    const ip = await canonicalIp(tx, input.request?.ip);
    const occurredAt = new Date(Math.max(Date.now(), prev ? (prev["occurred_at"] as Date).getTime() : 0));
    const unhashed: Omit<AuditEvent, "hash"> = {
      id: randomUUID(),
      accountId,
      seq: prev ? Number(prev["seq"]) + 1 : 1,
      organizationId: input.organizationId ?? null,
      actorPrincipalId: input.actor.principalId,
      actorText: truncateText(input.actor.text || "unknown", MAX_TEXT.actor),
      actorKind: input.actor.kind,
      action: input.action,
      targetType: input.target ? truncateText(input.target.type, MAX_TEXT.target) : null,
      targetId: input.target ? truncateText(input.target.id, MAX_TEXT.target) : null,
      ip,
      userAgent: input.request?.userAgent ? truncateText(input.request.userAgent, MAX_TEXT.userAgent) : null,
      requestId: input.request?.requestId ? truncateText(input.request.requestId, MAX_TEXT.requestId) : null,
      detail: sanitizeDetail(input.detail),
      prevHash: prev ? (prev["hash"] as Buffer).toString("hex") : null,
      occurredAt: occurredAt.toISOString(),
    };
    const hash = computeAuditHash(unhashed);
    await insertAuditEventRow(tx, {
      id: unhashed.id,
      accountId: unhashed.accountId,
      seq: unhashed.seq,
      organizationId: unhashed.organizationId,
      actorPrincipalId: unhashed.actorPrincipalId,
      actorText: unhashed.actorText,
      actorKind: unhashed.actorKind,
      action: unhashed.action,
      targetType: unhashed.targetType,
      targetId: unhashed.targetId,
      ip: unhashed.ip,
      userAgent: unhashed.userAgent,
      requestId: unhashed.requestId,
      detail: JSON.stringify(unhashed.detail),
      prevHash: unhashed.prevHash ? Buffer.from(unhashed.prevHash, "hex") : null,
      hash: Buffer.from(hash, "hex"),
      occurredAt: unhashed.occurredAt,
    });
    return { ...unhashed, hash };
  });
}

export async function recordRunAuditEvent(
  db: Queryable,
  engineeringRunId: string,
  input: Omit<AuditEventInput, "accountId" | "organizationId" | "target">,
): Promise<AuditEvent | null> {
  const organizationId = await selectRunOrganizationForAudit(db, engineeringRunId);
  if (!organizationId) return null;
  return recordAuditEvent(db, { ...input, organizationId, target: { type: "run", id: engineeringRunId } });
}

async function canonicalIp(tx: PoolClient, raw: string | null | undefined): Promise<string | null> {
  if (!raw) return null;
  const candidate = raw.trim().replace(/^\[(.*)\]$/, "$1");
  if (isIP(candidate) === 0) return null;
  return selectCanonicalInet(tx, candidate);
}

export interface AuditFilter {
  accountId: string;
  organizationId?: string | null | undefined;

  after?: Date | undefined;

  before?: Date | undefined;

  action?: string | undefined;
  actorPrincipalId?: string | undefined;
}

const DEFAULT_AUDIT_PAGE = 50;
const MAX_AUDIT_PAGE = 500;

export function encodeAuditCursor(seq: number): string {
  return Buffer.from(`audit:${seq}`, "utf8").toString("base64url");
}

export function decodeAuditCursor(cursor: string): number {
  const decoded = /^[A-Za-z0-9_-]+$/.test(cursor) ? Buffer.from(cursor, "base64url").toString("utf8") : "";
  const match = /^audit:(\d{1,15})$/.exec(decoded);
  if (!match) throw new InvalidAuditCursorError("that is not an audit cursor; start again without one");
  return Number(match[1]);
}

export function parseActionFilter(raw: string | undefined): { exact?: string; prefix?: string } {
  if (raw === undefined || raw === "") return {};
  if (raw.endsWith("*")) {
    const prefix = raw.slice(0, -1);
    if (AUDIT_ACTIONS.some((a) => a.startsWith(prefix))) return { prefix };
  } else if (isAuditAction(raw)) {
    return { exact: raw };
  }
  throw new UnknownAuditActionError(`unknown audit action ${JSON.stringify(raw)}`);
}

function whereFor(filter: AuditFilter, params: unknown[]): string[] {
  const clauses = ["e.account_id = $1"];
  params.push(filter.accountId);
  const add = (sql: (n: number) => string, value: unknown) => {
    params.push(value);
    clauses.push(sql(params.length));
  };
  if (filter.organizationId) add((n) => `e.organization_id = $${n}`, filter.organizationId);
  if (filter.after) add((n) => `e.occurred_at >= $${n}`, filter.after);
  if (filter.before) add((n) => `e.occurred_at < $${n}`, filter.before);
  const action = parseActionFilter(filter.action);
  if (action.exact) add((n) => `e.action = $${n}`, action.exact);
  if (action.prefix) add((n) => `starts_with(e.action, $${n})`, action.prefix);
  if (filter.actorPrincipalId) add((n) => `e.actor_principal_id = $${n}`, filter.actorPrincipalId);
  return clauses;
}

export interface AuditPage {
  items: AuditEvent[];
  endCursor: string | null;
  hasNextPage: boolean;
}

export async function listAuditEvents(
  db: Queryable,
  filter: AuditFilter & { cursor?: string | undefined; limit?: number | undefined },
): Promise<AuditPage> {
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? DEFAULT_AUDIT_PAGE) || DEFAULT_AUDIT_PAGE, 1), MAX_AUDIT_PAGE);
  const params: unknown[] = [];
  const where = whereFor(filter, params);
  if (filter.cursor) {
    params.push(decodeAuditCursor(filter.cursor));
    where.push(`e.seq < $${params.length}`);
  }
  const rows = await selectAuditEventRows(db, where, params, "desc", limit + 1);
  const items = rows.slice(0, limit).map(rowToEvent);
  const hasNextPage = rows.length > limit;
  return { items, endCursor: hasNextPage && items.length ? encodeAuditCursor(items[items.length - 1]!.seq) : null, hasNextPage };
}

export async function readAuditEventsAscending(
  db: Queryable,
  filter: AuditFilter,
  afterSeq: number,
  limit: number,
): Promise<AuditEvent[]> {
  const params: unknown[] = [];
  const where = whereFor(filter, params);
  params.push(afterSeq);
  where.push(`e.seq > $${params.length}`);
  const rows = await selectAuditEventRows(db, where, params, "asc", limit);
  return rows.map(rowToEvent);
}

export type AuditExportFormat = "jsonl" | "csv";

const CSV_COLUMNS = [
  "id",
  "seq",
  "occurred_at",
  "account_id",
  "organization_id",
  "actor_kind",
  "actor_principal_id",
  "actor_text",
  "action",
  "target_type",
  "target_id",
  "ip",
  "user_agent",
  "request_id",
  "detail",
  "prev_hash",
  "hash",
] as const;

export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : typeof value === "object" ? canonicalJson(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(event: AuditEvent): string {
  const cells: Record<(typeof CSV_COLUMNS)[number], unknown> = {
    id: event.id,
    seq: event.seq,
    occurred_at: event.occurredAt,
    account_id: event.accountId,
    organization_id: event.organizationId,
    actor_kind: event.actorKind,
    actor_principal_id: event.actorPrincipalId,
    actor_text: event.actorText,
    action: event.action,
    target_type: event.targetType,
    target_id: event.targetId,
    ip: event.ip,
    user_agent: event.userAgent,
    request_id: event.requestId,
    detail: event.detail,
    prev_hash: event.prevHash,
    hash: event.hash,
  };
  return CSV_COLUMNS.map((c) => csvField(cells[c])).join(",");
}

function jsonlRow(event: AuditEvent): string {
  return JSON.stringify(event);
}

const MAX_EXPORT_BYTES = 4 * 1024 * 1024;

export interface AuditExportPart {
  body: string;
  contentType: string;
  count: number;

  nextCursor: string | null;
}

export async function exportAuditEvents(
  db: Queryable,
  filter: AuditFilter & { format: AuditExportFormat; cursor?: string | undefined; maxBytes?: number | undefined },
): Promise<AuditExportPart> {
  const maxBytes = filter.maxBytes ?? MAX_EXPORT_BYTES;
  let afterSeq = filter.cursor ? decodeAuditCursor(filter.cursor) : 0;
  const lines: string[] = [];
  if (filter.format === "csv" && !filter.cursor) lines.push(CSV_COLUMNS.join(","));
  let bytes = lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  let count = 0;
  for (;;) {
    const batch = await readAuditEventsAscending(db, filter, afterSeq, 500);
    for (const event of batch) {
      const line = filter.format === "csv" ? csvRow(event) : jsonlRow(event);
      const size = Buffer.byteLength(line) + 1;
      if (count > 0 && bytes + size > maxBytes) {
        return finish(lines, filter.format, count, encodeAuditCursor(afterSeq));
      }
      lines.push(line);
      bytes += size;
      count += 1;
      afterSeq = event.seq;
    }
    if (batch.length < 500) return finish(lines, filter.format, count, null);
  }
}

function finish(lines: string[], format: AuditExportFormat, count: number, nextCursor: string | null): AuditExportPart {
  return {
    body: lines.length ? `${lines.join("\n")}\n` : "",
    contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
    count,
    nextCursor,
  };
}

export type ChainBreak = {
  seq: number;
  id: string;
  reason: "hash_mismatch" | "chain_broken" | "sequence_gap" | "unanchored_start";
};

export interface ChainVerdict {
  ok: boolean;
  checked: number;
  brokenAt?: ChainBreak;
}

export function verifyChainRows(rows: readonly AuditEvent[], previous: AuditEvent | null = null): ChainVerdict {
  let prev = previous;
  let checked = 0;
  for (const row of rows) {
    const { hash, ...rest } = row;
    if (computeAuditHash(rest) !== hash) return { ok: false, checked, brokenAt: { seq: row.seq, id: row.id, reason: "hash_mismatch" } };
    if (prev) {
      if (row.prevHash !== prev.hash) return { ok: false, checked, brokenAt: { seq: row.seq, id: row.id, reason: "chain_broken" } };
      if (row.seq !== prev.seq + 1) return { ok: false, checked, brokenAt: { seq: row.seq, id: row.id, reason: "sequence_gap" } };
    }
    prev = row;
    checked += 1;
  }
  return { ok: true, checked };
}

export async function verifyAuditChain(db: Queryable, accountId: string): Promise<ChainVerdict> {
  const filter = { accountId };
  let previous: AuditEvent | null = null;
  let checked = 0;
  let afterSeq = 0;
  for (;;) {
    const batch = await readAuditEventsAscending(db, filter, afterSeq, 1_000);
    if (batch.length === 0) break;
    if (previous === null) {
      const first = batch[0]!;
      if (first.prevHash !== null || first.seq !== 1) {
        const anchored = await hasAuditAnchor(db, accountId, first.prevHash ?? "");
        if (!anchored || first.prevHash === null) {
          return { ok: false, checked, brokenAt: { seq: first.seq, id: first.id, reason: "unanchored_start" } };
        }
      }
    }
    const verdict = verifyChainRows(batch, previous);
    checked += verdict.checked;
    if (!verdict.ok) return { ...verdict, checked };
    previous = batch[batch.length - 1]!;
    afterSeq = previous.seq;
  }
  return { ok: true, checked };
}

const DEFAULT_AUDIT_RETENTION_DAYS = 90;
export const MIN_AUDIT_RETENTION_DAYS = 30;
export const MAX_AUDIT_RETENTION_DAYS = 3650;

export function auditRetentionDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["WINDKEEL_AUDIT_RETENTION_DAYS"]?.trim();
  if (!raw) return DEFAULT_AUDIT_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < MIN_AUDIT_RETENTION_DAYS || days > MAX_AUDIT_RETENTION_DAYS) {
    throw new Error(
      `WINDKEEL_AUDIT_RETENTION_DAYS must be a whole number of days from ${MIN_AUDIT_RETENTION_DAYS} to ${MAX_AUDIT_RETENTION_DAYS}`,
    );
  }
  return days;
}

export async function purgeAuditEvents(
  db: Queryable,
  input: {
    accountId: string;
    before: Date;
    actor: AuditActor;
    reason: "deleted" | "retention";
    request?: AuditRequestContext | undefined;
    detail?: Record<string, unknown> | undefined;
  },
): Promise<{ deleted: number; event: AuditEvent | null }> {
  const before = new Date(Math.min(input.before.getTime(), Date.now()));
  return withTransaction(db, async (tx) => {
    await lockAuditAccount(tx, input.accountId);
    const anchor = await selectAuditPurgeAnchor(tx, input.accountId, before);
    if (!anchor && input.reason === "retention") return { deleted: 0, event: null };
    const expected = anchor ? Number(anchor["n"]) : 0;

    const event = await recordAuditEvent(tx, {
      accountId: input.accountId,
      actor: input.actor,
      action: input.reason === "deleted" ? "audit.deleted" : "audit.retention_swept",
      request: input.request,
      detail: {
        ...input.detail,
        before: before.toISOString(),
        deleted: expected,
        anchorHash: anchor ? (anchor["hash"] as Buffer).toString("hex") : null,
        throughSeq: anchor ? Number(anchor["seq"]) : null,
      },
    });
    const deleted = await purgeAuditEventRows(tx, input.accountId, before);

    if (deleted !== expected) throw new Error(`audit purge deleted ${deleted} events, expected ${expected}`);
    return { deleted, event };
  });
}
