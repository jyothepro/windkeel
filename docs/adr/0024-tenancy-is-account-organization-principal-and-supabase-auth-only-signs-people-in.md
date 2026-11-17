# ADR-0024: Tenancy is account → organization → principal, repositories are granted, and Supabase Auth only signs people in

- Status: Accepted; amended by ADR-0029 (proposed), ADR-0030
- Date: 2026-09-24

## Context

ADR-0001 §3 priced multi-tenancy in advance: "create `organizations`/`users`, add `organization_id` to `repositories`, backfill a default organization owning every existing row." ADR-0023 §11 repeated the price.

## Decision

- §1 — The hierarchy is account → organization → principal.
- §2 — Repositories belong to the account; organizations are granted them.
- §3 — A task carries its organization; everything else inherits it.
- §4 — Roles are sets of permissions.
- §5 — Supabase Auth signs people in, and does nothing else.
- §6 — There is one kind of API token, and it is scoped.
- §7 — The organization is in the path.
- §8 — Scoping lives in the store layer, and a row in another organization does not exist.
- §9 — Actors are principals, and a GitHub commenter is still an actor.
- §10 — One migration adds it, and one backfill makes today's data fit.
- §11 — Every new table lives in the `orqon` schema, because the database is shared.
- §12 — Sign-in has three doors, and each one ends in a principal.

## Consequences

- **This is not ADR-0001's "one column".** It is twelve tables, a column on tasks instead of on repositories, a column on secrets, and nullable actor columns.
- **Most of the churn is signatures, not schema.** Every store read gains a scope, and every read handler gains the principal it did not previously receive.
- **The console gets sign-in** through Supabase Auth's GitHub provider, and its shared server-side token becomes a session.
- **The operator commands of ADR-0023 §10 become API clients with a real identity.** When `reap`, `metrics`, `task` and `doctor` move onto the API, they authenticate with an organization token scoped to what each needs, rather than holding the database's credentials.

**Later changes** (full text in Background):

- As built, 2026-09-24
- As built, 2026-09-25: service principals (M8-2)
- Amendment, 2026-10-16 — §5: the GitHub account comes from `auth.identities`, never `user_metadata`
- As built, 2026-10-21: custom roles and the first account routes (#393)

## Background

The original record, verbatim except for heading levels. Section numbers (§n) cited from code resolve here.

- Status: Accepted
- Date: 2026-09-24
- Milestone: 7 (Product UI, REST API and CLI)
- Amends: [ADR-0001](archive/0001-v1-single-tenant-product-shape.md) §3,
  [ADR-0023](0023-control-plane-api-reads-direct-writes-intents-updates-resume-from-a-cursor.md) §11
- Decides what [ADR-0008](0008-supabase-postgres-and-storage-sql-file-migrations.md) deferred:
  "adopting [Supabase Auth] later is a separate decision"

> Amended by [ADR-0029](0029-windkeel-is-an-integrated-coding-assistant-and-the-verifier-stays-the-gate.md) (Proposed): two permissions, `runs.takeover` (Admin and Member) and `runs.merge` (Admin, grantable to Member), and a `human_session` actor record in §9's pattern.

### Context

ADR-0001 §3 priced multi-tenancy in advance: "create `organizations`/`users`, add
`organization_id` to `repositories`, backfill a default organization owning every existing row."
ADR-0023 §11 repeated the price. Both were written before anyone asked what an organization *is*,
and the cheap version answers that question wrongly in four ways that each cost a migration later —
which is exactly the cost ADR-0001 was written to avoid.

**1. `repository.organization_id` makes an organization a GitHub account.** One column means one
owner, and the owner can only come from the installation. A company with three GitHub orgs cannot be
one Windkeel organization. A company that wants a platform team and a product team on one GitHub org
cannot be two. Devin, the nearest comparable, connects the SCM once at the top of the hierarchy and
then *grants* repositories to organizations; an organization cannot touch a repository until it is
granted.

**2. A user token cannot run an automation.** M8 is automations and integrations. Every one of them
authenticates as something, and if that something is a person, it stops working when the person
leaves. Devin solves this with two mechanisms: personal access tokens, which carry exactly their
user's permissions, and *service users*, non-human accounts with their own role in one organization.
We need the same outcome with one mechanism (§6).

**3. Two hard-coded roles become a fork per permission.** `admin | member` as an enum means the
first request for "can view but not approve" is a schema change and a code path. A role that is a
set of named permissions absorbs it as data. Devin has one role per user per organization, plus one
account-wide role that carries into every organization.

**4. There is nowhere to hang SSO, billing or audit.** Those belong to the customer, not to a team
inside it, and a customer with two teams has two organizations. Without a level above the
organization each of them is either duplicated or homeless.

Today's code, read for this ADR (`origin/main` at `742735e`):

- **Auth** is one bearer token. `ApiAuth` is `{ token, subject }`
  (`apps/ingress/src/api/router.ts`), `subject` is the string `"operator"`, and `GET /v1/self`
  returns `{ subject, scopes }`.
- **Actors are free text** everywhere they are recorded: `repository_secret.set_by`,
  `run_guidance.actor`, the approval signal's `payload.actor`, `engineering_task.criteria_*_by`.
  `run_cancellation.requested_by` exists and is **never written** — `vercel.ts` inserts only the
  run and a reason, so the actor survives only inside the reason string.
- **Reads are whole-database.** `listQueue`, `listRepositoriesPage` and `collectMetrics` take no
  scope at all; `listTasksPage` and `listRunsPage` take an optional repository and return everything
  without one. `getEngineeringRun`, `getEngineeringTask` and `getRepository` look up by id with no
  ownership check, and every run, task and secret route goes through one of them. ADR-0001 §4 said
  all reads go through a scoped layer; with one tenant, nothing could notice that they did not.
- **GitHub commenters are authorised by GitHub**, via `author_association`
  (`isAuthorizedCommenter`), and are not Windkeel users.

### Decision

#### 1. The hierarchy is account → organization → principal

- An **account** is the customer. It owns SCM connections, and later SSO, billing and audit.
- An **organization** belongs to one account and is the unit that owns work: tasks, runs,
  secrets, guidance, and the metrics over them.
- A **principal** is anything that acts, and belongs to one account. It is either a **user** (a
  person, who holds memberships) or an **organization token** (an automation, §6). Nobody creates a
  token principal directly: it is created with its token and deleted with it. It exists so that
  every actor column can name what acted in the same way.

A deployment with one customer has one account and one organization, permanently. That is what
ADR-0001 promised self-hosted would stay, and nothing here removes it.

#### 2. Repositories belong to the account; organizations are granted them

- `scm_connection` holds the GitHub installation and belongs to an account.
- `repository` belongs to an account (`account_id not null`) and optionally to a connection. The
  local path has no connection, as ADR-0018 already allows.
- **`unique (owner, name)` stays global.** One GitHub App installs on a given repository at most
  once, so a repository has one true owner. Making the key per-organization would let two
  organizations each claim the same repository.
- `repository_grant (organization_id, repository_id)` is what lets an organization work on a
  repository. **No grant, no access** — every read and command against a repository checks for one.
- **At most one grant per repository is the intake grant**, enforced by a partial unique index. A
  GitHub `issues.labeled` event creates its task in that organization. A repository with no intake
  grant does not start work from a label. The refusal is recorded on the delivery row, where
  `applyIssueCommand` already records an unauthorised command, because that is where an operator
  asking "why did nothing happen?" looks.
- **Amended 2026-10-16:** granting a repository that **another organization already holds** — with
  or without `intake` — needs `repositories.manage` through the **account** role. The
  organization-level permission reaches only that organization's own grants and repositories
  nobody holds; without this, an organization admin could grant themselves any repository in the
  account by id and take its label intake (`putGrant`, `GrantForbiddenError`, 403).

#### 3. A task carries its organization; everything else inherits it

`engineering_task.organization_id not null`. Once a repository can be granted to two
organizations, the repository no longer tells you whose work a task is, so the task has to say.
Runs, attempts, events, cost and evidence reach their organization through the task, as they
already reach their repository.

**Repository secrets move to the grant.** A secret belongs to `(organization_id, repository_id)`,
because two organizations sharing a repository must not read each other's registry credentials. The
ADR-0014 §5 sealing is unchanged.

#### 4. Roles are sets of permissions

- `access_role (id, account_id null, name, permissions text[])`. Built-in roles have no account and
  cannot be edited; custom roles, when they arrive, are rows with an account.
- A user holds **one role per organization** (`membership`) and **at most one account role**
  (`account_membership`). The account role applies in every organization of that account.
- Effective permissions are the union of the two. Handlers check a **permission**, never a role
  name — that is what makes a custom role free later.
- The initial permissions are:
  - `runs.read`
  - `runs.write` (create, cancel, message)
  - `runs.approve`
  - `secrets.manage`
  - `repositories.manage` (grants)
  - `members.manage`
  - `tokens.manage` (organization tokens)
- Built-in roles:
  - **Admin** has all of them.
  - **Member** has `runs.read`, `runs.write` and `runs.approve`.
  - **Viewer** has `runs.read`.

#### 5. Supabase Auth signs people in, and does nothing else

Supabase Auth is adopted for **authentication of people**: GitHub OAuth for the console, SAML SSO
(Pro plan and above, one connection per customer), MFA and sessions. It is the decision ADR-0008
deferred, and it keeps the stack at one vendor.

It is **not** adopted for:

- **Authorisation.** Supabase Auth has no organizations or RBAC; its own documentation tells you
  to build the tables. They are ours, above.
- **API tokens.** Supabase issues short-lived session JWTs, not long-lived keys, and has nothing
  for automations. Those are ours (§6).
- **Row-level security.** Ingress queries as a privileged role through the transaction pooler
  (ADR-0008 §1). RLS would need per-request claims set on a pooled connection, and a policy that
  silently returns zero rows is a worse failure than a store function that refuses. Scoping stays
  in the store layer (§8).
- **JWT claims for org or role.** A role changed in the database must take effect on the next
  request, not when a token expires. Membership is looked up per request — one indexed query.

**Nothing in our schema references the `auth` schema.** A person is linked through
`user_identity (principal_id, provider, subject)`, where the provider is `supabase` and the subject
is `auth.users.id`, with no foreign key. So:

- the migrations still run on stock Postgres (ADR-0008, ADR-0016);
- a self-hosted deployment without Supabase can add another provider as another row;
- the GitHub user id (not the login, which can change) is stored on the user, so a GitHub
  commenter and a Windkeel user can be recognised as the same person.

**The `auth` schema is shared with every other product on this Supabase project**, and so is its
configuration: providers, redirect URLs and SSO connections are per project, not per product. Two
things follow:

- **A row in `auth.users` grants nothing in Windkeel.** Someone who signed in to another product is
  already in that table. They become a Windkeel principal only through a `user_identity` row, created
  when they accept an invitation to an organization or when a sign-in matches an invitation that is
  waiting for them. A valid Supabase session with no identity row gets `403 not_a_member`, never a
  new account.
- **Windkeel adds to the project's Auth configuration and never replaces it.** The console's redirect
  URL is added beside the other products' URLs. The GitHub provider is shared if one is already
  configured; its scopes are only widened, with that change named in the deployment notes.

Ingress verifies Supabase JWTs against the project's published signing keys. The secret surface of
ADR-0023 §1 grows by nothing secret: verifying needs only the public key set.

#### 6. There is one kind of API token, and it is scoped

There are no admin tokens and user tokens, and no service users. There is one token,
`orq_` plus 32 random bytes. It is shown **once**, and only its SHA-256 is stored: the token has too
much entropy to need a slow hash, and lookup by hash replaces the constant-time comparison.

```
api_token (id, name, owner_principal_id, organization_id null, permissions text[] null,
           created_by_principal_id, prefix, hash,
           created_at, last_used_at, expires_at, revoked_at)
```

**What varies is the owner, and the owner decides what the token acts as:**

- **A personal token** is owned by a user and **acts as that user**. Its power is the user's role
  in the organization the request names, *intersected with* the token's scopes. It stops working
  when the user loses the membership, because the role it is intersected with is gone.
- **An organization token** is owned by the organization, through a token principal of its own
  (§1), and **acts as itself**. Its power is exactly its scopes. It survives the person who created
  it leaving, which is the property automations need (Context, point 2). It needs
  `organization_id` and `permissions`, and it needs `tokens.manage` to create.

**Scopes can only shrink a token, never widen it:**

- `organization_id`, when set, pins the token to one organization. Organization tokens are
  always pinned.
- `permissions`, when set, is the most the token may do. Null on a personal token means everything
  its user may do.
- **Nobody can create a token with more than they hold.** An organization token's scopes must be a
  subset of its creator's permissions at the moment of creation.

**Admin power is kept out of everyday tokens by default.** `members.manage`, `tokens.manage` and
`repositories.manage` are not given to a token unless someone asks for them. A token that leaks from
a laptop or a CI log can then run and read work, but cannot invite a member or mint another token.

- `windkeel login` creates a personal token without those three. `windkeel login --admin` asks for
  them, and the console's approval page says so in large type.
- Admin work is normally done in the console, under a signed-in session that has MFA available
  through Supabase.

**`WINDKEEL_API_TOKEN` is the one exception, and it is break-glass.** It authenticates as a seeded
`operator` user who holds the account Admin role, unscoped. A deployment that never creates a user
keeps working exactly as it does today. `doctor` says when it is still in use.

#### 7. The organization is in the path

- Organization-scoped routes are `/v1/orgs/{orgId}/…` — runs, tasks, queue, metrics, repositories,
  secrets, members, tokens.
- **The existing unprefixed `/v1/…` routes stay**, and mean "the caller's organization" when the
  caller belongs to exactly one. A caller in several gets `400 organization_required` naming them.
  The CLI and the console keep working unchanged against a one-organization deployment.
- `GET /v1/self` returns the principal, its account, its organizations and its effective
  permissions in each. `{ subject, scopes }` stays in the response for one release so existing
  clients do not break.
- Account-scoped routes (`/v1/account/…`) are named here and not built: they arrive with SSO and
  billing.

#### 8. Scoping lives in the store layer, and a row in another organization does not exist

- The five whole-database lists take a **required** organization scope.
- The by-id getters take one too, and return nothing for a row outside it.
- The API therefore answers **404, not 403**, for another organization's run. A 403 would confirm
  the id exists.
- The metrics views gain an `organization_id` column, and `collectMetrics` filters on it.
- An unscoped store function that is not a worker-internal path is a bug against this ADR. That
  is ADR-0001 §4's rule, now checkable.

#### 9. Actors are principals, and a GitHub commenter is still an actor

- Every actor column gains a nullable `principal_id` next to its existing text:
  - `repository_secret.set_by`
  - `run_guidance.actor`
  - `run_cancellation.requested_by`, which is written for the first time
  - `engineering_task.criteria_approved_by`
  - the approval signal's payload
- The text stays, and holds the GitHub login or the principal's display name.
- The column is nullable because **someone approving by comment need not be a Windkeel user**.
  GitHub decided they had write access, and ADR-0023 §3 made the comment and the API two doors
  into one mechanism. Requiring a Windkeel account to approve from GitHub would close one of them.
  When the commenter's GitHub user id matches a user, the principal is filled in.
- The API door checks `runs.approve`; the GitHub door keeps checking `author_association`.
  **Amended 2026-10-16:** the GitHub door checks GitHub's *permission* for the commenter
  (`GET /repos/{o}/{r}/collaborators/{user}/permission` — `admin`, `maintain` or `write`), with
  `author_association` only as a pre-filter. `MEMBER` and `COLLABORATOR` include read-only and
  triage users, so the association let them approve and cancel runs. A lookup that fails refuses
  the command (`authorizeCommenter`, `src/factory/issue-commands.ts`).

#### 10. One migration adds it, and one backfill makes today's data fit

Create the tables. Then:

1. Seed one account, one organization named `default`, the built-in roles, and the `operator`
   user with the account Admin role.
2. Create one `scm_connection` per distinct `github_installation_id` on `repository`.
3. Set every repository's account, and grant every repository to `default` as its intake
   organization.
4. Set every task's organization to `default`, and every secret's.
5. Map actor text `operator` to the operator principal.
6. Only then make the new columns `not null`.

Every existing row ends up where a single-tenant deployment would have put it. Nothing is invented,
which is the standard ADR-0018 §5 set for backfills.

#### 11. Every new table lives in the `orqon` schema, because the database is shared

This Supabase database serves several products, and Windkeel's tables live in the `orqon` schema. The
migrations do not say so: they use unqualified names, and the connection's `search_path` decides
the schema. `migrate.ts` and every test rely on this, since each test targets its own schema the
same way. The new migration follows the same rules:

- **No schema qualifier on any object Windkeel owns.** No `public.` and no hard-coded `orqon.`, or
  the per-test schemas stop isolating anything.
- **The one qualified reference is to something Windkeel does not own**, and there is none: nothing
  here refers to `auth`, per §5.
- **Names follow the existing tables:**
  - singular snake_case table names
  - `id uuid primary key default gen_random_uuid()`
  - foreign keys named `<table>_id`
  - indexes named `<table>_<column>_idx`
  - `created_at` and `updated_at` as `timestamptz not null default now()`
  - a comment on each table saying why it exists
- **No name that means something else in Postgres or in Supabase.** There is no `user` table (a
  reserved word, and a shadow of `auth.users` for anyone reading the database) and no `role` table
  (Postgres roles are how the other products' connections are separated). The tables are
  `principal` and `access_role`.
- **`doctor` reports which schema the tables resolved to.** A local database may use `public`, so
  the migration cannot refuse it. On the shared database, though, a `search_path` that fell back to
  `public` would put Windkeel's tenancy tables where every product can see them, silently. Saying the
  resolved schema out loud is the cheap guard.

The new tables are:

- `account`
- `organization`
- `principal`
- `user_identity`
- `membership`
- `account_membership`
- `access_role`
- `api_token`
- `scm_connection`
- `repository_grant`
- `invitation`
- `device_authorization`

#### 12. Sign-in has three doors, and each one ends in a principal

Today none of them exists. The API has one token, the CLI reads `WINDKEEL_API_TOKEN` from the
environment, and the console calls the API from its own server with that same token. Its README
tells you to keep it behind Vercel Deployment Protection because of that.

**The API accepts two kinds of bearer, told apart by shape.** A token beginning with `orq_` is
looked up by hash (§6). Anything else is verified as a Supabase access token and resolved through
`user_identity`. Either way the result is a principal, so every handler after the router is the
same for a person, a CLI and an automation. New routes, all following the existing convention that
a delete is a `POST …/delete` command:

- **Identity:** `GET /v1/self`, extended per §7.
- **Personal tokens:** `GET` and `POST /v1/tokens`; `POST /v1/tokens/{id}/revoke`. Each takes a
  name, an optional organization, an optional permission list and an optional expiry.
- **Members:**
  - `GET /v1/orgs/{orgId}/members`
  - `POST /v1/orgs/{orgId}/members/{principalId}/role`
  - `POST /v1/orgs/{orgId}/members/{principalId}/delete`
- **Invitations:** `GET` and `POST /v1/orgs/{orgId}/invitations`, by GitHub login; and
  `POST /v1/orgs/{orgId}/invitations/{id}/delete`. An invitation stores the GitHub **user id**,
  resolved from the login when it is created, so a renamed account still matches. It is accepted
  on the invitee's first sign-in.
- **Organization tokens:** `GET` and `POST /v1/orgs/{orgId}/tokens`, and
  `POST /v1/orgs/{orgId}/tokens/{id}/revoke`. They need `tokens.manage`, and a creator can grant
  only permissions they hold.
- **Repository grants:** `GET` and `POST /v1/orgs/{orgId}/repositories/grants`.
- **CLI login (public, no bearer):**
  - `POST /v1/auth/device` starts a login.
  - `POST /v1/auth/device/token` is what the CLI polls.

  Both are rate-limited per address, and device codes are stored hashed and expire after ten
  minutes.

**The CLI logs in with the device flow**, the way `gh auth login` does. A terminal cannot receive
an OAuth redirect, and pasting a token into a shell puts it in the history file.

- `windkeel login` asks the API for a device code, prints a short user code and a URL, and opens the
  console's `/login/device` page. The token it gets is scoped as §6 says: no admin permissions
  unless `--admin` was passed.
- The person signs in there, checks the code matches, and approves.
- The poll then returns a new personal token named after the machine, which the CLI writes to
  `~/.config/windkeel/credentials.json` with mode `0600`.
- The other commands:
  - `windkeel logout` revokes that token on the server before deleting the file.
  - `windkeel whoami` prints `GET /v1/self`.
  - `--org` or `WINDKEEL_ORG` chooses the organization when the principal has more than one.
- **`WINDKEEL_API_TOKEN` still wins when it is set**, because CI and the Claude Code and Codex
  integrations have no browser. The MCP server and `remote` commands read credentials the same
  way, so none of them changes.

**The console signs in through Supabase Auth**, with `@supabase/ssr` holding the session in an
HTTP-only cookie. The console passes the session's access token to the API from its server, as it
passes the operator token today, so the browser still never calls `/v1` itself. The screens use
the design library under `design/` and nothing else:

- **`/login`**: a `Card` with one primary `Button`, *Continue with GitHub*. A `Banner` holds
  errors. *Continue with SSO* is a `TextField` for a work email, added when SAML is configured and
  not before.
- **`/login/device`**: the code the CLI printed, the machine name, what the token will be able
  to do (and, for `--admin`, a warning `Banner` saying so), *Approve* and *Deny*. This page
  is the only thing standing between a phished code and a working token, so the code is shown
  large and the wording says what approving grants.
- **Not a member**: signed in, but no membership and no invitation that matches. The page says who
  you are signed in as, that an organization admin has to invite you, and offers *Sign out*. It
  never creates an account (§5).
- **Organization switcher**: a `NavItem` group in the sidebar, shown only when there is more than
  one organization.
- **`/settings`**: gains *Members and invitations*, *Your tokens*, *Organization tokens* and
  *Repository access*. Creating a token means choosing its scopes from a list of checkboxes, limited to
  what you hold, with the admin permissions unticked by default. Each `Tabs` panel is shown only to someone holding the permission it needs, and a
  token's value appears once, in a `Dialog`.
- **With no Supabase configured**, the console keeps today's behaviour exactly: the operator token
  on the server, or fixtures. Local development gains no new dependency (ADR-0016).

### Consequences

- **This is not ADR-0001's "one column".** It is twelve tables, a column on tasks instead of on
  repositories, a column on secrets, and nullable actor columns. It is still entirely additive, and
  it is the last tenancy migration: SSO, custom roles, organization tokens and more organizations all
  become rows, not schema.
- **Most of the churn is signatures, not schema.** Every store read gains a scope, and every read
  handler gains the principal it did not previously receive. Tests that call store functions
  without a scope break at compile time, which is the point.
- **The console gets sign-in** through Supabase Auth's GitHub provider, and its shared server-side
  token becomes a session. The settings page's note ("Sign-in replaces the shared token when users
  arrive") becomes true.
- **The operator commands of ADR-0023 §10 become API clients with a real identity.** When `reap`,
  `metrics`, `task` and `doctor` move onto the API, they authenticate with an organization token
  scoped to what each needs, rather than holding the database's credentials.
- **Built in M7:** the tables, the backfill, the three built-in roles, users through Supabase Auth
  with GitHub, the three sign-in doors of §12, scoped personal and organization tokens, org-scoped routes, membership management, and repository
  grants.
- **Named and not built in M7:**
  - custom roles
  - SAML SSO (Supabase supports it; it needs only configuration and a domain-to-account mapping)
  - IdP group to role mapping
  - account-scoped routes, billing and an audit log
- **One more dependency at ingress:** a JWT verifier for Supabase's signing keys. `jose` is the
  candidate; `packages/verification` is untouched and keeps `dependencies: {}`.
- **Supabase lock-in stays operational, not architectural.** Leaving means adding an identity
  provider and re-linking `user_identity` rows. No table, and no foreign key, knows Supabase
  exists.

### As built, 2026-09-24

The first build (API, CLI and MCP; the console screens are on their own branch) departs from the
decision above in six places. Each was chosen, not overlooked.

1. **Only personal tokens exist.** Every token is owned by a user and scoped when it is made, with
   the presets `read`, `execute`, `approve` and `admin`, or an explicit list. Organization tokens
   (§6) are not built. `principal.kind` already allows `token`, so they arrive as rows, not schema.
   `api_token.permissions` is `not null`: a scope is always stated, never implied.
2. **`repository` has no `account_id`.** An account reaches a repository through its
   `scm_connection` and its grants, which is all the build needs. `upsertRepository` grants a
   repository nobody has claimed to the default organization as its intake, which is what
   single-tenant always did implicitly.
3. **Metrics stay account-wide** (§8). The ADR-0013 views do not carry an organization yet, so
   `GET /v1/metrics` is refused to anyone without an account role in an account with more than
   one organization. It is refused, never answered with another organization's aggregates.
4. **Actor principals are written for guidance and secrets only** (§9).
   `run_cancellation.requested_by`, `criteria_approved_by` and the approval payload still record text
   alone. The cancellation actor survives only in the reason string, as before.
5. **The public device-login endpoints are bounded, not rate-limited per address** (§12). There
   is a ceiling of 100 pending logins, a ten-minute expiry and `slow_down` on fast polls. Vercel
   gives a function no durable per-address state to count against.
6. **`GET /v1/self` also returns `via`** (`bootstrap`, `token` or `session`), so a client can say
   which door a caller used. The CLI uses it to refuse to "revoke" the bootstrap token, which lives
   in the deployment's configuration.

### As built, 2026-09-25: service principals (M8-2)

Organization tokens (§6, and departure 1 above) are built as **service principals**, in
`migrations/0024_service_principal.sql`, for M8's automations. It departs from §1, §6 and §12 in
these places, each chosen:

1. **A service principal exists on its own and holds many tokens.** §1 said a token principal "is
   created with its token and deleted with it". Here it is created first
   (`POST /v1/service-principals {name, role}`), holds any number of tokens, and deleting it revokes
   them all. A Slack intake that rotates its token keeps one identity in the audit columns.
2. **Its power comes from a role, not from its scopes alone.** §6 said an organization token's power
   is "exactly its scopes". A service principal holds a built-in role through an ordinary
   `membership`, and each token is that role intersected with the token's permissions — the same
   rule a personal token follows, so the router needed no second code path. A token's scope must
   fit inside the role and inside what its creator holds, and nobody can make a principal whose role
   holds more than they do. With no scope given, a token gets the role less the admin permissions.
3. **`principal.kind` stays `token`**, as §1 anticipated; `principal.organization_id` (the one
   organization) and `deactivated_at` are new. Deleting deactivates rather than removes the row,
   because tasks it created still name it.
4. **Routes are `/v1/service-principals…`**, not §12's `/v1/orgs/{orgId}/tokens`: that path would sit
   beside the personal `/v1/tokens` and mean something else. They are organization routes, reachable
   under `/v1/orgs/{orgId}/…` too, and need `tokens.manage`. Deletes answer to `DELETE` as well as
   the `POST …/delete` (`…/revoke`) command form; these are the API's first `DELETE` routes.
5. **Each organization has built-in system actors.** `getSystemActor(db, organizationId, purpose)`
   returns, creating once and idempotently, a service principal with the `member` role for one kind
   of internal automation (`schedules`, `integrations`, …). It owns no tokens and never
   authenticates; schedules and intakes name it as the actor of the work they create, through the
   new `engineering_task.created_by_principal_id`. It is listed with `system: true` and cannot be
   deleted.
6. **Service principals are not members.** They are left out of `GET /v1/members`, cannot be
   changed or removed through the member routes, and do not count as the organization's last admin.
   A service principal cannot mint its own tokens through `/v1/tokens`.
7. **Two permissions are added for M8:** `integrations.manage` and `schedules.manage`. The built-in
   Admin role gains both in the migration; like `members.manage`, `tokens.manage` and
   `repositories.manage`, they are kept out of a token unless asked for.
8. **A revoked service token is `403`, not `401`**, like every other rejected credential here: the
   API already answers a revoked token exactly as an unknown one.

### Amendment, 2026-10-16 — §5: the GitHub account comes from `auth.identities`, never `user_metadata`

§5 matched a session to invitations and principals by the GitHub id in the access token's
`user_metadata`. Supabase lets a signed-in user rewrite `user_metadata`
(`supabase.auth.updateUser({ data })`), and a refreshed token carries the edit under a valid
signature, so anyone with a session on the shared project could claim any public GitHub id and be
linked to that person's principal, admins included, or accept their invitations.

- **The id and login are Auth's, not the user's.** Ingress verifies the token as before, then reads
  the subject's one GitHub row of `auth.identities` — which only Auth writes — through
  `orqon.github_identity_of(uuid)`. `user_metadata` supplies a display name and nothing else.
- **One narrow function is Windkeel's only reach into `auth`.** It is `security definer`, owned by
  `postgres`, with an empty `search_path`; it returns one live (not deleted, not banned) user's GitHub
  id, login and name; `orqon_app` may execute it and has no other grant in `auth`. This is the one
  exception to "nothing in our schema references the `auth` schema": it lives in
  `migrations/supabase/`, outside `runMigrations`, so the migrations still run on stock Postgres, and
  an operator applies it as `postgres`. Without it every sign-in is `not_a_member`, and each refusal
  logs why. Refused: `GET /auth/v1/user` (Supabase documents it as IP rate-limited, 30 per five
  minutes, and ingress calls from shared egress), a grant on `auth.identities` (every product's
  users, emails included), the service-role Admin API (a project-wide secret) and a custom access
  token hook (it would change every product's tokens).
- **An identity row must still agree.** A `user_identity` row whose principal has a GitHub id is
  honoured only when the session's GitHub account is that id; otherwise the session is
  `not_a_member` and the row is left alone as evidence. Rows linked through the hole stop working
  without a migration.

### As built, 2026-10-21: custom roles and the first account routes (#393)

- **§4's custom roles exist** ([ADR-0030](0030-the-audit-log-is-a-per-account-hash-chain-roles-and-policy-are-the-accounts.md)
  §6, `migrations/0040_account_roles.sql`). An account's own roles are `access_role` rows with its
  `account_id`; built-ins stay global and immutable. A role is a subset of its maker's permissions, a
  role in use cannot be deleted, another account's role is a 404, and a role is never assigned by
  someone who holds less than it does. `runs.merge` is grantable beyond Admin through one.
- **§7's `/v1/account/…` routes exist** for the audit log, roles, the security policy and the
  access review. They are decided against the `account_membership` role, narrowed by any token, and
  a token pinned to one organization is refused. SSO and SCIM, which §7 expected to bring them, are
  #403.
- **Three permissions are added**, all admin-only: `audit.read`, `roles.manage`, `account.manage`.
