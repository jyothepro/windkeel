import { Banner } from "../../../components/banner.tsx";
import { ConfirmAction } from "../../../components/confirm-action.tsx";
import { RoleSelect, SimpleForm } from "../../../components/simple-form.tsx";
import { ThemeControl } from "../../../components/theme-control.tsx";
import { TokenForm } from "../../../components/token-form.tsx";
import {
  apiMode,
  databaseState,
  getHealth,
  listAllRepositories,
  listGrants,
  listInvitations,
  listMembers,
  listRoles,
  listTokens,
} from "../../../lib/api.ts";
import { supabaseConfig } from "../../../lib/auth.ts";
import { age, time } from "../../../lib/format.ts";
import { PERMISSION_LABEL, grantable, isPermission } from "../../../lib/permissions.ts";

import { BUILT_IN_ROLES, ROLE_LABEL, type ApiToken, type OrganizationView, type Role, type SelfView } from "../../../lib/types.ts";
import {
  cancelInvitation,
  changeRole,
  createPersonalToken,
  grantRepository,
  invite,
  removeFromOrganization,
  revokeGrant,
  revokePersonalToken,
} from "./actions.ts";

export { Integrations, Schedules } from "./automation-sections.tsx";
export { ServicePrincipals, Webhooks } from "./endpoint-sections.tsx";

export const roleName = (role: string) => ROLE_LABEL[role as Role] ?? role;

export const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

export async function General({ identity }: { identity: SelfView }) {
  const health = await getHealth();
  const signIn = supabaseConfig() !== null;
  return (
    <>
      <section className="console-section">
        <h3>You</h3>
        <dl className="console-kv">
          <dt>Signed in as</dt>
          <dd>
            {identity.principal.displayName}
            {identity.principal.githubLogin ? <span className="console-meta"> · @{identity.principal.githubLogin}</span> : null}
          </dd>
          <dt>Account</dt>
          <dd>{identity.account.name}</dd>
          <dt>Using</dt>
          <dd>
            {identity.via === "bootstrap"
              ? "The operator token (WINDKEEL_API_TOKEN) — it's set on the server, so it can't be revoked here"
              : identity.via === "token"
                ? `A token${identity.token ? `, “${identity.token.name}”` : ""}`
                : "Your signed-in session"}
          </dd>
          <dt>Organizations</dt>
          <dd>{identity.organizations.map((o) => `${o.name} (${roleName(o.role)})`).join(", ") || "none"}</dd>
        </dl>
        {signIn ? (
          <form action="/auth/sign-out" method="post">
            <button type="submit" className="oq-button oq-button--sm">
              Sign out
            </button>
          </form>
        ) : null}
      </section>

      <section className="console-section">
        <h3>Connection</h3>
        <dl className="console-kv">
          <dt>Source</dt>
          <dd>{apiMode() === "live" ? "Control plane API" : "Fixtures — no factory connected"}</dd>
          <dt>Database</dt>
          <dd>{databaseState(health.database)}</dd>
        </dl>
        <p className="oq-muted" style={{ margin: 0 }}>
          {signIn
            ? "The console calls the API from its own server with your session; your browser never holds an API token."
            : "The console calls the API from its own server with WINDKEEL_API_TOKEN; your browser never holds it. Configure Supabase sign-in to act as yourself instead."}
        </p>
      </section>

      <section className="console-section">
        <h3>Appearance</h3>
        <ThemeControl />
      </section>
    </>
  );
}

function scopes(token: ApiToken): string {
  if (!token.permissions) return "Everything your role allows";
  return token.permissions.filter(isPermission).map((p) => PERMISSION_LABEL[p].label).join(" · ") || "Nothing";
}

function TokenList({
  tokens,
  organizations,
}: {
  tokens: ApiToken[];
  organizations: OrganizationView[];
}) {
  const active = tokens.filter((t) => !t.revokedAt);
  const revoked = tokens.filter((t) => t.revokedAt);
  const orgName = (id: string | null) => (id ? (organizations.find((o) => o.id === id)?.name ?? "one organization") : "any organization you're in");
  if (tokens.length === 0) return <p className="oq-muted" style={{ margin: 0 }}>No tokens yet.</p>;
  return (
    <>
      <ul className="console-list">
        {active.map((t) => (
          <li key={t.id} className="console-list__static">
            <span className="console-list__main">
              <span className="console-list__title">
                {t.name} <span className="oq-mono console-meta">{t.prefix}…</span>
              </span>
              <span className="console-list__next">
                {scopes(t)} · in {orgName(t.organizationId)}
              </span>
              <span className="console-meta">
                {t.lastUsedAt ? `used ${age(t.lastUsedAt)} ago` : "never used"} · {t.expiresAt ? `expires ${time(t.expiresAt)}` : "doesn't expire"}
              </span>
            </span>
            <ConfirmAction
              label="Revoke"
              question={`Revoke “${t.name}”?`}
              consequence="Anything using it stops working immediately. This can't be undone; make a new token if you need one."
              confirmLabel="Revoke token"
              run={revokePersonalToken.bind(null, t.id)}
            />
          </li>
        ))}
      </ul>
      {revoked.length ? (
        <details>
          <summary className="console-meta">{revoked.length} revoked</summary>
          <ul className="console-list">
            {revoked.map((t) => (
              <li key={t.id} className="console-list__static" style={{ opacity: 0.65 }}>
                <span className="console-list__main">
                  <span className="console-list__title">{t.name}</span>
                  <span className="console-meta">revoked {time(t.revokedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

export async function PersonalTokens({ identity }: { identity: SelfView }) {
  const tokens = await listTokens();
  const held = [...new Set(identity.organizations.flatMap((o) => o.permissions))];
  return (
    <>
      <section className="console-section">
        <h2>Active tokens</h2>
        <p className="oq-muted" style={{ margin: 0 }}>
          A token acts as you, with no more than your role allows — and stops working if you leave the organization. For a terminal,{" "}
          <code>windkeel login</code> makes one for you; make one here for CI or a script.
        </p>
        <TokenList tokens={tokens} organizations={identity.organizations} />
      </section>
      <section className="console-section">
        <h2>New token</h2>
        <TokenForm action={createPersonalToken} held={grantable(held)} organizations={identity.organizations.map((o) => ({ id: o.id, name: o.name }))} />
      </section>
    </>
  );
}

export async function Members({ org }: { org: OrganizationView }) {
  const [members, invitations, accountRoles] = await Promise.all([
    listMembers(org.id),
    listInvitations(org.id),
    listRoles(org.id).catch(() => []),
  ]);
  const roleKeys = accountRoles.length ? accountRoles.map((r) => r.key) : [...BUILT_IN_ROLES];
  const roleLabels: Record<string, string> = { ...ROLE_LABEL, ...Object.fromEntries(accountRoles.map((r) => [r.key, r.name])) };
  const names = new Map(members.map((m) => [m.principalId, m.displayName]));
  const inviter = (i: { invitedBy: string | null; invitedByName?: string | null | undefined }) =>
    i.invitedByName ??
    (i.invitedBy === null ? "an admin" : names.get(i.invitedBy) ?? (/^[0-9a-f-]{36}$/i.test(i.invitedBy) ? "an admin" : i.invitedBy));
  return (
    <>
      <section className="console-section">
        <h2>Members</h2>
        <p className="oq-muted" style={{ margin: 0 }}>
          <strong>Admin</strong> can do everything. <strong>Member</strong> can read, start, steer and approve runs. <strong>Viewer</strong> can
          only read.
        </p>
        <ul className="console-list">
          {members.map((m) => (
            <li key={m.principalId} className="console-list__static">
              <span className="console-list__main">
                <span className="console-list__title">
                  {m.displayName}
                  {m.githubLogin ? <span className="console-meta"> · @{m.githubLogin}</span> : null}
                </span>
                <span className="console-meta">joined {time(m.createdAt)}</span>
              </span>
              <RoleSelect id={`role-${m.principalId}`} value={m.role} roles={roleKeys} labels={roleLabels} save={changeRole.bind(null, m.principalId)} />
              <ConfirmAction
                label="Remove"
                question={`Remove ${m.displayName} from ${org.name}?`}
                consequence="They lose access right away, and their tokens stop working here."
                confirmLabel="Remove member"
                run={removeFromOrganization.bind(null, m.principalId)}
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="console-section">
        <h2>Invitations</h2>
        {invitations.length ? (
          <ul className="console-list">
            {invitations.map((i) => (
              <li key={i.id} className="console-list__static">
                <span className="console-list__main">
                  <span className="console-list__title">@{i.githubLogin}</span>
                  <span className="console-meta">
                    as {roleName(i.role)} · invited by {inviter(i)} {age(i.createdAt)} ago ·{" "}
                    {i.expiresAt ? `waiting for their first sign-in until ${time(i.expiresAt)}` : "waiting for their first sign-in"}
                  </span>
                </span>
                <ConfirmAction
                  label="Cancel"
                  question={`Cancel the invitation for @${i.githubLogin}?`}
                  consequence="If they sign in later, they won't get in."
                  confirmLabel="Cancel invitation"
                  run={cancelInvitation.bind(null, i.id)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="oq-muted" style={{ margin: 0 }}>
            No invitations waiting.
          </p>
        )}
        <SimpleForm action={invite} submitLabel="Invite">
          <div className="console-composer-form__row">
            <div className="oq-field">
              <label className="oq-field__label" htmlFor="invite-login">
                GitHub username
              </label>
              <input id="invite-login" name="githubLogin" className="oq-input oq-input--mono" placeholder="octocat" autoComplete="off" required />
              <p className="oq-field__hint">They get in the next time they sign in with that account. Renaming it later doesn't break the invitation.</p>
            </div>
            <div className="oq-field">
              <label className="oq-field__label" htmlFor="invite-role">
                Role
              </label>
              <select id="invite-role" name="role" className="oq-input" defaultValue="member">
                {roleKeys.map((r) => (
                  <option key={r} value={r}>
                    {roleLabels[r] ?? r}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </SimpleForm>
      </section>
    </>
  );
}

export async function Access({ org }: { org: OrganizationView }) {
  const [grants, repos] = await Promise.all([listGrants(org.id), listAllRepositories()]);
  const granted = new Set(grants.map((g) => g.repositoryId));
  const available = repos.items.filter((r) => !granted.has(r.id));
  return (
    <>
      <section className="console-section">
        <h2>Granted repositories</h2>
        <p className="oq-muted" style={{ margin: 0 }}>
          {org.name} can work only on repositories granted to it. One organization per repository takes its <em>intake</em>: a labelled GitHub issue
          starts work there.
        </p>
        {grants.length ? (
          <ul className="console-list">
            {grants.map((g) => (
              <li key={g.repositoryId} className="console-list__static">
                <span className="console-list__main">
                  <span className="console-list__title">{g.fullName}</span>
                  <span className="console-meta">
                    {g.intake ? "Intake: labelled issues start work here" : "No intake: work starts only from the console or CLI"} · granted {time(g.createdAt)}
                  </span>
                </span>
                <ConfirmAction
                  label="Remove access"
                  question={`Remove ${org.name}'s access to ${g.fullName}?`}
                  consequence={`${org.name} can no longer start or see work on it${g.intake ? ", and labelled issues there stop starting runs" : ""}. Runs already finished keep their records.`}
                  confirmLabel="Remove access"
                  run={revokeGrant.bind(null, g.repositoryId)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <Banner intent="warning" title="No repositories granted">
            <p>Nothing can run in {org.name} until a repository is granted to it.</p>
          </Banner>
        )}
      </section>
      <section className="console-section">
        <h2>Grant a repository</h2>
        {available.length ? (
          <SimpleForm action={grantRepository} submitLabel="Grant access">
            <div className="oq-field">
              <label className="oq-field__label" htmlFor="grant-repo">
                Repository
              </label>
              <select id="grant-repo" name="repositoryId" className="oq-input">
                {available.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            </div>
            <label className="console-choice__item">
              <input type="checkbox" name="intake" />
              <span>
                <span className="console-choice__label">Take intake</span>
                <span className="console-choice__detail">Labelled issues in this repository start work in {org.name}. Only one organization can.</span>
              </span>
            </label>
          </SimpleForm>
        ) : (
          <p className="oq-muted" style={{ margin: 0 }}>
            Every repository your account has is already granted here. Install the GitHub App on more to add them.
          </p>
        )}
      </section>
    </>
  );
}
