"use client";

import { useRef, useState, useTransition } from "react";
import type { ActionResult } from "../lib/action-result.ts";
import {
  MODEL_PROVIDERS,
  MODEL_ROLES,
  MODEL_SUGGESTIONS,
  PROVIDER_LABEL,
  ROLE_LABEL,
  independenceProblem,
  providerName,
  vendorOf,
  type ModelCredential,
  type ModelProvider,
  type ModelRole,
} from "../lib/models.ts";

const gap3 = { ["--gap" as string]: "var(--space-3)" };

function Outcome({ error, message }: { error: string | null; message: string | null }) {
  if (error)
    return (
      <p className="oq-field__error" role="alert">
        {error}
      </p>
    );
  if (message)
    return (
      <p className="console-meta" role="status">
        {message}
      </p>
    );
  return null;
}

function KeyField({ id, inputRef, hint }: { id: string; inputRef: React.RefObject<HTMLInputElement | null>; hint?: string }) {
  return (
    <div className="oq-field">
      <label className="oq-field__label" htmlFor={id}>
        Key
      </label>
      <input
        ref={inputRef}
        id={id}
        name="value"
        type="password"
        className="oq-input oq-input--mono"
        autoComplete="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        required
      />
      <p className="oq-field__hint">{hint ?? "Sent once, sealed so this server can't read it back, and never shown again — only its last four characters."}</p>
    </div>
  );
}

export function CredentialForm({ action }: { action: (form: FormData) => Promise<ActionResult> }) {
  const form = useRef<HTMLFormElement>(null);
  const key = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState<ModelProvider>("openai");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      ref={form}
      className="oq-stack"
      style={gap3}
      autoComplete="off"
      aria-label="Add a model key"
      action={(data) =>
        start(async () => {
          const res = await action(data);
          if (key.current) key.current.value = "";
          if (res.ok) {
            form.current?.reset();
            setProvider("openai");
            setError(null);
            setMessage(res.message ?? "Stored.");
          } else {
            setMessage(null);
            setError(res.message);
          }
        })
      }
    >
      <div className="console-composer-form__row">
        <div className="oq-field">
          <label className="oq-field__label" htmlFor="cred-provider">
            Provider
          </label>
          <select id="cred-provider" name="provider" className="oq-input" value={provider} onChange={(e) => setProvider(e.target.value as ModelProvider)}>
            {MODEL_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
        <div className="oq-field">
          <label className="oq-field__label" htmlFor="cred-label">
            Label
          </label>
          <input id="cred-label" name="label" className="oq-input" placeholder="prod" autoComplete="off" required />
        </div>
      </div>
      {provider === "openai-compatible" ? (
        <div className="console-composer-form__row">
          <div className="oq-field">
            <label className="oq-field__label" htmlFor="cred-base-url">
              Base URL
            </label>
            <input id="cred-base-url" name="baseUrl" className="oq-input oq-input--mono" placeholder="https://llm.example.com/v1" autoComplete="off" required />
            <p className="oq-field__hint">Public https only. A private, loopback or link-local address is refused, now and when Windkeel connects.</p>
          </div>
          <div className="oq-field">
            <label className="oq-field__label" htmlFor="cred-vendor">
              Whose models it serves
            </label>
            <input id="cred-vendor" name="declaredVendor" className="oq-input oq-input--mono" placeholder="meta" autoComplete="off" />
            <p className="oq-field__hint">Only for models Windkeel can't recognise by name — it decides whether a checker is independent.</p>
          </div>
        </div>
      ) : null}
      <KeyField id="cred-value" inputRef={key} />
      <Outcome error={error} message={message} />
      <div className="console-actions">
        <button type="submit" className="oq-button oq-button--primary" disabled={pending} aria-busy={pending}>
          {pending ? <span className="oq-spinner" aria-hidden="true" /> : null}
          Add key
        </button>
      </div>
    </form>
  );
}

export function RotateCredential({ id, label, action }: { id: string; label: string; action: (form: FormData) => Promise<ActionResult> }) {
  const key = useRef<HTMLInputElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <details ref={details} className="console-inline-details">
      <summary className="oq-button oq-button--ghost oq-button--sm">Rotate</summary>
      <form
        className="oq-stack"
        style={gap3}
        autoComplete="off"
        aria-label={`Rotate ${label}`}
        action={(data) =>
          start(async () => {
            const res = await action(data);
            if (key.current) key.current.value = "";
            setError(res.ok ? null : res.message);
            setMessage(res.ok ? (res.message ?? "Rotated.") : null);
            if (res.ok && details.current) details.current.open = false;
          })
        }
      >
        <KeyField id={`rotate-${id}`} inputRef={key} hint={`Replaces “${label}”'s key everywhere it's chosen, from the next run that starts.`} />
        <Outcome error={error} message={null} />
        <div className="console-actions">
          <button type="submit" className="oq-button oq-button--sm" disabled={pending} aria-busy={pending}>
            Rotate key
          </button>
        </div>
      </form>
      <Outcome error={null} message={message} />
    </details>
  );
}

export function ActionButton({ label, run }: { label: string; run: () => Promise<ActionResult> }) {
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <button
        type="button"
        className="oq-button oq-button--ghost oq-button--sm"
        disabled={pending}
        aria-busy={pending}
        onClick={() =>
          start(async () => {
            const res = await run();
            setError(res.ok ? null : res.message);
            setMessage(res.ok ? (res.message ?? null) : null);
          })
        }
      >
        {label}
      </button>
      <Outcome error={error} message={message} />
    </>
  );
}

export type CredentialOption = Pick<ModelCredential, "id" | "label" | "provider" | "baseUrl" | "last4" | "status" | "declaredVendor">;

export interface RoleChoice {
  provider: string;
  model: string;
  credentialId: string | null;
  declaredVendor: string | null;
}

type Draft = { key: string; provider: string; model: string; declaredVendor: string };

const draftOf = (c: RoleChoice | null | undefined): Draft => ({
  key: c?.credentialId ?? "orqon",
  provider: c?.provider && c.provider !== "openai-compatible" ? c.provider : "openai",
  model: c?.model ?? "",
  declaredVendor: c?.declaredVendor ?? "",
});

export function PolicyForm({
  action,
  credentials,
  current,
  inherited,
  inheritedFrom,
  submitLabel = "Save models",
  children,
  label = "Models",
  resetOnSave = false,
  idPrefix = "",
}: {
  action: (form: FormData) => Promise<ActionResult>;
  credentials: CredentialOption[];
  current: Partial<Record<ModelRole, RoleChoice>>;
  inherited?: Partial<Record<ModelRole, RoleChoice>>;
  inheritedFrom?: string;
  submitLabel?: string;
  children?: React.ReactNode;
  label?: string;
  resetOnSave?: boolean;
  idPrefix?: string;
}) {
  const [drafts, setDrafts] = useState<Record<ModelRole, Draft>>({ maker: draftOf(current.maker), checker: draftOf(current.checker) });
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const usable = credentials.filter((c) => c.status !== "revoked");

  const effective = (role: ModelRole) => {
    const d = drafts[role];
    if (d.model.trim()) {
      const credential = d.key === "orqon" ? null : usable.find((c) => c.id === d.key);
      return { provider: credential?.provider ?? d.provider, model: d.model.trim(), declaredVendor: d.declaredVendor.trim() || credential?.declaredVendor || null };
    }
    const i = inherited?.[role];
    if (!i) return null;
    const credential = i.credentialId ? usable.find((c) => c.id === i.credentialId) : null;
    return { provider: i.provider, model: i.model, declaredVendor: i.declaredVendor ?? credential?.declaredVendor ?? null };
  };
  const problem = independenceProblem(effective("maker"), effective("checker"));
  const set = (role: ModelRole, patch: Partial<Draft>) => setDrafts((all) => ({ ...all, [role]: { ...all[role], ...patch } }));

  return (
    <form
      ref={formRef}
      className="oq-stack"
      style={gap3}
      autoComplete="off"
      aria-label={label}
      action={(data) =>
        start(async () => {
          const res = await action(data);
          setError(res.ok ? null : res.message);
          setMessage(res.ok ? (res.message ?? "Saved.") : null);
          if (res.ok && resetOnSave) {
            formRef.current?.reset();
            setDrafts({ maker: draftOf(undefined), checker: draftOf(undefined) });
          }
        })
      }
    >
      {children}
      {MODEL_ROLES.map((role) => {
        const d = drafts[role];
        const credential = d.key === "orqon" ? null : usable.find((c) => c.id === d.key) ?? null;
        const provider = credential?.provider ?? d.provider;
        const eff = effective(role);
        const vendor = eff ? vendorOf(eff) : null;
        const inheritedChoice = inherited?.[role];
        return (
          <fieldset key={role} className="console-fieldset" data-role={role}>
            <legend className="oq-field__label">
              {ROLE_LABEL[role]} <span className="console-meta">{role === "maker" ? "writes the change (Codex speaks OpenAI's formats)" : "reviews it, independently"}</span>
            </legend>
            <div className="console-composer-form__row">
              <div className="oq-field">
                <label className="oq-field__label" htmlFor={`${idPrefix}${role}-key`}>
                  Key
                </label>
                <select id={`${idPrefix}${role}-key`} name={`${role}.key`} className="oq-input" value={d.key} onChange={(e) => set(role, { key: e.target.value })}>
                  <option value="orqon">Windkeel-managed (the operator's keys)</option>
                  {usable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label} · {providerName(c.provider, c.baseUrl)} · …{c.last4}
                      {c.status === "valid" ? "" : ` (${c.status})`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="oq-field">
                <label className="oq-field__label" htmlFor={`${idPrefix}${role}-provider`}>
                  Provider
                </label>
                {credential ? (
                  <input id={`${idPrefix}${role}-provider`} className="oq-input" value={providerName(credential.provider, credential.baseUrl)} readOnly disabled />
                ) : (
                  <select id={`${idPrefix}${role}-provider`} name={`${role}.provider`} className="oq-input" value={d.provider} onChange={(e) => set(role, { provider: e.target.value })}>
                    {MODEL_PROVIDERS.filter((p) => p !== "openai-compatible").map((p) => (
                      <option key={p} value={p}>
                        {PROVIDER_LABEL[p]}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="oq-field">
                <label className="oq-field__label" htmlFor={`${idPrefix}${role}-model`}>
                  Model
                </label>
                <input
                  id={`${idPrefix}${role}-model`}
                  name={`${role}.model`}
                  className="oq-input oq-input--mono"
                  list={`${idPrefix}${role}-models`}
                  value={d.model}
                  placeholder={inheritedChoice ? `${inheritedChoice.model} (from ${inheritedFrom ?? "the default"})` : "the operator's default"}
                  onChange={(e) => set(role, { model: e.target.value })}
                />
                <datalist id={`${idPrefix}${role}-models`}>
                  {(MODEL_SUGGESTIONS[provider as ModelProvider] ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
            </div>
            {provider === "openai-compatible" || provider === "openrouter" || (vendor && "problem" in vendor) ? (
              <div className="oq-field">
                <label className="oq-field__label" htmlFor={`${idPrefix}${role}-vendor`}>
                  Whose model it is <span className="console-meta">only if Windkeel can't tell from the name</span>
                </label>
                <input
                  id={`${idPrefix}${role}-vendor`}
                  name={`${role}.declaredVendor`}
                  className="oq-input oq-input--mono"
                  value={d.declaredVendor}
                  placeholder={credential?.declaredVendor ?? "meta"}
                  onChange={(e) => set(role, { declaredVendor: e.target.value })}
                />
              </div>
            ) : null}
            <p className="console-meta" data-vendor={vendor && "vendor" in vendor ? vendor.vendor : undefined}>
              {vendor === null
                ? `Blank: ${inheritedChoice ? `inherits ${inheritedChoice.model} from ${inheritedFrom ?? "the default"}` : "the operator's default model, on Windkeel's keys"}.`
                : "vendor" in vendor
                  ? `${d.model.trim() ? "" : `Inherited from ${inheritedFrom ?? "the default"}: `}${vendor.vendor}'s model.`
                  : vendor.problem}
            </p>
          </fieldset>
        );
      })}
      {problem ? (
        <div className="oq-banner" data-intent="warning" role="alert">
          <div>
            <strong className="oq-banner__title">Not independent</strong>
            <div className="oq-banner__body">
              <p>{problem}</p>
            </div>
          </div>
        </div>
      ) : null}
      <Outcome error={error} message={message} />
      <div className="console-actions">
        <button type="submit" className="oq-button oq-button--primary" disabled={pending} aria-busy={pending}>
          {pending ? <span className="oq-spinner" aria-hidden="true" /> : null}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
