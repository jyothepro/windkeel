-- Organization service principals and service tokens (ADR-0024 §1, §6; M8-2).
--
-- An automation — a schedule, a signed webhook, a Slack/Linear/Jira intake — creates work *as*
-- something, and that something must outlive the person who set it up (ADR-0024 Context, point 2).
-- It is a `principal` of kind `token`, confined to one organization, holding one role there
-- through an ordinary `membership`. Its tokens are ordinary `api_token` rows it owns, so the
-- router authenticates them exactly as it does a personal token.
--
-- Additive, and nothing here is schema-qualified: the connection's `search_path` picks the schema
-- (ADR-0024 §11).

-- The one organization a service principal belongs to. Null for a person, who may belong to many
-- through memberships. Kept on the principal as well as the membership because deleting a service
-- principal removes its membership and it must still be findable, by organization, for audit.
alter table principal add column organization_id uuid references organization (id) on delete cascade;
-- Set for the built-in principal an organization's internal automations act as when they hold no
-- token of their own (`getSystemActor`): `schedules`, `integrations`, … One per purpose per
-- organization, enforced below, so two concurrent first calls cannot make two.
alter table principal add column system_purpose text;
-- A deleted service principal is deactivated, not removed: tasks, guidance and grants it created
-- keep naming it. Its tokens are revoked and its membership deleted in the same transaction.
alter table principal add column deactivated_at timestamptz;

alter table principal add constraint principal_service_organization_check
  check ((kind = 'token') = (organization_id is not null));
alter table principal add constraint principal_system_purpose_check
  check (system_purpose is null or kind = 'token');

create unique index principal_organization_id_system_purpose_idx
  on principal (organization_id, system_purpose) where system_purpose is not null;
create index principal_organization_id_idx on principal (organization_id) where organization_id is not null;

-- Who created a task, as a principal: the API caller, or the system actor of the automation that
-- made it. Nullable because the GitHub label path and the local CLI have no principal to name
-- (ADR-0024 §9).
--
-- migrations/0023 (M8-1, #293) already adds this column with its foreign key (`on delete set
-- null`). The two were written in parallel; 0024 therefore adds the column and its foreign key only
-- if absent, so that after every migration there is exactly one column and exactly one FK.
alter table engineering_task add column if not exists created_by_principal_id uuid;
do $$
begin
  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      join pg_attribute a on a.attrelid = t.oid and a.attnum = any (c.conkey)
     where c.contype = 'f'
       and t.relname = 'engineering_task'
       and n.nspname = current_schema()
       and a.attname = 'created_by_principal_id'
  ) then
    alter table engineering_task
      add constraint engineering_task_created_by_principal_id_fkey
      foreign key (created_by_principal_id) references principal (id) on delete set null;
  end if;
end
$$;

-- Two permissions for M8: managing integration connections (M8-3/#295) and schedules (M8-4).
-- Admin holds every permission (ADR-0024 §4), so the built-in admin role gains both. Idempotent,
-- and existing role rows keep every permission they had.
update access_role set permissions = permissions || array['integrations.manage'], updated_at = now()
 where key = 'admin' and account_id is null and not ('integrations.manage' = any (permissions));
update access_role set permissions = permissions || array['schedules.manage'], updated_at = now()
 where key = 'admin' and account_id is null and not ('schedules.manage' = any (permissions));
