

import { isIP } from "node:net";
import type { Pool, PoolClient } from "pg";
import { MAX_AUDIT_RETENTION_DAYS, MIN_AUDIT_RETENTION_DAYS } from "./audit-log.js";
import {
  selectSecurityPolicyRow,
  selectSecurityPolicyRowForPrincipal,
  selectSessionLastSeen,
  touchSessionActivity,
  upsertSecurityPolicyRow,
} from "./stores/security-policy-store.js";

type Queryable = Pool | PoolClient;

export interface SecurityPolicy {
  accountId: string;
  maxTokenTtlDays: number | null;
  requireTokenExpiry: boolean;
  idleSessionMinutes: number | null;
  requireMfa: boolean;

  ipAllowlist: string[] | null;

  auditRetentionDays: number | null;
  updatedAt: Date | null;
}

export class SecurityPolicyError extends Error {
  override readonly name = "SecurityPolicyError";
}

export class TokenPolicyError extends Error {
  override readonly name = "TokenPolicyError";
}

function emptyPolicy(accountId: string): SecurityPolicy {
  return {
    accountId,
    maxTokenTtlDays: null,
    requireTokenExpiry: false,
    idleSessionMinutes: null,
    requireMfa: false,
    ipAllowlist: null,
    auditRetentionDays: null,
    updatedAt: null,
  };
}

function rowToPolicy(row: Record<string, unknown>): SecurityPolicy {
  return {
    accountId: row["account_id"] as string,
    maxTokenTtlDays: (row["max_token_ttl_days"] as number | null) ?? null,
    requireTokenExpiry: row["require_token_expiry"] === true,
    idleSessionMinutes: (row["idle_session_minutes"] as number | null) ?? null,
    requireMfa: row["require_mfa"] === true,
    ipAllowlist: (row["ip_allowlist_text"] as string[] | null) ?? null,
    auditRetentionDays: (row["audit_retention_days"] as number | null) ?? null,
    updatedAt: (row["updated_at"] as Date | null) ?? null,
  };
}

export async function getSecurityPolicy(db: Queryable, accountId: string): Promise<SecurityPolicy> {
  const row = await selectSecurityPolicyRow(db, accountId);
  return row ? rowToPolicy(row) : emptyPolicy(accountId);
}

export async function policyForPrincipal(db: Queryable, principalId: string): Promise<SecurityPolicy | null> {
  const row = await selectSecurityPolicyRowForPrincipal(db, principalId);
  return row ? rowToPolicy(row) : null;
}

export interface SecurityPolicyInput {
  maxTokenTtlDays?: unknown;
  requireTokenExpiry?: unknown;
  idleSessionMinutes?: unknown;
  requireMfa?: unknown;
  ipAllowlist?: unknown;
  auditRetentionDays?: unknown;
}

function intOrNull(value: unknown, name: string, min: number, max: number): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new SecurityPolicyError(`${name} must be null or a whole number from ${min} to ${max}`);
  }
  return value;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new SecurityPolicyError(`${name} must be true or false`);
  return value;
}

export function parseCidr(raw: string): { family: 4 | 6; bytes: number[]; prefix: number } {
  const [address, prefixText, extra] = raw.trim().split("/");
  if (extra !== undefined || !address) throw new SecurityPolicyError(`${JSON.stringify(raw)} is not a CIDR`);
  const family = isIP(address);
  if (family === 0) throw new SecurityPolicyError(`${JSON.stringify(raw)} is not a CIDR`);
  const bits = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  if (!/^\d{1,3}$/.test(prefixText ?? String(bits)) || !Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw new SecurityPolicyError(`${JSON.stringify(raw)} has a prefix length outside 0–${bits}`);
  }
  return { family: family as 4 | 6, bytes: addressBytes(address), prefix };
}

export async function putSecurityPolicy(
  db: Queryable,
  accountId: string,
  input: SecurityPolicyInput,
  updatedByPrincipalId: string,
): Promise<{ before: SecurityPolicy; after: SecurityPolicy }> {
  const before = await getSecurityPolicy(db, accountId);
  const next = { ...before };
  if (input.maxTokenTtlDays !== undefined) next.maxTokenTtlDays = intOrNull(input.maxTokenTtlDays, "maxTokenTtlDays", 1, 366);
  if (input.requireTokenExpiry !== undefined) next.requireTokenExpiry = bool(input.requireTokenExpiry, "requireTokenExpiry");
  if (input.idleSessionMinutes !== undefined) {
    next.idleSessionMinutes = intOrNull(input.idleSessionMinutes, "idleSessionMinutes", 5, 43_200);
  }
  if (input.requireMfa !== undefined) next.requireMfa = bool(input.requireMfa, "requireMfa");
  if (input.auditRetentionDays !== undefined) {
    next.auditRetentionDays = intOrNull(input.auditRetentionDays, "auditRetentionDays", MIN_AUDIT_RETENTION_DAYS, MAX_AUDIT_RETENTION_DAYS);
  }
  if (input.ipAllowlist !== undefined) {
    if (input.ipAllowlist === null) {
      next.ipAllowlist = null;
    } else {
      if (!Array.isArray(input.ipAllowlist) || input.ipAllowlist.length === 0 || input.ipAllowlist.length > 100) {
        throw new SecurityPolicyError("ipAllowlist must be null or a list of 1 to 100 CIDRs");
      }
      for (const entry of input.ipAllowlist) {
        if (typeof entry !== "string") throw new SecurityPolicyError("ipAllowlist entries must be strings");
        parseCidr(entry);
      }
      next.ipAllowlist = input.ipAllowlist as string[];
    }
  }
  try {
    const row = await upsertSecurityPolicyRow(db, accountId, next, updatedByPrincipalId);
    return { before, after: rowToPolicy(row) };
  } catch (err) {

    if ((err as { code?: string }).code === "22P02") {
      throw new SecurityPolicyError("an ipAllowlist entry has bits set to the right of its prefix; use the network address");
    }
    throw err;
  }
}

const DAY_MS = 86_400_000;

export function resolveTokenExpiry(
  policy: Pick<SecurityPolicy, "maxTokenTtlDays" | "requireTokenExpiry"> | null,
  requested: {
    expiresInDays?: number | undefined;
    expiresAt?: Date | undefined;

    requiredDefaultDays?: number | undefined;
  },
  now: Date = new Date(),
): { expiresAt: Date | null; clamped: boolean } {
  const asked =
    requested.expiresAt ?? (requested.expiresInDays !== undefined ? new Date(now.getTime() + requested.expiresInDays * DAY_MS) : null);
  if (!policy) return { expiresAt: asked, clamped: false };
  const max = policy.maxTokenTtlDays !== null ? new Date(now.getTime() + policy.maxTokenTtlDays * DAY_MS) : null;
  if (asked === null) {
    if (max) return { expiresAt: max, clamped: true };
    if (policy.requireTokenExpiry && requested.requiredDefaultDays !== undefined) {
      return { expiresAt: new Date(now.getTime() + requested.requiredDefaultDays * DAY_MS), clamped: true };
    }
    if (policy.requireTokenExpiry) {
      throw new TokenPolicyError("this account requires every token to expire; give expiresInDays or expiresAt");
    }
    return { expiresAt: null, clamped: false };
  }
  if (max && asked.getTime() > max.getTime()) return { expiresAt: max, clamped: true };
  return { expiresAt: asked, clamped: false };
}

function addressBytes(address: string): number[] {
  if (isIP(address) === 4) return address.split(".").map(Number);

  let text = address.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  let tail: number[] = [];
  if (v4) {
    tail = v4[1]!.split(".").map(Number);
    text = text.slice(0, -v4[1]!.length) + "0:0";
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const fill = rest !== undefined ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array<string>(fill).fill("0"), ...right].map((g) => parseInt(g || "0", 16));
  const bytes = groups.flatMap((g) => [(g >> 8) & 0xff, g & 0xff]);
  if (v4) bytes.splice(12, 4, ...tail);
  return bytes;
}

function unmapped(address: string): string {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return match ? match[1]! : address;
}

export function ipAllowed(ip: string | null, cidrs: readonly string[]): boolean {
  if (!ip) return false;
  const address = unmapped(ip.trim());
  const family = isIP(address);
  if (family === 0) return false;
  const bytes = addressBytes(address);
  return cidrs.some((cidr) => {
    let parsed;
    try {
      parsed = parseCidr(cidr);
    } catch {
      return false;
    }
    if (parsed.family !== family) return false;
    for (let bit = 0; bit < parsed.prefix; bit += 1) {
      const i = bit >> 3;
      const mask = 0x80 >> (bit & 7);
      if ((bytes[i]! & mask) !== (parsed.bytes[i]! & mask)) return false;
    }
    return true;
  });
}

const DEFAULT_CLIENT_IP_HEADER = "x-vercel-forwarded-for";

export function clientIp(
  headers: Record<string, string | undefined>,
  remoteAddress: string | null | undefined,
  trustedHeader: string = DEFAULT_CLIENT_IP_HEADER,
): string | null {
  const header = trustedHeader.trim().toLowerCase();
  const raw = header ? headers[header] : undefined;
  if (raw) {
    const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
    const picked = header === "x-forwarded-for" ? parts[parts.length - 1] : parts[0];
    const candidate = picked?.replace(/^\[(.*)\](:\d+)?$/, "$1");
    if (candidate && isIP(candidate) !== 0) return unmapped(candidate);
  }
  if (remoteAddress && isIP(remoteAddress) !== 0) return unmapped(remoteAddress);
  return null;
}

export function sessionIdle(lastSeen: Date | null, now: Date, idleMinutes: number | null): boolean {
  if (idleMinutes === null || lastSeen === null) return false;
  return now.getTime() - lastSeen.getTime() > idleMinutes * 60_000;
}

export interface SessionFacts {

  sessionId: string | null;

  aal: string | null;
}

export type SessionRefusal = { code: "mfa_required" | "session_idle" | "session_untracked"; error: string };

const SESSION_TOUCH_MS = 60_000;

export async function checkSessionPolicy(
  db: Queryable,
  principal: { id: string },
  session: SessionFacts,
  policy: Pick<SecurityPolicy, "requireMfa" | "idleSessionMinutes">,
  now: Date = new Date(),
): Promise<{ refusal: SessionRefusal | null; firstSeen: boolean }> {
  if (policy.requireMfa && session.aal !== "aal2") {
    return { refusal: { code: "mfa_required", error: "this account requires a second factor; sign in again with MFA" }, firstSeen: false };
  }
  if (!session.sessionId) {

    if (policy.idleSessionMinutes !== null) {
      return {
        refusal: { code: "session_untracked", error: "this account limits idle sessions, and this session carries no session id; sign in again" },
        firstSeen: false,
      };
    }
    return { refusal: null, firstSeen: false };
  }
  const lastSeen = await selectSessionLastSeen(db, session.sessionId);
  if (sessionIdle(lastSeen, now, policy.idleSessionMinutes)) {
    return {
      refusal: { code: "session_idle", error: `this session was idle for more than ${policy.idleSessionMinutes} minutes; sign in again` },
      firstSeen: false,
    };
  }

  if (lastSeen && now.getTime() - lastSeen.getTime() < SESSION_TOUCH_MS) return { refusal: null, firstSeen: false };
  await touchSessionActivity(db, session.sessionId, principal.id, now);
  return { refusal: null, firstSeen: lastSeen === null };
}
