"use client";

import { useState } from "react";
import { verifierSentence, type PlaybookOption } from "../lib/playbooks.ts";

export function PlaybookPicker({ options, idPrefix }: { options: PlaybookOption[]; idPrefix: string }) {
  const [value, setValue] = useState("");
  const chosen = options.find((o) => o.value === value) ?? null;
  const verifier = chosen ? verifierSentence(chosen.verifier) : null;
  const id = `${idPrefix}-playbook`;
  return (
    <div className="oq-field">
      <label className="oq-field__label" htmlFor={id}>
        Playbook <span className="console-meta">optional</span>
      </label>
      <select id={id} name="playbook" className="oq-input" value={value} onChange={(e) => setValue(e.target.value)} aria-describedby={`${id}-adds`}>
        {options.map((o) => (
          <option key={o.value || "none"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <div id={`${id}-adds`} className="oq-field__hint" data-playbook-adds={chosen?.value || undefined}>
        {chosen && chosen.value ? (
          <>
            {chosen.criteria.length ? (
              <>
                <span>Adds these criteria to yours:</span>
                <ul className="console-list" aria-label="Criteria the playbook adds">
                  {chosen.criteria.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {verifier ? <p style={{ margin: 0 }}>{verifier}</p> : null}
            {!chosen.criteria.length && !verifier ? <span>Adds instructions for the maker only.</span> : null}
          </>
        ) : (
          <span>Reusable instructions and checks for a kind of work. They only ever add to verification.</span>
        )}
      </div>
    </div>
  );
}
