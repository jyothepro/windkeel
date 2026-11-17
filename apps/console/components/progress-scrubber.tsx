"use client";

import { useId, useState } from "react";
import { progressOf, spanText } from "../lib/progress.ts";
import { TERMINAL_STATES, parkedOnPerson, stateLabel } from "../lib/run-states.ts";
import type { RunEvent } from "../lib/types.ts";
import { withoutIds } from "../lib/activity.ts";

export function ProgressScrubber({ transitions, now }: { transitions: RunEvent[]; now: number }) {
  const { stops, spanMs } = progressOf(transitions, now);
  const [picked, setPicked] = useState<number | null>(null);
  const id = useId();
  if (stops.length === 0) return <p className="oq-muted">No state changes recorded yet.</p>;
  const index = Math.min(picked ?? stops.length - 1, stops.length - 1);
  const stop = stops[index]!;
  const clock = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const tone = (state: (typeof stops)[number]["state"]) =>
    state === "FAILED" || state === "MAX_REPAIR_ATTEMPTS_REACHED" ? "failed" : parkedOnPerson(state) ? "waiting" : TERMINAL_STATES.has(state) ? "ended" : undefined;

  return (
    <section className="console-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="oq-sr-only">
        Progress
      </h2>
      <div className="console-scrubber">
        <div className="console-scrubber__track" aria-hidden="true">
          {stops.map((s, i) => (
            <span
              key={s.key}
              className="console-scrubber__tick"
              data-tone={tone(s.state)}
              data-picked={i === index || undefined}
              style={{ left: `${s.offset * 100}%` }}
            />
          ))}
        </div>
        <label className="oq-sr-only" htmlFor={`${id}-range`}>
          Step through the run's state changes
        </label>
        <input
          id={`${id}-range`}
          className="console-scrubber__range"
          type="range"
          min={0}
          max={stops.length - 1}
          step={1}
          value={index}
          aria-valuetext={`${stateLabel(stop.state)}, ${clock(stop.at)}`}
          suppressHydrationWarning
          onChange={(e) => setPicked(Number(e.target.value))}
        />
        <div className="console-scrubber__ends console-meta">
          <span suppressHydrationWarning>{clock(stops[0]!.at)}</span>
          <span>{spanMs ? spanText(spanMs) : ""}</span>
          <span suppressHydrationWarning>{stops.at(-1)!.current ? "now" : clock(stops.at(-1)!.at)}</span>
        </div>
      </div>

      <div className="console-scrubber__picked" aria-live="polite">
        <strong>{stateLabel(stop.state)}</strong>
        <span className="console-meta" suppressHydrationWarning>
          {stop.from ? `from ${stateLabel(stop.from)} · ` : ""}
          {clock(stop.at)}
          {stop.spentMs !== null ? ` · ${stop.current ? "for" : "lasted"} ${spanText(stop.spentMs)}${stop.current ? " so far" : ""}` : ""}
        </span>
        {stop.reason ? (
          <span className="console-facts" title={stop.reason}>
            {withoutIds(stop.reason).text}
          </span>
        ) : null}
      </div>

      <ol className="console-progress-log">
        {stops.map((s, i) => (
          <li key={s.key}>
            <button type="button" className="console-progress-log__row" aria-current={i === index ? "step" : undefined} data-tone={tone(s.state)} onClick={() => setPicked(i)}>
              <span className="console-progress-log__state">{stateLabel(s.state)}</span>
              <span className="console-progress-log__time" suppressHydrationWarning>
                {new Date(s.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
              <span className="console-progress-log__spent">{s.spentMs !== null ? spanText(s.spentMs) : ""}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
