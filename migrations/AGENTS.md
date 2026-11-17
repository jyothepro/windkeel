# migrations/ — rules

Use the skill `.claude/skills/add-migration`. The short version:

- Merging to `main` applies these to production. No human step.
- `NNNN_snake_case.sql`, next free number on `main` at merge time. Forward-only; never edit a
  merged file.
- **Unqualified names.** No `public.` / `orqon.` prefixes: production is a shared database and
  `search_path` resolves to the `orqon` schema. (`set_config('orqon.…')` settings are fine.)
- Additive and backward-compatible only; removals take two releases.
- No `create index concurrently` (one transaction per file).
- Header comment: what, issue/ADR, and why it is additive.
- `supabase/` is the exception: not run by the migrator, applied by hand as `postgres` in the
  Supabase SQL editor, and schema-qualified on purpose (see its header). Changing it needs an
  operator.

`npm run arch:check` enforces names and qualifiers. Details: `docs/running-the-factory.md`
§ Migrations, ADR-0008, ADR-0024 §11.
