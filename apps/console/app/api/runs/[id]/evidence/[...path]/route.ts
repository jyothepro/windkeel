import { apiAuth, apiMode, scopedPath } from "../../../../../../lib/api.ts";

const VERIFICATION_ID = /^[0-9a-f-]{8,64}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  if (apiMode() === "fixtures") return new Response("No factory is connected; fixture packages have no files.", { status: 404 });
  const { id, path } = await params;
  const { url, token } = await apiAuth();
  const verification = new URL(request.url).searchParams.get("verification");
  const which = verification && VERIFICATION_ID.test(verification) ? `?verification=${encodeURIComponent(verification)}` : "";
  const scoped = await scopedPath(`/runs/${encodeURIComponent(id)}/evidence/${path.map(encodeURIComponent).join("/")}${which}`);
  const upstream = await fetch(`${url}/v1${scoped}`, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "manual",
    cache: "no-store",
  });
  const location = upstream.headers.get("location");
  if (upstream.status === 302 && location) return Response.redirect(location, 302);
  return new Response(await upstream.text(), { status: upstream.status, headers: { "content-type": "application/json" } });
}
