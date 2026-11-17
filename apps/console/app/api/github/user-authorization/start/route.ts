import "../../../../../lib/env-compat.ts";
import { NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  AUTH_COOKIE_MAX_AGE,
  CALLBACK_PATH,
  authorizeUrl,
  encodePending,
  githubWebBase,
  newPendingAuthorization,
  returnWith,
  safeReturnTo,
} from "../../../../../lib/github-authorization.ts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
  if (!clientId) return NextResponse.redirect(new URL(returnWith(returnTo, "unconfigured"), url));

  const pending = newPendingAuthorization(returnTo);
  const response = NextResponse.redirect(
    authorizeUrl({
      clientId,
      redirectUri: new URL(CALLBACK_PATH, url).toString(),
      state: pending.state,
      challenge: pending.challenge,
      webBase: githubWebBase(process.env.GITHUB_API_BASE_URL),
    }),
  );
  response.cookies.set(AUTH_COOKIE, encodePending(pending), {
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "lax",
    path: CALLBACK_PATH,
    maxAge: AUTH_COOKIE_MAX_AGE,
  });
  return response;
}
