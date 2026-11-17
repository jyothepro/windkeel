# ADR-0030: The audit log is a per-account hash chain, written with the change; custom roles and the security policy are the account's

- Status: Accepted
- Date: 2026-10-21

## Context

Security reviews at larger customers ask for an audit log they can export, roles of their own, and controls that map to SOC2.

## Decision

- §1 — One `audit_event` row per act, in the same transaction as the act: (`src/factory/audit-log.ts`, `migrations/0039_audit_event.sql`).
- §2 — Rows are a hash chain per account: `hash = sha256(prev_hash || canonical_json(row without hash))`, computed in TypeScript under `pg_advisory_xact_lock` per account, so `seq` is gap-free in commit order and `occurred_at` never goes backwards.
- §3 — Append-only by trigger; deletion only as a recorded prefix: A trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`.
- §4 — Retention: 90 days by default: (`WINDKEEL_AUDIT_RETENTION_DAYS`), per account 30–3650 days (`account_security_policy.audit_retention_days`).
- §5 — The verifier's verdict is in the log: `run.verified` / `run.verification_failed` are written with the verdict, naming the verification run and candidate SHA.
- §6 — Custom roles are account rows: (`migrations/0040_account_roles.sql`).
- §7 — Account routes need an account role: `/v1/account/…` is decided against the `account_membership` role, narrowed by any token, and refuses a token pinned to one organization.
- §8 — A per-account security policy: (`migrations/0041_account_security_policy.sql`): maximum token lifetime (clamped) and required expiry (refused), MFA (`aal2`), an idle-session timeout keyed by the JWT's `session_id` (a session without one is refused while the timeout is on), and an IP allowlist.
- §9 — Nothing here can weaken verification: No permission, role, policy field or environment variable disables, skips or bypasses the verifier; a test refuses any permission matching `verif|bypass|skip`.

Tamper detection (`verifyAuditChain`) is asserted by `npm run invariant:check` (`scripts/invariant-check.mjs`, check `adr-0030-audit-chain-test`).

## Consequences

- An auditor gets one export (JSONL or CSV, ≤ ~4 MB per response, continued by cursor) and one verify call, and `docs/security/soc2-controls.md` maps each control to the code behind it.
- Every audited write takes a per-account lock for the length of its transaction.
- Deleting audit data is possible by design (the maintainer's call) and always leaves a record of the deletion.
- The sink (`WINDKEEL_AUDIT_WEBHOOK_URL`) is at least once; receivers dedupe on the event id.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-10-21
- Issue: [#393 — Enterprise readiness](https://github.com/jyothepro/orqon/issues/393) (8A, 8B, 8F)
- Amends: [ADR-0024](0024-tenancy-is-account-organization-principal-and-supabase-auth-only-signs-people-in.md)
  §4 (custom roles built), §7 (the first `/v1/account/…` routes)
- Relates to: [ADR-0013](0013-v1-observability-cost-ledger-transition-log-sql-views.md),
  [ADR-0015](0015-evidence-retention-outcome-tiered-with-tombstones.md),
  [ADR-0022](0022-evidence-package-signing-stays-best-effort-and-says-so.md),
  [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md)

### Context

Security reviews at larger customers ask for an audit log they can export, roles of their own,
and controls that map to SOC2. ADR-0013's `run_state_transition` is half an audit trail for runs
and none for administration: who minted a token, who changed a role, who set a secret. And the
review's real question about Windkeel is the one its verifier answers: did every merged change go
through verification? The log has to let an auditor prove that, not just assert it.

The ingress connects as a privileged role, so `revoke update, delete` cannot make a table
append-only against it. ADR-0024 left `access_role.account_id` for custom roles and named the
`/v1/account/…` routes without building them. The maintainer decided on #393: audit retention is
**90 days**, configurable, and **customers may delete** their audit data.

### Decision

1. **One `audit_event` row per act, in the same transaction as the act** (`src/factory/audit-log.ts`,
   `migrations/0039_audit_event.sql`). The actor (principal id plus text, ADR-0024 §9) and its kind
   (`user`, `token`, `github`, `system`), the action from a fixed list (`AUDIT_ACTIONS`), the target,
   the client address (only from the trusted proxy header), user agent, request id, and a `detail`
   that never holds a token, secret or key value. A write that rolls back leaves no event; an event
   is never written for a change that did not happen. Run commands carried out by a port (approve,
   cancel) and the one store that opens its own transaction (schedule update) are recorded right
   after their commit.

2. **Rows are a hash chain per account.** `hash = sha256(prev_hash || canonical_json(row without
   hash))`, computed in TypeScript under `pg_advisory_xact_lock` per account, so `seq` is gap-free
   in commit order and `occurred_at` never goes backwards. Paging is on `seq`: stable under
   concurrent writes. `verifyAuditChain` names the first `hash_mismatch` (edited), `chain_broken`
   (removed or moved), `sequence_gap`, or `unanchored_start` (a prefix removed without a record).

3. **Append-only by trigger; deletion only as a recorded prefix.** A trigger refuses `UPDATE`,
   `DELETE` and `TRUNCATE`. `audit_event_purge(account, before)` is the one path it allows, and it
   deletes only rows older than a time — a prefix of the chain. Retention (hourly sweep, beside
   ADR-0015's) and a customer's own `DELETE /v1/account/audit-events` both go through it, and both
   write an event naming the hash the surviving chain now starts from. That event is appended before
   the prefix is deleted, so `seq` keeps counting even when nothing older survives. The trigger stops accidents;
   the chain is what makes deliberate tampering by someone with SQL visible.

4. **Retention: 90 days by default** (`WINDKEEL_AUDIT_RETENTION_DAYS`), per account 30–3650 days
   (`account_security_policy.audit_retention_days`). Customers may delete their data before then.

5. **The verifier's verdict is in the log.** `run.verified` / `run.verification_failed` are written
   with the verdict, naming the verification run and candidate SHA. `run.merged` — from Windkeel, as the
   person, or observed on GitHub — names the same, so "every merged PR went through verification"
   is a join an auditor can run.

6. **Custom roles are account rows** (`migrations/0040_account_roles.sql`). Built-ins stay
   immutable and global. A role's permissions are a subset of its maker's (ADR-0024 §6's rule for
   tokens); a role still held or offered cannot be deleted (kept with `deleted_at`, because accepted
   invitations name it); another account's role is a 404. Assigning a role is refused when it holds
   more than the assigner. `runs.merge` can now be granted beyond Admin; the merge route still
   refuses every token.

7. **Account routes need an account role.** `/v1/account/…` is decided against the
   `account_membership` role, narrowed by any token, and refuses a token pinned to one organization.
   Three permissions, all admin-only and named-only for tokens: `audit.read`, `roles.manage`,
   `account.manage`.

8. **A per-account security policy** (`migrations/0041_account_security_policy.sql`): maximum token
   lifetime (clamped) and required expiry (refused), MFA (`aal2`), an idle-session timeout keyed by
   the JWT's `session_id` (a session without one is refused while the timeout is on), and an IP allowlist. The bootstrap `WINDKEEL_API_TOKEN` is exempt from the
   allowlist — it is break-glass — and `windkeel doctor` warns while it is set.

9. **Nothing here can weaken verification.** No permission, role, policy field or environment
   variable disables, skips or bypasses the verifier; a test refuses any permission matching
   `verif|bypass|skip`.

### Consequences

- An auditor gets one export (JSONL or CSV, ≤ ~4 MB per response, continued by cursor) and one
  verify call, and `docs/security/soc2-controls.md` maps each control to the code behind it.
- Every audited write takes a per-account lock for the length of its transaction. Volume is admin
  acts and run milestones, so throughput is not the constraint; a hot account would be the sign to
  revisit.
- Deleting audit data is possible by design (the maintainer's call) and always leaves a record of
  the deletion. A buyer who needs a year sets `auditRetentionDays: 365`.
- The sink (`WINDKEEL_AUDIT_WEBHOOK_URL`) is at least once; receivers dedupe on the event id.
- A refused sign-in by someone in no account is recorded on the default account — the single-tenant
  shape ADR-0001 keeps.
- Unsigned evidence (ADR-0022) is now reported by count in `windkeel doctor`'s security check, as
  information, not a failure: an auditor citing verdicts is ADR-0022's own trigger to revisit.
- SSO enforcement and SCIM (#403), data residency and self-hosting (#393 8D, 8E) are not decided here.
