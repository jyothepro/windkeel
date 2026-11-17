# ADR-0001: v1 is single-tenant; organizations and users land with the Product UI, not at Milestone 1

- Status: Superseded by ADR-0038
- Date: 2026-08-14

## Context

The route to Milestone 6 ends at: GitHub issue → implementation → verification → repair → verified draft PR (`research/direction-change/PLAN.md` §23, §25).

## Decision

**v1 through Milestone 6 is single-tenant.** One Windkeel deployment serves one operator running Windkeel against their own repositories. There is no signup, no auth, no RBAC, no billing.

- §1 — The M1 schema has no `organizations` or `users` tables: The §18 table list is amended: those two rows move to the Product UI milestone.
- §2 — `repository_id` is the top-level scope: `EngineeringTask` loses its `organization_id` field until multi-tenancy exists; every durable row is reachable from a repository.
- §3 — Multi-tenancy arrives with the Product UI milestone at the earliest: when users and organizations first get a surface to exist on.
- §4 — Tenancy-readiness constraints on M1–M6 code: — the cheap-now, expensive-later set, and nothing more:

## Consequences

- M1 shrinks to the factory entities themselves (§6 minus `organization_id`); no auth or identity work blocks the route to M6.
- The Product UI milestone's migration cost is bounded and known in advance: additive tables, one added column, one backfill.
- Single-tenant remains a supported deployment shape permanently — the enterprise/self-hosted milestone ships what v1 already is, hardened, rather than unwinding SaaS assumptions.
- Anything in M1–M6 that violates the readiness constraints above is a bug against this ADR, not a style preference.

**Later changes** (full text in Background):

- Amendment, 2026-09-23 — this ADR names milestones instead of numbering them
- Amendment, 2026-09-24 — §3's price was for the wrong shape
- Superseded, 2026-10-21 — self-serve signup, invite-only, behind a flag

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Superseded by ADR-0038
- Date: 2026-08-14
- Resolves: [#54 — Decide v1 tenancy and product shape](https://github.com/jyothepro/orqon/issues/54) (wayfinder map [#50](https://github.com/jyothepro/orqon/issues/50))

### Context

The route to Milestone 6 ends at: GitHub issue → implementation → verification → repair → verified draft PR (`research/direction-change/PLAN.md` §23, §25). Between here and there, nothing on the milestone list gives an organization or a user a product surface: the Product UI, BYOK/model routing, team/RBAC/billing ("later" UI, §17) and enterprise/self-hosted are all later milestones — all explicitly out of scope for the current map.

Yet §18 lists `organizations` and `users` among the Postgres tables, and §6 gives `EngineeringTask` an `organization_id`, without saying when they land. Left undecided, this shapes three things at M1: the persistence schema, the GitHub App (#62), and hosting (#55).

### Decision

**v1 through Milestone 6 is single-tenant.** One Windkeel deployment serves one operator running Windkeel against their own repositories. There is no signup, no auth, no RBAC, no billing.

Concretely:

1. **The M1 schema has no `organizations` or `users` tables.** The §18 table list is amended: those two rows move to the Product UI milestone. Everything else in §18 stands.
2. **`repository_id` is the top-level scope.** `EngineeringTask` loses its `organization_id` field until multi-tenancy exists; every durable row is reachable from a repository. The `repositories` table stays in M1 — tasks need it.
3. **Multi-tenancy arrives with the Product UI milestone at the earliest**, when users and organizations first get a surface to exist on. It lands as additive migrations: create `organizations`/`users`, add `organization_id` to `repositories`, backfill a default organization owning every existing row. Nothing is rebuilt.
4. **Tenancy-readiness constraints on M1–M6 code** — the cheap-now, expensive-later set, and nothing more:
   - primary keys are globally unique (UUIDs), never per-scope serials;
   - all reads/writes go through a repository-scoped service layer — no query pattern that assumes "the whole database is mine";
   - configuration and credentials are keyed by repository or installation, never stored as a schema-level singleton.

Implications this ADR notes but does not decide (they have their own tickets): single-tenant means the GitHub App (#62) needs only a single-account installation for M6, and the control plane (#55) serves one operator — neither needs public multi-install or a hosted signup path before the Product UI milestone.

### Consequences

- M1 shrinks to the factory entities themselves (§6 minus `organization_id`); no auth or identity work blocks the route to M6.
- The Product UI milestone's migration cost is bounded and known in advance: additive tables, one added column, one backfill.
- Single-tenant remains a supported deployment shape permanently — the enterprise/self-hosted milestone ships what v1 already is, hardened, rather than unwinding SaaS assumptions.
- Anything in M1–M6 that violates the readiness constraints above is a bug against this ADR, not a style preference.

### Amendment, 2026-09-23 — this ADR names milestones instead of numbering them

The roadmap's M7–M15 were reordered (`research/MILESTONES.md`, *The 2026-09-23 reordering*). No
decision here changes: the deliverables moved position, not content. Every milestone *number* in
this record was replaced with the milestone's *name*, because a number written into a decision
record becomes wrong the first time the roadmap resequences, and a wrong number is worse than no
number. The mapping table in `MILESTONES.md` decodes the old numbers still visible in git history.

Product UI is now **M7**; enterprise/self-hosted is now **M14**.

### Amendment, 2026-09-24 — §3's price was for the wrong shape

§3 priced multi-tenancy as "create `organizations`/`users`, add `organization_id` to
`repositories`, backfill a default organization". That shape makes an organization a GitHub account,
and it has no place for automations, roles, or anything that belongs to a customer rather than a
team. [ADR-0024](../0024-tenancy-is-account-organization-principal-and-supabase-auth-only-signs-people-in.md)
replaces §3 with account → organization → principal, repositories granted to organizations, and an
organization on the task. It is still additive, and it is still one backfill. §4's readiness
constraints stand unchanged, and ADR-0024 §8 is where they become checkable.

### Superseded, 2026-10-21 — self-serve signup, invite-only, behind a flag

[ADR-0038](../0038-invite-only-self-serve-signup-makes-windkeel-multi-tenant.md) supersedes this record's
product shape: with `WINDKEEL_SELF_SERVE_SIGNUP=invite`, a person with an operator's invite code can
create their own account and organization and be billed for usage
([ADR-0037](../0037-usage-billing-and-organization-budgets.md)) (#394). Unset, the deployment is still
exactly the single-tenant shape decided here, which stays a permanently supported deployment shape
as the Consequences above promise. §4's tenancy-readiness constraints stand.
