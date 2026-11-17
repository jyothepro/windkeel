"use client";

import { useRef, useState, useTransition } from "react";
import type { ActionResult } from "../lib/action-result.ts";

export function SimpleForm({
  action,
  submitLabel,
  children,
}: {
  action: (form: FormData) => Promise<ActionResult>;
  submitLabel: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      ref={ref}
      className="oq-stack"
      style={{ ["--gap" as string]: "var(--space-3)" }}
      action={(form) =>
        start(async () => {
          const res = await action(form);
          if (res.ok) {
            setError(null);
            ref.current?.reset();
          } else setError(res.message);
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
        <button type="submit" className="oq-button" disabled={pending} aria-busy={pending}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export function RoleSelect({
  id,
  value,
  roles,
  labels,
  save,
}: {
  id: string;
  value: string;
  roles: readonly string[];
  labels?: Record<string, string>;
  save: (role: string) => Promise<ActionResult>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="oq-row" style={{ ["--gap" as string]: "var(--space-2)" }}>
      <label className="oq-sr-only" htmlFor={id}>
        Role
      </label>
      <select
        id={id}
        className="oq-input"
        defaultValue={value}
        disabled={pending}
        onChange={(e) => {
          const role = e.target.value;
          start(async () => {
            const res = await save(role);
            setError(res.ok ? null : res.message);
          });
        }}
      >
        {roles.map((r) => (
          <option key={r} value={r}>
            {labels?.[r] ?? r}
          </option>
        ))}
      </select>
      {error ? (
        <span className="oq-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
