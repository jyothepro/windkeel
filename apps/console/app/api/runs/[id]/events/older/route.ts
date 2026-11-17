import { ApiError, FEED_TAIL, getRunEventsTail } from "../../../../../../lib/api.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const before = new URL(request.url).searchParams.get("before") ?? undefined;
  if (before !== undefined && !/^\d+$/.test(before)) {
    return Response.json({ error: "before must be a cursor" }, { status: 400 });
  }
  try {
    return Response.json(await getRunEventsTail(id, before, FEED_TAIL), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof ApiError) return Response.json({ error: err.message, code: err.code }, { status: err.status >= 500 ? 502 : err.status });
    throw err;
  }
}
