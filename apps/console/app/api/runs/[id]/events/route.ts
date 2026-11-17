import { apiAuth, apiMode, getRunEvents, scopedPath } from "../../../../../lib/api.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

function stopFrame(after: string, reason: string): Response {
  const frame = `id: ${after}\nevent: cursor\ndata: ${JSON.stringify({ cursor: after, reason, reconnect: false })}\n\n`;
  return new Response(frame, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const after = new URL(request.url).searchParams.get("after") ?? "0";

  if (apiMode() === "fixtures") return fixtureStream(id, after);

  const { url, token } = await apiAuth();
  const path = await scopedPath(`/runs/${encodeURIComponent(id)}/events?after=${encodeURIComponent(after)}&stream=sse`);
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
      return stopFrame(after, `refused: ${body.error ?? `the API answered ${upstream.status}`}`);
    }
    return new Response(null, { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

async function fixtureStream(id: string, after: string): Promise<Response> {
  const page = await getRunEvents(id);
  const events = page.items.filter((e) => Number(e.cursor) > Number(after));
  const last = events.at(-1)?.cursor ?? after;
  const frames = events.map((e) => `id: ${e.cursor}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
  const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" };

  if (page.terminal) {
    frames.push(`id: ${last}\nevent: cursor\ndata: ${JSON.stringify({ cursor: last, reason: "run_terminal", reconnect: false })}\n\n`);
    return new Response(frames.join(""), { headers });
  }

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.join("")));
      timer = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 15_000);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(body, { headers });
}
