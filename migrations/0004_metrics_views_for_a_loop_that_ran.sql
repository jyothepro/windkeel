-- migrations/0002 wrote the plan §20 metric views for a factory whose repair loop had never
-- run. Now that it does, two of them answer the wrong question, and both errors flatter the
-- system — which is the worst direction for a metric to be wrong in.
--
-- Both fixes narrow a denominator to *finished* work. Nothing here changes what the metrics
-- mean; it changes which rows are allowed to answer.

-- 2. first-pass verification rate.
--
-- The original counted every engineering_run with any verification_run row, including one whose
-- first verification is still in flight (`verdict` null). An in-flight run therefore landed in
-- the denominator as a non-first-pass immediately, so the rate sagged while runs were merely
-- running and recovered as they finished. Only a *completed* first verification can answer
-- "did this run pass the first time".
drop view if exists first_pass_verification_rate;
create view first_pass_verification_rate as
with first_verification as (
  select distinct on (engineering_run_id) engineering_run_id, verdict
  from verification_run
  where completed_at is not null
  order by engineering_run_id, started_at nulls last, id
)
select
  count(*) filter (where verdict in ('pass', 'warn')) as first_pass,
  count(*) as total,
  case when count(*) = 0 then null
       else round(100.0 * count(*) filter (where verdict in ('pass', 'warn')) / count(*), 2)
  end as first_pass_rate_pct
from first_verification;

-- 3. repair success rate.
--
-- Two corrections:
--
-- (a) The denominator was every run with a repair_attempt row, in flight or not. A run
--     mid-repair has `final_verdict = 'fail'` from the cycle that triggered the repair, so it
--     counted as a repair *failure* the instant it entered the loop — and stopped counting as
--     one only if it later passed. The rate was therefore a function of how many runs happened
--     to be mid-flight when it was read.
--
--     The fix is "has left the repair loop", not "is terminal": a run that repaired
--     successfully and is now opening its PR has a settled verdict and belongs in the
--     numerator, and it may sit at PR_READY/WAITING_FOR_HUMAN for days waiting on a human.
--     Requiring a terminal state would have hidden every successful repair until someone
--     merged it — biasing the metric toward failure exactly as badly, in the other direction.
--
-- (b) The numerator counted an attempt row rather than an attempt. VERIFYING persists a packet
--     for every fail verdict, including the last one — the one whose rails check then stops the
--     run — so a capped or stuck run carries one attempt row that was never taken. Requiring
--     `agent_run_id is not null` counts repairs that actually happened.
drop view if exists repair_success_rate;
create view repair_success_rate as
with repaired_runs as (
  select distinct engineering_run_id
  from repair_attempt
  where agent_run_id is not null
)
select
  count(*) filter (where er.final_verdict in ('pass', 'warn')) as repaired_to_success,
  count(*) as total_repaired,
  case when count(*) = 0 then null
       else round(100.0 * count(*) filter (where er.final_verdict in ('pass', 'warn')) / count(*), 2)
  end as repair_success_rate_pct
from repaired_runs rr
join engineering_run er on er.id = rr.engineering_run_id
where er.status in (
  'PR_CREATING', 'PR_READY', 'WAITING_FOR_HUMAN',
  'COMPLETED', 'CANCELLED', 'FAILED', 'MAX_REPAIR_ATTEMPTS_REACHED'
);

-- New: repair attempts per run, taken vs recorded.
--
-- The §16 "Repair attempts" line is the *taken* count, and the gap between the two numbers is
-- exactly the signal that a run was stopped by a rail rather than by running out of things to
-- fix. Nothing could compute either until the loop existed.
create view repair_attempts_per_run as
select
  engineering_run_id,
  count(*) as attempts_recorded,
  count(*) filter (where agent_run_id is not null) as attempts_taken
from repair_attempt
group by engineering_run_id;
