

export async function insertRepositoryIfMissing(client, owner, name) {
  const { rows } = await client.query(
    `insert into repository (owner, name, default_branch, clone_url)
     select $1, $2, 'main', $3 where not exists (select 1 from repository where owner = $1 and name = $2)
     returning id`,
    [owner, name, `https://github.com/${owner}/${name}.git`],
  );
  return rows.length > 0;
}

export async function grantRepositoryToDefaultOrganization(client, owner, name) {
  await client.query(
    `insert into repository_grant (organization_id, repository_id, intake)
       select o.id, r.id, true from organization o, repository r
        where o.is_default and r.owner = $1 and r.name = $2
          and not exists (select 1 from repository_grant g where g.repository_id = r.id)`,
    [owner, name],
  );
}
