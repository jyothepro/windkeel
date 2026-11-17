# ADR-0008: Supabase hosts Postgres and object storage; migrations are plain SQL files

- Status: Accepted
- Date: 2026-08-17

## Context

Plan §18 leaves three concretes open: which Postgres (Supabase / Neon / Vercel Postgres / self-managed), which object store for evidence packages, and the migration tooling for the Milestone 1 schema.

## Decision

**Supabase provides both stores: hosted Postgres for the factory schema and Supabase Storage for evidence packages. The Milestone 1 schema is managed as numbered plain-SQL migration files.**

- §1 — Postgres: one Supabase project.
- §2 — Object storage: evidence packages, logs, screenshots, traces, and other §18 artifacts go to Supabase Storage **via its S3-compatible API**.
- §3 — Migrations.
- §4 — Credentials: the worker container holds the direct connection string and the Storage S3 keys; Vercel ingress holds only the pooled connection string (ADR-0002's secret-surface split).

## Consequences

- One vendor, one credential set, and a free tier that comfortably covers single-tenant v1; plan §18's "PostgreSQL / Supabase" header becomes literal.
- The S3-protocol seam means the object store carries no Supabase lock-in; the Postgres itself is standard and exportable (`pg_dump`), so the exit cost from Supabase is operational, not architectural.
- Supabase-specific surfaces (Auth, RLS, Realtime, Edge Functions) are explicitly **not** adopted in v1 — access control is repository-scoped in application code per ADR-0001, and adopting them later is a separate decision.
- Migration discipline is ours: forward-only SQL with no down-migrations means recovering from a bad migration is a new migration — acceptable for a single-operator database, revisit before the Product UI milestone's multi-tenancy.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-08-17
- Resolves: [#61 — Decide persistence concretes: Postgres flavor and object storage](https://github.com/jyothepro/orqon/issues/61) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

### Context

Plan §18 leaves three concretes open: which Postgres (Supabase / Neon / Vercel Postgres / self-managed), which object store for evidence packages, and the migration tooling for the Milestone 1 schema. The decisions already made shape the answer:

- ADR-0002: two components need the database — the Vercel ingress functions (short-lived, connection-pooled writes of tasks/signals) and the long-lived worker container (the heavy consumer).
- ADR-0007: pg-boss runs in the worker container and needs a real, direct Postgres connection (Postgres 13+); the `EngineeringRun` rows in the same database are the authoritative run state.
- ADR-0003 / ADR-0001 constrain the schema itself: five entities plus the engine types, UUID keys, `repository_id` as top-level scope, no `organizations`/`users` tables, no config singletons. `VerificationRun.evidence_package_ref` is an object-storage pointer — Postgres never stores the package.
- Vercel Postgres is the awkward fit for the hybrid topology: its pricing and connection model favor Vercel-side consumers, while our primary consumer is an external container. Self-managed Postgres puts backups/upgrades on the operator from day one for no v1 gain. Neon + R2 is a strong pure-Postgres alternative but means two vendors and two credential sets where one suffices at ADR-0001's scale.

### Decision

**Supabase provides both stores: hosted Postgres for the factory schema and Supabase Storage for evidence packages. The Milestone 1 schema is managed as numbered plain-SQL migration files.**

Concretely:

1. **Postgres**: one Supabase project. The worker container connects **direct** (session mode) — pg-boss and the state-machine reducer need real connections. Vercel ingress connects through the **Supavisor transaction pooler**, the shape serverless functions require. Same database, one authoritative store (ADR-0007).
2. **Object storage**: evidence packages, logs, screenshots, traces, and other §18 artifacts go to Supabase Storage **via its S3-compatible API**. Factory code writes against the S3 protocol, not the Supabase SDK, so the store is swappable (S3, R2) by changing endpoint + credentials — relevant when the Cloudflare provider milestone arrives. `evidence_package_ref` records bucket + key.
3. **Migrations**: numbered, forward-only SQL files in a `migrations/` directory, applied by a small `node-pg` runner that records applied filenames in a `schema_migrations` table — no ORM, no migration framework dependency, matching the repo's minimal-dependency style and keeping the schema readable as SQL. The Milestone 1 schema is the first migration, transcribed from ADR-0003's entities (pg-boss creates and versions its own tables in its own schema; ours never depend on them).
4. **Credentials**: the worker container holds the direct connection string and the Storage S3 keys; Vercel ingress holds only the pooled connection string (ADR-0002's secret-surface split).

### Consequences

- One vendor, one credential set, and a free tier that comfortably covers single-tenant v1; plan §18's "PostgreSQL / Supabase" header becomes literal.
- The S3-protocol seam means the object store carries no Supabase lock-in; the Postgres itself is standard and exportable (`pg_dump`), so the exit cost from Supabase is operational, not architectural.
- Supabase-specific surfaces (Auth, RLS, Realtime, Edge Functions) are explicitly **not** adopted in v1 — access control is repository-scoped in application code per ADR-0001, and adopting them later is a separate decision.
- Migration discipline is ours: forward-only SQL with no down-migrations means recovering from a bad migration is a new migration — acceptable for a single-operator database, revisit before the Product UI milestone's multi-tenancy.
- Local development and CI run the same migrations against dockerized Postgres; nothing in the schema or the runner may depend on Supabase extensions beyond what stock Postgres ships.
