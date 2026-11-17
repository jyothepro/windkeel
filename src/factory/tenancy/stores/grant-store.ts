
import type { Queryable } from "../common.js";

type Row = Record<string, unknown>;

export async function grantExists(db: Queryable, organizationId: string, repositoryId: string): Promise<boolean> {
  const { rows } = await db.query(
    "select 1 from repository_grant where organization_id = $1 and repository_id = $2",
    [organizationId, repositoryId],
  );
  return rows.length > 0;
}

export async function taskGrantExists(db: Queryable, taskId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from engineering_task t
       join repository_grant g on g.organization_id = t.organization_id and g.repository_id = t.repository_id
      where t.id = $1`,
    [taskId],
  );
  return rows.length > 0;
}

export async function runGrantExists(db: Queryable, runId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from engineering_run r
       join engineering_task t on t.id = r.task_id
       join repository_grant g on g.organization_id = t.organization_id and g.repository_id = t.repository_id
      where r.id = $1`,
    [runId],
  );
  return rows.length > 0;
}

export async function selectGrants(db: Queryable, organizationId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select g.repository_id, r.owner, r.name, g.intake, g.created_at
       from repository_grant g join repository r on r.id = g.repository_id
      where g.organization_id = $1
      order by r.owner, r.name`,
    [organizationId],
  );
  return rows;
}

export async function lockRepositoryRow(db: Queryable, repositoryId: string): Promise<void> {
  await db.query("select 1 from repository where id = $1 for update", [repositoryId]);
}

export interface GrantFacts {
  orgAccount: unknown;
  repoAccount: unknown;
  repoExists: boolean;
  heldElsewhere: boolean;
  accountManages: boolean;
}

export async function selectGrantFacts(
  db: Queryable,
  organizationId: string,
  repositoryId: string,
  principalId: string,
): Promise<GrantFacts> {
  const { rows } = await db.query(
    `select
       (select account_id from organization where id = $1) as org_account,
       (select c.account_id from repository r
          join scm_connection c on c.installation_id = r.github_installation_id
         where r.id = $2) as repo_account,
       exists (select 1 from repository where id = $2) as repo_exists,
       exists (select 1 from repository_grant
                where repository_id = $2 and organization_id <> $1) as held_elsewhere,
       exists (select 1 from account_membership am
                 join access_role ar on ar.id = am.access_role_id
                where am.principal_id = $3
                  and am.account_id = (select account_id from organization where id = $1)
                  and 'repositories.manage' = any (ar.permissions)) as account_manages`,
    [organizationId, repositoryId, principalId],
  );
  const f = rows[0]!;
  return {
    orgAccount: f["org_account"],
    repoAccount: f["repo_account"],
    repoExists: Boolean(f["repo_exists"]),
    heldElsewhere: Boolean(f["held_elsewhere"]),
    accountManages: Boolean(f["account_manages"]),
  };
}

export async function clearRepositoryIntake(db: Queryable, repositoryId: string): Promise<void> {
  await db.query("update repository_grant set intake = false where repository_id = $1 and intake", [repositoryId]);
}

export async function upsertGrant(
  db: Queryable,
  input: { organizationId: string; repositoryId: string; intake: boolean; createdByPrincipalId: string },
): Promise<void> {
  await db.query(
    `insert into repository_grant (organization_id, repository_id, intake, created_by_principal_id)
     values ($1, $2, $3, $4)
     on conflict (organization_id, repository_id) do update set intake = excluded.intake`,
    [input.organizationId, input.repositoryId, input.intake, input.createdByPrincipalId],
  );
}

export async function deleteGrantRow(db: Queryable, organizationId: string, repositoryId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "delete from repository_grant where organization_id = $1 and repository_id = $2",
    [organizationId, repositoryId],
  );
  return (rowCount ?? 0) > 0;
}
