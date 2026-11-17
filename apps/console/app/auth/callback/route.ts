import { NextResponse } from "next/server";
import { supabaseServer } from "../../../lib/auth.ts";
import { safeNext } from "../../../lib/redirects.ts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));
  const denied = url.searchParams.get("error");
  if (denied) return NextResponse.redirect(new URL(`/login?error=${denied === "access_denied" ? "access_denied" : "oauth_callback"}`, url));

  const supabase = await supabaseServer();
  if (!supabase) return NextResponse.redirect(new URL("/login?error=not_configured", url));
  if (!code) return NextResponse.redirect(new URL("/login?error=oauth_callback", url));

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(new URL(`/login?error=oauth_callback&next=${encodeURIComponent(next)}`, url));
  return NextResponse.redirect(new URL(next, url));
}
