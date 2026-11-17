import { NextResponse } from "next/server";
import { ApiError, linkInstallation } from "../../../../lib/api.ts";
import { installReturn } from "../../../../lib/welcome.ts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (outcome: { ok: true } | { ok: false; code: string }) => NextResponse.redirect(new URL(installReturn(outcome), url));
  const installationId = url.searchParams.get("installation_id");
  const state = url.searchParams.get("state");
  if (!installationId || !state) return back({ ok: false, code: "invalid_state" });
  try {
    await linkInstallation({ installationId, state, code: url.searchParams.get("code") ?? undefined });
  } catch (err) {
    if (err instanceof ApiError) return back({ ok: false, code: err.code });
    throw err;
  }
  return back({ ok: true });
}
