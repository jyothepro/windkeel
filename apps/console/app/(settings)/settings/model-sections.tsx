import { Banner } from "../../../components/banner.tsx";
import { ConfirmAction } from "../../../components/confirm-action.tsx";
import { ActionButton, CredentialForm, PolicyForm, RotateCredential, type CredentialOption, type RoleChoice } from "../../../components/model-controls.tsx";
import { Badge } from "../../../components/status.tsx";
import { ApiError, models } from "../../../lib/api.ts";
import { age, time } from "../../../lib/format.ts";
import {
  MODEL_ROLES,
  ROLE_LABEL,
  STATUS_WORDS,
  effectiveChoice,
  harnessName,
  providerName,
  vendorOf,
  type HarnessView,
  type ModelCredential,
  type ModelPolicyEntry,
  type ModelPreset,
  type ModelRole,
  type TaskModelChoice,
} from "../../../lib/models.ts";
import { fallbackNote } from "../../../lib/model-actions.ts";
import { PERMISSION_LABEL, canManage } from "../../../lib/permissions.ts";
import type { OrganizationView } from "../../../lib/types.ts";
import {
  addModelCredential,
  checkModelCredential,
  clearModelPolicy,
  deleteModelPreset,
  revokeModelCredential,
  rotateModelCredential,
  saveModelPolicy,
  saveModelPreset,
} from "./actions.ts";

const muted = { margin: 0 } as const;

function ReadOnly() {
  return (
    <p className="oq-muted" style={muted}>
      Read-only: changing these needs the <strong>{PERMISSION_LABEL["models.manage"].label}</strong> permission (<code>models.manage</code>), which admins
      have.
    </p>
  );
}

const options = (credentials: ModelCredential[]): CredentialOption[] =>
  credentials.map(({ id, label, provider, baseUrl, last4, status, declaredVendor }) => ({ id, label, provider, baseUrl, last4, status, declaredVendor }));

const choiceOf = (row: ModelPolicyEntry | null): RoleChoice | undefined =>
  row ? { provider: row.provider, model: row.model, credentialId: row.credentialId, declaredVendor: row.declaredVendor } : undefined;

function ChoiceText({ row, credentials }: { row: ModelPolicyEntry; credentials: ModelCredential[] }) {
  const credential = row.credentialId ? credentials.find((c) => c.id === row.credentialId) : null;
  const vendor = vendorOf({ provider: row.provider, model: row.model, declaredVendor: row.declaredVendor ?? credential?.declaredVendor });
  return (
    <>
      <span className="oq-mono">{row.model}</span>
      <span className="console-meta">
        {" "}
        · {providerName(row.provider, credential?.baseUrl)}
        {"vendor" in vendor && vendor.vendor !== row.provider ? ` (${vendor.vendor}'s model)` : ""} ·{" "}
        {row.credentialId ? (credential ? `key “${credential.label}” …${credential.last4}` : "a key that's since been revoked") : "Windkeel-managed key"}
      </span>
    </>
  );
}

function CredentialRow({ c, manage }: { c: ModelCredential; manage: boolean }) {
  const status = STATUS_WORDS[c.status];
  return (
    <li className="console-list__static" data-credential={c.label}>
      <span className="console-list__main">
        <span className="console-list__title">
          {c.label} <span className="oq-mono console-meta">…{c.last4}</span> <Badge intent={status.intent} small>{status.label}</Badge>
        </span>
        <span className="console-list__next">
          {providerName(c.provider, c.baseUrl)}
          {c.declaredVendor ? ` · serves ${c.declaredVendor}'s models` : ""}
        </span>
        <span className="console-meta">
          {c.statusReason ? `${c.statusReason} · ` : ""}
          {c.validatedAt ? `checked ${age(c.validatedAt)} ago` : c.status === "unverified" ? "not checked yet" : ""} · added {time(c.createdAt)}
        </span>
      </span>
      {manage ? (
        <>
          <ActionButton label="Check again" run={checkModelCredential.bind(null, c.id)} />
          <RotateCredential id={c.id} label={c.label} action={rotateModelCredential.bind(null, c.id)} />
          <ConfirmAction
            label="Revoke"
            question={`Revoke “${c.label}”?`}
            consequence="Runs that start from now on can't use it, and a policy that names it refuses to start them until you choose another key. A run already going keeps its own copy of the choice. This can't be undone; the label becomes free."
            confirmLabel="Revoke key"
            run={revokeModelCredential.bind(null, c.id)}
          />
        </>
      ) : null}
    </li>
  );
}

export async function Models({ org }: { org: OrganizationView }) {
  const manage = canManage("models", org.permissions);
  const [credentials, policy] = await Promise.all([models.listCredentials(org.id), models.getPolicy(org.id)]);
  const live = credentials.filter((c) => c.status !== "revoked");
  const row = (role: ModelRole) => effectiveChoice(policy.items, role, null).own;
  const invalid = live.filter((c) => c.status === "invalid");

  return (
    <>
      <section className="console-section" aria-labelledby="model-keys">
        <h2 id="model-keys">Keys</h2>
        <p className="oq-muted" style={muted}>
          {org.name}'s own keys for model providers. A key is sealed when it's stored, so this console and the API can't read it back; it's opened
          only inside the step that calls the model. Without one, runs use <strong>Windkeel-managed</strong> models on the operator's keys.
        </p>
        {!manage ? <ReadOnly /> : null}
        {invalid.length ? (
          <Banner intent="warning" title={`${invalid.length === 1 ? "A key was" : `${invalid.length} keys were`} refused by the provider`}>
            <p>Runs routed to {invalid.map((c) => `“${c.label}”`).join(", ")} will fail when they call the model. Rotate the key, or choose another for those roles.</p>
          </Banner>
        ) : null}
        {live.length ? (
          <ul className="console-list" aria-label="Model keys">
            {live.map((c) => (
              <CredentialRow key={c.id} c={c} manage={manage} />
            ))}
          </ul>
        ) : (
          <p className="oq-muted" style={muted}>
            No keys yet.
          </p>
        )}
      </section>

      {manage ? (
        <section className="console-section" aria-labelledby="model-add">
          <h2 id="model-add">Add a key</h2>
          <CredentialForm action={addModelCredential} />
        </section>
      ) : null}

      <section className="console-section" aria-labelledby="model-defaults">
        <h2 id="model-defaults">Default models</h2>
        <p className="oq-muted" style={muted}>
          What every run in {org.name} uses unless its repository or its task says otherwise. Chosen once, when a run starts: changing this doesn't
          change a run already going. The <strong>checker</strong> must be another vendor's model than the <strong>maker</strong> — that's what
          makes its verdict independent.
        </p>
        <dl className="console-kv">
          {MODEL_ROLES.map((role) => {
            const r = row(role);
            return (
              <div key={role} style={{ display: "contents" }}>
                <dt>{ROLE_LABEL[role]}</dt>
                <dd>{r ? <ChoiceText row={r} credentials={credentials} /> : <span className="oq-muted">the operator's default, Windkeel-managed</span>}</dd>
              </div>
            );
          })}
        </dl>
        {manage ? (
          <>
            <PolicyForm action={saveModelPolicy.bind(null, null)} credentials={options(live)} current={{ maker: choiceOf(row("maker")), checker: choiceOf(row("checker")) }} />
            <ClearButtons layer={null} rows={MODEL_ROLES.flatMap((role) => (row(role) ? [role] : []))} where={`${org.name}'s default`} />
          </>
        ) : null}
      </section>

      <Presets orgName={org.name} manage={manage} presets={policy.presets ?? []} harnesses={policy.harnesses ?? []} credentials={credentials} />
    </>
  );
}

function presetChoice(choice: TaskModelChoice | undefined, credentials: ModelCredential[]): RoleChoice | undefined {
  if (!choice) return undefined;
  const credential = choice.credentialId ? credentials.find((c) => c.id === choice.credentialId) : null;
  return { provider: credential?.provider ?? choice.provider ?? "openai", model: choice.model, credentialId: choice.credentialId ?? null, declaredVendor: choice.declaredVendor ?? null };
}

function PresetChoiceText({ choice, credentials }: { choice: TaskModelChoice; credentials: ModelCredential[] }) {
  const credential = choice.credentialId ? credentials.find((c) => c.id === choice.credentialId) : null;
  return (
    <>
      <span className="oq-mono">{choice.model}</span>
      <span className="console-meta">
        {" "}
        · {credential ? `key “${credential.label}”` : choice.credentialId ? "a key that's since been revoked" : `${providerName(choice.provider ?? "")}, Windkeel-managed`}
      </span>
    </>
  );
}

function PresetFields({ id, preset, harnesses }: { id: string; preset?: ModelPreset; harnesses: HarnessView[] }) {
  return (
    <div className="console-composer-form__row">
      <div className="oq-field">
        <label className="oq-field__label" htmlFor={`${id}-name`}>
          Name
        </label>
        <input id={`${id}-name`} name="name" className="oq-input" defaultValue={preset?.name} placeholder="Fast" maxLength={40} autoComplete="off" required />
      </div>
      {harnesses.length > 1 ? (
        <div className="oq-field">
          <label className="oq-field__label" htmlFor={`${id}-harness`}>
            Agent
          </label>
          <select id={`${id}-harness`} name="harness" className="oq-input" defaultValue={preset?.harness ?? harnesses.find((h) => h.default)?.id}>
            {harnesses.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
                {h.default ? " (default)" : ""}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}

function Presets({
  orgName,
  manage,
  presets,
  harnesses,
  credentials,
}: {
  orgName: string;
  manage: boolean;
  presets: ModelPreset[];
  harnesses: HarnessView[];
  credentials: ModelCredential[];
}) {
  const live = credentials.filter((c) => c.status !== "revoked");
  return (
    <section className="console-section" aria-labelledby="model-presets">
      <h2 id="model-presets">Presets</h2>
      <p className="oq-muted" style={muted}>
        {orgName}'s own names for a maker and checker pairing — say <em>Fast</em> and <em>Thorough</em>. The composer offers them first, before the raw
        models; Windkeel ships none of its own. A preset is checked for independence when it's saved, and choosing one copies it into the task, so changing a
        preset later doesn't change any run.
      </p>
      {!manage ? <ReadOnly /> : null}
      {presets.length ? (
        <ul className="console-list" aria-label="Presets">
          {presets.map((p) => (
            <li key={p.id} className="console-list__static" data-preset={p.name}>
              <span className="console-list__main">
                <span className="console-list__title">{p.name}</span>
                <span className="console-list__next">
                  <PresetChoiceText choice={p.maker} credentials={credentials} /> makes; {p.checker.map((c, i) => (
                    <span key={i}>
                      {i ? ", then " : ""}
                      <PresetChoiceText choice={c} credentials={credentials} />
                    </span>
                  ))}{" "}
                  checks
                </span>
                {harnesses.length > 1 || p.harness ? <span className="console-meta">Agent: {harnessName(p.harness ?? harnesses.find((h) => h.default)?.id, harnesses)}</span> : null}
              </span>
              {manage ? (
                <>
                  <details className="console-disclosure">
                    <summary>
                      <span className="console-disclosure__title">Edit</span>
                    </summary>
                    <PolicyForm
                      action={saveModelPreset.bind(null, p.id)}
                      credentials={options(live)}
                      current={{ maker: presetChoice(p.maker, credentials), checker: presetChoice(p.checker[0], credentials) }}
                      submitLabel="Save preset"
                      label={`Edit ${p.name}`}
                      idPrefix={`preset-${p.id}-`}
                    >
                      <PresetFields id={`preset-${p.id}`} preset={p} harnesses={harnesses} />
                      {p.checker.length > 1 ? (
                        <p className="oq-field__hint" data-fallbacks={p.checker.length - 1}>
                          {fallbackNote(p)}
                        </p>
                      ) : null}
                    </PolicyForm>
                  </details>
                  <ConfirmAction
                    label="Delete"
                    question={`Delete the preset “${p.name}”?`}
                    consequence="It's no longer offered in the composer. Tasks and runs that chose it keep the models they copied from it."
                    confirmLabel="Delete preset"
                    run={deleteModelPreset.bind(null, p.id)}
                  />
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="oq-muted" style={muted}>
          No presets yet{manage ? "." : " — an admin can add them."}
        </p>
      )}
      {manage ? (
        <details className="console-disclosure">
          <summary>
            <span className="console-disclosure__title">Add a preset</span>
            <span className="console-meta">A name, a maker and a checker from another vendor</span>
          </summary>
          <PolicyForm action={saveModelPreset.bind(null, null)} credentials={options(live)} current={{}} submitLabel="Add preset" label="Add a preset" resetOnSave idPrefix="preset-new-">
            <PresetFields id="preset-new" harnesses={harnesses} />
          </PolicyForm>
        </details>
      ) : null}
    </section>
  );
}

function ClearButtons({ layer, rows, where }: { layer: string | null; rows: ModelRole[]; where: string }) {
  if (!rows.length) return null;
  return (
    <div className="console-actions">
      {rows.map((role) => (
        <ConfirmAction
          key={role}
          label={`Clear the ${role}`}
          question={`Clear the ${role} from ${where}?`}
          consequence={
            layer
              ? `Runs here then use ${role === "maker" ? "the organization's maker" : "the organization's checker"}, from the next one that starts.`
              : `Runs then use the operator's default ${role} on Windkeel-managed keys, unless a repository or task chooses one.`
          }
          confirmLabel="Clear"
          run={clearModelPolicy.bind(null, layer, role)}
        />
      ))}
    </div>
  );
}

export async function RepositoryModels({ org, repositoryId, repositoryName }: { org: OrganizationView; repositoryId: string; repositoryName: string }) {
  if (!org.permissions.includes("models.read") && !org.permissions.includes("models.manage")) return null;
  const manage = canManage("models", org.permissions);
  let credentials: ModelCredential[];
  let policy: Awaited<ReturnType<typeof models.getPolicy>>;
  try {
    [credentials, policy] = await Promise.all([models.listCredentials(org.id), models.getPolicy(org.id, repositoryId)]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
  const live = credentials.filter((c) => c.status !== "revoked");
  const layer = (role: ModelRole) => effectiveChoice(policy.items, role, repositoryId);

  return (
    <section className="console-section" aria-labelledby="repo-models">
      <h3 id="repo-models">Models</h3>
      <p className="oq-muted" style={muted}>
        Overrides {org.name}'s <a href="/settings/models">default models</a> for runs on this repository. A role left blank inherits the default.
      </p>
      {!manage ? <ReadOnly /> : null}
      <dl className="console-kv">
        {MODEL_ROLES.map((role) => {
          const { own, inherited } = layer(role);
          return (
            <div key={role} style={{ display: "contents" }}>
              <dt>{ROLE_LABEL[role]}</dt>
              <dd>
                {own ? (
                  <>
                    <ChoiceText row={own} credentials={credentials} /> <Badge small>override</Badge>
                  </>
                ) : inherited ? (
                  <>
                    <ChoiceText row={inherited} credentials={credentials} /> <span className="console-meta">· inherited</span>
                  </>
                ) : (
                  <span className="oq-muted">the operator's default, Windkeel-managed · inherited</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {manage ? (
        <>
          <PolicyForm
            action={saveModelPolicy.bind(null, repositoryId)}
            credentials={options(live)}
            current={{ maker: choiceOf(layer("maker").own), checker: choiceOf(layer("checker").own) }}
            inherited={{ maker: choiceOf(layer("maker").inherited), checker: choiceOf(layer("checker").inherited) }}
            inheritedFrom={`${org.name}'s default`}
            submitLabel="Save override"
          />
          <ClearButtons layer={repositoryId} rows={MODEL_ROLES.flatMap((role) => (layer(role).own ? [role] : []))} where={repositoryName} />
        </>
      ) : null}
    </section>
  );
}
