import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { insertIdempotencyClaim, selectIdempotencyRecord, setIntakeDeliveryResponse } from "./stores/intake-store.js";

const IDEMPOTENCY_SOURCE = "api";

const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

const KEY_PATTERN = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

export function invalidIdempotencyKey(key: string): string | null {
  if (key.length === 0) return "Idempotency-Key is empty";
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return `Idempotency-Key is longer than ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`;
  }
  if (!KEY_PATTERN.test(key)) return "Idempotency-Key must be printable ASCII";
  return null;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function requestHash(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

function idempotencyDeliveryKey(organizationId: string, principalId: string, key: string): string {
  return `${organizationId}:${principalId}:${key}`;
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

export type IdempotencyClaim =
  | { claimed: true; deliveryKey: string }
  | {
      claimed: false;
      deliveryKey: string;
      requestHash: string | null;
      engineeringTaskId: string | null;
      response: StoredResponse | null;
    };

export async function claimIdempotencyKey(
  db: PoolClient,
  input: { principalId: string; key: string; organizationId: string; requestHash: string },
): Promise<IdempotencyClaim> {
  const deliveryKey = idempotencyDeliveryKey(input.organizationId, input.principalId, input.key);
  const claimed = await insertIdempotencyClaim(db, IDEMPOTENCY_SOURCE, deliveryKey, input.organizationId, input.requestHash);
  if ((claimed.rowCount ?? 0) > 0) return { claimed: true, deliveryKey };
  const { rows } = await selectIdempotencyRecord<{
    request_hash: string | null;
    engineering_task_id: string | null;
    response: StoredResponse | null;
  }>(db, IDEMPOTENCY_SOURCE, deliveryKey);
  return {
    claimed: false,
    deliveryKey,
    requestHash: rows[0]?.request_hash ?? null,
    engineeringTaskId: rows[0]?.engineering_task_id ?? null,
    response: rows[0]?.response ?? null,
  };
}

export async function storeIdempotentResponse(
  db: Pick<PoolClient, "query">,
  deliveryKey: string,
  response: StoredResponse,
): Promise<void> {
  await setIntakeDeliveryResponse(db, IDEMPOTENCY_SOURCE, deliveryKey, JSON.stringify(response));
}
