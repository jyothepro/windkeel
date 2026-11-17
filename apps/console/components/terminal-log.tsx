import { workspaceHref } from "../lib/session.ts";
import type { TerminalTurn } from "../lib/terminal.ts";
import Link from "next/link";

export function TerminalLog({ runId, turns, partial }: { runId: string; turns: TerminalTurn[]; partial: boolean }) {
  if (turns.length === 0) {
    return (
      <p className="oq-muted" style={{ margin: 0 }}>
        No commands yet. When Windkeel runs one, it shows here with what it printed.
      </p>
    );
  }
  return (
    <div className="oq-stack" style={{ ["--gap" as string]: "var(--space-3)" }}>
      <p className="console-guidance-rule">
        Read-only: what the agent ran, from its own steps{partial ? " (the newest ones)" : ""}. Output is the tail of what each command printed, up to 4,000
        characters; a command that printed nothing, or ran before Windkeel kept output, shows none.
      </p>
      {turns.map((turn) => (
        <div key={turn.key} className="oq-terminal console-terminal">
          <div className="oq-terminal__header">
            <span className="oq-terminal__title" title={`Agent run ${turn.agentRunId}`}>
              {turn.role === "repairer" ? "repair turn" : "maker turn"}
              {turn.duration ? ` · ${turn.running ? "working for" : "worked for"} ${turn.duration}` : ""}
            </span>
            {turn.running ? <span className="oq-spinner" aria-label="running" /> : null}
            <Link className="oq-button oq-button--ghost oq-button--sm" href={workspaceHref(runId, "changes", undefined, { turn: turn.agentRunId })} scroll={false}>
              Changes
            </Link>
          </div>
          <pre className="oq-terminal__body">
            {turn.commands.map((c, i) => (
              <span key={c.key}>
                {i > 0 ? "\n" : null}
                <span className="oq-terminal__cmd">{c.command}</span>
                {"  "}
                {c.state === "running" ? (
                  <span className="oq-terminal__dim">running…</span>
                ) : (
                  <>
                    <span className={c.state === "failed" ? "oq-terminal__err" : "oq-terminal__dim"}>{c.status ?? "no exit recorded"}</span>
                    {c.duration ? (
                      <span className="oq-terminal__dim" title={c.duration.title}>
                        {" · "}
                        {c.duration.label}
                      </span>
                    ) : null}
                  </>
                )}
                {c.output ? `\n${c.output}` : null}
                {"\n"}
              </span>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}
