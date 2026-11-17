-- ADR-0013 §4: the plan §20 metric list as named SQL views, versioned with the schema.
-- Nothing leaves Postgres in v1 — these views are the entire query surface; `orqon
-- metrics` (src/commands/metrics.ts) is the only reader. Timing comes from the
-- append-only run_state_transition log; cost from the append-only cost_event ledger.

-- 1. task success rate
create view task_success_rate as
select
  count(*) filter (where status = 'COMPLETED') as completed,
  count(*) filter (where status in ('COMPLETED', 'FAILED', 'CANCELLED')) as terminal,
  case when count(*) filter (where status in ('COMPLETED', 'FAILED', 'CANCELLED')) = 0 then null
       else round(100.0 * count(*) filter (where status = 'COMPLETED')
                 / count(*) filter (where status in ('COMPLETED', 'FAILED', 'CANCELLED')), 2)
  end as success_rate_pct
from engineering_task;

-- 2. first-pass verification rate: did the first VerificationRun of a run pass/warn
-- (never needed a repair), per engineering_run.
create view first_pass_verification_rate as
with first_verification as (
  select distinct on (engineering_run_id) engineering_run_id, verdict
  from verification_run
  order by engineering_run_id, started_at nulls last, id
)
select
  count(*) filter (where verdict in ('pass', 'warn')) as first_pass,
  count(*) as total,
  case when count(*) = 0 then null
       else round(100.0 * count(*) filter (where verdict in ('pass', 'warn')) / count(*), 2)
  end as first_pass_rate_pct
from first_verification;

-- 3. repair success rate: of runs that entered the repair loop at least once, how many
-- ended in a passing/warn final verdict.
create view repair_success_rate as
with repaired_runs as (
  select distinct engineering_run_id from repair_attempt
)
select
  count(*) filter (where er.final_verdict in ('pass', 'warn')) as repaired_to_success,
  count(*) as total_repaired,
  case when count(*) = 0 then null
       else round(100.0 * count(*) filter (where er.final_verdict in ('pass', 'warn')) / count(*), 2)
  end as repair_success_rate_pct
from repaired_runs rr
join engineering_run er on er.id = rr.engineering_run_id;

-- 4. human rework rate: of merged runs, how many got human commits after the PR opened.
create view human_rework_rate as
select
  count(*) filter (where human_commits_after_pr > 0) as reworked,
  count(*) as merged,
  case when count(*) = 0 then null
       else round(100.0 * count(*) filter (where human_commits_after_pr > 0) / count(*), 2)
  end as human_rework_rate_pct
from engineering_run
where pr_merged_at is not null;

-- 5. merge rate: of runs that opened a PR, how many were merged.
create view merge_rate as
select
  count(*) filter (where pr_merged_at is not null) as merged,
  count(*) filter (where pr_number is not null) as pr_opened,
  case when count(*) filter (where pr_number is not null) = 0 then null
       else round(100.0 * count(*) filter (where pr_merged_at is not null)
                 / count(*) filter (where pr_number is not null), 2)
  end as merge_rate_pct
from engineering_run;

-- 6. time to PR: elapsed time from a run leaving CREATED to reaching PR_READY.
create view time_to_pr as
select
  engineering_run_id,
  min(at) filter (where from_state = 'CREATED') as run_started_at,
  min(at) filter (where to_state = 'PR_READY') as pr_ready_at,
  min(at) filter (where to_state = 'PR_READY') - min(at) filter (where from_state = 'CREATED')
    as time_to_pr
from run_state_transition
group by engineering_run_id
having min(at) filter (where to_state = 'PR_READY') is not null;

-- 7. sandbox duration: Workspace carries no start/end timestamps (ADR-0003), so this is
-- approximated from the state each workspace role owns — IMPLEMENTING for the maker
-- workspace, VERIFYING for the verifier workspace — paired occurrence by occurrence so a
-- run that repaired (and so re-entered VERIFYING) gets one row per cycle, not one blended
-- average.
create view sandbox_duration as
with entries as (
  select engineering_run_id, to_state as state, at as entered_at,
         row_number() over (partition by engineering_run_id, to_state order by at) as rn
  from run_state_transition
  where to_state in ('IMPLEMENTING', 'VERIFYING')
),
exits as (
  select engineering_run_id, from_state as state, at as exited_at,
         row_number() over (partition by engineering_run_id, from_state order by at) as rn
  from run_state_transition
  where from_state in ('IMPLEMENTING', 'VERIFYING')
)
select
  e.engineering_run_id,
  case e.state when 'IMPLEMENTING' then 'maker' else 'verifier' end as workspace_role,
  x.exited_at - e.entered_at as duration
from entries e
join exits x
  on x.engineering_run_id = e.engineering_run_id and x.state = e.state and x.rn = e.rn;

-- 8. model tokens, per run.
create view model_tokens as
select engineering_run_id, sum(tokens_in) as tokens_in, sum(tokens_out) as tokens_out
from cost_event
where kind = 'model'
group by engineering_run_id;

-- 9. model cost, per run.
create view model_cost as
select engineering_run_id, sum(usd) as model_cost_usd
from cost_event
where kind = 'model'
group by engineering_run_id;

-- 10. sandbox cost, per run.
create view sandbox_cost as
select engineering_run_id, sum(usd) as sandbox_cost_usd
from cost_event
where kind = 'sandbox'
group by engineering_run_id;

-- 11. verification cost, per run.
create view verification_cost as
select engineering_run_id, sum(usd) as verification_cost_usd
from cost_event
where stage_type = 'verification_run'
group by engineering_run_id;

-- 12. cost per verified PR — also the key infrastructure metric, "COGS per verified PR".
create view cost_per_verified_pr as
select
  sum(er.cost) as total_cost_usd,
  count(*) filter (where er.pr_merged_at is not null) as verified_prs,
  case when count(*) filter (where er.pr_merged_at is not null) = 0 then null
       else round(sum(er.cost) / count(*) filter (where er.pr_merged_at is not null), 4)
  end as cost_per_verified_pr_usd
from engineering_run er;

-- Key business metric: "verified engineering work merged without human rework".
create view verified_work_merged_without_rework as
select
  count(*) filter (where pr_merged_at is not null and coalesce(human_commits_after_pr, 0) = 0)
    as clean_merges,
  count(*) as total_runs,
  case when count(*) = 0 then null
       else round(100.0 * count(*) filter (
              where pr_merged_at is not null and coalesce(human_commits_after_pr, 0) = 0
            ) / count(*), 2)
  end as clean_merge_rate_pct
from engineering_run;
