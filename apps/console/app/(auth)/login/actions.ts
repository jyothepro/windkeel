"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseServer } from "../../../lib/auth.ts";
import { safeNext } from "../../../lib/redirects.ts";

export async function continueWithGitHub(form: FormData): Promise<void> {
  const supabase = await supabaseServer();
  if (!supabase) redirect("/login?error=not_configured");
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const next = safeNext(String(form.get("next") ?? ""));
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  if (error || !data.url) redirect(`/login?error=oauth_start&next=${encodeURIComponent(next)}`);
  redirect(data.url);
}
