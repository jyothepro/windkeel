# SOC2-supporting controls

What Windkeel implements for the SOC2 Trust Services Criteria a customer's security review asks
about, and where. This feeds an audit; it is not one. Choosing an auditor and obtaining a report are
out of scope (#393). **Draft for human review.**

Decisions behind it: [ADR-0024](../adr/0024-tenancy-is-account-organization-principal-and-supabase-auth-only-signs-people-in.md)
(tenancy), [ADR-0030](../adr/0030-the-audit-log-is-a-per-account-hash-chain-roles-and-policy-are-the-accounts.md)
(audit log, roles, policy), [ADR-0004](../adr/0004-verification-runs-in-a-fresh-independent-sandbox.md)
and [ADR-0029](../adr/0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md)
(the verifier is the gate).

| Control | What Windkeel does | Code and tables | Evidence an auditor pulls |
| --- | --- | --- | --- |
| **CC6.1** Logical access | Every request authenticates (personal or service token, Supabase session, or the bootstrap token); membership is read per request, never cached in a credential. Permissions are named sets on roles; tokens are narrowed subsets, admin permissions only by name. Another organization's rows are 404. Account policy: IP allowlist, MFA (`aal2`), idle-session timeout, maximum token lifetime and required expiry | `apps/ingress/src/api/router.ts` (`authenticate`, `enforcePolicy`, `accountScope`), `src/factory/tenancy.ts`, `src/factory/security-policy.ts`; `principal`, `membership`, `account_membership`, `access_role`, `api_token`, `account_security_policy`, `session_activity` | `GET /v1/account/security-policy`; `GET /v1/account/access-review`; `policy.updated`, `request.ip_denied`, `session.refused` events |
| **CC6.2** Provisioning | People join only by invitation to a GitHub account id, accepted at sign-in; roles are assigned by someone holding at least the role's permissions; custom roles are subsets of their maker's; tokens are shown once and stored as SHA-256 | `createInvitation`, `acceptInvitations`, `setMemberRole`, `createRole`, `createApiToken` in `src/factory/tenancy.ts`; `invitation`, `membership`, `access_role` | `invitation.created`, `invitation.accepted`, `member.role_changed`, `role.*`, `token.created` events; the access review |
| **CC6.3** Deprovisioning | Removing a member revokes their tokens pinned to that organization; deleting a service principal revokes every token it holds; tokens can be revoked individually; a revoked or expired token is refused like an unknown one. SCIM deprovisioning is #403 | `removeMember`, `deleteServicePrincipal`, `revokeToken`, `findLiveToken` | `member.removed`, `service_principal.deleted`, `token.revoked` events; the access review's live tokens (prefix, last use, expiry) |
| **CC7.2** Monitoring | Every administrative act and run milestone is an `audit_event`, written in the same transaction, hash-chained per account, append-only by trigger, exportable as JSONL/CSV, verifiable, and optionally forwarded to a SIEM (HMAC-signed, at least once). Retention 90 days by default, configurable; deletions are recorded. `windkeel doctor` reports break-glass use, undated tokens and a failing sink | `src/factory/audit-log.ts`, `src/factory/sweeps/audit-retention.ts`, `src/factory/sweeps/audit-sink.ts`, `src/commands/doctor.ts` (`security-controls`); `audit_event`, `audit_sink_cursor` | `windkeel audit export`, `windkeel audit verify`; `GET /v1/account/audit-events/verify`; the doctor report |
| **CC8.1** Change management | Every candidate change — an agent's or a person's — is verified in a fresh sandbox the maker never touched, against criteria fixed before work began; a pull request opens only after a pass; merging from Windkeel re-checks the verdict of record and the verified SHA. No permission, role, policy or variable can switch verification off | `src/factory/workflow/handlers/verifying.ts`, `src/factory/merge-eligibility.ts`, `src/factory/user-merge.ts`; `verification_run`, `run_merge`, evidence packages (ADR-0015) | `run.verified` / `run.verification_failed` (with `verificationRunId`, `candidateSha`) followed by `run.merged` (same `verificationRunId`, `verifiedSha`); evidence packages via `/v1/runs/{id}/evidence` |

## Known gaps, stated

- **SSO enforcement and SCIM** are #403. Until then, sign-in is GitHub OAuth through Supabase, and
  deprovisioning is manual (remove the member; their tokens in that organization are revoked).
- **The bootstrap `WINDKEEL_API_TOKEN`** is break-glass: exempt from the IP allowlist, not narrowed by
  any policy, recorded as `actorKind: "token"`, `actorText: WINDKEEL_API_SUBJECT`. Unset it once people
  have their own tokens; `windkeel doctor` warns while it is set.
- **Evidence packages are unsigned** on the deployed control plane (ADR-0022): tamper-evident, with no
  Sigstore provenance. An auditor citing verdicts is ADR-0022's trigger to revisit.
- **The append-only trigger can be disabled** by someone with database owner rights. The hash chain
  makes that detectable (`verify`), not impossible; forward to a SIEM for an independent copy.
- **Data residency and self-hosting** (#393 8D, 8E) await decisions.
