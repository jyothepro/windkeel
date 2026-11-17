"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, use, useCallback, useEffect, useRef, useState } from "react";
import { activityOf, costText, splitEarlier, type ActivityItem, type ActivityTurn, type CostFold, type StageHeader } from "../lib/activity.ts";
import { stepCount, turnDuration, type StepRow } from "../lib/agent-steps.ts";
import {
  afterStream,
  feedStorageKey,
  feedView,
  laterCursor,
  liveLine,
  mergeEvents,
  olderOf,
  restoreFeed,
  resumeFrom,
  retryDelayMs,
  storableFeed,
  STORED_MAX_EVENTS,
  type CursorFrame,
  type FeedLink,
  type Older,
  type StoredFeed,
} from "../lib/feed.ts";
import { usd } from "../lib/format.ts";
import { RUN_GAP_MS, sharedRefreshScheduler } from "../lib/live.ts";
import { TERMINAL_STATES, stateLabel } from "../lib/run-states.ts";
import { workspaceHref } from "../lib/session.ts";
import { ScreenshotThumb } from "./screenshot-strip.tsx";
import type { EventTail, RunEvent } from "../lib/types.ts";

export function ActivityFeed({
  runId,
  tail,
  head,
  terminal,
  working,
  parked,
}: {
  runId: string;
  tail: Promise<EventTail | null>;
  head: string;
  terminal: boolean;
  working: boolean;
  parked: boolean;
}) {
  const router = useRouter();
  const [live, setLive] = useState<RunEvent[]>([]);
  const [earlier, setEarlier] = useState<RunEvent[]>([]);
  const [earlierFrom, setEarlierFrom] = useState<Older | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState<"idle" | "loading" | "failed">("idle");
  const [link, setLink] = useState<FeedLink>(terminal ? "ended" : "connecting");
  const [stopReason, setStopReason] = useState<string | null>(null);
  const [stored, setStored] = useState<StoredFeed | null>(null);
  const [tailPage, setTailPage] = useState<EventTail | null>(null);
  const restored = useRef(false);
  const position = useRef(head);
  const shown: FeedLink = terminal ? "ended" : link;

  useEffect(() => {
    let saved: StoredFeed | null = null;
    try {
      saved = restoreFeed(window.sessionStorage.getItem(feedStorageKey(runId)), runId, Date.now());
    } catch {
    }
    restored.current = true;
    position.current = resumeFrom(saved, head);
    setStored(saved);
  }, [runId]);

  useEffect(() => {
    if (terminal) return;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let stopped = false;
    const refreshPage = () => sharedRefreshScheduler().request(() => router.refresh(), RUN_GAP_MS);

    let hidden = document.visibilityState === "hidden";
    const onVisibility = () => {
      hidden = document.visibilityState === "hidden";
      if (hidden) {
        clearTimeout(timer);
        source?.close();
        source = null;
      } else if (!stopped && !source) {
        open();
      }
    };

    const open = () => {
      if (hidden) return;
      source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(position.current)}`);
      source.onopen = () => {
        failures = 0;
        setLink("live");
      };
      const onEvent = (e: MessageEvent<string>) => {
        const event = JSON.parse(e.data) as RunEvent;
        position.current = event.cursor;
        setLive((held) => mergeEvents(held, [event]));
        if (event.kind === "transition") refreshPage();
      };
      source.addEventListener("transition", onEvent);
      source.addEventListener("cost", onEvent);
      source.addEventListener("agent", onEvent);
      source.addEventListener("cursor", (e) => {
        const frame = JSON.parse((e as MessageEvent<string>).data) as CursorFrame;
        position.current = frame.cursor;
        source?.close();
        if (afterStream(frame) === "stop") {
          stopped = true;
          setLink("ended");
          if (frame.reason === "run_terminal") refreshPage();
          else setStopReason(frame.reason);
        } else {
          open();
        }
      });
      source.onerror = () => {
        source?.close();
        if (stopped) return;
        failures += 1;
        setLink("reconnecting");
        timer = setTimeout(open, retryDelayMs(failures));
      };
    };

    document.addEventListener("visibilitychange", onVisibility);
    open();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stopped = true;
      clearTimeout(timer);
      source?.close();
    };
  }, [runId, terminal, router]);

  const loadEarlier = useCallback(async (from: Older) => {
    setLoadingEarlier("loading");
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/events/older?before=${encodeURIComponent(from.cursor)}`);
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as EventTail;
      setEarlier((held) => mergeEvents(page.items, held));
      setEarlierFrom(olderOf(page) ?? { cursor: from.cursor, more: false });
      setLoadingEarlier("idle");
    } catch {
      setLoadingEarlier("failed");
    }
  }, [runId]);

  const line = liveLine({ link: shown, stopReason, resuming: stored !== null, parked });

  const resumed = stored !== null && !terminal;

  useEffect(() => {
    if (!restored.current) return;
    const save = () => {
      const { events, older } = feedView({ stored, tail: tailPage, earlier, earlierFrom, live, resumed });
      if (events.length === 0) return;
      for (const max of [STORED_MAX_EVENTS, 50]) {
        try {
          const cursor = resumed ? position.current : laterCursor(position.current, events.at(-1)!.cursor)!;
          window.sessionStorage.setItem(feedStorageKey(runId), JSON.stringify(storableFeed(runId, events, cursor, older, Date.now(), max)));
          return;
        } catch {
        }
      }
    };
    const timer = setTimeout(save, 400);
    window.addEventListener("pagehide", save);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", save);
    };
  }, [runId, stored, tailPage, earlier, earlierFrom, live, resumed]);

  const body = (page: EventTail | null) => {
    const { events, older } = feedView({ stored, tail: page, earlier, earlierFrom, live, resumed });
    return (
      <FeedBody
        runId={runId}
        events={events}
        running={working && shown !== "ended"}
        older={older?.more ? older : null}
        loadingEarlier={loadingEarlier}
        onEarlier={(from) => void loadEarlier(from)}
      />
    );
  };

  return (
    <div className="oq-stack" style={{ ["--gap" as string]: "var(--space-3)" }}>
      <div className="console-feed__live" role="status" data-link={line.tone}>
        {line.text}
      </div>
      <Suspense fallback={body(null)}>
        <WithTail tail={tail} onTail={setTailPage}>
          {body}
        </WithTail>
      </Suspense>
    </div>
  );
}

function WithTail({
  tail,
  onTail,
  children,
}: {
  tail: Promise<EventTail | null>;
  onTail: (page: EventTail | null) => void;
  children: (page: EventTail | null) => React.ReactNode;
}) {
  const page = use(tail);
  useEffect(() => onTail(page), [page, onTail]);
  return children(page);
}

function FeedBody({
  runId,
  events,
  running,
  older,
  loadingEarlier,
  onEarlier,
}: {
  runId: string;
  events: RunEvent[];
  running: boolean;
  older: Older | null;
  loadingEarlier: "idle" | "loading" | "failed";
  onEarlier: (from: Older) => void;
}) {
  const { earlier, recent } = splitEarlier(activityOf(events, running));
  const passed = earlier.filter((i): i is StageHeader => i.kind === "stage");
  const feedItem = (it: ActivityItem) => (
    <li key={it.key}>{it.kind === "turn" ? <TurnGroup runId={runId} turn={it} /> : it.kind === "stage" ? <Stage header={it} /> : <LeadingCost cost={it.cost} />}</li>
  );
  return (
    <>
      {older ? (
        <button type="button" className="oq-button oq-button--ghost oq-button--sm console-feed__earlier" disabled={loadingEarlier === "loading"} onClick={() => onEarlier(older)}>
          {loadingEarlier === "loading" ? "Loading earlier activity…" : loadingEarlier === "failed" ? "Couldn't load earlier activity. Try again" : "Show earlier activity"}
        </button>
      ) : null}
      <ol className="console-feed">
        {earlier.length ? (
          <li>
            <details className="console-feed__earlier-stages">
              <summary>
                <svg className="oq-icon oq-icon--sm console-turn__chevron" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m9 6 6 6-6 6" />
                </svg>
                {passed.length ? `${passed.length} earlier ${passed.length === 1 ? "stage" : "stages"} · ${passed.map((h) => stateLabel(h.to)).join(" → ")}` : "Earlier activity"}
              </summary>
              <ol className="console-feed">{earlier.map(feedItem)}</ol>
            </details>
          </li>
        ) : null}
        {recent.map(feedItem)}
      </ol>
    </>
  );
}

function CostNote({ cost }: { cost: CostFold }) {
  const text = costText(cost, usd);
  return <span title={text.detail}>{text.short}</span>;
}

const TOOL_ICON: Record<StepRow["tool"], React.ReactNode> = {
  run: <path d="M4 17l6-5-6-5M12 19h8" />,
  test: <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  think: <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3z" />,
  retry: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  fail: <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6" />,
  browser: <path d="M3 5h18v14H3zM3 9h18M6 7h.01M9 7h.01" />,
};

function TurnGroup({ runId, turn }: { runId: string; turn: ActivityTurn }) {
  const who = turn.role === "repairer" ? "Repair turn" : "Windkeel";
  const steps = stepCount(turn);
  const edited = turn.ended && turn.rows.some((r) => r.kind === "step" && r.tool === "edit");
  const duration = turnDuration(turn);
  return (
    <details className="console-turn" open={!turn.ended || undefined} data-state={turn.ended ? (turn.failed ? "failed" : "done") : "running"}>
      <summary className="console-turn__summary">
        {turn.ended ? null : <span className="oq-spinner" aria-hidden="true" />}
        <span className="console-turn__title" suppressHydrationWarning title={`Agent run ${turn.agentRunId}`}>
          {who} {turn.ended ? "worked" : "is working"}
          {duration ? ` for ${duration}` : ""}
        </span>
        <span className="console-turn__meta">
          {steps} {steps === 1 ? "step" : "steps"}
          {turn.cost ? (
            <>
              {" · "}
              <CostNote cost={turn.cost} />
            </>
          ) : null}
        </span>
        {edited ? (
          <Link className="console-turn__changes" href={workspaceHref(runId, "changes", undefined, { turn: turn.agentRunId })} scroll={false}>
            Changes
          </Link>
        ) : null}
        <svg className="oq-icon oq-icon--sm console-turn__chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </summary>
      <div className="console-turn__body">
        {turn.rows.map((row) =>
          row.kind === "message" ? (
            <article key={row.key} className="oq-message console-turn__message">
              <span className="oq-avatar oq-avatar--agent oq-avatar--sm" aria-hidden="true">
                O
              </span>
              <div>
                <div className="oq-message__header">
                  <span className="oq-message__author">Windkeel</span>
                  <time dateTime={row.at} suppressHydrationWarning>
                    {new Date(row.at).toLocaleTimeString()}
                  </time>
                </div>
                <div className="oq-message__body">
                  <p>{row.text}</p>
                </div>
              </div>
            </article>
          ) : row.kind === "screenshot" ? (
            <ScreenshotThumb key={row.key} runId={runId} screenshotId={row.screenshotId} name={row.name} url={row.url} />
          ) : (
            <Step key={row.key} row={row} />
          ),
        )}
        {turn.ended && (turn.cost || duration) ? (
          <footer className="console-turn__footer">
            {turn.cost ? <CostNote cost={turn.cost} /> : null}
            {turn.cost && duration ? " · " : null}
            {duration}
          </footer>
        ) : null}
      </div>
    </details>
  );
}

function Step({ row }: { row: StepRow }) {
  const summary = (
    <summary className="oq-step__summary" style={row.detail ? undefined : { cursor: "default" }}>
      {row.state === "running" ? (
        <span className="oq-spinner" aria-hidden="true" />
      ) : (
        <svg className="oq-icon oq-icon--sm" viewBox="0 0 24 24" aria-hidden="true">
          {TOOL_ICON[row.state === "failed" && row.tool !== "test" && row.tool !== "run" ? "fail" : row.tool]}
        </svg>
      )}
      <span className="oq-step__verb">{row.verb}</span>
      <span className={row.tool === "think" ? "oq-step__target console-step__prose" : "oq-step__target"} title={row.target}>
        {row.target}
      </span>
      {row.meta ? <span className="oq-step__meta">{row.meta}</span> : null}
      {row.detail ? (
        <svg className="oq-icon oq-icon--sm oq-step__chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
      ) : null}
    </summary>
  );
  return (
    <details className="oq-step" data-state={row.state}>
      {summary}
      {row.detail ? (
        <div className="oq-step__detail">
          <p className="console-step__detail">{row.detail}</p>
        </div>
      ) : null}
    </details>
  );
}

function Stage({ header }: { header: StageHeader }) {
  const tone = header.to === "FAILED" || header.to === "MAX_REPAIR_ATTEMPTS_REACHED" ? "failed" : TERMINAL_STATES.has(header.to) ? "ended" : undefined;
  return (
    <div className="console-stage" data-tone={tone} title={header.title}>
      <span className="console-stage__name">{stateLabel(header.to)}</span>
      {header.reason ? <span className="console-stage__reason">{header.reason}</span> : null}
      <span className="console-stage__meta">
        {header.cost ? (
          <>
            <CostNote cost={header.cost} />
            {" · "}
          </>
        ) : null}
        <time dateTime={header.at} suppressHydrationWarning>
          {new Date(header.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </time>
      </span>
    </div>
  );
}

function LeadingCost({ cost }: { cost: CostFold }) {
  return (
    <p className="console-stage__reason console-feed__cost">
      Spent before this point: <CostNote cost={cost} />
    </p>
  );
}
