-- ADR-0013 §3's `human_commits_after_pr` has been `integer not null default 0` since
-- migrations/0001 and nothing has ever written it. Two views read it, so both have been
-- answering from a column that only ever holds its default:
--
--   * `human_rework_rate` reported 0% rework, over every merged run.
--   * `verified_work_merged_without_rework` — plan §20's key business metric — reported a 100%
--     clean-merge rate, over every run that merged.
--
-- Neither number is "unknown". They are wrong in the flattering direction, which is the most
-- dangerous shape a business metric can have and precisely the shape ADR-0013 exists to prevent.
-- The same failure #35 names in the verification engine ("skipped must never read as passed"),
-- expressed in SQL.
--
-- The column is now written (src/factory/human-rework.ts, applied when a pull request merges).
-- But the metric cannot always be computed honestly — a hermetic run has no GitHub client, a
-- pull request past GitHub's 250-commit cap yields a floor rather than a count, a commit with no
-- author email cannot be attributed, and the API call can simply fail. In every one of those
-- cases a `0` would be a lie and the pre-existing `not null default 0` left no other option.
--
-- So: **nullable, with no default.** `null` means not measured; `0` means measured, and a human
-- added nothing. Making those two states distinguishable is the whole fix — the computation
-- above is what fills the column in, and this is what stops an absence from reading as a
-- perfect score.
alter table engineering_run
  alter column human_commits_after_pr drop not null,
  alter column human_commits_after_pr drop default;

-- Every existing value is the default, never a measurement: no code path wrote this column
-- before this migration. Recording them as unknown is not discarding data, it is declining to
-- keep asserting something that was never true. Forward-only and irreversible by design; the
-- alternative — leaving historical zeroes in place — would keep both views reporting a clean
-- record for runs nobody ever looked at.
update engineering_run set human_commits_after_pr = null;

-- 4. human rework rate, over the merged runs it can actually speak about.
--
-- The denominator was every merged run. It is now every merged run *with a measurement*, and
-- the ones without are reported alongside rather than folded in — a reader who cannot see how
-- many runs were excluded cannot tell a genuine 0% from an empty column, which is the mistake
-- this migration exists to correct.
drop view if exists human_rework_rate;
create view human_rework_rate as
select
  count(*) filter (where human_commits_after_pr > 0) as reworked,
  count(*) filter (where human_commits_after_pr is not null) as merged,
  count(*) filter (where human_commits_after_pr is null) as merged_unmeasured,
  case when count(*) filter (where human_commits_after_pr is not null) = 0 then null
       else round(
         100.0 * count(*) filter (where human_commits_after_pr > 0)
         / count(*) filter (where human_commits_after_pr is not null), 2)
  end as human_rework_rate_pct
from engineering_run
where pr_merged_at is not null;

-- Key business metric: "verified engineering work merged without human rework".
--
-- `coalesce(human_commits_after_pr, 0) = 0` was the exact line that turned an unwritten column
-- into a clean merge. A merged run with no measurement is now excluded from the denominator
-- entirely — not counted as clean and not counted as reworked, because neither is known. Runs
-- that never merged stay in the denominator, since "did not merge" is a fact and it is not a
-- clean merge.
--
-- Excluding rather than nulling the whole rate is deliberate. Nulling it would mean one
-- unmeasurable run (a hermetic one, say) suppressed the project's headline metric permanently;
-- excluding it narrows the claim to the runs that support it, and `merged_unmeasured` says how
-- much was set aside.
drop view if exists verified_work_merged_without_rework;
create view verified_work_merged_without_rework as
select
  count(*) filter (where pr_merged_at is not null and human_commits_after_pr = 0)
    as clean_merges,
  count(*) filter (where pr_merged_at is not null and human_commits_after_pr is null)
    as merged_unmeasured,
  count(*) filter (where pr_merged_at is null or human_commits_after_pr is not null)
    as total_runs,
  case when count(*) filter (where pr_merged_at is null or human_commits_after_pr is not null) = 0
         then null
       else round(
         100.0 * count(*) filter (where pr_merged_at is not null and human_commits_after_pr = 0)
         / count(*) filter (where pr_merged_at is null or human_commits_after_pr is not null), 2)
  end as clean_merge_rate_pct
from engineering_run;
