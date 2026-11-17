-- Cost priced per model and attributed by key source (ADR-0026 §9, M9-6 #324).
--
-- Three changes to the ADR-0013 §1 ledger, each one keeping every existing reader working:
--
-- 1. **Whose key paid.** `key_source` is `orqon` (the operator's key) or `customer` (the
--    organization's own, M9-4/M9-5), and `credential_id` names the customer's `model_credential`.
--    Null on rows written before this migration — nobody recorded it then, and guessing `orqon` would
--    be a measurement nobody made — and on sandbox rows, which no model key paid for.
--
-- 2. **Unpriced is null, not zero.** Until now an unpriced model call (tokens, no rate: #242) was
--    written as `usd = 0` and recognised by its tokens. With per-model prices from a catalog, "the
--    catalog does not know this model" is the ordinary unpriced case, and a zero that has to be
--    read together with another column to mean "unknown" is how #242 happened in the first place.
--    `usd` becomes nullable; `sum(usd)` already skips nulls, so every view and the run row's
--    maintained `cost` (which `recordCost` increments by `coalesce(usd, 0)`) read the same totals.
--    The ADR-0011 spend cap does *not* stop counting an unpriced call: `enforceSpendAndTimeRails`
--    adds its tokens at a conservative rate (rails-gate.ts) — unknown is neither zero nor unbounded.
--    Old rows of that shape are rewritten to null: no Orqon rate was ever configured at exactly
--    zero for a call that reported tokens, so those zeros were all "unpriced".
--
-- 3. **Criteria generation has its own stage.** M9-4 (#331) booked it as `verification_run` with
--    `stage_id = engineering_run_id`, because the check constraint had no better value and no
--    verification row exists yet at intake. It gets `criteria`, and those rows move: a
--    `verification_run` id is never its run's id, so the match is exact. `verification_cost`
--    keeps counting it — criteria generation is checker spend (ADR-0012 §3) — so its figures do
--    not change.
--
-- **No object here is schema-qualified** (ADR-0024 §11).

-- `model` is the model a model row was priced for (or found unpriced for). It is what the ADR-0011
-- spend rail names when it counts an unpriced call at the conservative estimate ("model X is
-- unpriced"), and what an operator needs to pin a rate for it. Null on sandbox and pre-0031 rows.
alter table cost_event
  add column key_source text check (key_source in ('orqon', 'customer')),
  add column credential_id uuid references model_credential (id),
  add column model text;

-- A credential is named exactly when a customer's key paid. Two checks rather than one equality,
-- because `null = x` is null and would let a pre-M9 row (both null) and a bad row (only one null)
-- through alike.
alter table cost_event
  add constraint cost_event_credential_customer_check
    check (credential_id is null or key_source = 'customer'),
  add constraint cost_event_customer_credential_check
    check (key_source is distinct from 'customer' or credential_id is not null);

alter table cost_event alter column usd drop not null;

update cost_event set usd = null
 where kind = 'model' and usd = 0 and coalesce(tokens_in, 0) > 0;

alter table cost_event drop constraint cost_event_stage_type_check;
alter table cost_event
  add constraint cost_event_stage_type_check
    check (stage_type in ('agent_run', 'verification_run', 'workspace', 'criteria'));

update cost_event set stage_type = 'criteria'
 where stage_type = 'verification_run' and stage_id = engineering_run_id;

-- 0002's view, with criteria generation still counted as the checker spend it always was.
create or replace view verification_cost as
select engineering_run_id, sum(usd) as verification_cost_usd
from cost_event
where stage_type in ('verification_run', 'criteria')
group by engineering_run_id;

-- Model spend per run and per key source (null: recorded before key sources were). `unpriced_calls`
-- are calls that reported tokens and have no price, so `model_cost_usd` is a lower bound whenever
-- it is non-zero. `model_cost` and `model_tokens` (0002) are unchanged and remain the totals.
create view model_cost_by_source as
select engineering_run_id,
       key_source,
       sum(usd) as model_cost_usd,
       sum(tokens_in) as tokens_in,
       sum(tokens_out) as tokens_out,
       count(*) filter (where usd is null) as unpriced_calls,
       count(*) as calls
from cost_event
where kind = 'model'
group by engineering_run_id, key_source;
