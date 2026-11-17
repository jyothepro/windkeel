import { createHash, randomBytes } from "node:crypto";
import { policyForPrincipal, resolveTokenExpiry } from "../security-policy.js";
import { type Queryable } from "./common.js";
import { type Permission, isPermission } from "./permissions.js";
import { insertApiToken, revokeOwnedToken, selectTokensByOwner, touchLiveTokenByHash } from "./stores/token-store.js";

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  organizationId: string | null;
  permissions: Permission[];
  ownerPrincipalId: string;
  createdBy: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

const TOKEN_MARK = "orq_";

function rowToToken(row: Record<string, unknown>): ApiToken {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    prefix: row["prefix"] as string,
    organizationId: (row["organization_id"] as string | null) ?? null,
    permissions: (row["permissions"] as string[]).filter(isPermission),
    ownerPrincipalId: row["owner_principal_id"] as string,
    createdBy: (row["created_by_principal_id"] as string | null) ?? null,
    createdAt: row["created_at"] as Date,
    lastUsedAt: (row["last_used_at"] as Date | null) ?? null,
    expiresAt: (row["expires_at"] as Date | null) ?? null,
    revokedAt: (row["revoked_at"] as Date | null) ?? null,
  };
}

export function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function looksLikeApiToken(value: string): boolean {
  return value.startsWith(TOKEN_MARK);
}

export class TokenScopeError extends Error {
  override readonly name = "TokenScopeError";
}

export async function createApiToken(
  db: Queryable,
  input: {
    name: string;
    ownerPrincipalId: string;
    createdByPrincipalId: string;
    organizationId: string | null;

    creatorPin?: string | null | undefined;
    permissions: Permission[];
    ceiling: readonly Permission[];
    expiresInDays?: number | undefined;

    expiresAt?: Date | undefined;

    requiredDefaultDays?: number | undefined;
  },
): Promise<{ token: ApiToken; secret: string; expiryClamped: boolean }> {
  const creatorPin = input.creatorPin ?? null;
  if (creatorPin !== null && input.organizationId !== creatorPin) {
    throw new TokenScopeError("a token pinned to one organization can only make tokens pinned to that organization");
  }
  const beyond = input.permissions.filter((p) => !input.ceiling.includes(p));
  if (beyond.length > 0) {
    throw new TokenScopeError(`you cannot grant a token ${beyond.join(", ")}, which you do not hold`);
  }
  const name = input.name.trim();
  if (name === "" || name.length > 100) {
    throw new TokenScopeError("a token needs a name of 1 to 100 characters");
  }
  const expiresInDays = input.expiresInDays;
  if (expiresInDays !== undefined && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 366)) {
    throw new TokenScopeError("expiresInDays must be a whole number from 1 to 366");
  }
  const expiresAt = input.expiresAt;
  if (expiresAt !== undefined) {
    if (expiresInDays !== undefined) throw new TokenScopeError("give either expiresAt or expiresInDays, not both");
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new TokenScopeError("expiresAt must be a time in the future");
    }
  }

  const policy = await policyForPrincipal(db, input.ownerPrincipalId);
  const resolved = resolveTokenExpiry(policy, { expiresInDays, expiresAt, requiredDefaultDays: input.requiredDefaultDays });

  const secret = `${TOKEN_MARK}${randomBytes(32).toString("base64url")}`;
  const row = await insertApiToken(db, {
    name,
    ownerPrincipalId: input.ownerPrincipalId,
    createdByPrincipalId: input.createdByPrincipalId,
    organizationId: input.organizationId,
    permissions: input.permissions,
    prefix: secret.slice(0, TOKEN_MARK.length + 6),
    hash: hashToken(secret),
    expiresAt: resolved.expiresAt,
  });
  return { token: rowToToken(row), secret, expiryClamped: resolved.clamped };
}

export async function findLiveToken(db: Queryable, value: string): Promise<ApiToken | null> {
  const row = await touchLiveTokenByHash(db, hashToken(value));
  return row ? rowToToken(row) : null;
}

export async function listTokens(db: Queryable, ownerPrincipalId: string): Promise<ApiToken[]> {
  return (await selectTokensByOwner(db, ownerPrincipalId)).map(rowToToken);
}

export async function revokeToken(
  db: Queryable,
  ownerPrincipalId: string,
  tokenId: string,
): Promise<ApiToken | null> {
  const row = await revokeOwnedToken(db, ownerPrincipalId, tokenId);
  return row ? rowToToken(row) : null;
}
