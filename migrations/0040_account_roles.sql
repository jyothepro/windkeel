-- Custom roles per account (#393 8B, ADR-0030).
--
-- No new table: `access_role.account_id` was left for this in 0021. A custom role is a row with an
-- account; built-ins keep `account_id is null` and stay immutable (the API refuses to edit them).
-- A deleted role is kept, `deleted_at` set, because invitations already accepted still name it; the
-- key unique index ignores deleted rows so the name can be reused.

alter table access_role
  add column description             text,
  add column created_by_principal_id uuid references principal (id),
  add column deleted_at              timestamptz;

drop index access_role_account_id_key_idx;
create unique index access_role_account_id_key_idx on access_role (account_id, key)
  where account_id is not null and deleted_at is null;

-- The account-level permissions: managing custom roles, and the account's security policy and audit
-- data (retention, deletion). Admin holds every permission: the full current list is merged into the
-- built-in row — appended in order after what it holds, so nothing another migration added is taken
-- away or reordered.
update access_role
   set permissions = permissions || array(
         select t.p from unnest(array[
           'runs.read', 'runs.write', 'runs.approve', 'secrets.manage', 'repositories.manage',
           'members.manage', 'tokens.manage', 'integrations.manage', 'schedules.manage',
           'models.read', 'models.manage', 'runs.takeover', 'runs.merge',
           'audit.read', 'roles.manage', 'account.manage'
         ]) with ordinality as t(p, i)
          where not (t.p = any (permissions))
          order by t.i
       ),
       updated_at = now()
 where key = 'admin' and account_id is null;
