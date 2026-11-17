import { Banner } from "../../../components/banner.tsx";
import { ConfirmAction } from "../../../components/confirm-action.tsx";
import { LazyDetails, ScheduleForm, Toggle } from "../../../components/automation-controls.tsx";
import { SimpleForm } from "../../../components/simple-form.tsx";
import { Badge } from "../../../components/status.tsx";
import { automations, listGrants, listMembers } from "../../../lib/api.ts";
import { PROVIDERS, PROVIDER_LABEL, PROVIDER_SCOPE } from "../../../lib/automation-actions.ts";
import { age, inZone, time } from "../../../lib/format.ts";
import { PERMISSION_LABEL, canManage } from "../../../lib/permissions.ts";
import { lastOutcomeText } from "../../../lib/schedules.ts";
import {
  type Integration,
  type IntegrationRoute,
  type OrganizationView,
  type RepositoryGrant,
  type Schedule,
} from "../../../lib/types.ts";
import {
  addIntegrationRoute,
  connectIntegration,
  createSchedule,
  deleteSchedule,
  disconnectIntegration,
  fireSchedule,
  previewCron,
  removeIntegrationRoute,
  setScheduleEnabled,
  updateIntegrationRoute,
  updateSchedule,
} from "./actions.ts";

export const muted = { margin: 0 } as const;

function ReadOnlyNote({ permission }: { permission: "integrations.manage" | "schedules.manage" }) {
  return (
    <p className="oq-muted" style={muted}>
      Read-only: changing these needs the <strong>{PERMISSION_LABEL[permission].label}</strong> permission (<code>{permission}</code>).
    </p>
  );
}

export function NoGrants({ org, what }: { org: OrganizationView; what: string }) {
  return (
    <Banner intent="warning" title="No repositories granted">
      <p>
        {what} needs a repository to send work to, and {org.name} has none. Grant one under <a href="/settings/access">Repository access</a> first.
      </p>
    </Banner>
  );
}

export function RepoSelect({ id, grants, defaultValue, name = "repositoryId" }: { id: string; grants: RepositoryGrant[]; defaultValue?: string; name?: string }) {
  return (
    <select id={id} name={name} className="oq-input" defaultValue={defaultValue ?? grants[0]?.repositoryId}>
      {grants.map((g) => (
        <option key={g.repositoryId} value={g.repositoryId}>
          {g.fullName}
        </option>
      ))}
    </select>
  );
}

export const repoNamer = (grants: RepositoryGrant[]) => {
  const names = new Map(grants.map((g) => [g.repositoryId, g.fullName]));
  return (id: string) => names.get(id) ?? "a repository no longer granted here";
};

function scopeText(route: IntegrationRoute): string {
  switch (route.scopeKind) {
    case "default":
      return "Everything else (default)";
    case "slack_channel":
      return `Channel ${route.scopeValue}`;
    case "linear_team":
      return `Team ${route.scopeValue}`;
    case "jira_project":
      return `Project ${route.scopeValue}`;
    case "sentry_project":
      return `Sentry project ${route.scopeValue}`;
  }
}

function RouteRow({ integration, route, grants, manage }: { integration: Integration; route: IntegrationRoute; grants: RepositoryGrant[]; manage: boolean }) {
  const repoName = repoNamer(grants);
  const f = `route-${route.id}`;
  return (
    <li className="console-list__static console-route">
      <span className="console-list__main">
        <span className="console-list__title">
          {scopeText(route)}{" "}
          {route.enabled ? null : (
            <Badge small intent="warning">
              off
            </Badge>
          )}
        </span>
        <span className="console-list__next">
          → {repoName(route.repositoryId)} · items labelled <code>{route.triggerLabel}</code>
        </span>
        {manage ? (
          <details className="console-inline-edit">
            <summary className="console-meta">Change</summary>
            <SimpleForm action={updateIntegrationRoute.bind(null, integration.id, route.id)} submitLabel="Save route">
              <div className="console-composer-form__row">
                <div className="oq-field">
                  <label className="oq-field__label" htmlFor={`${f}-repo`}>
                    Repository
                  </label>
                  <RepoSelect id={`${f}-repo`} grants={grants} defaultValue={route.repositoryId} />
                </div>
                <div className="oq-field">
                  <label className="oq-field__label" htmlFor={`${f}-label`}>
                    Trigger label
                  </label>
                  <input id={`${f}-label`} name="triggerLabel" className="oq-input oq-input--mono" defaultValue={route.triggerLabel} maxLength={100} required />
                </div>
              </div>
              <label className="console-choice__item">
                <input type="checkbox" name="enabled" defaultChecked={route.enabled} />
                <span>
                  <span className="console-choice__label">Enabled</span>
                  <span className="console-choice__detail">Off: its items are ignored with a reason, not sent to the default route.</span>
                </span>
              </label>
            </SimpleForm>
          </details>
        ) : null}
      </span>
      {manage ? (
        <ConfirmAction
          label="Remove"
          question={`Remove the route for ${scopeText(route).toLowerCase()}?`}
          consequence={
            route.scopeKind === "default"
              ? "Items that match no other route stop starting work."
              : "Its items fall through to the default route, if there is one."
          }
          confirmLabel="Remove route"
          run={removeIntegrationRoute.bind(null, integration.id, route.id)}
        />
      ) : null}
    </li>
  );
}

function AddRoute({ integration, grants }: { integration: Integration; grants: RepositoryGrant[] }) {
  const scope = PROVIDER_SCOPE[integration.provider];
  const hasDefault = integration.routes.some((r) => r.scopeKind === "default");
  const f = `add-${integration.id}`;
  return (
    <details className="console-inline-edit" open={integration.routes.length === 0}>
      <summary className="console-meta">Add a route</summary>
      <SimpleForm action={addIntegrationRoute.bind(null, integration.id, integration.provider)} submitLabel="Add route">
        <div className="console-composer-form__row">
          <div className="oq-field">
            <label className="oq-field__label" htmlFor={`${f}-kind`}>
              Applies to
            </label>
            <select id={`${f}-kind`} name="scopeKind" className="oq-input" defaultValue={hasDefault ? scope.kind : "default"}>
              {hasDefault ? null : <option value="default">Everything (default)</option>}
              <option value={scope.kind}>One {scope.label.replace(/ (key|id|key or id)$/i, "").toLowerCase()}</option>
            </select>
          </div>
          <div className="oq-field">
            <label className="oq-field__label" htmlFor={`${f}-value`}>
              {scope.label}
            </label>
            <input id={`${f}-value`} name="scopeValue" className="oq-input oq-input--mono" placeholder={scope.example} autoComplete="off" />
            <p className="oq-field__hint">Leave empty for the default route.</p>
          </div>
        </div>
        <div className="console-composer-form__row">
          <div className="oq-field">
            <label className="oq-field__label" htmlFor={`${f}-repo`}>
              Repository
            </label>
            <RepoSelect id={`${f}-repo`} grants={grants} />
          </div>
          <div className="oq-field">
            <label className="oq-field__label" htmlFor={`${f}-label`}>
              Trigger label
            </label>
            <input id={`${f}-label`} name="triggerLabel" className="oq-input oq-input--mono" defaultValue="windkeel" maxLength={100} />
          </div>
        </div>
        <label className="console-choice__item">
          <input type="checkbox" name="enabled" defaultChecked />
          <span>
            <span className="console-choice__label">Enabled</span>
          </span>
        </label>
      </SimpleForm>
    </details>
  );
}

export async function Integrations({ org }: { org: OrganizationView }) {
  const manage = canManage("integrations", org.permissions);
  const [connections, grants, members] = await Promise.all([automations.listIntegrations(org.id), listGrants(org.id), listMembers(org.id)]);
  const people = new Map(members.map((m) => [m.principalId, m.githubLogin ? `@${m.githubLogin}` : m.displayName]));
  const who = (id: string | null | undefined) => (id ? (people.get(id) ?? "someone no longer here") : null);
  const active = connections.filter((c) => c.status === "active");
  const gone = connections.filter((c) => c.status !== "active");
  return (
    <>
      <section className="console-section">
        <h2>Connected workspaces</h2>
        <p className="oq-muted" style={muted}>
          A labelled Slack message, Linear issue or Jira issue starts work the way a labelled GitHub issue does. Each workspace's routes decide which repository
          it goes to; Windkeel keeps no provider credentials — Vercel Connect holds them.
        </p>
        {manage ? null : <ReadOnlyNote permission="integrations.manage" />}
        {active.length === 0 ? (
          <p className="oq-muted" style={muted}>
            Nothing connected yet.
          </p>
        ) : null}
        {active.map((c) => (
          <div key={c.id} className="console-card oq-stack" style={{ ["--gap" as string]: "var(--space-3)" }}>
            <div className="console-card__head">
              <span className="console-list__main">
                <span className="console-list__title">
                  <Badge small>{PROVIDER_LABEL[c.provider]}</Badge> {c.externalTenantName ?? c.externalTenantId}
                </span>
                <span className="console-meta">
                  <Badge small intent="success">
                    connected
                  </Badge>{" "}
                  {who(c.createdByPrincipalId) ? `by ${who(c.createdByPrincipalId)}, ` : ""}
                  {time(c.createdAt)} · installation <span className="oq-mono">{c.installationId}</span>
                </span>
              </span>
              {manage ? (
                <ConfirmAction
                  label="Disconnect"
                  question={`Disconnect ${c.externalTenantName ?? c.externalTenantId}?`}
                  consequence={`Its ${PROVIDER_LABEL[c.provider]} items stop starting work in ${org.name}, and another organization may connect it. Tasks already filed keep running.`}
                  confirmLabel="Disconnect"
                  run={disconnectIntegration.bind(null, c.id)}
                />
              ) : null}
            </div>
            {c.routes.length ? (
              <ul className="console-list">
                {c.routes.map((r) => (
                  <RouteRow key={r.id} integration={c} route={r} grants={grants} manage={manage} />
                ))}
              </ul>
            ) : (
              <Banner intent="warning" title="No routes">
                <p>Nothing from this workspace starts work until it has a route to a repository.</p>
              </Banner>
            )}
            {manage && grants.length ? <AddRoute integration={c} grants={grants} /> : null}
          </div>
        ))}
        {gone.length ? (
          <details>
            <summary className="console-meta">{gone.length} disconnected</summary>
            <ul className="console-list">
              {gone.map((c) => (
                <li key={c.id} className="console-list__static" style={{ opacity: 0.65 }}>
                  <span className="console-list__main">
                    <span className="console-list__title">
                      {PROVIDER_LABEL[c.provider]} · {c.externalTenantName ?? c.externalTenantId}
                    </span>
                    <span className="console-meta">disconnected {time(c.disconnectedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      {manage ? (
        <section className="console-section">
          <h2>Connect a workspace</h2>
          {grants.length === 0 ? <NoGrants org={org} what="A workspace" /> : null}
          <p className="oq-muted" style={muted}>
            Install the provider's connector into the workspace from the Vercel dashboard, then paste the installation id it shows. Windkeel asks Vercel Connect
            which workspace that is and keeps only its id and name.
          </p>
          <SimpleForm action={connectIntegration} submitLabel="Connect">
            <div className="console-composer-form__row">
              <div className="oq-field">
                <label className="oq-field__label" htmlFor="int-provider">
                  Provider
                </label>
                <select id="int-provider" name="provider" className="oq-input" defaultValue="slack">
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_LABEL[p]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="oq-field">
                <label className="oq-field__label" htmlFor="int-installation">
                  Installation id
                </label>
                <input id="int-installation" name="installationId" className="oq-input oq-input--mono" placeholder="icfg_…" autoComplete="off" required />
              </div>
            </div>
          </SimpleForm>
        </section>
      ) : null}
    </>
  );
}

const SCHEDULE_PAGES = 20;

async function allSchedules(orgId: string): Promise<{ items: Schedule[]; truncated: boolean }> {
  let page = await automations.listSchedules(orgId);
  const items = [...page.items];
  for (let n = 1; page.hasNextPage && page.endCursor && n < SCHEDULE_PAGES; n++) {
    page = await automations.listSchedules(orgId, page.endCursor);
    items.push(...page.items);
  }
  return { items, truncated: page.hasNextPage };
}

export async function Schedules({ org }: { org: OrganizationView }) {
  const manage = canManage("schedules", org.permissions);
  const [{ items: schedules, truncated }, grants] = await Promise.all([allSchedules(org.id), listGrants(org.id)]);
  const repoName = repoNamer(grants);
  const repos = grants.map((g) => ({ id: g.repositoryId, fullName: g.fullName }));
  return (
    <>
      <section className="console-section">
        <h2>Schedules</h2>
        <p className="oq-muted" style={muted}>
          Each fire files one task as the organization's schedule actor, never as a person. A schedule waits while its previous run is still open — including
          an unmerged pull request — rather than stacking copies of the same work.
        </p>
        {manage ? null : <ReadOnlyNote permission="schedules.manage" />}
        {truncated ? (
          <Banner intent="warning" title={`Showing the newest ${schedules.length} schedules`}>
            <p>There are more than this page reads. Use the API or <code>windkeel schedule list</code> to see the rest.</p>
          </Banner>
        ) : null}
        {schedules.length ? (
          <ul className="console-list">
            {schedules.map((s) => {
              const outcome = lastOutcomeText(s.lastOutcome);
              return (
                <li key={s.id} className="console-list__static console-schedule">
                  <span className="console-list__main">
                    <span className="console-list__title">{s.name}</span>
                    <span className="console-list__next">
                      <code>{s.cron}</code> · {s.timezone} · {repoName(s.repositoryId)}
                    </span>
                    <span className="console-meta">
                      {s.enabled && s.nextFireTimes[0] ? `next ${inZone(s.nextFireTimes[0], s.timezone)}` : "paused"} ·{" "}
                      <Badge small intent={outcome.intent}>
                        {outcome.text}
                      </Badge>
                      {s.lastFiredAt ? ` ${age(s.lastFiredAt)} ago` : ""}
                    </span>
                    {manage ? (
                      <LazyDetails summary="Edit">
                        <ScheduleForm
                          key={s.updatedAt}
                          idPrefix={`sch-${s.id}`}
                          action={updateSchedule.bind(null, s.id)}
                          preview={previewCron}
                          repositories={repos}
                          initial={s}
                          submitLabel="Save schedule"
                        />
                      </LazyDetails>
                    ) : null}
                  </span>
                  {manage ? (
                    <span className="console-row-actions">
                      <Toggle id={`sch-on-${s.id}`} label="Enabled" checked={s.enabled} save={setScheduleEnabled.bind(null, s.id)} />
                      <ConfirmAction
                        label="Fire now"
                        question={`Fire “${s.name}” now?`}
                        consequence={`Files “${s.title}” on ${repoName(s.repositoryId)} now, once. Its next scheduled slot doesn't move. If its previous run is still open, nothing is fired.`}
                        confirmLabel="Fire now"
                        intent="primary"
                        buttonClass="oq-button--secondary"
                        run={fireSchedule.bind(null, s.id)}
                      />
                      <ConfirmAction
                        label="Delete"
                        question={`Delete “${s.name}”?`}
                        consequence="It stops firing. Tasks and runs it already started keep their records."
                        confirmLabel="Delete schedule"
                        run={deleteSchedule.bind(null, s.id)}
                      />
                    </span>
                  ) : (
                    <span className="console-meta">{s.enabled ? "enabled" : "disabled"}</span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="oq-muted" style={muted}>
            No schedules yet.
          </p>
        )}
      </section>
      {manage ? (
        <section className="console-section">
          <h2>New schedule</h2>
          {grants.length ? (
            <ScheduleForm idPrefix="sch-new" action={createSchedule} preview={previewCron} repositories={repos} submitLabel="Create schedule" />
          ) : (
            <NoGrants org={org} what="A schedule" />
          )}
        </section>
      ) : null}
    </>
  );
}
