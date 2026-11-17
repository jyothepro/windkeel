---
name: add-migration
description: Add a SQL migration to Windkeel's migrations/ folder. Use when a change needs a new table, column, index, view, function or constraint, or when the user says "migration" or "schema change".
---

# Add a migration

Merging to `main` applies migrations to production automatically
(`.github/workflows/migrate.yml`). There is no human step to catch a mistake, so follow every rule.

## Steps

1. **Pick the number.** `git fetch origin main && git ls-tree -r --name-only origin/main -- migrations/ | rg '^migrations/[0-9]{4}_[a-z0-9_]+\.sql$' | sort | tail -1`.
   Use the next number. Re-check right before merging; parallel PRs have collided.
2. **Name it** `migrations/NNNN_snake_case_subject.sql` (e.g. `0051_playbook_version.sql`).
3. **Header comment**: what it adds, the issue and ADR, and the word `Additive.` plus why older
   code keeps working. Copy the style of `migrations/0050_credits.sql`.
4. **Write the SQL** with these rules:
   - Unqualified names only. Never `public.x` or `orqon.x`: the role's `search_path` resolves to
     the `orqon` schema in a database shared with other products (ADR-0024 §11).
   - Singular snake_case table names. No generic names (`user`, `role`).
   - Additive and backward-compatible: create tables/views/indexes/functions, add nullable or
     defaulted columns, widen constraints. No drop, rename, type change or new `not null` without
     default in the same release as the code change. Removals take two releases.
   - No `create index concurrently`: each file runs in one transaction.
   - Never edit a merged migration. Fix forward with a new file.
5. Nothing to register: `src/factory/schema-guard.ts` compares the bundled filenames with
   `schema_migrations`, so code shipped with the file refuses (`503 schema_behind`) until it lands.
6. **Test locally**:
   ```sh
   docker compose up -d
   npm run db:migrate -- --dry-run   # lists pending
   npm run db:migrate
   TEST_DATABASE_URL=postgresql://windkeel:windkeel@localhost:5432/windkeel npm test
   ```
7. `npm run arch:check` enforces the naming and no-qualifier rules.

Background: `docs/running-the-factory.md` § Migrations, ADR-0008.
