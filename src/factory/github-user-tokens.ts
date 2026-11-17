

import type { Pool, PoolClient } from "pg";
import { openSecret, publicKeyFromPrivate, sealSecretV2 } from "./secret-box.js";
import { redact, type UserTokenSet } from "../github/user-client.js";
import { withTransaction } from "./db/transaction.js";
import {
  deleteGithubUserAuthorizationRow,
  selectGithubUserAuthorizationRow,
  selectSealedGithubUserAuthorizationForUpdate,
  updateGithubUserAuthorizationNeedsReauth,
  updateRefreshedGithubUserTokens,
  upsertGithubUserAuthorizationRow,
} from "./stores/github-user-authorization-store.js";

type Db = Pool | PoolClient;

const REFRESH_WITHIN_MS = 5 * 60 * 1000;

export function githubUserTokenContext(principalId: string, githubUserId: number, kind: "access" | "refresh"): string {
  return `github_user_token:${principalId}:${githubUserId}:${kind}`;
}

export interface GithubUserAuthorization {
  principalId: string;
  githubUserId: number;
  githubLogin: string;
  status: "valid" | "needs_reauth";
  statusReason: string | null;
  keypairId: string;
  hasRefreshToken: boolean;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  refreshedAt: Date | null;
}

const VIEW_COLUMNS = `principal_id, github_user_id, github_login, status, status_reason, keypair_id,
  sealed_refresh_token is not null as has_refresh_token, access_expires_at, refresh_expires_at,
  created_at, updated_at, refreshed_at`;

function mapRow(row: Record<string, unknown>): GithubUserAuthorization {
  return {
    principalId: row["principal_id"] as string,
    githubUserId: Number(row["github_user_id"]),
    githubLogin: row["github_login"] as string,
    status: row["status"] as GithubUserAuthorization["status"],
    statusReason: (row["status_reason"] as string | null) ?? null,
    keypairId: row["keypair_id"] as string,
    hasRefreshToken: row["has_refresh_token"] === true,
    accessExpiresAt: (row["access_expires_at"] as Date | null) ?? null,
    refreshExpiresAt: (row["refresh_expires_at"] as Date | null) ?? null,
    createdAt: row["created_at"] as Date,
    updatedAt: row["updated_at"] as Date,
    refreshedAt: (row["refreshed_at"] as Date | null) ?? null,
  };
}

export async function getGithubUserAuthorization(db: Db, principalId: string): Promise<GithubUserAuthorization | null> {
  const row = await selectGithubUserAuthorizationRow(db, VIEW_COLUMNS, principalId);
  return row ? mapRow(row) : null;
}

function expiry(now: number, seconds: number | undefined): Date | null {
  return typeof seconds === "number" && seconds > 0 ? new Date(now + seconds * 1000) : null;
}

function sealPair(publicKey: string, principalId: string, githubUserId: number, tokens: UserTokenSet) {
  const access = sealSecretV2(publicKey, githubUserTokenContext(principalId, githubUserId, "access"), tokens.accessToken);
  const refresh = tokens.refreshToken
    ? sealSecretV2(publicKey, githubUserTokenContext(principalId, githubUserId, "refresh"), tokens.refreshToken).sealed
    : null;
  return { sealedAccess: access.sealed, sealedRefresh: refresh, keypairId: access.keypairId };
}

export async function putGithubUserAuthorization(
  db: Db,
  input: {
    principalId: string;
    githubUserId: number;
    githubLogin: string;
    tokens: UserTokenSet;
    publicKey: string;
    now?: number;
  },
): Promise<GithubUserAuthorization> {
  const now = input.now ?? Date.now();
  const { sealedAccess, sealedRefresh, keypairId } = sealPair(input.publicKey, input.principalId, input.githubUserId, input.tokens);
  const row = await upsertGithubUserAuthorizationRow(db, VIEW_COLUMNS, {
    principalId: input.principalId,
    githubUserId: input.githubUserId,
    githubLogin: input.githubLogin,
    sealedAccess,
    sealedRefresh,
    keypairId,
    accessExpiresAt: expiry(now, input.tokens.expiresIn),
    refreshExpiresAt: expiry(now, input.tokens.refreshTokenExpiresIn),
  });
  return mapRow(row);
}

export async function deleteGithubUserAuthorization(db: Db, principalId: string): Promise<boolean> {
  return (await deleteGithubUserAuthorizationRow(db, principalId)) > 0;
}

export async function markGithubUserAuthorizationNeedsReauth(db: Db, principalId: string, reason: string): Promise<void> {
  await updateGithubUserAuthorizationNeedsReauth(db, principalId, reason.slice(0, 300));
}

export class GithubUserTokenError extends Error {
  override name = "GithubUserTokenError";
  constructor(
    readonly code: "not_authorized" | "needs_reauth" | "cannot_open" | "refresh_failed",
    message: string,
  ) {
    super(message);
  }
}

export interface OpenedGithubUserToken {
  accessToken: string;
  githubUserId: number;
  githubLogin: string;
  refreshed: boolean;
}

export async function openGithubUserToken(
  pool: Pool,
  privateKeys: readonly string[],
  principalId: string,
  options: {
    refresh: (refreshToken: string) => Promise<UserTokenSet>;
    now?: () => number;
    refreshWithinMs?: number;
  },
): Promise<OpenedGithubUserToken> {
  if (privateKeys.length === 0) {
    throw new GithubUserTokenError("cannot_open", "the stage deployment has no WINDKEEL_SECRET_PRIVATE_KEY, so the GitHub authorization cannot be opened");
  }
  const now = options.now ?? Date.now;
  const within = options.refreshWithinMs ?? REFRESH_WITHIN_MS;

  type Outcome = { opened: OpenedGithubUserToken } | { gaveUp: GithubUserTokenError };
  const giveUp = async (tx: PoolClient, code: GithubUserTokenError["code"], reason: string): Promise<Outcome> => {
    await markGithubUserAuthorizationNeedsReauth(tx, principalId, reason);
    return { gaveUp: new GithubUserTokenError(code, reason) };
  };

  const storeFailed = new Error("refreshed GitHub token not stored");
  let outcome: Outcome;
  try {
    outcome = await withTransaction(pool, async (tx): Promise<Outcome> => {
      const row = await selectSealedGithubUserAuthorizationForUpdate(tx, principalId);
      if (!row) {
        throw new GithubUserTokenError("not_authorized", "this person has not connected GitHub to merge from Windkeel");
      }
      if (row["status"] !== "valid") {
        throw new GithubUserTokenError("needs_reauth", "this person's GitHub authorization needs renewing");
      }
      const githubUserId = Number(row["github_user_id"]);
      const githubLogin = row["github_login"] as string;

      let accessToken: string;
      try {
        accessToken = openSecret(privateKeys, githubUserTokenContext(principalId, githubUserId, "access"), row["sealed_access_token"] as string);
      } catch (err) {

        return giveUp(tx, "cannot_open", `the GitHub authorization could not be opened: ${err instanceof Error ? err.message : "unknown"}`);
      }

      const accessExpiresAt = row["access_expires_at"] as Date | null;
      if (accessExpiresAt === null || accessExpiresAt.getTime() - now() > within) {
        return { opened: { accessToken, githubUserId, githubLogin, refreshed: false } };
      }

      const sealedRefresh = row["sealed_refresh_token"] as string | null;
      const refreshExpiresAt = row["refresh_expires_at"] as Date | null;
      if (sealedRefresh === null) return giveUp(tx, "needs_reauth", "the GitHub token expired and there is no refresh token");
      if (refreshExpiresAt !== null && refreshExpiresAt.getTime() <= now()) {
        return giveUp(tx, "needs_reauth", "the GitHub refresh token expired");
      }
      let refreshToken: string;
      try {
        refreshToken = openSecret(privateKeys, githubUserTokenContext(principalId, githubUserId, "refresh"), sealedRefresh);
      } catch (err) {
        return giveUp(tx, "cannot_open", `the GitHub refresh token could not be opened: ${err instanceof Error ? err.message : "unknown"}`);
      }

      let fresh: UserTokenSet;
      try {
        fresh = await options.refresh(refreshToken);
      } catch (err) {
        return giveUp(tx, "refresh_failed", redact(err instanceof Error ? err.message : "refresh failed", [refreshToken, accessToken]));
      }

      const publicKey = publicKeyFromPrivate(privateKeys[0]!);

      const sealed = sealPair(publicKey, principalId, githubUserId, fresh);
      const at = now();
      try {
        await updateRefreshedGithubUserTokens(tx, principalId, {
          sealedAccess: sealed.sealedAccess,
          sealedRefresh: sealed.sealedRefresh,
          keypairId: sealed.keypairId,
          accessExpiresAt: expiry(at, fresh.expiresIn),
          refreshExpiresAt: expiry(at, fresh.refreshTokenExpiresIn),
        });
      } catch {
        throw storeFailed;
      }
      return { opened: { accessToken: fresh.accessToken, githubUserId, githubLogin, refreshed: true } };
    });
  } catch (err) {
    if (err !== storeFailed) throw err;

    await markGithubUserAuthorizationNeedsReauth(pool, principalId, "a refreshed GitHub token could not be stored").catch(() => {});
    throw new GithubUserTokenError("refresh_failed", "a refreshed GitHub token could not be stored; connect GitHub again");
  }
  if ("gaveUp" in outcome) throw outcome.gaveUp;
  return outcome.opened;
}
