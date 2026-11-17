"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import type { ActionResult, PreviewResult } from "../lib/action-result.ts";
import { inZone } from "../lib/format.ts";
import { Banner } from "./banner.tsx";

export interface Shown {
  value: string;
  sample: boolean;
}

export function SecretOnce({ secret, title, children, onDismiss }: { secret: Shown; title: string; children?: React.ReactNode; onDismiss: () => void }) {
  const labelId = useId();
  const [copied, setCopied] = useState(false);
  return (
    <div className="console-secret oq-stack" style={{ ["--gap" as string]: "var(--space-3)" }}>
      <Banner intent="warning" title={title}>
        <p>This is the only time it's shown. Windkeel doesn't keep it, so if you lose it, rotate or revoke and make another.</p>
      </Banner>
      {secret.sample ? <p className="oq-field__hint">Sample data: this value is for show and won't work anywhere.</p> : null}
      <div role="group" aria-labelledby={labelId} className="oq-stack" style={{ ["--gap" as string]: "var(--space-1)" }}>
        <span id={labelId} className="oq-field__label">
          Secret value
        </span>
        <code className="token-secret">{secret.value}</code>
      </div>
      {children}
      <div className="console-actions">
        <button
          type="button"
          className="oq-button"
          onClick={() => void navigator.clipboard?.writeText(secret.value).then(() => setCopied(true), () => setCopied(false))}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="oq-button oq-button--primary" onClick={onDismiss}>
          I've saved it
        </button>
      </div>
    </div>
  );
}

export function SecretForm({
  action,
  submitLabel,
  secretTitle,
  secretHint,
  children,
}: {
  action: (form: FormData) => Promise<ActionResult>;
  submitLabel: string;
  secretTitle: string;
  secretHint?: React.ReactNode;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<Shown | null>(null);
  const [pending, start] = useTransition();
  if (secret) {
    return (
      <SecretOnce secret={secret} title={secretTitle} onDismiss={() => setSecret(null)}>
        {secretHint}
      </SecretOnce>
    );
  }
  return (
    <form
      ref={ref}
      className="oq-stack"
      style={{ ["--gap" as string]: "var(--space-3)" }}
      autoComplete="off"
      action={(form) =>
        start(async () => {
          const res = await action(form);
          if (!res.ok) return setError(res.message);
          setError(null);
          ref.current?.reset();
          setSecret(res.secret ? { value: res.secret, sample: res.sample === true } : null);
        })
      }
    >
      {children}
      {error ? (
        <p className="oq-field__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="console-actions">
        <button type="submit" className="oq-button oq-button--primary" disabled={pending} aria-busy={pending}>
          {pending ? <span className="oq-spinner" aria-hidden="true" /> : null}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export function SecretConfirm({
  label,
  question,
  consequence,
  confirmLabel,
  secretTitle,
  run,
}: {
  label: string;
  question: string;
  consequence: string;
  confirmLabel: string;
  secretTitle: string;
  run: () => Promise<ActionResult>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<Shown | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <button type="button" className="oq-button oq-button--ghost oq-button--sm" onClick={() => dialog.current?.showModal()}>
        {label}
      </button>
      {error ? (
        <span className="oq-field__error" role="alert">
          {error}
        </span>
      ) : null}
      <dialog ref={dialog} className="oq-dialog" aria-label={secret ? secretTitle : question} onClose={() => setSecret(null)}>
        {secret ? (
          <div className="oq-dialog__body">
            <SecretOnce secret={secret} title={secretTitle} onDismiss={() => dialog.current?.close()} />
          </div>
        ) : (
          <>
            <div className="oq-dialog__header">
              <h2 className="oq-dialog__title">{question}</h2>
            </div>
            <div className="oq-dialog__body">
              <p>{consequence}</p>
            </div>
            <div className="oq-dialog__footer">
              <button type="button" className="oq-button" autoFocus onClick={() => dialog.current?.close()}>
                Cancel
              </button>
              <button
                type="button"
                className="oq-button oq-button--danger"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await run();
                    if (res.ok && res.secret) {
                      setError(null);
                      setSecret({ value: res.secret, sample: res.sample === true });
                    } else {
                      dialog.current?.close();
                      setError(res.ok ? null : res.message);
                    }
                  })
                }
              >
                {confirmLabel}
              </button>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}

export function Toggle({ id, label, checked, save }: { id: string; label: string; checked: boolean; save: (on: boolean) => Promise<ActionResult> }) {
  const [on, setOn] = useState(checked);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => setOn(checked), [checked]);
  return (
    <span className="console-toggle">
      <label className="console-toggle__label" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={on}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            start(async () => {
              const res = await save(next);
              if (!res.ok) {
                setOn(!next);
                setError(res.message);
              } else setError(null);
            });
          }}
        />
        <span>{label}</span>
      </label>
      {error ? (
        <span className="oq-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

const ZONES = ["UTC", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney"];

export interface ScheduleFormValues {
  name: string;
  repositoryId: string;
  cron: string;
  timezone: string;
  title: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
  enabled: boolean;
  nextFireTimes?: string[];
}

export function LazyDetails({ summary, children }: { summary: string; children: React.ReactNode }) {
  const [opened, setOpened] = useState(false);
  return (
    <details className="console-inline-edit" onToggle={(e) => e.currentTarget.open && setOpened(true)}>
      <summary className="console-meta">{summary}</summary>
      {opened ? children : null}
    </details>
  );
}

export function ScheduleForm({
  idPrefix,
  action,
  preview,
  repositories,
  initial,
  submitLabel,
}: {
  idPrefix: string;
  action: (form: FormData) => Promise<ActionResult>;
  preview: (cron: string, timezone: string) => Promise<PreviewResult>;
  repositories: Array<{ id: string; fullName: string }>;
  initial?: ScheduleFormValues;
  submitLabel: string;
}) {
  const start0 = initial ?? { name: "", repositoryId: repositories[0]?.id ?? "", cron: "0 3 * * *", timezone: "UTC", title: "", description: "", riskLevel: "low" as const, enabled: true };
  const ref = useRef<HTMLFormElement>(null);
  const [cron, setCron] = useState(start0.cron);
  const [timezone, setTimezone] = useState(start0.timezone);
  const [times, setTimes] = useState<PreviewResult | null>(initial ? { ok: true, times: initial.nextFireTimes ?? [] } : null);
  const [edited, setEdited] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!edited) return;
    let live = true;
    const t = setTimeout(() => {
      preview(cron, timezone).then(
        (res) => live && setTimes(res),
        () => live && setTimes({ ok: false, message: "Couldn't reach the control plane to preview this." }),
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [cron, timezone, preview, edited]);

  const f = (name: string) => `${idPrefix}-${name}`;
  return (
    <form
      ref={ref}
      className="oq-stack"
      style={{ ["--gap" as string]: "var(--space-3)" }}
      action={(form) =>
        start(async () => {
          const res = await action(form);
          if (!res.ok) return setError(res.message);
          setError(null);
          setSaved(true);
          if (!initial) {
            ref.current?.reset();
            setCron(start0.cron);
            setTimezone(start0.timezone);
          }
        })
      }
      onChange={() => setSaved(false)}
    >
      <div className="console-composer-form__row">
        <div className="oq-field">
          <label className="oq-field__label" htmlFor={f("name")}>
            Name
          </label>
          <input id={f("name")} name="name" className="oq-input" placeholder="Nightly dependency bump" defaultValue={start0.name} required />
        </div>
        <div className="oq-field">
          <label className="oq-field__label" htmlFor={f("repo")}>
            Repository
          </label>
          <select id={f("repo")} name="repositoryId" className="oq-input" defaultValue={start0.repositoryId}>
            {repositories.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="console-composer-form__row">
        <div className="oq-field">
          <label className="oq-field__label" htmlFor={f("cron")}>
            Cron
          </label>
          <input id={f("cron")} name="cron" className="oq-input oq-input--mono" value={cron} onChange={(e) => {
              setEdited(true);
              setCron(e.target.value);
            }} autoComplete="off" required />
          <p className="oq-field__hint">minute hour day-of-month month day-of-week</p>
        </div>
        <div className="oq-field">
          <label className="oq-field__label" htmlFor={f("tz")}>
            Time zone
          </label>
          <input id={f("tz")} name="timezone" className="oq-input" list={f("zones")} value={timezone} onChange={(e) => {
              setEdited(true);
              setTimezone(e.target.value);
            }} autoComplete="off" />
          <datalist id={f("zones")}>
            {ZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <p className="oq-field__hint">The cron is read in this zone, daylight saving included.</p>
        </div>
      </div>

      <div className="console-preview" aria-live="polite">
        <span className="console-preview__label">Next fires</span>
        {times === null ? (
          <span className="console-meta">Reading…</span>
        ) : times.ok && times.times.length === 0 ? (
          <span className="console-meta">Paused: it won't fire until it's switched on.</span>
        ) : times.ok ? (
          <ol className="console-preview__times">
            {times.times.map((t) => (
              <li key={t}>{inZone(t, timezone)}</li>
            ))}
          </ol>
        ) : (
          <span className="oq-field__error">{times.message}</span>
        )}
      </div>

      <div className="oq-field">
        <label className="oq-field__label" htmlFor={f("title")}>
          Task title
        </label>
        <input id={f("title")} name="title" className="oq-input" placeholder="Bump patch-level dependencies" defaultValue={start0.title} required />
      </div>
      <div className="oq-field">
        <label className="oq-field__label" htmlFor={f("desc")}>
          Task description
        </label>
        <textarea id={f("desc")} name="description" className="oq-input console-textarea" rows={4} defaultValue={start0.description} required />
        <p className="oq-field__hint">Acceptance criteria are read from this, as from an issue. With none, Windkeel writes them and the run waits for approval.</p>
      </div>

      <div className="console-composer-form__row">
        <div className="oq-field">
          <label className="oq-field__label" htmlFor={f("risk")}>
            Risk
          </label>
          <select id={f("risk")} name="riskLevel" className="oq-input" defaultValue={start0.riskLevel}>
            <option value="low">Low — routine</option>
            <option value="medium">Medium — standard</option>
            <option value="high">High — sensitive</option>
          </select>
        </div>
        {initial ? null : (
          <label className="console-choice__item" style={{ alignSelf: "end" }}>
            <input type="checkbox" name="enabled" defaultChecked={start0.enabled} />
            <span>
              <span className="console-choice__label">Enabled</span>
              <span className="console-choice__detail">Fires on its cron.</span>
            </span>
          </label>
        )}
      </div>

      {error ? (
        <p className="oq-field__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="console-actions">
        <button type="submit" className="oq-button oq-button--primary" disabled={pending} aria-busy={pending}>
          {pending ? <span className="oq-spinner" aria-hidden="true" /> : null}
          {submitLabel}
        </button>
        {saved ? <span className="console-meta">Saved.</span> : null}
      </div>
    </form>
  );
}
