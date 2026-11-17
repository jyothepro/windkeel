

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { openSecret, sealSecretV2 } from "./secret-box.js";
import { credentialProvider, CREDENTIAL_PROVIDER_IDS } from "./model-credential-providers.js";
import { assertSafeBaseUrl, type EndpointGuardOptions } from "./model-endpoint-guard.js";
import { redactSecrets } from "./log.js";
import {
  insertModelCredentialRow,
  revokeModelCredentialRow,
  selectModelCredentialRow,
  selectModelCredentialRows,
  selectSealedModelCredentialRow,
  updateModelCredentialValueRow,
} from "./stores/model-credential-store.js";

type Db = Pool | PoolClient;

export type ModelCredentialStatus = "unverified" | "valid" | "invalid" | "revoked";

export interface ModelCredential {
  id: string;
  organizationId: string;
  provider: string;
  baseUrl: string | null;
  declaredVendor: string | null;
  label: string;
  last4: string;
  keypairId: string;
  status: ModelCredentialStatus;
  statusReason: string | null;
  validatedAt: Date | null;
  createdByPrincipalId: string | null;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
}

export class ModelCredentialError extends Error {
  override readonly name = "ModelCredentialError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function modelCredentialContext(organizationId: string, credentialId: string): string {
  return `model_credential:${organizationId}:${credentialId}`;
}

const LABEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const VENDOR_SHAPE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MIN_VALUE_LENGTH = 8;
const MAX_VALUE_LENGTH = 4096;

function checkedValue(value: unknown): string {
  if (typeof value !== "string") throw invalid("value is required");
  const trimmed = value.trim();
  if (trimmed.length < MIN_VALUE_LENGTH || trimmed.length > MAX_VALUE_LENGTH) {
    throw invalid(`the value must be ${MIN_VALUE_LENGTH}-${MAX_VALUE_LENGTH} characters`);
  }
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    throw invalid("the value must not contain whitespace or control characters");
  }
  return trimmed;
}

function checkedLabel(label: unknown): string {
  if (typeof label !== "string" || !LABEL_SHAPE.test(label)) {
    throw invalid(
      "label must be 1-64 characters of letters, digits, space, '.', '_' or '-', starting with a letter or digit",
    );
  }

  if (redactSecrets(label) !== label || /\bsk-/i.test(label)) {
    throw invalid("label looks like a key; the value goes on stdin or --from-env, never in the label");
  }
  return label;
}

function invalid(message: string): ModelCredentialError {
  return new ModelCredentialError(400, "invalid_model_credential", message);
}

export interface PutModelCredentialInput {
  organizationId: string;
  provider: string;
  baseUrl?: string | null;
  declaredVendor?: string | null;
  label: string;
  value: string;
  createdByPrincipalId?: string | null;

  publicKey: string;

  endpoint?: EndpointGuardOptions;
}

export async function putModelCredential(db: Db, input: PutModelCredentialInput): Promise<ModelCredential> {
  const provider = credentialProvider(input.provider);
  if (!provider) {
    throw invalid(`provider must be one of ${CREDENTIAL_PROVIDER_IDS.join(", ")}`);
  }
  const label = checkedLabel(input.label);
  const value = checkedValue(input.value);
  const declaredVendor = input.declaredVendor ?? null;
  if (declaredVendor !== null && !VENDOR_SHAPE.test(declaredVendor)) {
    throw invalid("declared vendor must be lower-case letters, digits and '-', at most 32 characters");
  }
  const rawBaseUrl = input.baseUrl ?? null;
  if (rawBaseUrl === null && provider.defaultBaseUrl === null) {
    throw invalid(`provider ${provider.id} needs a base URL`);
  }
  let baseUrl: string | null = null;
  if (rawBaseUrl !== null) {
    try {
      baseUrl = await assertSafeBaseUrl(rawBaseUrl, input.endpoint);
    } catch (err) {
      if (err instanceof Error && err.name === "UnsafeEndpointError") {
        throw new ModelCredentialError(400, "unsafe_base_url", err.message);
      }
      throw err;
    }
  }

  const id = randomUUID();
  const { sealed, keypairId } = sealSecretV2(
    input.publicKey,
    modelCredentialContext(input.organizationId, id),
    value,
  );
  try {
    const row = await insertModelCredentialRow(db, {
      id,
      organizationId: input.organizationId,
      provider: provider.id,
      baseUrl,
      declaredVendor,
      label,
      last4: value.slice(-4),
      sealed,
      keypairId,
      createdByPrincipalId: input.createdByPrincipalId ?? null,
    });
    return mapRow(row);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new ModelCredentialError(409, "label_taken", `a credential labelled "${label}" already exists`);
    }
    throw err;
  }
}

export async function rotateModelCredential(
  db: Db,
  input: { organizationId: string; credentialId: string; value: string; publicKey: string },
): Promise<ModelCredential | null> {
  const value = checkedValue(input.value);
  if (!isUuid(input.credentialId)) return null;
  const { sealed, keypairId } = sealSecretV2(
    input.publicKey,
    modelCredentialContext(input.organizationId, input.credentialId),
    value,
  );
  const row = await updateModelCredentialValueRow(db, {
    credentialId: input.credentialId,
    organizationId: input.organizationId,
    sealed,
    keypairId,
    last4: value.slice(-4),
  });
  return row ? mapRow(row) : null;
}

export async function listModelCredentials(
  db: Db,
  organizationId: string,
  options: { includeRevoked?: boolean } = {},
): Promise<ModelCredential[]> {
  return (await selectModelCredentialRows(db, organizationId, options.includeRevoked === true)).map(mapRow);
}

export async function getModelCredential(
  db: Db,
  organizationId: string,
  credentialId: string,
): Promise<ModelCredential | null> {
  if (!isUuid(credentialId)) return null;
  const row = await selectModelCredentialRow(db, organizationId, credentialId);
  return row ? mapRow(row) : null;
}

export async function revokeModelCredential(
  db: Db,
  organizationId: string,
  credentialId: string,
): Promise<ModelCredential | null> {
  if (!isUuid(credentialId)) return null;
  const row = await revokeModelCredentialRow(db, organizationId, credentialId);
  return row ? mapRow(row) : null;
}

export interface OpenedModelCredential {
  credential: ModelCredential;
  value: string;

  sealed: string;
}

export async function openModelCredential(
  db: Db,
  privateKeys: string | readonly string[],
  organizationId: string,
  credentialId: string,
): Promise<OpenedModelCredential> {
  if (!isUuid(credentialId)) {
    throw new ModelCredentialError(404, "not_found", "no such model credential");
  }
  const row = await selectSealedModelCredentialRow(db, organizationId, credentialId);
  if (!row) throw new ModelCredentialError(404, "not_found", "no such model credential");
  const credential = mapRow(row);
  if (credential.revokedAt !== null || credential.status === "revoked") {
    throw new ModelCredentialError(409, "credential_revoked", `model credential ${credential.label} is revoked`);
  }
  const sealed = row["sealed_value"] as string;

  const value = openSecret(privateKeys, modelCredentialContext(organizationId, credentialId), sealed);
  return { credential, value, sealed };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function mapRow(row: Record<string, unknown>): ModelCredential {
  return {
    id: row["id"] as string,
    organizationId: row["organization_id"] as string,
    provider: row["provider"] as string,
    baseUrl: (row["base_url"] as string | null) ?? null,
    declaredVendor: (row["declared_vendor"] as string | null) ?? null,
    label: row["label"] as string,
    last4: row["last4"] as string,
    keypairId: row["keypair_id"] as string,
    status: row["status"] as ModelCredentialStatus,
    statusReason: (row["status_reason"] as string | null) ?? null,
    validatedAt: (row["validated_at"] as Date | null) ?? null,
    createdByPrincipalId: (row["created_by_principal_id"] as string | null) ?? null,
    createdAt: row["created_at"] as Date,
    updatedAt: row["updated_at"] as Date,
    revokedAt: (row["revoked_at"] as Date | null) ?? null,
  };
}
