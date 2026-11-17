"use client";

import { useActionState } from "react";
import { ModelPickerFields } from "../../../../components/model-picker.tsx";
import { PlaybookPicker } from "../../../../components/playbook-picker.tsx";
import type { PlaybookOption } from "../../../../lib/playbooks.ts";
import type { ModelPicker } from "../../../../lib/model-picker.ts";
import { fileTask, type FileTaskState } from "./actions.ts";

const AUTONOMY = [
  { value: "low", label: "Routine", detail: "Keeps fixing on its own — up to 3 repairs before it stops for you." },
  { value: "medium", label: "Standard", detail: "Up to 2 repairs, then it stops for you." },
  { value: "high", label: "Sensitive", detail: "Stops for you after 1 repair. For changes you want to watch closely." },
] as const;

const MODES = [
  { value: "autonomous", label: "Autonomous", detail: "Windkeel implements, verifies, repairs and brings back a pull request." },
  { value: "pair", label: "Pair", detail: "Windkeel stops after its first turn and hands you the workspace, so you look before anything is verified." },
] as const;

function ModeFields({ idPrefix }: { idPrefix: string }) {
  return (
    <fieldset className="console-choice" aria-describedby={`${idPrefix}-mode-hint`}>
      <legend className="oq-field__label">Mode</legend>
      {MODES.map((m) => (
        <label key={m.value} className="console-choice__item">
          <input type="radio" name="mode" value={m.value} defaultChecked={m.value === "autonomous"} />
          <span>
            <span className="console-choice__label">{m.label}</span>
            <span className="console-choice__detail">{m.detail}</span>
          </span>
        </label>
      ))}
      <p className="oq-field__hint" id={`${idPrefix}-mode-hint`}>
        Every mode is verified the same way.
      </p>
    </fieldset>
  );
}

export function FileTaskForm({
  repositories,
  compact = false,
  picker = null,
  pairMode = false,
  playbooks = null,
}: {
  repositories: Array<{ id: string; fullName: string }>;
  compact?: boolean;
  pairMode?: boolean;
  picker?: ModelPicker | null;
  playbooks?: PlaybookOption[] | null;
}) {
  const [state, action, pending] = useActionState<FileTaskState, FormData>(fileTask, { error: null, field: null });
  const err = (field: FileTaskState["field"]) => (state.field === field ? state.error : null);

  return (
    <form action={action} className="console-composer-form">
      <div className="oq-field">
        <label className="console-ask" htmlFor="change">
          What should Windkeel change?
        </label>
        <textarea
          id="change"
          name="change"
          className="oq-input"
          rows={compact ? 4 : 7}
          placeholder={"When a merge lands after a run's execution has ended, adopt the run instead of dropping the merge.\n\nDone when: the run ends COMPLETED, its evidence is kept, and a test covers the late merge."}
          aria-invalid={err("change") ? true : undefined}
          aria-describedby={err("change") ? "change-error" : "change-hint"}
          autoFocus
        />
        {err("change") ? (
          <p className="oq-field__error" id="change-error">
            {err("change")}
          </p>
        ) : (
          <p className="oq-field__hint" id="change-hint">
            Say what should be true when it's done. Windkeel checks the change against exactly that.
          </p>
        )}
      </div>

      <div className="console-composer-form__row">
        <div className="oq-field">
          <label className="oq-field__label" htmlFor="repositoryId">
            Repository
          </label>
          <select id="repositoryId" name="repositoryId" className="oq-input" defaultValue={repositories[0]?.id}>
            {repositories.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
        </div>
        <div className="oq-field">
          <label className="oq-field__label" htmlFor="link">
            Related issue or pull request <span className="console-meta">optional</span>
          </label>
          <input
            id="link"
            name="link"
            className="oq-input"
            inputMode="url"
            placeholder="https://github.com/…/issues/261"
            aria-invalid={err("link") ? true : undefined}
            aria-describedby={err("link") ? "link-error" : undefined}
          />
          {err("link") ? (
            <p className="oq-field__error" id="link-error">
              {err("link")}
            </p>
          ) : null}
        </div>
      </div>

      {playbooks && playbooks.length > 1 && !compact ? <PlaybookPicker options={playbooks} idPrefix="new" /> : null}

      {picker && !compact ? <ModelPickerFields picker={picker} idPrefix="new" /> : null}
      {pairMode && !compact ? <ModeFields idPrefix="new" /> : null}
      {err("model") ? (
        <p className="oq-field__error" role="alert">
          {err("model")}
        </p>
      ) : null}

      <details className="console-disclosure">
        <summary>
          <span className="console-disclosure__title">More options</span>
          <span className="console-meta">{picker && compact ? "Model, name, how much Windkeel does on its own" : "Name, how much Windkeel does on its own"}</span>
        </summary>
        <div className="oq-stack" style={{ ["--gap" as string]: "var(--space-4)", paddingTop: "var(--space-3)" }}>
          {picker && compact ? <ModelPickerFields picker={picker} idPrefix="home" /> : null}
          {pairMode && compact ? <ModeFields idPrefix="home" /> : null}
          <div className="oq-field">
            <label className="oq-field__label" htmlFor="title">
              Name <span className="console-meta">optional — the first line is used if blank</span>
            </label>
            <input id="title" name="title" className="oq-input" />
          </div>
          <fieldset className="console-choice">
            <legend className="oq-field__label">How much should Windkeel do on its own?</legend>
            {AUTONOMY.map((a) => (
              <label key={a.value} className="console-choice__item">
                <input type="radio" name="riskLevel" value={a.value} defaultChecked={a.value === "medium"} />
                <span>
                  <span className="console-choice__label">{a.label}</span>
                  <span className="console-choice__detail">{a.detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      </details>

      {compact ? (
        <p className="oq-field__hint" style={{ margin: 0 }}>
          Criteria Windkeel has to write itself come back to you for approval before it touches code.
        </p>
      ) : (
        <div className="console-next">
          <strong>What happens next</strong>
          <p>
            Windkeel reads the criteria from what you wrote. If it has to write any itself, it asks you to approve them before it touches code.
            Then it makes the change, checks it in a separate sandbox, and brings you a pull request with the evidence.
          </p>
        </div>
      )}

      {state.error && state.field === null ? (
        <p className="oq-field__error" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="console-actions">
        <button type="submit" className="oq-button oq-button--primary oq-button--lg" aria-busy={pending} disabled={pending}>
          {pending ? <span className="oq-spinner" aria-hidden="true" /> : null}
          Give Windkeel the task
        </button>
      </div>
    </form>
  );
}
