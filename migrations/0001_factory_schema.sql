-- Milestone 1 factory schema (ADR-0003, amended by ADR-0011, ADR-0013, ADR-0015).
-- Entities and the run state machine are ADR-0003's; this file is the schema mapping
-- (issue #61), not a re-litigation of shape. Applied by the ADR-0008 node-pg runner.

create extension if not exists pgcrypto;

-- EngineeringTask (ADR-0003 §1)
create table engineering_task (
  id                  uuid primary key default gen_random_uuid(),
  repository_id       uuid not null,
  source_type         text not null,
  source_reference    text not null,
  title               text not null,
  description         text not null,
  acceptance_criteria jsonb not null default '[]'::jsonb,
  risk_level          text not null check (risk_level in ('low', 'medium', 'high')),
  priority            integer,
  status              text not null check (status in (
                         'OPEN', 'IN_PROGRESS', 'WAITING_FOR_HUMAN', 'COMPLETED', 'FAILED', 'CANCELLED'
                       )),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index engineering_task_repository_id_idx on engineering_task (repository_id);

-- EngineeringRun (ADR-0003 §2, amended by ADR-0011 §4-6 and ADR-0013 §3)
create table engineering_run (
  id                       uuid primary key default gen_random_uuid(),
  task_id                  uuid not null references engineering_task (id),
  status                   text not null check (status in (
                             'CREATED', 'CLASSIFYING', 'PLANNING', 'WAITING_FOR_APPROVAL', 'PROVISIONING',
                             'IMPLEMENTING', 'VERIFYING', 'REPAIRING', 'PR_CREATING', 'PR_READY',
                             'WAITING_FOR_HUMAN', 'COMPLETED', 'CANCELLED', 'BLOCKED', 'FAILED',
                             'MAX_REPAIR_ATTEMPTS_REACHED'
                           )),
  plan                     jsonb,
  selected_worker          text,
  selected_model           text,
  sandbox_provider         text,
  started_at               timestamptz,
  completed_at             timestamptz,
  -- Maintained sum of this run's cost_event rows (ADR-0013 §1); the M1 run service
  -- ships a test asserting this never drifts from SUM(cost_event.usd).
  cost                     numeric not null default 0,
  final_verdict            text check (final_verdict in ('pass', 'warn', 'fail')),
  -- ADR-0011: an unset spend cap is a deliberate operator act, never a default.
  spend_cap_usd            numeric,
  wall_clock_cap_seconds   integer not null,
  stop_reason              text check (stop_reason in (
                             'spend_cap', 'wall_clock_cap', 'stuck', 'repair_cap', 'error'
                           )),
  -- ADR-0013 §3: PR outcome recorded from webhooks.
  pr_number                integer,
  pr_merged_at             timestamptz,
  human_commits_after_pr   integer not null default 0
);

create index engineering_run_task_id_idx on engineering_run (task_id);
create index engineering_run_status_idx on engineering_run (status);

-- AgentRun (ADR-0003 §3)
create table agent_run (
  id                  uuid primary key default gen_random_uuid(),
  engineering_run_id  uuid not null references engineering_run (id),
  worker_type         text not null,
  model               text not null,
  role                text not null check (role in (
                        'planner', 'implementer', 'debugger', 'reviewer', 'repairer'
                      )),
  started_at          timestamptz,
  completed_at        timestamptz,
  result              jsonb,
  token_usage         jsonb,
  model_cost          numeric
);

create index agent_run_engineering_run_id_idx on agent_run (engineering_run_id);

-- VerificationRun (ADR-0003 §4, amended by ADR-0015)
create table verification_run (
  id                        uuid primary key default gen_random_uuid(),
  engineering_run_id        uuid not null references engineering_run (id),
  candidate_sha             text not null,
  policy_version            text not null,
  verdict                   text check (verdict in ('pass', 'warn', 'fail')),
  -- Nullable per ADR-0015: null + evidence_pruned_at set = pruned by policy;
  -- null + evidence_pruned_at null = no package produced.
  evidence_package_ref      text,
  risk_summary              jsonb,
  started_at                timestamptz,
  completed_at              timestamptz,
  evidence_pruned_at        timestamptz,
  -- Written for every verification, pruned or not (ADR-0015).
  evidence_manifest_digest  text
);

create index verification_run_engineering_run_id_idx on verification_run (engineering_run_id);

-- RepairAttempt (ADR-0003 §5)
create table repair_attempt (
  id                  uuid primary key default gen_random_uuid(),
  engineering_run_id  uuid not null references engineering_run (id),
  verification_run_id uuid not null references verification_run (id),
  agent_run_id        uuid references agent_run (id),
  attempt_number      integer not null,
  repair_packet       jsonb not null,
  result              jsonb
);

create index repair_attempt_engineering_run_id_idx on repair_attempt (engineering_run_id);
create index repair_attempt_verification_run_id_idx on repair_attempt (verification_run_id);

-- Workspace (ADR-0003 §6)
create table workspace (
  id                  uuid primary key default gen_random_uuid(),
  engineering_run_id  uuid not null references engineering_run (id),
  role                text not null check (role in ('maker', 'verifier')),
  sandbox_provider    text not null,
  provider_handle     text,
  repository          text not null,
  base_sha            text not null,
  working_branch      text,
  status              text not null,
  expires_at          timestamptz
);

create index workspace_engineering_run_id_idx on workspace (engineering_run_id);

-- cost_event (ADR-0013 §1): append-only ledger, one row per completed billable unit.
create table cost_event (
  id                  uuid primary key default gen_random_uuid(),
  engineering_run_id  uuid not null references engineering_run (id),
  stage_type          text not null check (stage_type in ('agent_run', 'verification_run', 'workspace')),
  stage_id            uuid not null,
  kind                text not null check (kind in ('model', 'sandbox')),
  tokens_in           integer,
  tokens_out          integer,
  usd                 numeric not null,
  recorded_at         timestamptz not null default now()
);

create index cost_event_engineering_run_id_idx on cost_event (engineering_run_id);

-- run_state_transition (ADR-0013 §2): append-only log, one row per legal transition,
-- written by the ADR-0007 reducer in the same transaction that moves the run. This is
-- also the audit trail for ADR-0003's "any transition not in the table is illegal" —
-- a rejected transition is recorded nowhere.
create table run_state_transition (
  id                  uuid primary key default gen_random_uuid(),
  engineering_run_id  uuid not null references engineering_run (id),
  from_state          text,
  to_state            text not null,
  reason              text,
  at                  timestamptz not null default now()
);

create index run_state_transition_engineering_run_id_idx on run_state_transition (engineering_run_id);
