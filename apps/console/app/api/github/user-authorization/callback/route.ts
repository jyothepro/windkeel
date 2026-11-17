import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ApiError, connectGithub } from "../../../../../lib/api.ts";
import { AUTH_COOKIE, CALLBACK_PATH, decodePending, returnWith, statesMatch } from "../../../../../lib/github-authorization.ts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  const pending = decodePending(jar.get(AUTH_COOKIE)?.value);
  jar.set(AUTH_COOKIE, "", { path: CALLBACK_PATH, maxAge: 0 });
  const back = (outcome: string) => NextResponse.redirect(new URL(returnWith(pending?.returnTo ?? "/settings/merging", outcome), url));

  if (url.searchParams.get("error")) return back(url.searchParams.get("error") === "access_denied" ? "denied" : "failed");
  if (!pending || !statesMatch(pending.state, url.searchParams.get("state"))) return back("state_mismatch");
  const code = url.searchParams.get("code");
  if (!code) return back("failed");

  try {
    await connectGithub({ code, codeVerifier: pending.verifier, redirectUri: new URL(CALLBACK_PATH, url).toString() });
  } catch (err) {
    if (err instanceof ApiError) return back(err.code === "github_account_mismatch" ? "github_account_mismatch" : "failed");
    throw err;
  }
  return back("connected");
}
