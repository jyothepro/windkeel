
import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

export interface RepositoryUpsert {
  githubInstallationId: number | null;
  owner: string;
  name: string;
  defaultBranch: string;
  cloneUrl: string;
}

export async function upsertRepositoryRow(db: Queryable, repository: RepositoryUpsert): Promise<Row> {
  const { rows } = await db.query(
    `insert into repository (github_installation_id, owner, name, default_branch, clone_url)
     values ($1, $2, $3, $4, $5)
     on conflict (owner, name) do update
       set github_installation_id = excluded.github_installation_id,
           default_branch         = excluded.default_branch,
           clone_url              = excluded.clone_url,
           updated_at             = now()
     returning *`,
    [
      repository.githubInstallationId,
      repository.owner,
      repository.name,
      repository.defaultBranch,
      repository.cloneUrl,
    ],
  );
  return rows[0];
}

export async function insertDefaultScmConnection(db: Queryable, installationId: number): Promise<void> {
  await db.query(
    `insert into scm_connection (account_id, installation_id)
       select id, $1 from account where is_default
     on conflict (provider, installation_id) do nothing`,
    [installationId],
  );
}

export async function insertFirstRepositoryGrant(
  db: Queryable,
  repositoryId: string,
  installationId: number | null,
  selfServeSignupOn: boolean,
): Promise<void> {
  await db.query(
    `insert into repository_grant (organization_id, repository_id, intake)
       select org.id, $1, true
         from (select coalesce(
                 (select o.id from scm_connection c
                    join account a on a.id = c.account_id
                    join organization o on o.account_id = a.id
                   where $2::bigint is not null and c.provider = 'github' and c.installation_id = $2 and not a.is_default
                   order by o.created_at, o.id limit 1),
                 (select o.id from organization o
                   where o.is_default
                     and ($2::bigint is null
                          or not $3::boolean
                          or exists (select 1 from scm_connection c join account a on a.id = c.account_id
                                      where c.provider = 'github' and c.installation_id = $2 and a.is_default)))
               ) as id) org
        where org.id is not null
          and not exists (select 1 from repository_grant where repository_id = $1)
     on conflict do nothing`,
    [repositoryId, installationId, selfServeSignupOn],
  );
}

export async function selectRepositoryRow(db: Queryable, id: string): Promise<Row | undefined> {
  const { rows } = await db.query("select * from repository where id = $1", [id]);
  return rows[0];
}

export async function selectRepositoryRowByFullName(db: Queryable, owner: string, name: string): Promise<Row | undefined> {
  const { rows } = await db.query("select * from repository where owner = $1 and name = $2", [
    owner,
    name,
  ]);
  return rows[0];
}

export async function selectOrphanTaskRows(db: Queryable): Promise<Row[]> {
  const { rows } = await db.query(
    `select t.id, t.source_type, t.repository_id,
            (select count(*) from engineering_run r where r.task_id = t.id) as run_count
       from engineering_task t
      where not exists (select 1 from repository r where r.id = t.repository_id)
      order by t.created_at`,
  );
  return rows;
}

export async function hasIntakeGrantRow(db: Queryable, repositoryId: string): Promise<boolean> {
  const { rows } = await db.query("select 1 from repository_grant where repository_id = $1 and intake", [repositoryId]);
  return rows.length > 0;
}
