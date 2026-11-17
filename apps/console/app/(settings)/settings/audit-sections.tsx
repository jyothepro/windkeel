import { ConfirmAction } from "../../../components/confirm-action.tsx";
import { SimpleForm } from "../../../components/simple-form.tsx";
import { listAccountRoles, listAuditEvents } from "../../../lib/api.ts";
import { time } from "../../../lib/format.ts";
import { PERMISSION_LABEL, PERMISSIONS, isPermission } from "../../../lib/permissions.ts";
import type { AuditEvent, OrganizationView } from "../../../lib/types.ts";
import { createCustomRole, deleteCustomRole } from "./actions.ts";

export interface AuditFilter {
  action?: string;
  after?: string;
  before?: string;
  cursor?: string;
}

function day(raw: string | undefined): string | undefined {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : undefined;
}

function who(e: AuditEvent): string {
  const kind = e.actorKind === "token" ? " (token)" : e.actorKind === "github" ? " (on GitHub)" : e.actorKind === "system" ? " (Windkeel)" : "";
  return `${e.actorText}${kind}`;
}

function what(e: AuditEvent): string {
  const d = e.detail;
  const bits = [d["key"], d["name"], d["role"], d["to"] ? `→ ${String(d["to"])}` : undefined, d["reason"], d["verdict"]]
    .filter((v) => typeof v === "string" && v !== "")
    .map(String);
  return [e.targetType ? `${e.targetType}${e.targetId ? ` ${e.targetId.slice(0, 8)}` : ""}` : null, ...bits].filter(Boolean).join(" · ");
}

export async function AuditLog({ org, filter, accountHeld = [] }: { org: OrganizationView; filter: AuditFilter; accountHeld?: readonly string[] }) {
  const query = {
    ...(filter.action ? { action: filter.action } : {}),
    ...(day(filter.after) ? { after: day(filter.after)! } : {}),
    ...(day(filter.before) ? { before: day(filter.before)! } : {}),
    ...(filter.cursor ? { cursor: filter.cursor } : {}),
  };
  let page;
  let refused: string | null = null;
  try {
    page = await listAuditEvents(org.id, query);
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  const exportQuery = new URLSearchParams({ ...query, format: "csv" });
  exportQuery.delete("cursor");
  const next = page?.hasNextPage && page.endCursor ? new URLSearchParams({ ...filter, cursor: page.endCursor }) : null;

  return (
    <>
      <section className="console-section">
        <h2>Events</h2>
        <form method="get" action="/settings/audit" className="console-composer-form__row" aria-label="Filter the audit log">
          <div className="oq-field">
            <label className="oq-field__label" htmlFor="audit-action">
              Action
            </label>
            <input id="audit-action" name="action" className="oq-input oq-input--mono" placeholder="token.* or run.merged" defaultValue={filter.action ?? ""} />
          </div>
          <div className="oq-field">
            <label className="oq-field__label" htmlFor="audit-after">
              From
            </label>
            <input id="audit-after" name="after" type="date" className="oq-input" defaultValue={filter.after ?? ""} />
          </div>
          <div className="oq-field">
            <label className="oq-field__label" htmlFor="audit-before">
              Until
            </label>
            <input id="audit-before" name="before" type="date" className="oq-input" defaultValue={filter.before ?? ""} />
          </div>
          <button type="submit" className="oq-button oq-button--sm">
            Filter
          </button>
          <a className="oq-button oq-button--sm" href={`/api/audit/export?${exportQuery.toString()}`} download>
            Export CSV
          </a>
        </form>
        {refused ? (
          <p className="oq-muted" style={{ margin: 0 }}>
            {refused}
          </p>
        ) : page && page.items.length ? (
          <div className="console-table-wrap">
          <table className="console-table" aria-label="Audit events">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>What</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((e) => (
                <tr key={e.id}>
                  <td className="console-meta">{time(e.occurredAt)}</td>
                  <td>{who(e)}</td>
                  <td className="oq-mono">{e.action}</td>
                  <td className="console-meta">{what(e)}</td>
                  <td className="oq-mono console-meta">{e.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ) : (
          <p className="oq-muted" style={{ margin: 0 }}>
            No events match.
          </p>
        )}
        {next ? (
          <a className="oq-button oq-button--sm" href={`/settings/audit?${next.toString()}`}>
            Older events
          </a>
        ) : null}
        {accountHeld.includes("audit.read") ? (
          <a className="oq-button oq-button--sm" href="/api/access-review" download>
            Access review (CSV): everyone in the account, their roles and tokens
          </a>
        ) : null}
        <p className="oq-muted" style={{ margin: 0 }}>
          The export carries up to 4 MB; for a longer range, or the whole account, use <code>windkeel audit export</code>. Every row is part of a hash
          chain the API can verify (<code>windkeel audit verify</code>).
        </p>
      </section>
    </>
  );
}

export async function Roles({ held }: { held: readonly string[] }) {
  const roles = await listAccountRoles();
  const grantable = PERMISSIONS.filter((p) => held.includes(p));
  return (
    <>
      <section className="console-section">
        <h2>Roles</h2>
        <ul className="console-list">
          {roles.map((r) => (
            <li key={r.id} className="console-list__static">
              <span className="console-list__main">
                <span className="console-list__title">
                  {r.name} <span className="oq-mono console-meta">{r.key}</span>
                  {r.builtIn ? <span className="console-meta"> · built-in</span> : null}
                </span>
                {r.description ? <span className="console-list__next">{r.description}</span> : null}
                <span className="console-meta">
                  {r.permissions.filter(isPermission).map((p) => PERMISSION_LABEL[p].label).join(" · ") || "Nothing"}
                </span>
              </span>
              {r.builtIn ? null : (
                <ConfirmAction
                  label="Delete"
                  question={`Delete the ${r.name} role?`}
                  consequence="Only a role nobody holds, and no pending invitation offers, can be deleted."
                  confirmLabel="Delete role"
                  run={deleteCustomRole.bind(null, r.id)}
                />
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="console-section">
        <h2>New role</h2>
        <SimpleForm action={createCustomRole} submitLabel="Create role">
          <div className="oq-field">
            <label className="oq-field__label" htmlFor="role-name">
              Name
            </label>
            <input id="role-name" name="name" className="oq-input" placeholder="Member + merge" required maxLength={80} />
          </div>
          <div className="oq-field">
            <label className="oq-field__label" htmlFor="role-description">
              Description
            </label>
            <input id="role-description" name="description" className="oq-input" maxLength={500} />
          </div>
          <fieldset className="console-choice">
            <legend className="oq-field__label">Permissions — never more than you hold</legend>
            {grantable.map((p) => (
              <label key={p} className="console-choice__item">
                <input type="checkbox" name="permissions" value={p} />
                <span>
                  <span className="console-choice__label">{PERMISSION_LABEL[p].label}</span>
                  <span className="console-choice__detail">{PERMISSION_LABEL[p].detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </SimpleForm>
      </section>
    </>
  );
}
