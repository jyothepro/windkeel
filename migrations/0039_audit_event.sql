-- The account audit log (#393 8A, ADR-0030).
--
-- One row per administrative act or run milestone, written in the same transaction as the change it
-- describes (`src/factory/audit-log.ts`). Rows form a hash chain per account:
-- `hash = sha256(prev_hash || canonical_json(row without hash))`, computed in TypeScript under a
-- per-account transaction-scoped advisory lock, so `seq` is gap-free and in commit order.
--
-- Append-only. `revoke update, delete` cannot bind the privileged role the ingress connects as, so a
-- trigger refuses UPDATE, DELETE and TRUNCATE. The one way rows leave is `audit_event_purge`, which
-- deletes a *prefix* of an account's chain (everything before a time): retention and a customer's own
-- deletion both go through it, and both write an event naming the hash the remaining chain now
-- starts from. Someone with SQL can still disable the trigger; the chain is what makes that visible.
--
-- No object here is schema-qualified (ADR-0024 §11).

create table audit_event (
  id                  uuid primary key,
  account_id          uuid not null references account (id),
  -- Position in the account's chain: 1, 2, 3… with no gaps. Lists page on it, not on time.
  seq                 bigint not null,
  organization_id     uuid references organization (id),
  actor_principal_id  uuid references principal (id),
  -- A login or display name, as in ADR-0024 §9: GitHub commenters act without being principals.
  actor_text          text not null,
  actor_kind          text not null check (actor_kind in ('user', 'token', 'github', 'system', 'scim')),
  action              text not null,
  target_type         text,
  target_id           text,
  ip                  inet,
  user_agent          text,
  request_id          text,
  detail              jsonb not null default '{}',
  prev_hash           bytea,
  hash                bytea not null,
  -- Set by the writer, never earlier than the row before it: time is monotonic along the chain, so
  -- "everything before T" is always a prefix.
  occurred_at         timestamptz not null
);
create unique index audit_event_account_seq_idx on audit_event (account_id, seq);
create index audit_event_account_time_idx on audit_event (account_id, occurred_at desc, id);
create index audit_event_account_org_seq_idx on audit_event (account_id, organization_id, seq);
create index audit_event_account_action_idx on audit_event (account_id, action, seq);

create function audit_event_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('orqon.audit_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'audit_event is append-only: % is refused (use audit_event_purge for retention)', tg_op
    using errcode = '42501';
end
$$;

create trigger audit_event_append_only
  before update or delete on audit_event
  for each row execute function audit_event_guard();

create trigger audit_event_no_truncate
  before truncate on audit_event
  for each statement execute function audit_event_guard();

-- Deletes one account's events older than `p_before`, and nothing else. The only path the trigger
-- allows. The flag is transaction-local and cleared before returning.
create function audit_event_purge(p_account_id uuid, p_before timestamptz) returns bigint
language plpgsql as $$
declare
  deleted bigint;
begin
  perform set_config('orqon.audit_purge', 'on', true);
  delete from audit_event where account_id = p_account_id and occurred_at < p_before;
  get diagnostics deleted = row_count;
  perform set_config('orqon.audit_purge', 'off', true);
  return deleted;
end
$$;

-- Where the optional SIEM sink (`ORQON_AUDIT_WEBHOOK_URL`) has got to, per account. At least once:
-- the cursor moves only after the receiver answered 2xx.
create table audit_sink_cursor (
  account_id       uuid primary key references account (id),
  last_seq         bigint not null default 0,
  last_success_at  timestamptz,
  last_error       text,
  failures         integer not null default 0,
  updated_at       timestamptz not null default now()
);

-- Reading the audit log is an admin's (ADR-0024 §4); a token gets it only when asked by name.
update access_role set permissions = permissions || array['audit.read'], updated_at = now()
 where key = 'admin' and account_id is null and not ('audit.read' = any (permissions));
