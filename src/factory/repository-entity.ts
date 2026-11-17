

import { selfServeMode } from "./config/billing.js";
import type { Pool, PoolClient } from "pg";
import {
  insertDefaultScmConnection,
  insertFirstRepositoryGrant,
  selectOrphanTaskRows,
  selectRepositoryRow,
  selectRepositoryRowByFullName,
  upsertRepositoryRow,
} from "./stores/repository-store.js";

type Queryable = Pool | PoolClient;

export interface Repository {
  id: string;

  githubInstallationId: number | null;
  owner: string;
  name: string;

  defaultBranch: string;
  cloneUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

export type NewRepository = Omit<Repository, "id" | "createdAt" | "updatedAt">;

export function pullRequestUrl(
  repository: Pick<Repository, "cloneUrl">,
  prNumber: number | null,
): string | null {
  if (prNumber === null) return null;
  let url: URL;
  try {
    url = new URL(repository.cloneUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const path = url.pathname.replace(/\.git$/, "").replace(/\/+$/, "");
  if (path.split("/").filter(Boolean).length < 2) return null;
  return `${url.origin}${path}/pull/${prNumber}`;
}

export function repositoryFullName(repository: Pick<Repository, "owner" | "name">): string {
  return `${repository.owner}/${repository.name}`;
}

function rowToRepository(row: Record<string, unknown>): Repository {
  return {
    id: row.id as string,

    githubInstallationId:
      row.github_installation_id === null ? null : Number(row.github_installation_id),
    owner: row.owner as string,
    name: row.name as string,
    defaultBranch: row.default_branch as string,
    cloneUrl: row.clone_url as string,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export async function upsertRepository(
  db: Queryable,
  repository: NewRepository,
): Promise<Repository> {
  const stored = rowToRepository(
    await upsertRepositoryRow(db, {
      githubInstallationId: repository.githubInstallationId,
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.defaultBranch,
      cloneUrl: repository.cloneUrl,
    }),
  );
  await claimForDefaultOrganization(db, stored);
  return stored;
}

async function claimForDefaultOrganization(db: Queryable, repository: Repository): Promise<void> {
  const installation = repository.githubInstallationId;

  if (installation !== null && !selfServeSignupOn()) {
    await insertDefaultScmConnection(db, installation);
  }

  await insertFirstRepositoryGrant(db, repository.id, installation, selfServeSignupOn());
}

function selfServeSignupOn(): boolean {
  return selfServeMode(process.env) !== "off";
}

export async function getRepository(db: Queryable, id: string): Promise<Repository | null> {
  const row = await selectRepositoryRow(db, id);
  return row ? rowToRepository(row) : null;
}

export async function findOrphanTasks(
  db: Queryable,
): Promise<Array<{ id: string; sourceType: string; repositoryId: string; runCount: number }>> {
  const rows = await selectOrphanTaskRows(db);
  return rows.map((row) => ({
    id: row.id as string,
    sourceType: row.source_type as string,
    repositoryId: row.repository_id as string,
    runCount: Number(row.run_count),
  }));
}

export async function getRepositoryByFullName(
  db: Queryable,
  owner: string,
  name: string,
): Promise<Repository | null> {
  const row = await selectRepositoryRowByFullName(db, owner, name);
  return row ? rowToRepository(row) : null;
}

export function parseFullName(fullName: string): { owner: string; name: string } {
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`repository must be "owner/name", got ${JSON.stringify(fullName)}`);
  }
  return { owner: parts[0], name: parts[1] };
}
