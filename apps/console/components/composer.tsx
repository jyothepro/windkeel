"use client";

import { useState, useTransition } from "react";
import { guide } from "../app/(console)/runs/[id]/actions.ts";

export function Composer({ runId, closedReason }: { runId: string; closedReason: string | null }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const send = () => {
    const message = text.trim();
    if (!message || pending) return;
    start(async () => {
      const res = await guide(runId, message);
      if (res.ok) {
        setText("");
        setNote("Queued. Windkeel gets it as its next turn — after the current one finishes, within about a minute of that.");
      } else {
        setNote(res.message);
      }
    });
  };

  if (closedReason) {
    return <p className="console-guidance-rule">{closedReason}</p>;
  }

  return (
    <div className="oq-stack">
      <form
        className="oq-composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label className="oq-sr-only" htmlFor={`composer-${runId}`}>
          Guidance for Windkeel
        </label>
        <textarea
          id={`composer-${runId}`}
          className="oq-composer__input"
          rows={1}
          placeholder="Tell Windkeel how to go about it…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="oq-composer__toolbar">
          <span className="oq-composer__spacer" />
          <button type="submit" className="oq-button oq-button--primary oq-button--sm" aria-busy={pending} disabled={pending || !text.trim()}>
            Send <span className="oq-button__hint">⌘↵</span>
          </button>
        </div>
      </form>
      <p className="console-guidance-rule" role="status">
        {note ?? "Guidance changes how, never what. To change what this run is for, change its criteria — which means approval again."}
      </p>
    </div>
  );
}
