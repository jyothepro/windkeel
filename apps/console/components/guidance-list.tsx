import { time } from "../lib/format.ts";
import type { GuidanceMessage } from "../lib/types.ts";

const STATE: Record<GuidanceMessage["state"], string> = {
  delivered: "Delivered",
  queued: "Queued — waiting for the current turn to end",
  undeliverable: "Couldn't be delivered",
  superseded: "Not delivered — the run ended first",
};

export function GuidanceList({ messages }: { messages: GuidanceMessage[] }) {
  if (messages.length === 0) return null;
  return (
    <ul className="console-list" aria-label="Guidance you sent">
      {messages.map((m) => (
        <li key={m.id} className="console-list__static">
          <span className="console-list__main">
            <span className="console-list__title" style={{ whiteSpace: "normal" }}>
              {m.message}
            </span>
            <span className="console-list__next" data-guidance={m.state}>
              {STATE[m.state]}
              {m.state === "delivered" && m.deliveredAt ? ` ${time(m.deliveredAt)}` : ""}
              {m.state === "undeliverable" && m.undeliverableReason ? `: ${m.undeliverableReason}` : ""}
            </span>
          </span>
          <span className="console-list__meta">
            <span>{m.actor}</span>
            <span>{time(m.at)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
