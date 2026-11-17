-- Layered model policy and the per-run model snapshot (ADR-0026 §4–6, M9-3 #321).
--
-- `model_policy` says which model a role runs on, at two layers: the organization's default
-- (`repository_id` null) and a repository's override. The third layer, a task's own choice, lives on
-- the task (`engineering_task.model_override`) because it is set once, by whoever created the task,
-- and means nothing to any other task.
--
-- A row names a model and *how it is paid for*: a `credential_id` is the organization's own key
-- (M9-2's `model_credential`); null is Orqon-managed, the operator's keys of today. A row never holds
-- a key and never could: there is no column for one.
--
-- `engineering_run.model_config` is the snapshot intake resolves once from those layers (and the
-- operator's defaults beneath them), so a policy changed mid-run does not change the run, and two
-- runs on one warm instance can use different vendors. It names models, providers, credential ids
-- and key sources — never a value. Null on every run created before this migration: those keep the
-- process-environment behaviour they started with.
--
-- `stop_reason` gains `model_policy`: a run refused at intake because its models cannot be used — a
-- revoked or invalid credential, a dependent maker/checker pairing — says so rather than `error`.
--
-- **No object here is schema-qualified** (ADR-0024 §11).

create table model_policy (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references organization (id),
  -- Null is the organization's default; a repository row overrides it for that repository.
  repository_id             uuid references repository (id) on delete cascade,
  role                      text not null check (role in ('maker', 'checker')),
  -- A catalog provider id (M9-1): openai, anthropic, openrouter, openai-compatible.
  provider                  text not null,
  model                     text not null check (char_length(model) between 1 and 200),
  -- Null is Orqon-managed. A credential is never deleted (revocation is soft), so this cannot dangle.
  credential_id             uuid references model_credential (id),
  -- For a model the catalog cannot attribute (ADR-0026 §5). Overrides the credential's own.
  declared_vendor           text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  updated_by_principal_id   uuid references principal (id) on delete set null
);

-- One row per role per layer. `coalesce` because two nulls are distinct to a plain unique index, and
-- two organization defaults for one role would leave "which one?" to row order.
create unique index model_policy_layer_idx
  on model_policy (organization_id, coalesce(repository_id, '00000000-0000-0000-0000-000000000000'::uuid), role);

alter table engineering_run add column model_config jsonb;
alter table engineering_task add column model_override jsonb;

alter table engineering_run drop constraint if exists engineering_run_stop_reason_check;
alter table engineering_run add constraint engineering_run_stop_reason_check
  check (stop_reason in (
    'spend_cap', 'wall_clock_cap', 'stuck', 'repair_cap', 'approval_expired', 'error', 'model_policy'
  ));
