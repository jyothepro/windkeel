-- Take over, hand back and submit (ADR-0029 §3, integrated assistant phase 4, #369). Behind
-- `ORQON_TAKEOVER=1`; nothing here changes what a run does while the flag is off.
--
-- 1. `HUMAN_EDITING`, one non-terminal state (amends ADR-0003). A person is working in a human
--    workspace of their own — a new sandbox seeded through git from the run's candidate — and the
--    run waits for *Submit for verification* or *Hand back to Orqon*.
--
-- 2. `human_session`: the actor record ADR-0024 §9's pattern asks for. `AgentRun.role` stays
--    agent-only; who edited, in which sandbox, from which seed candidate, and which commits they
--    produced live here. One live session per run (the partial unique index). The capability
--    token the console opens the workspace with is **not** stored: it is minted per request,
--    returned once, and the server in the sandbox holds only its SHA-256 (ADR-0029 §4).
--    `commits` is `[{ sha, parentSha, kind: 'submit'|'handback', at }]`, each authored by the
--    person's GitHub noreply identity and pushed by the API host from a git bundle (§3.6).
--
-- 3. `engineering_run.human_cycles` / `human_cycles_cap`: a person's cycles do not spend the repair
--    budget (amends ADR-0011 §2); they are capped separately (default 10) and by the spend cap.
--
-- 4. `engineering_task.session_mode`: *Autonomous* or *Pair* (ADR-0029 §1), stored on the task as
--    the risk level is. Pair stops after the first implementing turn and enters HUMAN_EDITING.
--
-- 5. `runs.takeover` for Admin and Member (ADR-0024 as amended by ADR-0029).
--
-- Idempotent. **No object here is schema-qualified** (ADR-0024 §11).

alter table engineering_run drop constraint if exists engineering_run_status_check;
alter table engineering_run add constraint engineering_run_status_check check (status in (
  'CREATED', 'CLASSIFYING', 'PLANNING', 'WAITING_FOR_APPROVAL', 'PROVISIONING',
  'IMPLEMENTING', 'VERIFYING', 'REPAIRING', 'PR_CREATING', 'PR_READY',
  'WAITING_FOR_HUMAN', 'HUMAN_EDITING', 'COMPLETED', 'CANCELLED', 'BLOCKED', 'FAILED',
  'MAX_REPAIR_ATTEMPTS_REACHED'
));

alter table engineering_run
  add column if not exists human_cycles integer not null default 0,
  add column if not exists human_cycles_cap integer not null default 10;

alter table engineering_run drop constraint if exists engineering_run_human_cycles_check;
alter table engineering_run add constraint engineering_run_human_cycles_check
  check (human_cycles >= 0 and human_cycles_cap >= 0);

alter table engineering_task
  add column if not exists session_mode text not null default 'autonomous';
-- Who asked for Pair mode: the person whose workspace the run opens after its first turn.
alter table engineering_task
  add column if not exists pair_principal_id uuid references principal (id) on delete set null;
alter table engineering_task drop constraint if exists engineering_task_session_mode_check;
alter table engineering_task add constraint engineering_task_session_mode_check
  check (session_mode in ('autonomous', 'pair'));

create table if not exists human_session (
  id                    uuid primary key default gen_random_uuid(),
  engineering_run_id    uuid not null references engineering_run (id),
  -- Who took over. Kept when the principal is deleted, as the login below, so the record stays.
  principal_id          uuid references principal (id) on delete set null,
  actor                 text not null,
  -- The identity the person's commits are authored as: `<id>+<login>@users.noreply.github.com`.
  github_user_id        bigint not null,
  github_login          text not null,
  display_name          text,
  -- How the session began: *Take over*, Pair mode after the first turn, or *Make changes* on a PR.
  origin                text not null check (origin in ('takeover', 'pair', 'make_changes')),
  -- The run state the request was made in.
  requested_from        text not null,
  state                 text not null default 'requested' check (state in (
                          'requested', 'provisioning', 'ready', 'sleeping',
                          'submitting', 'handing_back', 'ended', 'failed'
                        )),
  -- A queued submit or hand back, honoured by the workflow's next HUMAN_EDITING tick.
  intent                text check (intent in ('submit', 'handback')),
  intent_at             timestamptz,
  -- The candidate the workspace was seeded from: the branch head at hand-off.
  seed_sha              text check (seed_sha is null or seed_sha ~ '^[0-9a-f]{40}$'),
  base_sha              text,
  sandbox_provider      text,
  sandbox_name          text,
  -- The workspace server's public origin (an exposed port; ADR-0014 §3 as amended).
  workspace_origin      text,
  -- `(pid, starttime)` of processes of other uids at hand-off: Spike B's baseline.
  process_baseline      jsonb,
  commits               jsonb not null default '[]'::jsonb check (jsonb_typeof(commits) = 'array'),
  -- The person's verified commit, recorded *before* the host pushes it: a redelivery that finds
  -- the run branch already at this SHA treats the push as landed rather than as the branch moving.
  push_sha              text check (push_sha is null or push_sha ~ '^[0-9a-f]{40}$'),
  -- What the console says about the workspace's install. Human workspaces always install without
  -- repository secrets (ADR-0029 §3.4 as amended after review of #363).
  install_note          text,
  outcome               text check (outcome in (
                          'submitted', 'handed_back', 'cancelled', 'blocked', 'expired', 'failed'
                        )),
  error                 text,
  -- Sandbox usage already charged to the run, so each tick charges only the delta.
  charged_cpu_ms        bigint not null default 0,
  charged_egress_bytes  bigint not null default 0,
  -- A handed-back session's resume turn: the agent run that carries it, and when it was used.
  resume_agent_run_id   uuid references agent_run (id),
  resumed_at            timestamptz,
  requested_at          timestamptz not null default now(),
  started_at            timestamptz,
  last_active_at        timestamptz,
  ended_at              timestamptz
);

create index if not exists human_session_engineering_run_id_idx on human_session (engineering_run_id);
create unique index if not exists human_session_live_idx
  on human_session (engineering_run_id) where ended_at is null;

update access_role set permissions = permissions || array['runs.takeover'], updated_at = now()
 where key in ('admin', 'member') and account_id is null and not ('runs.takeover' = any (permissions));
