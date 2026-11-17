import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE = "windkeel_github_authorization";
export const CALLBACK_PATH = "/api/github/user-authorization/callback";
export const START_PATH = "/api/github/user-authorization/start";
export const AUTH_COOKIE_MAX_AGE = 600;

export interface PendingAuthorization {
  state: string;
  verifier: string;
  returnTo: string;
}

export function newPendingAuthorization(returnTo: string): PendingAuthorization & { challenge: string } {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  return { state, verifier, returnTo: safeReturnTo(returnTo), challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function githubWebBase(apiBase: string | undefined | null): string {
  const raw = (apiBase ?? "").trim().replace(/\/+$/, "");
  if (raw === "") return "https://github.com";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "https://github.com";
  }
  if (/^\/api\/v3$/.test(url.pathname)) return url.origin;
  if (url.hostname.startsWith("api.")) return `${url.protocol}//${url.host.slice(4)}`;
  return url.origin;
}

export function authorizeUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string; webBase?: string }): string {
  const url = new URL(`${input.webBase ?? "https://github.com"}/login/oauth/authorize`);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/settings/merging";
  return raw;
}

export function encodePending(p: PendingAuthorization): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

export function decodePending(raw: string | undefined): PendingAuthorization | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<PendingAuthorization>;
    if (typeof p.state !== "string" || typeof p.verifier !== "string") return null;
    return { state: p.state, verifier: p.verifier, returnTo: safeReturnTo(p.returnTo) };
  } catch {
    return null;
  }
}

export function statesMatch(expected: string, received: string | null): boolean {
  if (!received) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(received).digest();
  return timingSafeEqual(a, b) && expected.length === received.length;
}

export function returnWith(returnTo: string, outcome: string): string {
  const sep = returnTo.includes("?") ? "&" : "?";
  return `${returnTo}${sep}github=${encodeURIComponent(outcome)}`;
}

export function outcomeMessage(outcome: string | undefined): { intent: "success" | "danger"; text: string } | null {
  switch (outcome) {
    case undefined:
      return null;
    case "connected":
      return { intent: "success", text: "GitHub is connected. Windkeel can merge as you where you're allowed to." };
    case "github_account_mismatch":
      return { intent: "danger", text: "You authorized a different GitHub account from the one you sign in with. Sign in to GitHub as yourself and connect again." };
    case "state_mismatch":
      return { intent: "danger", text: "That authorization didn't start here, or took too long. Start it again." };
    case "denied":
      return { intent: "danger", text: "GitHub authorization was cancelled. Nothing changed." };
    case "unconfigured":
      return { intent: "danger", text: "This console has no GITHUB_APP_CLIENT_ID, so it can't start a GitHub authorization." };
    default:
      return { intent: "danger", text: "GitHub authorization didn't complete. Try again; if it keeps failing, the deployment's GitHub App settings need a look." };
  }
}
