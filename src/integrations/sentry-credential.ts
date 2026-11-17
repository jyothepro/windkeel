import type { Pool, PoolClient } from "pg";
import { openSecret, sealSecretV2 } from "../factory/secret-box.js";
import { deleteSentryCredentialRow, selectSealedSentryToken, selectSentryCredentialView, upsertSentryCredential } from "./stores/connections-store.js";

type Queryable = Pool | PoolClient;

export function sentryCredentialContext(organizationId: string, connectionId: string): string {
  return `sentry_credential:${organizationId}:${connectionId}`;
}

const SENTRY_TOKEN_MAX_CHARS = 512;

class SentryCredentialError extends Error {
  override readonly name = "SentryCredentialError";
}

export function isTokenShaped(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= SENTRY_TOKEN_MAX_CHARS && /^[\x21-\x7e]+$/.test(value);
}

export interface SentryCredentialView {
  connectionId: string;
  last4: string;
  updatedAt: Date;
}

export async function putSentryCredential(
  db: Queryable,
  input: {
    organizationId: string;
    connectionId: string;
    publicKey: string;
    token: string;
    createdByPrincipalId: string | null;
  },
): Promise<SentryCredentialView> {
  if (!isTokenShaped(input.token)) throw new SentryCredentialError("the Sentry token is not shaped like a token");
  const { sealed, keypairId } = sealSecretV2(
    input.publicKey,
    sentryCredentialContext(input.organizationId, input.connectionId),
    input.token,
  );
  const { rows } = await upsertSentryCredential(db, {
    connectionId: input.connectionId,
    organizationId: input.organizationId,
    sealed,
    keypairId,
    last4: input.token.slice(-4),
    createdByPrincipalId: input.createdByPrincipalId,
  });
  const row = rows[0];
  if (!row) throw new SentryCredentialError("that connection's credential belongs to another organization");
  return { connectionId: row.connection_id, last4: row.last4, updatedAt: row.updated_at };
}

export async function getSentryCredential(db: Queryable, connectionId: string): Promise<SentryCredentialView | null> {
  const { rows } = await selectSentryCredentialView(db, connectionId);
  const row = rows[0];
  return row ? { connectionId: row.connection_id, last4: row.last4, updatedAt: row.updated_at } : null;
}

export async function deleteSentryCredential(db: Queryable, connectionId: string): Promise<void> {
  await deleteSentryCredentialRow(db, connectionId);
}

export async function openSentryToken(
  db: Queryable,
  privateKeys: string | readonly string[],
  organizationId: string,
  connectionId: string,
): Promise<string | null> {
  const { rows } = await selectSealedSentryToken(db, connectionId, organizationId);
  const sealed = rows[0]?.sealed_value;
  if (!sealed) return null;
  return openSecret(privateKeys, sentryCredentialContext(organizationId, connectionId), sealed);
}
