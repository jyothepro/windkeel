-- Organization model credentials (ADR-0026 §1–3, M9-2 #320).
--
-- An organization brings its own model key. The row says which provider it is for, where that
-- provider lives (`base_url`, for an OpenAI-compatible endpoint), what to call it, and whether it
-- has been seen to work. **It never holds the key.** `sealed_value` is `secret-box.ts`'s v2 output,
-- sealed by ingress to a public key it holds and openable only on the stage deployment, and its
-- additional data binds `model_credential:<organization_id>:<id>` — a ciphertext copied into another
-- organization's row, or another row of this one, fails to open there.
--
-- `keypair_id` names the key pair that sealed the value (it is also inside the value), so a key-pair
-- rotation can find what still needs re-sealing with a query rather than by trying to open each row.
--
-- Revocation is soft: the row stays as the record of what existed and who made it, and the
-- ciphertext is overwritten with '' so nothing — not even the stage deployment — can open it again.
--
-- **No object here is schema-qualified** (ADR-0024 §11).

create table model_credential (
  id                       uuid primary key,
  organization_id          uuid not null references organization (id),
  -- A catalog provider id: openai, anthropic, openrouter, openai-compatible (M9-1 owns the list).
  provider                 text not null,
  -- Null means the provider's own endpoint. Checked by `assertSafeBaseUrl` before it is stored.
  base_url                 text,
  -- For an OpenAI-compatible endpoint serving models the catalog does not know (ADR-0026 §5).
  declared_vendor          text,
  label                    text not null,
  -- The last four characters, so a person can tell two keys apart. Never more than four.
  last4                    text not null check (char_length(last4) <= 4),
  sealed_value             text not null,
  keypair_id               text not null,
  status                   text not null default 'unverified'
                           check (status in ('unverified', 'valid', 'invalid', 'revoked')),
  -- Why the status is what it is, in words built from a status code — never a response body.
  status_reason            text,
  validated_at             timestamptz,
  created_by_principal_id  uuid references principal (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  revoked_at               timestamptz,
  -- Revoked and revoked_at agree, so neither can be set without the other.
  check ((status = 'revoked') = (revoked_at is not null))
);

-- One live credential per label per organization. A revoked label may be reused.
create unique index model_credential_label_idx
  on model_credential (organization_id, label) where revoked_at is null;

-- Two permissions. `models.manage` stores, rotates and revokes credentials — an org admin's, since a
-- model key spends the organization's money. `models.read` lists them (label, provider, last four,
-- status), which a member needs in order to pick one; a viewer does not. Idempotent, and existing
-- role rows keep every permission they had.
update access_role set permissions = permissions || array['models.read'], updated_at = now()
 where key in ('admin', 'member') and account_id is null and not ('models.read' = any (permissions));
update access_role set permissions = permissions || array['models.manage'], updated_at = now()
 where key = 'admin' and account_id is null and not ('models.manage' = any (permissions));
