"use client";

import { useState } from "react";
import {
  MODE_OPTIONS,
  TASK_MODELS,
  TASK_MODELS_LABEL,
  checkerOptions,
  defaultLabel,
  makerOptions,
  pairReason,
  rerunDefaultProblem,
  showsAgentPicker,
  type ModelPicker,
} from "../lib/model-picker.ts";
import { harnessName } from "../lib/models.ts";

export function ModelPickerFields({ picker, idPrefix = "pick", rerun = false }: { picker: ModelPicker; idPrefix?: string; rerun?: boolean }) {
  const [model, setModel] = useState(rerun ? TASK_MODELS : "");
  const [maker, setMaker] = useState("");
  const [checker, setChecker] = useState("");
  const defaultHarness = picker.harnesses.find((h) => h.default)?.id ?? "";
  const [harness, setHarness] = useState(defaultHarness);
  const preset = model.startsWith("preset:") ? picker.presets.find((p) => p.id === model.slice(7)) ?? null : null;
  const more = model === "more";
  const task = rerun && model === TASK_MODELS;
  const defaultUnnamed = rerun ? rerunDefaultProblem(picker) : null;
  const reason = more ? pairReason(picker, maker, checker) : null;
  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <div className="oq-stack console-picker" style={{ ["--gap" as string]: "var(--space-3)" }} data-picker>
      <div className="console-composer-form__row">
        {showsAgentPicker(picker) ? (
          <div className="oq-field">
            <label className="oq-field__label" htmlFor={id("harness")}>
              Agent
            </label>
            {task ? (
              <input id={id("harness")} className="oq-input" value="The task's agent" readOnly disabled />
            ) : preset ? (
              <input id={id("harness")} className="oq-input" value={harnessName(preset.harness ?? defaultHarness, picker.harnesses)} readOnly disabled />
            ) : (
              <select id={id("harness")} name="harness" className="oq-input" value={harness} onChange={(e) => setHarness(e.target.value)}>
                {picker.harnesses.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label}
                    {h.default ? " (organization default)" : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
        ) : null}
        <div className="oq-field">
          <label className="oq-field__label" htmlFor={id("model")}>
            Model
          </label>
          <select id={id("model")} name="model" className="oq-input" value={model} onChange={(e) => setModel(e.target.value)}>
            {rerun ? <option value={TASK_MODELS}>{TASK_MODELS_LABEL}</option> : null}
            <option value="" disabled={defaultUnnamed !== null} title={defaultUnnamed ?? undefined}>
              {defaultLabel(picker)}
              {defaultUnnamed ? " — unavailable" : ""}
            </option>
            {picker.presets.length ? (
              <optgroup label="Presets">
                {picker.presets.map((p) => (
                  <option key={p.id} value={`preset:${p.id}`} disabled={p.disabledReason !== null} title={p.disabledReason ?? undefined}>
                    {p.label}
                    {p.disabledReason ? " — unavailable" : ""}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <option value="more">More — choose the maker and checker models…</option>
          </select>
        </div>
      </div>

      {preset ? (
        <p className="console-meta" style={{ margin: 0 }}>
          {preset.name}: {preset.maker.model} makes the change, {preset.checker.map((c) => c.model).join(", then ")} checks it.
        </p>
      ) : null}
      {picker.presets.some((p) => p.disabledReason) && !more ? (
        <p className="console-meta" style={{ margin: 0 }}>
          {picker.presets
            .filter((p) => p.disabledReason)
            .map((p) => `${p.name} is unavailable: ${p.disabledReason}`)
            .join(" ")}
        </p>
      ) : null}

      {more ? (
        <div className="console-composer-form__row">
          <div className="oq-field">
            <label className="oq-field__label" htmlFor={id("maker")}>
              Maker <span className="console-meta">writes the change</span>
            </label>
            <select id={id("maker")} name="maker" className="oq-input" value={maker} onChange={(e) => setMaker(e.target.value)}>
              <option value="">{picker.defaultMaker.label}</option>
              {makerOptions(picker, checker).map((o) => (
                <option key={o.key} value={o.key} disabled={o.disabledReason !== null} title={o.disabledReason ?? undefined}>
                  {o.label}
                  {o.disabledReason ? " — no independent checker" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="oq-field">
            <label className="oq-field__label" htmlFor={id("checker")}>
              Checker <span className="console-meta">another vendor's model</span>
            </label>
            <select id={id("checker")} name="checker" className="oq-input" value={checker} onChange={(e) => setChecker(e.target.value)}>
              <option value="">{picker.defaultChecker.label}</option>
              {checkerOptions(picker, maker).map((o) => (
                <option key={o.key} value={o.key} disabled={o.disabledReason !== null} title={o.disabledReason ?? undefined}>
                  {o.label}
                  {o.disabledReason ? " — same vendor as the maker" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
      {more && makerOptions(picker, checker).some((o) => o.disabledReason) ? (
        <p className="console-meta" style={{ margin: 0 }} data-disabled-reason>
          Makers that would leave no independent checker are disabled: {makerOptions(picker, checker).find((o) => o.disabledReason)!.disabledReason}
        </p>
      ) : null}
      {reason ? (
        <p className="oq-field__error" role="alert">
          {reason}
        </p>
      ) : null}

      <fieldset className="console-choice">
        <legend className="oq-field__label">Mode</legend>
        {MODE_OPTIONS.map((m) => (
          <label key={m.value} className="console-choice__item" aria-disabled={!m.available || undefined}>
            <input type="radio" name="mode" value={m.value} defaultChecked={m.value === "autonomous"} disabled={!m.available} />
            <span>
              <span className="console-choice__label">{m.label}</span>
              <span className="console-choice__detail">{m.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="oq-field__hint" style={{ margin: 0 }}>
        Chosen once, when the run starts. A run's models never change after that — to try others, run it again with them.
      </p>
    </div>
  );
}
