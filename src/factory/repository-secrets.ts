

import type { Pool, PoolClient } from "pg";
import { secretKeyProblem } from "@windkeel/verification/secret-names.js";
import { openSecret, sealSecret } from "./secret-box.js";
import { invalidateSnapshots } from "./environment-snapshots.js";
import {
  deleteRepositorySecretRow,
  selectRepositorySecretRows,
  selectSealedRepositorySecretRows,
  upsertRepositorySecretRow,
} from "./stores/repository-secret-store.js";

type Db = Pool | PoolClient;

export interface RepositorySecret {
  key: string;
  note: string | null;
  setBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export class InvalidSecretKeyError extends Error {
  constructor(
    readonly key: string,
    problem: string,
  ) {
    super(`"${key}" is not a usable secret name — ${problem}`);
    this.name = "InvalidSecretKeyError";
  }
}

export function assertSecretKey(key: string): string {
  const problem = secretKeyProblem(key);
  if (problem) throw new InvalidSecretKeyError(key, problem);
  return key;
}

export async function putRepositorySecret(
  db: Db,
  input: {

    organizationId: string;
    repositoryId: string;
    key: string;
    value: string;
    note?: string | null;
    setBy: string;
    setByPrincipalId?: string | null;
    publicKey: string;
  },
): Promise<RepositorySecret> {
  const key = assertSecretKey(input.key);
  if (input.value === "") {
    throw new InvalidSecretKeyError(key, "the value is empty; use delete to remove a secret");
  }
  const sealed = sealSecret(input.publicKey, key, input.value);
  const row = await upsertRepositorySecretRow(db, {
    organizationId: input.organizationId,
    repositoryId: input.repositoryId,
    key,
    sealedValue: sealed,
    note: input.note ?? null,
    setBy: input.setBy,
    setByPrincipalId: input.setByPrincipalId ?? null,
  });

  await invalidateSnapshots(db, input.repositoryId, `repository secret ${key} was set`, input.organizationId);
  return mapRow(row);
}

export async function listRepositorySecrets(
  db: Db,
  organizationId: string,
  repositoryId: string,
): Promise<RepositorySecret[]> {
  return (await selectRepositorySecretRows(db, organizationId, repositoryId)).map(mapRow);
}

export async function deleteRepositorySecret(
  db: Db,
  organizationId: string,
  repositoryId: string,
  key: string,
): Promise<boolean> {
  const removed = (await deleteRepositorySecretRow(db, organizationId, repositoryId, key)) > 0;

  if (removed) await invalidateSnapshots(db, repositoryId, `repository secret ${key} was deleted`, organizationId);
  return removed;
}

export interface UnopenableSecret {
  key: string;
  reason: string;
}

export interface ResolvedSecrets {

  values: Record<string, string>;

  unopenable: UnopenableSecret[];
}

export async function resolveRepositorySecrets(
  db: Db,
  organizationId: string,
  repositoryId: string,

  privateKey: string | readonly string[],
): Promise<ResolvedSecrets> {

  const rows = await selectSealedRepositorySecretRows(db, organizationId, repositoryId);
  const values: Record<string, string> = {};
  const unopenable: UnopenableSecret[] = [];
  for (const row of rows) {
    const key = row["key"] as string;
    try {
      values[key] = openSecret(privateKey, key, row["sealed_value"] as string);
    } catch (err) {
      unopenable.push({ key, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { values, unopenable };
}

export function hostsFromSecretValues(values: Readonly<Record<string, string>>): string[] {
  const hosts = new Set<string>();
  for (const value of Object.values(values)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (parsed.hostname) hosts.add(parsed.hostname);
  }
  return [...hosts].sort();
}

function mapRow(row: Record<string, unknown>): RepositorySecret {
  return {
    key: row["key"] as string,
    note: (row["note"] as string | null) ?? null,
    setBy: row["set_by"] as string,
    createdAt: row["created_at"] as Date,
    updatedAt: row["updated_at"] as Date,
  };
}
