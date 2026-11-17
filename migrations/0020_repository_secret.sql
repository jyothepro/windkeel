-- Repository-scoped secrets (ADR-0023 §9, ADR-0014 §5).
--
-- The capability this unblocks, stated plainly: a repository whose dependencies come from a private
-- registry could not be built at all. `installDependencies` runs `npm ci` / `pip install` /
-- `go mod download` in the install phase, and there was no way to give any of them a credential —
-- so the install failed, the verifier ran the repository's declared checks against a tree with no
-- packages, and the verdict was about the factory rather than about the candidate. ADR-0023 §9
-- calls that "a missing capability that silently bounds which repositories Orqon can build".
--
-- **The value column holds a sealed box, not a secret.** `src/factory/secret-box.ts` seals to an
-- X25519 public key that ingress holds; the private half lives only in the worker container. So the
-- guarantee in ADR-0023 §9 — "there is no field for the value" — is not a property of a response
-- shape that someone could change, and not a property of column permissions: this table is
-- unreadable to the process that writes it, and a dump of it is unreadable without a key that was
-- never in the database.
--
-- Scoped to a repository rather than to a task or a run, because that is the thing the credential
-- belongs to: a private registry token is a fact about where a repository gets its packages, and it
-- has to be present for the *verifier's* sandbox too — a fresh one per run (ADR-0004) that has
-- never seen the maker's environment.
create table repository_secret (
  id              uuid primary key default gen_random_uuid(),
  repository_id   uuid not null references repository (id) on delete cascade,
  -- The environment variable name the value is injected as. Constrained in
  -- `src/factory/repository-secrets.ts`, which also refuses the names that would shadow a
  -- brokered credential — a `key` reaching this table has already been through that.
  key             text not null,
  -- The output of `sealSecret`. Never a plaintext value, at any point in this column's life.
  sealed_value    text not null,
  -- Free text from the operator: what it is for, where it came from, when it expires. It is read
  -- back by everyone who can list secrets, so it must never be used to hold part of a value.
  note            text,
  -- The token subject that last wrote it. Not a foreign key, for the same reason `run_guidance`'s
  -- `actor` is not: users do not exist until the Product UI milestone (ADR-0001).
  set_by          text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One value per name per repository. `put` is an upsert on this constraint, so setting a secret
-- twice replaces it rather than leaving two rows and an injection order that depends on `id`.
create unique index repository_secret_key_idx on repository_secret (repository_id, key);
