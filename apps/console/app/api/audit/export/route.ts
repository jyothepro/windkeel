import { apiAuth, apiMode, currentOrganization, getIdentity } from "../../../../lib/api.ts";

const FORWARDED = ["format", "action", "after", "before"] as const;

export async function GET(request: Request) {
  if (apiMode() === "fixtures") return new Response("No factory is connected; sample data has no audit log.", { status: 404 });
  const org = await currentOrganization(await getIdentity());
  if (!org) return new Response("You're not in an organization.", { status: 403 });
  const { url, token } = await apiAuth();
  const incoming = new URL(request.url).searchParams;
  const params = new URLSearchParams();
  for (const name of FORWARDED) {
    const value = incoming.get(name);
    if (value) params.set(name, value);
  }
  if (!params.has("format")) params.set("format", "csv");
  const upstream = await fetch(`${url}/v1/orgs/${encodeURIComponent(org.id)}/audit-events/export?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const headers = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });
  for (const name of ["content-disposition", "x-windkeel-next-cursor", "x-windkeel-export-count"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(await upstream.text(), { status: upstream.status, headers });
}
