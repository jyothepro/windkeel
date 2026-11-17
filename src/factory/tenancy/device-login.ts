import { randomBytes, randomInt } from "node:crypto";
import { type Queryable } from "./common.js";
import { type Permission, isPermission } from "./permissions.js";
import { hashToken } from "./tokens.js";
import {
  countPendingDeviceLogins,
  decidePendingDeviceLogin,
  insertDeviceLogin,
  recordDevicePoll,
  selectLatestDeviceLoginByUserCode,
  setDeviceLoginToken,
} from "./stores/device-login-store.js";

export const DEVICE_CODE_TTL_SECONDS = 600;

export const DEVICE_POLL_INTERVAL_SECONDS = 5;

const MAX_PENDING_DEVICE_LOGINS = 100;

const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export interface DeviceLogin {
  id: string;
  userCode: string;
  machineName: string;
  permissions: Permission[];
  organizationId: string | null;
  state: "pending" | "approved" | "denied" | "consumed" | "expired";
  expiresAt: Date;
}

export class DeviceLoginError extends Error {
  override readonly name = "DeviceLoginError";
  constructor(
    readonly code: "too_many_pending",
    message: string,
  ) {
    super(message);
  }
}

function rowToDeviceLogin(row: Record<string, unknown>): DeviceLogin {
  const expiresAt = row["expires_at"] as Date;
  const stored = row["state"] as DeviceLogin["state"];
  return {
    id: row["id"] as string,
    userCode: row["user_code"] as string,
    machineName: row["machine_name"] as string,
    permissions: (row["permissions"] as string[]).filter(isPermission),
    organizationId: (row["organization_id"] as string | null) ?? null,
    state: stored === "pending" && expiresAt.getTime() <= Date.now() ? "expired" : stored,
    expiresAt,
  };
}

function newUserCode(): string {
  const pick = () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${Array.from({ length: 4 }, pick).join("")}-${Array.from({ length: 4 }, pick).join("")}`;
}

function normaliseUserCode(input: string): string {
  const bare = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return bare.length === 8 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : input.toUpperCase();
}

export async function startDeviceLogin(
  db: Queryable,
  input: { machineName: string; permissions: Permission[]; organizationId: string | null },
): Promise<{ deviceCode: string; login: DeviceLogin }> {
  if ((await countPendingDeviceLogins(db)) >= MAX_PENDING_DEVICE_LOGINS) {
    throw new DeviceLoginError("too_many_pending", "too many logins are waiting; try again in a few minutes");
  }
  const deviceCode = randomBytes(32).toString("base64url");
  const machineName = input.machineName.trim().slice(0, 100) || "unnamed machine";

  for (let attempt = 0; ; attempt += 1) {
    try {
      const row = await insertDeviceLogin(db, {
        deviceCodeHash: hashToken(deviceCode),
        userCode: newUserCode(),
        machineName,
        permissions: input.permissions,
        organizationId: input.organizationId,
        ttlSeconds: DEVICE_CODE_TTL_SECONDS,
      });
      return { deviceCode, login: rowToDeviceLogin(row) };
    } catch (err) {
      if (attempt >= 1 || (err as { code?: string }).code !== "23505") throw err;
    }
  }
}

export async function findDeviceLogin(db: Queryable, userCode: string): Promise<DeviceLogin | null> {
  const row = await selectLatestDeviceLoginByUserCode(db, normaliseUserCode(userCode));
  return row ? rowToDeviceLogin(row) : null;
}

export async function decideDeviceLogin(
  db: Queryable,
  userCode: string,
  decision: "approved" | "denied",
  principalId: string,
): Promise<DeviceLogin | null> {
  const row = await decidePendingDeviceLogin(db, normaliseUserCode(userCode), decision, principalId);
  return row ? rowToDeviceLogin(row) : null;
}

export type DevicePoll =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "approved"; login: DeviceLogin; decidedBy: string };

export async function pollDeviceLogin(db: Queryable, deviceCode: string): Promise<DevicePoll> {
  const hash = hashToken(deviceCode);
  const row = await recordDevicePoll(db, hash);
  if (!row) return { kind: "expired" };
  const previousState = row["previous_state"] as string;
  const expired = (row["expires_at"] as Date).getTime() <= Date.now();
  if (previousState === "approved") {
    return { kind: "approved", login: rowToDeviceLogin(row), decidedBy: row["decided_by_principal_id"] as string };
  }
  if (previousState === "denied") return { kind: "denied" };
  if (previousState === "consumed" || expired) return { kind: "expired" };
  const previousPoll = row["previous_poll"] as Date | null;
  if (previousPoll && Date.now() - previousPoll.getTime() < (DEVICE_POLL_INTERVAL_SECONDS * 1000) / 2) {
    return { kind: "slow_down" };
  }
  return { kind: "pending" };
}

export async function linkDeviceToken(db: Queryable, loginId: string, tokenId: string): Promise<void> {
  await setDeviceLoginToken(db, loginId, tokenId);
}
