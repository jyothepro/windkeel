"use client";

import { useRef, useState, useTransition } from "react";
import type { ActionResult } from "../lib/action-result.ts";
import {
  ADMIN_PERMISSIONS,
  DEFAULT_PRESET,
  PERMISSION_LABEL,
  TOKEN_EXPIRY_DAYS,
  defaultTokenScopes,
  offeredPresets,
  type Permission,
} from "../lib/permissions.ts";

export function TokenForm({
  action,
  held,
  organizations,
}: {
  action: (form: FormData) => Promise<ActionResult>;
  held: Permission[];
  organizations: Array<{ id: string; name: string }>;
}) {
  const presets = offeredPresets(held);
  const initial = presets.some((p) => p.preset === DEFAULT_PRESET) ? DEFAULT_PRESET : (presets.at(-1)?.preset ?? "custom");
  const [choice, setChoice] = useState<string>(initial);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const dialog = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const defaults = defaultTokenScopes(held);

  const submit = (form: FormData) =>
    start(async () => {
      setError(null);
      const res = await action(form);
      if (!res.ok) return setError(res.message);
      formRef.current?.reset();
      setChoice(initial);
      setSecret(res.secret ?? null);
      setCopied(false);
      dialog.current?.showModal();
    });

  return (
    <>
      <form ref={formRef} action={submit} className="oq-stack" style={{ ["--gap" as string]: "var(--space-4)" }}>
        <div className="oq-field">
          <label className="oq-field__label" htmlFor="tok-name">
            Name
          </label>
          <input id="tok-name" name="name" className="oq-input" placeholder="work laptop" required />
          <p className="oq-field__hint">Where it will live, so you know what breaks when you revoke it.</p>
        </div>

        <fieldset className="console-checks">
          <legend className="oq-field__label">What it can do</legend>
          {presets.map((p) => (
            <label key={p.preset} className="console-choice__item">
              <input type="radio" name="preset" value={p.preset} checked={choice === p.preset} onChange={() => setChoice(p.preset)} />
              <span>
                <span className="console-choice__label">
                  {p.label}
                  {p.preset === "admin" ? (
                    <span className="oq-badge oq-badge--sm" data-intent="warning" style={{ marginLeft: "var(--space-2)" }}>
                      admin
                    </span>
                  ) : null}
                </span>
                <span className="console-choice__detail">{p.detail}</span>
              </span>
            </label>
          ))}
          <label className="console-choice__item">
            <input type="radio" name="preset" value="custom" checked={choice === "custom"} onChange={() => setChoice("custom")} />
            <span>
              <span className="console-choice__label">Custom</span>
              <span className="console-choice__detail">Pick exactly what it can do.</span>
            </span>
          </label>
          {choice === "custom" ? (
            <div className="console-checks" style={{ paddingLeft: "var(--space-6)" }}>
              {held.map((p) => (
                <label key={p} className="console-choice__item">
                  <input type="checkbox" name="permissions" value={p} defaultChecked={defaults.includes(p)} />
                  <span>
                    <span className="console-choice__label">
                      {PERMISSION_LABEL[p].label}
                      {ADMIN_PERMISSIONS.has(p) ? <span className="console-meta"> · admin</span> : null}
                    </span>
                    <span className="console-choice__detail">{PERMISSION_LABEL[p].detail}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          <p className="oq-field__hint">Never more than your role allows — and if your role shrinks, so does the token.</p>
        </fieldset>

        <div className="console-composer-form__row">
          {organizations.length > 1 ? (
            <div className="oq-field">
              <label className="oq-field__label" htmlFor="tok-org">
                Organization
              </label>
              <select id="tok-org" name="organizationId" className="oq-input" defaultValue="">
                <option value="">Any I belong to</option>
                {organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    Only {o.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="oq-field">
            <label className="oq-field__label" htmlFor="tok-exp">
              Expires
            </label>
            <select id="tok-exp" name="expiresInDays" className="oq-input" defaultValue="90">
              {TOKEN_EXPIRY_DAYS.map((e) => (
                <option key={e.label} value={e.days ?? "never"}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error ? (
          <p className="oq-field__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="console-actions">
          <button type="submit" className="oq-button oq-button--primary" disabled={pending} aria-busy={pending}>
            {pending ? <span className="oq-spinner" aria-hidden="true" /> : null}
            Create token
          </button>
        </div>
      </form>

      <dialog ref={dialog} className="oq-dialog" aria-labelledby="tok-created" onClose={() => setSecret(null)}>
        <div className="oq-dialog__header">
          <h2 className="oq-dialog__title" id="tok-created">
            Copy your token now
          </h2>
        </div>
        <div className="oq-dialog__body oq-stack" style={{ ["--gap" as string]: "var(--space-3)" }}>
          <p>This is the only time it's shown. Windkeel keeps just a fingerprint, so if you lose it, revoke it and make another.</p>
          {secret?.startsWith("orq_SAMPLE") ? <p className="oq-field__hint">Sample data: this value is for show and won't work anywhere.</p> : null}
          <div className="token-secret">{secret}</div>
          <p className="oq-field__hint">
            Use it as <code>WINDKEEL_API_TOKEN</code> in CI, or for a terminal run <code>windkeel login</code> instead — it makes its own.
          </p>
        </div>
        <div className="oq-dialog__footer">
          <button
            type="button"
            className="oq-button"
            onClick={() => {
              if (secret) navigator.clipboard?.writeText(secret).then(() => setCopied(true), () => setCopied(false));
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="oq-button oq-button--primary" onClick={() => dialog.current?.close()}>
            I've saved it
          </button>
        </div>
      </dialog>
    </>
  );
}
