import "./env-compat.ts";
import { redirect } from "next/navigation";
import { cache } from "react";
import { chosenOrganization, sessionAccessToken, supabaseConfig } from "./auth.ts";
import * as fixtures from "./fixtures.ts";
import { ApiError, callApi, refusal, type Method } from "./http.ts";
import { orgScoped } from "./org-path.ts";
import { notAMemberPath } from "./redirects.ts";
import { PERMISSIONS } from "./permissions.ts";
import type { CreatedToken, OrganizationView, SelfView } from "./types.ts";

if (typeof window !== "undefined") {
  throw new Error("lib/api-transport.ts is server-only: it reads WINDKEEL_API_TOKEN");
}

export function apiMode(): "live" | "fixtures" {
  const url = Boolean(process.env.WINDKEEL_API_URL);
  const token = Boolean(process.env.WINDKEEL_API_TOKEN);
  const signIn = supabaseConfig() !== null;

  if (url && (token || signIn)) return "live";
  if (signIn) {
    throw new ApiError(500, "api_misconfigured", "Sign-in is configured but WINDKEEL_API_URL isn't. Set it to the control plane's address.");
  }
  if (url || token) {
    throw new ApiError(500, "api_misconfigured", `${url ? "WINDKEEL_API_TOKEN" : "WINDKEEL_API_URL"} is not set, but ${url ? "WINDKEEL_API_URL" : "WINDKEEL_API_TOKEN"} is. Set both, or neither for sample data.`);
  }
  if (process.env.VERCEL) {
    throw new ApiError(500, "api_misconfigured", "This deployment has no WINDKEEL_API_URL and WINDKEEL_API_TOKEN. Sample data is for local development only.");
  }
  return "fixtures";
}

export async function apiAuth(): Promise<{ url: string; token: string }> {
  const url = process.env.WINDKEEL_API_URL;
  if (!url) throw new ApiError(503, "api_unconfigured", "WINDKEEL_API_URL is not set");
  if (supabaseConfig()) {
    const session = await sessionAccessToken();
    if (!session) redirect("/login");
    return { url: url.replace(/\/+$/, ""), token: session };
  }
  const token = process.env.WINDKEEL_API_TOKEN;
  if (!token) throw new ApiError(503, "api_unconfigured", "WINDKEEL_API_TOKEN is not set");
  return { url: url.replace(/\/+$/, ""), token };
}

export async function scopedPath(path: string): Promise<string> {
  return orgScoped(path, await chosenOrganization());
}

export const MAX_IN_FLIGHT = 3;
let inFlight = 0;
const waiting: Array<() => void> = [];

export async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

const CONNECTION_RETRY_MS = 600;

const cachedGet = cache((rawPath: string): Promise<unknown> => send("GET", rawPath));

export async function request<T>(method: Method, rawPath: string, body?: unknown, orgOverride?: string): Promise<T> {
  if (method === "GET" && body === undefined && !orgOverride) return (await cachedGet(rawPath)) as T;
  return send<T>(method, rawPath, body, orgOverride);
}

async function send<T>(method: Method, rawPath: string, body?: unknown, orgOverride?: string, retried = false): Promise<T> {
  const { url, token } = await apiAuth();
  const path = orgOverride ? orgScoped(rawPath, orgOverride) : await scopedPath(rawPath);
  const answer = await slot(() => callApi(url, token, method, path, body));
  if (!answer.ok) {
    const code = String(answer.json["code"] ?? answer.status);

    if (code === "connection_limit" && method === "GET" && !retried) {
      await new Promise((resolve) => setTimeout(resolve, CONNECTION_RETRY_MS + Math.random() * CONNECTION_RETRY_MS));
      return send<T>(method, rawPath, body, orgOverride, true);
    }

    if (code === "organization_required" && !orgOverride) {
      const first = (answer.json["organizations"] as Array<{ id: string }> | undefined)?.[0]?.id;
      if (first) return send<T>(method, rawPath, body, first);
    }

    if (code === "not_a_member") redirect(notAMemberPath());

    if (answer.status === 401 && supabaseConfig()) redirect("/login");
    throw refusal(answer);
  }
  return answer.json as T;
}

export function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const live = () => apiMode() === "live";

export function fixtureRefusal(): never {
  throw new ApiError(503, "api_unconfigured", "Commands need a factory. Set WINDKEEL_API_URL and WINDKEEL_API_TOKEN.");
}

export async function getIdentity(): Promise<SelfView> {
  if (!live()) return fixtures.self();
  const raw = await request<Partial<SelfView> & { subject: string; scopes: string[] }>("GET", "/self");
  if (raw.organizations && raw.principal && raw.account) return raw as SelfView;
  return {
    principal: { id: "operator", kind: "user", displayName: raw.subject, githubLogin: null },
    account: { id: "", name: "This deployment" },
    organizations: [{ id: "", name: "Default", role: "Operator", permissions: [...PERMISSIONS] }],
    token: null,
    via: "bootstrap",
    subject: raw.subject,
    scopes: raw.scopes,
  };
}

export async function currentOrganization(identity: SelfView): Promise<OrganizationView | null> {
  const chosen = await chosenOrganization();
  return identity.organizations.find((o) => o.id === chosen) ?? identity.organizations[0] ?? null;
}

export const orgRoute = (orgId: string, rest: string) => `/orgs/${encodeURIComponent(orgId)}${rest}`;

export function sampleOnly(): never {
  throw new ApiError(503, "api_unconfigured", "This needs a factory. Sample data can't change members, grants, tokens, integrations, schedules or models.");
}

export function sampleToken(): CreatedToken["secret"] {
  return `orq_SAMPLE_not_a_real_token_${Math.random().toString(36).slice(2, 10)}`;
}

export async function liveOr<T>(real: () => Promise<T>, sample: () => T | Promise<T> = sampleOnly): Promise<T> {
  return live() ? real() : sample();
}
