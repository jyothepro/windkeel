-- Model presets and a run's own model choice (ADR-0029 §6, integrated assistant phase 2, #365, G15).
--
-- `model_preset` is a name an organization gives to a maker/checker pairing (and, once ADR-0027
-- lands, the harness that drives the maker): *Fast*, *Thorough*. The composer shows presets first
-- and the raw models under *More*. Orqon ships no preset names of its own.
--
-- A preset is not a policy layer. Choosing one in the composer copies its choices into the task's
-- `models` (`engineering_task.model_override`) or a re-run's (`engineering_run.model_override`), so
-- editing or deleting a preset later changes no task and no run — and nothing changes the snapshot
-- of a run already past intake (ADR-0011 §2, ADR-0026 §4).
--
-- `maker` is one `{ model, provider?, credentialId?, declaredVendor? }`; `checker` a list of one to
-- five in preference order — the shape of a task's `models`. Each names a credential *id*, never a
-- value; there is no column for one. Independence is checked when a preset is saved, with intake's
-- rule, so a preset the picker offers cannot fail a run for its pairing.
--
-- `engineering_run.model_override` is *Run again with…*: a new run of the same task with other
-- models (ADR-0003: recovery is a new run). Resolved at intake over the task's own choice, into the
-- new run's snapshot. Null on every other run.
--
-- **No object here is schema-qualified** (ADR-0024 §11).

create table model_preset (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references organization (id),
  name                     text not null check (char_length(name) between 1 and 40),
  -- Null is the operator's default harness (ADR-0027 §1). Checked against the enabled set on write.
  harness                  text check (harness is null or harness ~ '^[a-z][a-z0-9-]{0,31}$'),
  maker                    jsonb not null,
  checker                  jsonb not null check (jsonb_typeof(checker) = 'array'),
  created_by_principal_id  uuid references principal (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- One name per organization, case-insensitively: two "Fast" presets would leave the picker ambiguous.
create unique index model_preset_name_idx on model_preset (organization_id, lower(name));

alter table engineering_run add column model_override jsonb;
