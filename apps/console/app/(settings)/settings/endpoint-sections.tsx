import { ConfirmAction } from "../../../components/confirm-action.tsx";
import { SecretConfirm, SecretForm, Toggle } from "../../../components/automation-controls.tsx";
import { SimpleForm } from "../../../components/simple-form.tsx";
import { Badge } from "../../../components/status.tsx";
import { automations, ingressUrl, listGrants } from "../../../lib/api.ts";
import { age, time } from "../../../lib/format.ts";
import { PERMISSION_LABEL, TOKEN_EXPIRY_DAYS, isPermission, offeredPresets } from "../../../lib/permissions.ts";
import {
  BUILT_IN_ROLES,
  ROLE_LABEL,
  type ApiToken,
  type OrganizationView,
  type RepositoryGrant,
  type WebhookEndpoint,
} from "../../../lib/types.ts";
import {
  createServicePrincipal,
  createServiceToken,
  createWebhookEndpoint,
  deleteServicePrincipal,
  deleteWebhookEndpoint,
  revokeServiceToken,
  rotateWebhookEndpoint,
  setWebhookEndpointEnabled,
} from "./actions.ts";
import { NoGrants, RepoSelect, muted, repoNamer } from "./automation-sections.tsx";

export function curlExample(url: string): string {
  return [
    "SECRET='whsec_…'   # shown once, when the endpoint was made or last rotated",
    `ENDPOINT='${url}'`,
    `BODY='{"title":"Fix flaky upload test","description":"- [ ] upload retries a 500 three times"}'`,
    "TS=$(date +%s)",
    `SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')`,
    `curl -sS -X POST "$ENDPOINT" -H 'content-type: application/json' \\`,
    `  -H "x-windkeel-timestamp: $TS" -H "x-windkeel-signature: v1=$SIG" \\`,
    `  -H "x-windkeel-delivery: $(uuidgen)" --data-raw "$BODY"`,
  ].join("\n");
}

function EndpointRow({ e, grants, base }: { e: WebhookEndpoint; grants: RepositoryGrant[]; base: string }) {
  const repoName = repoNamer(grants);
  const url = `${base}${e.path}`;
  return (
    <li className="console-list__static console-endpoint">
      <span className="console-list__main">
        <span className="console-list__title">
          {e.name}{" "}
          {e.enabled ? null : (
            <Badge small intent="warning">
              disabled
            </Badge>
          )}
        </span>
        <span className="console-list__next">
          → {repoName(e.repositoryId)} · risk {e.defaultRiskLevel} unless the sender says otherwise
        </span>
        <span className="console-meta">
          <span className="oq-mono">{e.path}</span> · secret v{e.secretVersion}, {e.rotatedAt ? `rotated ${time(e.rotatedAt)}` : `made ${time(e.createdAt)}`}
        </span>
        <details className="console-inline-edit">
          <summary className="console-meta">Send a task with curl</summary>
          <pre className="console-code">{curlExample(url)}</pre>
          <p className="oq-field__hint">
            Sign <code>{"{timestamp}.{body}"}</code> with HMAC-SHA256 under the whole secret. Resend with the same <code>x-windkeel-delivery</code> to retry
            safely; see docs/webhook-intake.md for the answers.
          </p>
        </details>
      </span>
      <span className="console-row-actions">
        <Toggle id={`whe-on-${e.id}`} label="Enabled" checked={e.enabled} save={setWebhookEndpointEnabled.bind(null, e.id)} />
        <SecretConfirm
          label="Rotate secret"
          question={`Rotate the secret for “${e.name}”?`}
          consequence="The current secret stops working at once — there is no overlap. Deliveries signed with it are refused until the sender has the new one."
          confirmLabel="Rotate"
          secretTitle={`New secret for “${e.name}”`}
          run={rotateWebhookEndpoint.bind(null, e.id)}
        />
        <ConfirmAction
          label="Delete"
          question={`Delete “${e.name}”?`}
          consequence="Its URL stops accepting deliveries. Tasks it already started keep running."
          confirmLabel="Delete endpoint"
          run={deleteWebhookEndpoint.bind(null, e.id)}
        />
      </span>
    </li>
  );
}

export async function Webhooks({ org }: { org: OrganizationView }) {
  const [endpoints, grants] = await Promise.all([automations.listWebhookEndpoints(org.id), listGrants(org.id)]);
  const base = ingressUrl() ?? "https://your-ingress.example.com";
  return (
    <>
      <section className="console-section">
        <h2>Endpoints</h2>
        <p className="oq-muted" style={muted}>
          Anything that can send a signed HTTP request — CI, PagerDuty, an internal tool — can start a task here without a Windkeel token. Each endpoint files
          into one repository, as the organization's webhook actor.
        </p>
        {endpoints.length ? (
          <ul className="console-list">
            {endpoints.map((e) => (
              <EndpointRow key={e.id} e={e} grants={grants} base={base} />
            ))}
          </ul>
        ) : (
          <p className="oq-muted" style={muted}>
            No endpoints yet.
          </p>
        )}
      </section>
      <section className="console-section">
        <h2>New endpoint</h2>
        {grants.length ? (
          <SecretForm
            action={createWebhookEndpoint}
            submitLabel="Create endpoint"
            secretTitle="Copy the endpoint's secret now"
            secretHint={<p className="oq-field__hint">Give it to the sender as its signing secret. Each endpoint above has a curl example of how to sign.</p>}
          >
            <div className="console-composer-form__row">
              <div className="oq-field">
                <label className="oq-field__label" htmlFor="whe-name">
                  Name
                </label>
                <input id="whe-name" name="name" className="oq-input" placeholder="pagerduty" required />
                <p className="oq-field__hint">What will call it, so you know what breaks when you rotate it.</p>
              </div>
              <div className="oq-field">
                <label className="oq-field__label" htmlFor="whe-repo">
                  Repository
                </label>
                <RepoSelect id="whe-repo" grants={grants} />
              </div>
              <div className="oq-field">
                <label className="oq-field__label" htmlFor="whe-risk">
                  Default risk
                </label>
                <select id="whe-risk" name="defaultRiskLevel" className="oq-input" defaultValue="low">
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>
          </SecretForm>
        ) : (
          <NoGrants org={org} what="An endpoint" />
        )}
      </section>
    </>
  );
}

function scopesOf(token: ApiToken): string {
  if (!token.permissions) return "Everything its role allows";
  return token.permissions.filter(isPermission).map((p) => PERMISSION_LABEL[p].label).join(" · ") || "Nothing";
}

function ServiceTokens({ principalId, tokens }: { principalId: string; tokens: ApiToken[] }) {
  const active = tokens.filter((t) => !t.revokedAt);
  if (active.length === 0) return <span className="console-meta">No tokens.</span>;
  return (
    <ul className="console-list">
      {active.map((t) => (
        <li key={t.id} className="console-list__static">
          <span className="console-list__main">
            <span className="console-list__title">
              {t.name} <span className="oq-mono console-meta">{t.prefix}…</span>
            </span>
            <span className="console-list__next">{scopesOf(t)}</span>
            <span className="console-meta">
              {t.lastUsedAt ? `used ${age(t.lastUsedAt)} ago` : "never used"} · {t.expiresAt ? `expires ${time(t.expiresAt)}` : "doesn't expire"}
            </span>
          </span>
          <ConfirmAction
            label="Revoke"
            question={`Revoke “${t.name}”?`}
            consequence="Whatever uses it stops working immediately. This can't be undone."
            confirmLabel="Revoke token"
            run={revokeServiceToken.bind(null, principalId, t.id)}
          />
        </li>
      ))}
    </ul>
  );
}

export async function ServicePrincipals({ org }: { org: OrganizationView }) {
  const principals = (await automations.listServicePrincipals(org.id)).filter((p) => !p.deactivatedAt);
  const own = principals.filter((p) => !p.system);
  const builtIn = principals.filter((p) => p.system);
  const tokens = new Map(await Promise.all(own.map(async (p) => [p.id, await automations.listServiceTokens(org.id, p.id)] as const)));
  const presets = offeredPresets(org.permissions);
  return (
    <>
      <section className="console-section">
        <h2>Service principals</h2>
        <p className="oq-muted" style={muted}>
          An automation should act as itself, not as whoever set it up: a service principal's tokens keep working when a person leaves, and its role caps what
          they can do.
        </p>
        {own.length ? (
          <ul className="console-list">
            {own.map((p) => (
              <li key={p.id} className="console-list__static console-principal">
                <span className="console-list__main oq-stack" style={{ ["--gap" as string]: "var(--space-2)" }}>
                  <span className="console-list__title">
                    {p.displayName} <Badge small>{ROLE_LABEL[p.role as keyof typeof ROLE_LABEL] ?? p.role}</Badge>
                  </span>
                  <span className="console-meta">made {time(p.createdAt)}</span>
                  <ServiceTokens principalId={p.id} tokens={tokens.get(p.id) ?? []} />
                  <details className="console-inline-edit">
                    <summary className="console-meta">New token</summary>
                    <SecretForm
                      action={createServiceToken.bind(null, p.id)}
                      submitLabel="Create token"
                      secretTitle={`Copy ${p.displayName}'s token now`}
                      secretHint={
                        <p className="oq-field__hint">
                          Use it as <code>WINDKEEL_API_TOKEN</code> where the automation runs. It acts as {p.displayName}, never as you.
                        </p>
                      }
                    >
                      <div className="console-composer-form__row">
                        <div className="oq-field">
                          <label className="oq-field__label" htmlFor={`stok-name-${p.id}`}>
                            Name
                          </label>
                          <input id={`stok-name-${p.id}`} name="name" className="oq-input" placeholder="GitHub Actions" required />
                        </div>
                        <div className="oq-field">
                          <label className="oq-field__label" htmlFor={`stok-preset-${p.id}`}>
                            Can
                          </label>
                          <select id={`stok-preset-${p.id}`} name="preset" className="oq-input" defaultValue="execute">
                            {presets.map((x) => (
                              <option key={x.preset} value={x.preset}>
                                {x.label} — {x.detail}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="oq-field">
                          <label className="oq-field__label" htmlFor={`stok-exp-${p.id}`}>
                            Expires
                          </label>
                          <select id={`stok-exp-${p.id}`} name="expiresInDays" className="oq-input" defaultValue="90">
                            {TOKEN_EXPIRY_DAYS.map((e) => (
                              <option key={e.label} value={e.days ?? "never"}>
                                {e.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <p className="oq-field__hint">Never more than its role, nor more than you hold.</p>
                    </SecretForm>
                  </details>
                </span>
                <ConfirmAction
                  label="Delete"
                  question={`Delete ${p.displayName}?`}
                  consequence="Every token it holds is revoked at once, and anything using them stops working."
                  confirmLabel="Delete service principal"
                  run={deleteServicePrincipal.bind(null, p.id)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="oq-muted" style={muted}>
            None yet.
          </p>
        )}
      </section>

      <section className="console-section">
        <h2>New service principal</h2>
        <SimpleForm action={createServicePrincipal} submitLabel="Create">
          <div className="console-composer-form__row">
            <div className="oq-field">
              <label className="oq-field__label" htmlFor="sp-name">
                Name
              </label>
              <input id="sp-name" name="name" className="oq-input" placeholder="release-ci" autoComplete="off" required />
            </div>
            <div className="oq-field">
              <label className="oq-field__label" htmlFor="sp-role">
                Role
              </label>
              <select id="sp-role" name="role" className="oq-input" defaultValue="member">
                {BUILT_IN_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </SimpleForm>
      </section>

      {builtIn.length ? (
        <section className="console-section">
          <h2>Built in</h2>
          <p className="oq-muted" style={muted}>
            The actors {org.name}'s intakes file work as — schedules, webhooks, Slack, Linear, Jira. Made on first use; they can't be deleted.
          </p>
          <ul className="console-list">
            {builtIn.map((p) => (
              <li key={p.id} className="console-list__static">
                <span className="console-list__main">
                  <span className="console-list__title">{p.displayName}</span>
                  <span className="console-meta">
                    {p.systemPurpose} · {ROLE_LABEL[p.role as keyof typeof ROLE_LABEL] ?? p.role} · since {time(p.createdAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
