# ADR-0038: Invite-only self-serve signup makes Windkeel multi-tenant, behind a flag

- Status: Accepted; amended by ADR-0040
- Date: 2026-10-21
- Supersedes: [ADR-0001](archive/0001-v1-single-tenant-product-shape.md) — the single-tenant product shape

## Context

ADR-0001 made v1 one operator running Windkeel on their own repositories: "no signup, no auth, no RBAC, no billing".

## Decision

- §1 — Off by default; the single-tenant shape is unchanged.
- §2 — Invite-only signup.
- §3 — Installing the GitHub App links it to the organization.
- §4 — The first task is an ordinary task.

## Consequences

- Windkeel can be run as a multi-tenant service, one operator inviting customers, without a code path that assumes otherwise: tenancy was already enforced (ADR-0024 §8).
- The operator's own account is still the default account, holds the bootstrap principal, and is never billed (ADR-0037 §3).
- The App must be configured to request user authorization during installation, and the API needs `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` to verify installations; without them linking answers 503 and nothing is linked.
- An open signup mode, email invitations, SSO and per-account roles are later decisions.

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-10-21
- Supersedes: [ADR-0001](archive/0001-v1-single-tenant-product-shape.md) — the single-tenant product shape
  (its §4 readiness constraints stand, and single-tenant stays the default)
- Builds on: [ADR-0024](0024-tenancy-is-account-organization-principal-and-supabase-auth-only-signs-people-in.md)
  (account → organization → principal, repository grants, Supabase Auth only signs people in),
  [ADR-0037](0037-usage-billing-and-organization-budgets.md) (billing and budgets)
- Resolves: [#394](https://github.com/jyothepro/orqon/issues/394) (maintainer decision 2026-10-21:
  "self-serve multi-tenant is approved, invite-only first, behind a flag")
- Migration: `migrations/0049_billing.sql` (`signup_invite`, `github_install_state`)

### Context

ADR-0001 made v1 one operator running Windkeel on their own repositories: "no signup, no auth, no RBAC,
no billing". ADR-0024 added accounts, organizations, principals and invitations, but a person could
only ever be *invited into* an existing organization; nobody could create one. ADR-0037 adds billing
and budgets. What remains for self-serve is the door: a person signs in, gets their own account and
organization, installs the GitHub App on their repositories, and runs a first task.

That changes the product's shape, which is ADR-0001's subject, so it is recorded here and ADR-0001 is
superseded. The maintainer approved it invite-only first, behind a flag.

### Decision

#### 1. Off by default; the single-tenant shape is unchanged

`WINDKEEL_SELF_SERVE_SIGNUP` unset (or `0`) is today's deployment: no signup route, the GitHub App's
first-seen installations belong to the default account (ADR-0024 §2), and a signed-in person with no
invitation is `not_a_member`. Single-tenant remains a permanently supported shape, as ADR-0001
promised.

#### 2. Invite-only signup

`WINDKEEL_SELF_SERVE_SIGNUP=invite` (or `1`) turns on `POST /v1/signup`, reachable by a **verified
session whose person has no principal yet** — the one caller `authenticate` would otherwise refuse.
It takes an invite code minted by the operator (`windkeel-admin signup-invite`; only the SHA-256 is
stored; single use; 14 days by default) and creates, in one transaction: the account, its first
organization, the principal and its identity, the person as Admin of both, a `billing_account` on
the deployment's provider with the plan chosen (`byok` or `managed`), and a first monthly budget of
`WINDKEEL_TRIAL_CREDIT_USD` (default 20). Refusals — unknown, used or expired code (one answer for all
three), a person already in an organization, a GitHub user who already has an account — leave
nothing behind. An open (code-less) mode is deliberately not offered yet.

Abuse limits by construction: one invite per account, one account per GitHub user id
(`principal.github_user_id` is unique), and a small first budget enforced by ADR-0037 §5.

#### 3. Installing the GitHub App links it to the organization

- `POST /v1/github-installations/state` (holder of `repositories.manage`) mints a single-use state —
  32 random bytes, stored only as a hash, bound to the organization and the person, 30 minutes — and
  answers the App's install URL (`WINDKEEL_GITHUB_APP_SLUG`).
- GitHub returns the person to the console's callback with `installation_id`, `state` and, because
  the App is set to *request user authorization during installation*, an OAuth `code`.
  `POST /v1/github-installations` spends the state (once, whatever happens next), then proves the
  person **owns** that installation by trading the code for a user token: the id must be in
  `GET /user/installations`, and its account must be the person (a User account with their id) or an
  Organization they are an active admin of (`GET /user/memberships/orgs/{org}`). Reach alone is not
  enough — GitHub lists an installation to every collaborator on any of its repositories, and linking
  claims the whole installation — so anyone else is refused (`403 installation_not_owned`). A state is
  not proof of an installation; anyone can type a callback URL.
- The installation's `scm_connection` becomes the new account's. One another account already owns —
  including the default account's — is refused (409). Every repository of the installation that
  nobody holds is granted to the organization, intake on.
- **With signup on, a first-seen installation is no longer the default account's.** It waits to be
  linked; `upsertRepository` grants its repositories to whichever organization's account linked it,
  and to nobody until then. Installations the default account already owns are unaffected.

#### 4. The first task is an ordinary task

The welcome wizard's first task goes through `POST /v1/tasks` — the same intake, criteria extraction,
rails, budget and independent verifier as every other task (ADR-0004, ADR-0012, ADR-0029). There is
no onboarding path, no trial shortcut and no "demo" verdict.

### Consequences

- Windkeel can be run as a multi-tenant service, one operator inviting customers, without a code path
  that assumes otherwise: tenancy was already enforced (ADR-0024 §8).
- The operator's own account is still the default account, holds the bootstrap principal, and is
  never billed (ADR-0037 §3).
- The App must be configured to request user authorization during installation, and the API needs
  `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` to verify installations; without them linking
  answers 503 and nothing is linked.
- An open signup mode, email invitations, SSO and per-account roles are later decisions.
