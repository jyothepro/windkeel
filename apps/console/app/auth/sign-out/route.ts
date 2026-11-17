import { NextResponse } from "next/server";
import { supabaseServer } from "../../../lib/auth.ts";

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  if (supabase) await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
