-- Milestone 6 (ADR-0012): whose acceptance criteria a task is held to, and who signed off.
--
-- ADR-0012's consequences say the extracted/generated distinction is what the §16 evidence
-- summary surfaces, and §4 makes approval a precondition for provisioning — neither is
-- expressible while `engineering_task` records only the criteria themselves. The requirement
-- these columns exist to satisfy is stated plainly in #159: *the database alone must answer what
-- was generated, by which model, who approved it, and when.*

alter table engineering_task
  -- 'extracted' is the right default for every existing row: everything created before ADR-0012's
  -- gate came from an author's own words (a CLI --criteria file or an issue checklist), and
  -- backfilling them as 'generated' would mark human criteria as unapproved machine output.
  add column criteria_provenance text not null default 'extracted'
    check (criteria_provenance in ('extracted', 'generated')),
  -- `vendor/model`, recorded at generation time. Not a foreign key to anything: it is a
  -- historical fact about one generation, and re-reading it must not depend on that model still
  -- being configured (ADR-0010's independence check is made *at* generation, not re-litigated).
  add column criteria_generated_by text,
  -- Null while generated criteria are unapproved. `assertProvisionable` reads exactly this
  -- (src/factory/criteria-gate.ts), which is why the gate is enforced rather than observed.
  add column criteria_approved_at timestamptz,
  -- The GitHub login that commented `/orqon approve`. The consumed `run_signal` row records the
  -- same actor with its own timestamp; this column is the answer to "who approved *this task*"
  -- without walking the signal log of every run.
  add column criteria_approved_by text;

-- The gate's read: "is there a task holding unapproved machine-written criteria?"
create index engineering_task_unapproved_criteria_idx
  on engineering_task (criteria_provenance)
  where criteria_provenance = 'generated' and criteria_approved_at is null;
