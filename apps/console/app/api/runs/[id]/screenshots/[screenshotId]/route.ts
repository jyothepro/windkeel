import { apiAuth, apiMode, scopedPath } from "../../../../../../lib/api.ts";

const SCREENSHOT_ID = /^[0-9a-f-]{36}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; screenshotId: string }> }) {
  if (apiMode() === "fixtures") return new Response("No factory is connected; fixtures have no screenshots.", { status: 404 });
  const { id, screenshotId } = await params;
  if (!SCREENSHOT_ID.test(screenshotId)) return new Response("not a screenshot id", { status: 404 });
  const { url, token } = await apiAuth();
  const scoped = await scopedPath(`/runs/${encodeURIComponent(id)}/screenshots/${encodeURIComponent(screenshotId)}`);
  const upstream = await fetch(`${url}/v1${scoped}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (upstream.status !== 200 || upstream.headers.get("content-type") !== "image/png") {
    return new Response(await upstream.text(), { status: upstream.status === 200 ? 502 : upstream.status, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
  }
  return new Response(await upstream.arrayBuffer(), {
    status: 200,
    headers: {
      "content-type": "image/png",
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=300",
    },
  });
}
