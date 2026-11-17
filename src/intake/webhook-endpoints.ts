

import { createHmac } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { RiskLevel } from "../factory/rails.js";
import { grantedRepository, isUuid } from "../factory/tenancy.js";
import { defaultLog } from "../factory/log.js";
import type { ReadOnlyQueryable } from "./pipeline.js";
import {
  bumpWebhookEndpointSecret,
  deleteWebhookEndpointRow,
  insertWebhookEndpoint,
  selectWebhookEndpointById,
  selectWebhookEndpoints,
  updateWebhookEndpointColumns,
} from "./stores/intake-store.js";

type Queryable = Pool | PoolClient;

const WEBHOOK_SECRET_PREFIX = "whsec_";

const WEBHOOK_SIGNING_KEY_ENV = "WINDKEEL_WEBHOOK_SIGNING_KEY";

export const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high"];

export interface WebhookEndpoint {
  id: string;
  organizationId: string;
  repositoryId: string;
  name: string;
  secretVersion: number;
  enabled: boolean;
  defaultRiskLevel: RiskLevel;
  createdByPrincipalId: string | null;
  createdAt: Date;
  rotatedAt: Date | null;
}

class WebhookEndpointError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 422 = 400,
    readonly code = "invalid_webhook_endpoint",
  ) {
    super(message);
    this.name = "WebhookEndpointError";
  }
}

export const MIN_WEBHOOK_SIGNING_KEY_BYTES = 32;

let weakKeyLogged = false;

function logWeakKeyOnce(bytes: number): void {
  if (weakKeyLogged) return;
  weakKeyLogged = true;

  defaultLog(
    `${WEBHOOK_SIGNING_KEY_ENV} is ${bytes} bytes; at least ${MIN_WEBHOOK_SIGNING_KEY_BYTES} are required, so webhook signing is treated as unconfigured`,
    { tag: "webhook_signing_key_too_short" },
  );
}

export function usableWebhookSigningKey(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < MIN_WEBHOOK_SIGNING_KEY_BYTES) {
    logWeakKeyOnce(bytes);
    return undefined;
  }
  return value;
}

export function webhookSigningKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return usableWebhookSigningKey(env[WEBHOOK_SIGNING_KEY_ENV]);
}

export function deriveWebhookSecret(signingKey: string, endpointId: string, secretVersion: number): string {
  const digest = createHmac("sha256", signingKey).update(`${endpointId}:${secretVersion}`, "utf8").digest("base64url");
  return `${WEBHOOK_SECRET_PREFIX}${digest}`;
}

function rowToEndpoint(row: Record<string, unknown>): WebhookEndpoint {
  return {
    id: row["id"] as string,
    organizationId: row["organization_id"] as string,
    repositoryId: row["repository_id"] as string,
    name: row["name"] as string,
    secretVersion: Number(row["secret_version"]),
    enabled: row["enabled"] as boolean,
    defaultRiskLevel: row["default_risk_level"] as RiskLevel,
    createdByPrincipalId: (row["created_by_principal_id"] as string | null) ?? null,
    createdAt: row["created_at"] as Date,
    rotatedAt: (row["rotated_at"] as Date | null) ?? null,
  };
}

function validName(name: unknown): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new WebhookEndpointError("name is required");
  }
  if (name.trim().length > 200) throw new WebhookEndpointError("name is longer than 200 characters");
  return name.trim();
}

function validRisk(value: unknown): RiskLevel {
  if (typeof value !== "string" || !RISK_LEVELS.includes(value as RiskLevel)) {
    throw new WebhookEndpointError("defaultRiskLevel must be low, medium or high");
  }
  return value as RiskLevel;
}

export interface CreateWebhookEndpointInput {
  organizationId: string;
  repositoryId: unknown;
  name: unknown;
  defaultRiskLevel?: unknown;
  enabled?: unknown;
  createdByPrincipalId?: string | null;
}

export async function createWebhookEndpoint(db: Queryable, input: CreateWebhookEndpointInput): Promise<WebhookEndpoint> {
  const name = validName(input.name);
  const risk = input.defaultRiskLevel === undefined ? "low" : validRisk(input.defaultRiskLevel);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new WebhookEndpointError("enabled must be true or false");
  }
  if (typeof input.repositoryId !== "string" || input.repositoryId === "") {
    throw new WebhookEndpointError("repositoryId is required");
  }

  const repository = await grantedRepository(db, input.organizationId, input.repositoryId);
  if (!repository) {
    throw new WebhookEndpointError(
      "repositoryId is not a repository granted to this organization",
      422,
      "repository_not_granted",
    );
  }
  const { rows } = await insertWebhookEndpoint(db, {
    organizationId: input.organizationId,
    repositoryId: input.repositoryId,
    name,
    defaultRiskLevel: risk,
    enabled: input.enabled === undefined ? true : input.enabled,
    createdByPrincipalId: input.createdByPrincipalId ?? null,
  });
  return rowToEndpoint(rows[0]);
}

export async function listWebhookEndpoints(db: Queryable, organizationId: string): Promise<WebhookEndpoint[]> {
  const { rows } = await selectWebhookEndpoints(db, organizationId);
  return rows.map(rowToEndpoint);
}

export async function findWebhookEndpoint(
  db: ReadOnlyQueryable,
  endpointId: string,
): Promise<WebhookEndpoint | null> {

  const id = isUuid(endpointId) ? endpointId : "00000000-0000-0000-0000-000000000000";
  const { rows } = await selectWebhookEndpointById(db, id);
  return rows[0] ? rowToEndpoint(rows[0]) : null;
}

export async function updateWebhookEndpoint(
  db: Queryable,
  organizationId: string,
  endpointId: string,
  patch: { name?: unknown; enabled?: unknown; defaultRiskLevel?: unknown },
): Promise<WebhookEndpoint | null> {
  const changes: { name?: string; enabled?: boolean; defaultRiskLevel?: string } = {};
  if (patch.name !== undefined) changes.name = validName(patch.name);
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new WebhookEndpointError("enabled must be true or false");
    changes.enabled = patch.enabled;
  }
  if (patch.defaultRiskLevel !== undefined) changes.defaultRiskLevel = validRisk(patch.defaultRiskLevel);
  if (Object.keys(changes).length === 0) {
    throw new WebhookEndpointError("nothing to change: send name, enabled or defaultRiskLevel");
  }
  if (!isUuid(endpointId)) return null;
  const { rows } = await updateWebhookEndpointColumns(db, endpointId, organizationId, changes);
  return rows[0] ? rowToEndpoint(rows[0]) : null;
}

export async function rotateWebhookEndpoint(
  db: Queryable,
  organizationId: string,
  endpointId: string,
): Promise<WebhookEndpoint | null> {
  if (!isUuid(endpointId)) return null;
  const { rows } = await bumpWebhookEndpointSecret(db, endpointId, organizationId);
  return rows[0] ? rowToEndpoint(rows[0]) : null;
}

export async function deleteWebhookEndpoint(
  db: Queryable,
  organizationId: string,
  endpointId: string,
): Promise<boolean> {
  if (!isUuid(endpointId)) return false;
  const { rowCount } = await deleteWebhookEndpointRow(db, endpointId, organizationId);
  return (rowCount ?? 0) > 0;
}
