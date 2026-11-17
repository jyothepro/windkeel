"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { afterStream, retryDelayMs, type CursorFrame } from "../lib/feed.ts";
import { FALLBACK_REFRESH_MS, fallbackDue, firstSighting, sharedRefreshScheduler } from "../lib/live.ts";
import type { RunChange } from "../lib/types.ts";

const FALLBACK_CHECK_MS = 30_000;

export function LiveLists() {
  const router = useRouter();
  useEffect(() => {
    const scheduler = sharedRefreshScheduler();
    const refresh = () => router.refresh();
    const seen: string[] = [];
    let source: EventSource | null = null;
    let cursor: string | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let stopped = false;
    let missed = false;
    let hidden = document.visibilityState === "hidden";

    const changed = () => {
      if (hidden) missed = true;
      else scheduler.request(refresh);
    };

    const open = () => {
      if (hidden || stopped) return;
      source = new EventSource(cursor ? `/api/events?after=${encodeURIComponent(cursor)}` : "/api/events");
      source.onopen = () => {
        failures = 0;
      };
      source.addEventListener("run.changed", (e) => {
        const message = e as MessageEvent<string>;
        if (message.lastEventId) cursor = message.lastEventId;
        const change = JSON.parse(message.data) as RunChange;
        if (firstSighting(seen, change.changeId)) changed();
      });
      source.addEventListener("resync", (e) => {
        cursor = (JSON.parse((e as MessageEvent<string>).data) as { cursor: string }).cursor;
        changed();
      });
      source.addEventListener("cursor", (e) => {
        const frame = JSON.parse((e as MessageEvent<string>).data) as CursorFrame;
        cursor = frame.cursor;
        source?.close();
        source = null;
        if (afterStream(frame) === "stop") retry = setTimeout(open, FALLBACK_REFRESH_MS);
        else open();
      });
      source.onerror = () => {
        source?.close();
        source = null;
        failures += 1;
        retry = setTimeout(open, retryDelayMs(failures));
      };
    };

    const onVisibility = () => {
      hidden = document.visibilityState === "hidden";
      if (hidden) {
        clearTimeout(retry);
        source?.close();
        source = null;
        return;
      }
      if (missed || fallbackDue(scheduler.lastRefreshAt(), Date.now())) {
        missed = false;
        scheduler.request(refresh);
      }
      if (!source) open();
    };

    const fallback = setInterval(() => {
      if (!hidden && fallbackDue(scheduler.lastRefreshAt(), Date.now())) {
        scheduler.noteRefreshed();
        refresh();
      }
    }, FALLBACK_CHECK_MS);

    document.addEventListener("visibilitychange", onVisibility);
    open();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(fallback);
      clearTimeout(retry);
      source?.close();
    };
  }, [router]);
  return null;
}
