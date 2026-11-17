
import type { MakerBrowserState } from "../../sandbox/maker-browser/install.js";
import type { Queryable } from "../db/transaction.js";

export interface Workspace {
  id: string;
  engineeringRunId: string;
  role: "maker" | "verifier";
  sandboxProvider: string;
  providerHandle: string | null;
  repository: string;

  baseSha: string;
  workingBranch: string | null;
  status: string;
  expiresAt: Date | null;

  gitTokenExpiresAt: Date | null;

  makerBrowser?: MakerBrowserState;
}

export type NewWorkspace = Omit<
  Workspace,
  "id" | "providerHandle" | "workingBranch" | "expiresAt" | "gitTokenExpiresAt" | "makerBrowser"
> &
  Partial<Pick<Workspace, "providerHandle" | "workingBranch" | "expiresAt" | "gitTokenExpiresAt">>;

function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as string,
    engineeringRunId: row.engineering_run_id as string,
    role: row.role as Workspace["role"],
    sandboxProvider: row.sandbox_provider as string,
    providerHandle: row.provider_handle as string | null,
    repository: row.repository as string,
    baseSha: row.base_sha as string,
    workingBranch: row.working_branch as string | null,
    status: row.status as string,
    expiresAt: row.expires_at as Date | null,
    gitTokenExpiresAt: row.git_token_expires_at as Date | null,
    ...(row.maker_browser ? { makerBrowser: row.maker_browser as MakerBrowserState } : {}),
  };
}

export async function insertWorkspace(db: Queryable, workspace: NewWorkspace): Promise<Workspace> {
  const { rows } = await db.query(
    `insert into workspace
       (engineering_run_id, role, sandbox_provider, provider_handle, repository,
        base_sha, working_branch, status, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [
      workspace.engineeringRunId,
      workspace.role,
      workspace.sandboxProvider,
      workspace.providerHandle ?? null,
      workspace.repository,
      workspace.baseSha,
      workspace.workingBranch ?? null,
      workspace.status,
      workspace.expiresAt ?? null,
    ],
  );
  return rowToWorkspace(rows[0]);
}

export async function getWorkspace(db: Queryable, id: string): Promise<Workspace | null> {
  const { rows } = await db.query("select * from workspace where id = $1", [id]);
  return rows[0] ? rowToWorkspace(rows[0]) : null;
}

export async function listWorkspaces(db: Queryable, engineeringRunId: string): Promise<Workspace[]> {
  const { rows } = await db.query(
    "select * from workspace where engineering_run_id = $1 order by id",
    [engineeringRunId],
  );
  return rows.map(rowToWorkspace);
}

export type WorkspacePatch = Partial<
  Pick<
    Workspace,
    "providerHandle" | "status" | "workingBranch" | "expiresAt" | "gitTokenExpiresAt" | "baseSha" | "makerBrowser"
  >
>;

const WORKSPACE_PATCH_COLUMNS: Record<keyof WorkspacePatch, string> = {
  providerHandle: "provider_handle",
  status: "status",
  workingBranch: "working_branch",
  expiresAt: "expires_at",
  gitTokenExpiresAt: "git_token_expires_at",
  baseSha: "base_sha",
  makerBrowser: "maker_browser",
};

export async function updateWorkspace(
  db: Queryable,
  id: string,
  patch: WorkspacePatch,
): Promise<Workspace> {
  const entries = Object.entries(patch) as Array<[keyof WorkspacePatch, unknown]>;
  if (entries.length === 0) {
    const current = await getWorkspace(db, id);
    if (!current) throw new Error(`workspace ${id} not found`);
    return current;
  }
  const setClauses = entries.map(([key], i) => `${WORKSPACE_PATCH_COLUMNS[key]} = $${i + 2}`);
  const values = entries.map(([key, value]) => (key === "makerBrowser" ? JSON.stringify(value) : value));
  const { rows } = await db.query(
    `update workspace set ${setClauses.join(", ")} where id = $1 returning *`,
    [id, ...values],
  );
  if (!rows[0]) throw new Error(`workspace ${id} not found`);
  return rowToWorkspace(rows[0]);
}

export async function selectWorkspaceEnvironmentRows(db: Queryable, engineeringRunId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query(
    `select w.id, w.role, w.environment_mode, w.environment_snapshot_id, s.cache_key
       from workspace w left join environment_snapshot s on s.id = w.environment_snapshot_id
      where w.engineering_run_id = $1 and w.environment_mode is not null
      order by w.id`,
    [engineeringRunId],
  );
  return rows;
}
