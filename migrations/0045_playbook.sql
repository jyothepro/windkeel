-- Playbooks (#390): reusable kinds of work — "upgrade this dependency", "write tests for this
-- module" — that shape the maker and can only strengthen the verifier (ADR-0033).
--
-- A playbook carries maker instructions, extra acceptance criteria, and verifier requirements:
-- extra checks, `checks.required` switched on, stages that must run rather than skip, extra flows
-- and tools. **Strengthen only.** The verifier requirements have no field that could remove a
-- check, switch `checks.required` off, skip a pipeline stage or lower the gate level; the factory's
-- parser refuses unknown keys on save and again on read (`src/factory/playbooks.ts`), and the
-- verifier package owns the monotonic merge (`packages/verification/src/playbook-policy.ts`).
--
-- **Playbook criteria are added, never the author's.** They are kept in the playbook (and in the
-- task's snapshot), not in `engineering_task.acceptance_criteria`, so a description with no
-- criteria of its own still takes ADR-0012's generation-then-approval route. A template never
-- approves anything.
--
-- **Built-ins are not rows.** The five Orqon ships (`code-review`, `migration`, `incident-fix`,
-- `test-writing`, `dependency-upgrade`) live in code (`src/factory/playbooks-builtin.ts`) so a
-- deploy can improve them; an organization overrides one by copying it into a row here, and a row's
-- slug shadows the built-in's for that organization.
--
-- **The snapshot rule** (the model-preset pattern, migrations/0033): choosing a playbook copies it
-- onto the task as `engineering_task.playbook` — slug, version, instructions, criteria, verifier
-- requirements, and whether it was a built-in. Editing or archiving a playbook later changes no task
-- and no run. `version` goes up on every edit so a snapshot says which one it took.
--
-- **No object here is schema-qualified** (ADR-0024 §11).

create table playbook (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references organization (id),
  slug                     text not null check (slug ~ '^[a-z][a-z0-9-]{0,39}$'),
  name                     text not null check (char_length(name) between 1 and 60),
  kind                     text not null check (kind in ('code-review', 'migration', 'incident-fix', 'test-writing', 'dependency-upgrade', 'custom')),
  version                  integer not null default 1 check (version >= 1),
  maker_instructions       text not null check (char_length(maker_instructions) <= 8000),
  -- [{ text }]: added to the task's own criteria, never in place of them.
  criteria                 jsonb not null default '[]' check (jsonb_typeof(criteria) = 'array'),
  -- PlaybookVerifierRequirements: strengthen-only, checked on save.
  verifier                 jsonb not null default '{}' check (jsonb_typeof(verifier) = 'object'),
  default_risk_level       text check (default_risk_level in ('low', 'medium', 'high')),
  model_preset_id          uuid references model_preset (id) on delete set null,
  archived_at              timestamptz,
  created_by_principal_id  uuid references principal (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- One live playbook per slug per organization; an archived one frees its slug.
create unique index playbook_slug_idx on playbook (organization_id, slug) where archived_at is null;

-- The frozen copy a task was created with; null for a task that chose none.
alter table engineering_task add column playbook jsonb;

-- Read by anyone who files work (a member picks one in the composer); managed by an admin, because
-- a playbook's extra checks are commands the verifier runs for every task that chooses it.
update access_role set permissions = permissions || array['playbooks.read'], updated_at = now()
 where key in ('admin', 'member') and account_id is null and not ('playbooks.read' = any (permissions));
update access_role set permissions = permissions || array['playbooks.manage'], updated_at = now()
 where key = 'admin' and account_id is null and not ('playbooks.manage' = any (permissions));
