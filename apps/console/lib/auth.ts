import "./env-compat.ts";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

if (typeof window !== "undefined") {
  throw new Error("lib/auth.ts is server-only");
}

export interface SupabaseConfig {
  url: string;
  key: string;
}

export function supabaseConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

export async function supabaseServer() {
  const config = supabaseConfig();
  if (!config) return null;
  const store = await cookies();
  return createServerClient(config.url, config.key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
        }
      },
    },
  });
}

export async function sessionAccessToken(): Promise<string | null> {
  const supabase = await supabaseServer();
  if (!supabase) return null;
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function signedInAs(): Promise<{ email: string | null; githubLogin: string | null } | null> {
  const supabase = await supabaseServer();
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  const meta = data.user.user_metadata as Record<string, unknown>;
  return {
    email: data.user.email ?? null,
    githubLogin: typeof meta["user_name"] === "string" ? (meta["user_name"]) : null,
  };
}

export const ORG_COOKIE = "windkeel-org";

export async function chosenOrganization(): Promise<string | null> {
  return (await cookies()).get(ORG_COOKIE)?.value ?? null;
}
