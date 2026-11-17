import { adapterFromEnv } from "../../../lib/access-adapter.ts";
import { clientIp, createRateLimiter } from "../../../lib/rate-limit.ts";
import { validateAccessRequest } from "../../../lib/request-access.ts";

const limiter = createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });
const MAX_BODY_BYTES = 8 * 1024;

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

async function readBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new RangeError("too large");
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return JSON.parse(raw) as unknown;
  return Object.fromEntries(new URLSearchParams(raw));
}

export async function POST(request: Request): Promise<Response> {
  const limit = limiter.check(clientIp(request.headers));
  if (!limit.allowed) {
    return json(
      { ok: false, error: "Too many requests from this address. Try again in a few minutes." },
      429,
      { "retry-after": String(limit.retryAfterSeconds) },
    );
  }

  let body: unknown;
  try {
    body = await readBody(request);
  } catch {
    return json({ ok: false, error: "The request could not be read. Reload the page and try again." }, 400);
  }

  const result = validateAccessRequest(body);
  if (!result.ok && result.spam) return json({ ok: true }, 200);
  if (!result.ok) return json({ ok: false, error: "Some fields need a fix.", fields: result.errors }, 422);

  try {
    await adapterFromEnv(process.env).submit({ ...result.value, receivedAt: new Date().toISOString() });
  } catch (error) {
    console.error("access-request delivery failed", error instanceof Error ? error.message : String(error));
    return json({ ok: false, error: "We couldn't save your request just now. Try again in a minute." }, 502);
  }
  return json({ ok: true }, 200);
}
