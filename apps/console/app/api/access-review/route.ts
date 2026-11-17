import { apiAuth, apiMode } from "../../../lib/api.ts";

export async function GET() {
  if (apiMode() === "fixtures") return new Response("No factory is connected; sample data has no access review.", { status: 404 });
  const { url, token } = await apiAuth();
  const upstream = await fetch(`${url}/v1/account/access-review?format=csv`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const headers = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });
  const disposition = upstream.headers.get("content-disposition");
  if (disposition) headers.set("content-disposition", disposition);
  return new Response(await upstream.text(), { status: upstream.status, headers });
}
