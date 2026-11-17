import { ConfirmAction } from "../../../components/confirm-action.tsx";
import { SimpleForm } from "../../../components/simple-form.tsx";
import { Badge } from "../../../components/status.tsx";
import { ApiError, playbooks } from "../../../lib/api.ts";
import { PERMISSION_LABEL, canManage } from "../../../lib/permissions.ts";
import { PLAYBOOK_KINDS, formDefaults, verifierSentence, type Playbook } from "../../../lib/playbooks.ts";
import type { OrganizationView } from "../../../lib/types.ts";
import { archivePlaybook, duplicatePlaybook, savePlaybook } from "./actions.ts";

const muted = { margin: 0 } as const;

function PlaybookFields({ id, playbook }: { id: string; playbook?: Playbook }) {
  const d = playbook ? formDefaults(playbook) : null;
  return (
    <>
      <div className="console-composer-form__row">
        <div className="oq-field">
          <label className="oq-field__label" htmlFor={`${id}-name`}>
            Name
          </label>
          <input id={`${id}-name`} name="name" className="oq-input" defaultValue={d?.name ?? ""} maxLength={60} required />
        </div>
        <div className="oq-field">
          <label className="oq-field__label" htmlFor={`${id}-slug`}>
            Slug <span className="console-meta">what --playbook takes</span>
          </label>
          <input id={`${id}-slug`} name="slug" className="oq-input oq-mono" defaultValue={d?.slug ?? ""} maxLength={40} required />
        </div>
        <div className="oq-field">
          <label className="oq-field__label" htmlFor={`${id}-kind`}>
            Kind
          </label>
          <select id={`${id}-kind`} name="kind" className="oq-input" defaultValue={d?.kind ?? "custom"}>
            {PLAYBOOK_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="oq-field">
        <label className="oq-field__label" htmlFor={`${id}-instructions`}>
          Instructions for the maker
        </label>
        <textarea id={`${id}-instructions`} name="makerInstructions" className="oq-input" rows={6} defaultValue={d?.makerInstructions ?? ""} maxLength={8000} required />
      </div>
      <div className="oq-field">
        <label className="oq-field__label" htmlFor={`${id}-criteria`}>
          Added criteria <span className="console-meta">one per line; added to the task's own, never instead of them</span>
        </label>
        <textarea id={`${id}-criteria`} name="criteria" className="oq-input" rows={3} defaultValue={d?.criteria ?? ""} />
      </div>
      <div className="oq-field">
        <label className="oq-field__label" htmlFor={`${id}-checks`}>
          Extra checks <span className="console-meta">one “name: command” per line; run by the verifier as playbook.name</span>
        </label>
        <textarea id={`${id}-checks`} name="extraChecks" className="oq-input oq-mono" rows={2} defaultValue={d?.extraChecks ?? ""} />
      </div>
      <fieldset className="console-choice">
        <legend className="oq-field__label">The verifier will also</legend>
        <label className="console-choice__item">
          <input type="checkbox" name="checksRequired" defaultChecked={d?.checksRequired ?? false} />
          <span className="console-choice__label">Fail when the repository declares no checks</span>
        </label>
        <label className="console-choice__item">
          <input type="checkbox" name="require-security" defaultChecked={d?.requireSecurity ?? false} />
          <span className="console-choice__label">Require the security stage to run</span>
        </label>
        <label className="console-choice__item">
          <input type="checkbox" name="require-browser" defaultChecked={d?.requireBrowser ?? false} />
          <span className="console-choice__label">Require the browser stage to run</span>
        </label>
      </fieldset>
      <div className="oq-field">
        <label className="oq-field__label" htmlFor={`${id}-risk`}>
          Default risk level <span className="console-meta">when the task doesn't choose one</span>
        </label>
        <select id={`${id}-risk`} name="defaultRiskLevel" className="oq-input" defaultValue={d?.defaultRiskLevel ?? ""}>
          <option value="">None</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </div>
    </>
  );
}

export async function Playbooks({ org }: { org: OrganizationView }) {
  const manage = canManage("playbooks", org.permissions);
  let items: Playbook[] = [];
  let error: string | null = null;
  try {
    items = await playbooks.list(org.id);
  } catch (err) {
    if (err instanceof ApiError) error = err.message;
    else throw err;
  }
  return (
    <section className="console-section" aria-labelledby="playbooks">
      <h2 id="playbooks">Playbooks</h2>
      <p className="oq-muted" style={muted}>
        A playbook gives the maker instructions for a kind of work and asks the verifier to check more. It can never skip or weaken a check, and
        its criteria are added to the task's own. Editing one changes no task already filed: each keeps the version it was filed with.
      </p>
      {!manage ? (
        <p className="oq-muted" style={muted}>
          Read-only: changing these needs <strong>{PERMISSION_LABEL["playbooks.manage"].label}</strong> (<code>playbooks.manage</code>), which admins have.
        </p>
      ) : null}
      {error ? (
        <p className="oq-field__error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="console-list" aria-label="Playbooks">
        {items.map((p) => {
          const verifier = verifierSentence(p.verifierAdds);
          return (
            <li key={p.id ?? `builtin-${p.slug}`} data-playbook={p.slug}>
              <div>
                <strong>{p.name}</strong> <span className="oq-mono">{p.slug}</span>{" "}
                <Badge small intent="neutral">
                  {`v${p.version}`}
                </Badge>{" "}
                {p.builtin ? (
                  <Badge small intent="agent">
                    built-in
                  </Badge>
                ) : null}
              </div>
              {p.addedCriteria.length ? <p style={muted}>Adds: {p.addedCriteria.map((c) => `${c.id} — ${c.text}`).join("; ")}</p> : null}
              {verifier ? <p style={muted}>{verifier}</p> : null}
              {manage && p.builtin ? (
                <details className="console-disclosure">
                  <summary>
                    <span className="console-disclosure__title">Duplicate</span>
                    <span className="console-meta">Copy it into one of yours to edit</span>
                  </summary>
                  <SimpleForm action={duplicatePlaybook.bind(null, p.slug)} submitLabel="Duplicate">
                    <div className="oq-field">
                      <label className="oq-field__label" htmlFor={`dup-${p.slug}`}>
                        Slug for the copy <span className="console-meta">blank keeps “{p.slug}”, which replaces the built-in here</span>
                      </label>
                      <input id={`dup-${p.slug}`} name="slug" className="oq-input oq-mono" maxLength={40} />
                    </div>
                  </SimpleForm>
                </details>
              ) : null}
              {manage && !p.builtin && p.id ? (
                <>
                  <details className="console-disclosure">
                    <summary>
                      <span className="console-disclosure__title">Edit</span>
                    </summary>
                    <SimpleForm action={savePlaybook.bind(null, p.id)} submitLabel="Save playbook">
                      <PlaybookFields id={`pb-${p.id}`} playbook={p} />
                    </SimpleForm>
                  </details>
                  <ConfirmAction
                    label="Archive"
                    question={`Archive the playbook “${p.name}”?`}
                    consequence="It's no longer offered when filing work, and its slug is free again. Tasks filed under it keep their copy."
                    confirmLabel="Archive playbook"
                    run={archivePlaybook.bind(null, p.id)}
                  />
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      {manage ? (
        <details className="console-disclosure">
          <summary>
            <span className="console-disclosure__title">Add a playbook</span>
            <span className="console-meta">Instructions, criteria and checks for a kind of work</span>
          </summary>
          <SimpleForm action={savePlaybook.bind(null, null)} submitLabel="Add playbook">
            <PlaybookFields id="pb-new" />
          </SimpleForm>
        </details>
      ) : null}
    </section>
  );
}
