"use client";

import { useRef, useState, useTransition } from "react";
import type { ActionResult } from "../lib/action-result.ts";

export function ConfirmAction({
  label,
  question,
  consequence,
  confirmLabel,
  run,
  intent = "danger",
  buttonClass = "oq-button--ghost",
}: {
  label: string;
  question: string;
  consequence: string;
  confirmLabel: string;
  run: () => Promise<ActionResult>;
  intent?: "danger" | "primary";
  buttonClass?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string; href?: string; hrefLabel?: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <button type="button" className={`oq-button ${buttonClass} oq-button--sm`} onClick={() => dialog.current?.showModal()}>
        {label}
      </button>
      {error ? (
        <span className="oq-field__error" role="alert">
          {error}
        </span>
      ) : null}
      {done ? (
        <span className="console-meta" role="status">
          {done.message} {done.href ? <a href={done.href}>{done.hrefLabel ?? "Open"}</a> : null}
        </span>
      ) : null}
      <dialog ref={dialog} className="oq-dialog">
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
            className={intent === "danger" ? "oq-button oq-button--danger" : "oq-button oq-button--primary"}
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await run();
                dialog.current?.close();
                setError(res.ok ? null : res.message);
                setDone(res.ok && res.message ? { message: res.message, href: res.href, hrefLabel: res.hrefLabel } : null);
              })
            }
          >
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </>
  );
}
