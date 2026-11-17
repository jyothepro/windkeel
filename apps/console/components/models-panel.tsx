import { harnessName, providerName, type RunModelChoice, type RunModelConfig } from "../lib/models.ts";
import { time } from "../lib/format.ts";

const SOURCE: Record<RunModelChoice["source"], string> = {
  run: "chosen for this run (Run again with…)",
  task: "chosen for this task",
  repository: "the repository's override",
  organization: "the organization's default",
  operator: "the operator's default",
};

function keyText(c: RunModelChoice): string {
  if (c.keySource === "orqon") return "Windkeel-managed key";
  return c.credentialLabel ? `your key “${c.credentialLabel}”` : "your organization's key";
}

function Choice({ role, choice, note }: { role: string; choice: RunModelChoice; note?: string }) {
  return (
    <div className="console-model" data-role={role}>
      <div className="console-model__role">{role}</div>
      <div className="console-model__name oq-mono">{choice.model}</div>
      <div className="console-meta">
        {choice.vendor}'s model via {providerName(choice.provider, choice.baseUrl)} · {keyText(choice)}
      </div>
      <div className="console-meta">
        {SOURCE[choice.source] ?? choice.source}
        {choice.worker ? ` · driven by ${harnessName(choice.worker)}` : ""}
        {note ? ` · ${note}` : ""}
      </div>
    </div>
  );
}

export function ModelsPanel({ config }: { config: RunModelConfig | null | undefined }) {
  return (
    <details className="console-disclosure" data-panel="models">
      <summary>
        <span className="console-disclosure__title">Models</span>
        <span className="console-meta">{config ? `${config.maker.vendor} made · ${config.checker[0]?.vendor ?? "nobody"} checks` : "not recorded"}</span>
      </summary>
      {config ? (
        <div className="console-models">
          <Choice role="Maker" choice={config.maker} />
          {config.checker.length === 0 ? (
            <div className="console-model" data-role="Checker">
              <div className="console-model__role">Checker</div>
              <div className="oq-muted">None configured — review and mapping report themselves skipped.</div>
            </div>
          ) : (
            config.checker.map((c, i) => (
              <Choice key={`${c.provider}:${c.model}:${i}`} role={i === 0 ? "Checker" : `Checker, fallback ${i}`} choice={c} note={i > 0 ? "used only if the first is unavailable" : undefined} />
            ))
          )}
          <p className="console-meta" style={{ margin: 0 }}>
            Chosen {time(config.resolvedAt)}, when the run started. A policy changed since doesn't change this run.
          </p>
        </div>
      ) : (
        <p className="oq-muted" style={{ margin: 0 }}>
          No model snapshot: the run hasn't started yet, or it started before model routing and ran on the operator's default models and keys.
        </p>
      )}
    </details>
  );
}
