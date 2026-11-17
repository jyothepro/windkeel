import { apiAuth, apiMode, scopedPath } from "../../../lib/api.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
};

function stopFrame(after: string, reason: string): Response {
  const frame = `id: ${after}\nevent: cursor\ndata: ${JSON.stringify({ cursor: after, reason, reconnect: false })}\n\n`;
  return new Response(frame, { headers: SSE_HEADERS });
}

export async function GET(request: Request) {
  const after = new URL(request.url).searchParams.get("after");
  if (after !== null && !/^\d+$/.test(after)) return stopFrame("0", "refused: not a cursor");

  if (apiMode() === "fixtures") return fixtureStream(after ?? "0", request.signal);

  const { url, token } = await apiAuth();
  const path = await scopedPath(`/events?stream=sse${after ? `&after=${encodeURIComponent(after)}` : ""}`);
  let upstream: Response;
  try {
    upstream = await fetch(`${url}/v1${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: request.signal,
      cache: "no-store",
    });
  } catch {
    return new Response(null, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    if (upstream.status >= 400 && upstream.status < 500) {
      const body = (await upstream.json().catch(() => ({}))) as { error?: string };
      return stopFrame(after ?? "0", `refused: ${body.error ?? `the API answered ${upstream.status}`}`);
    }
    return new Response(null, { status: 502 });
  }
  return new Response(upstream.body, { headers: SSE_HEADERS });
}

function fixtureStream(after: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let budget: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearInterval(keepAlive);
    clearTimeout(budget);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": keep-alive\n\n"));
      keepAlive = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 15_000);
      budget = setTimeout(() => {
        stop();
        controller.enqueue(encoder.encode(`id: ${after}\nevent: cursor\ndata: ${JSON.stringify({ cursor: after, reason: "budget_exhausted", reconnect: true })}\n\n`));
        controller.close();
      }, 120_000);
      signal.addEventListener("abort", stop);
    },
    cancel: stop,
  });
  return new Response(body, { headers: SSE_HEADERS });
}
