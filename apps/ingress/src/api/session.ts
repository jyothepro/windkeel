import { createHmac, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import type { SessionClaims } from "@windkeel/factory/tenancy";
import { githubIdentityRows } from "../stores/identity-store.js";

export interface SessionVerifier {
  verify(jwt: string): Promise<SessionClaims | null>;
}

export interface SupabaseSessionConfig {
  url: string;
  jwtSecret?: string | undefined;
  githubIdentities?: GithubIdentitySource | undefined;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  [field: string]: unknown;
}

const JWKS_TTL_MS = 10 * 60 * 1000;
const SKEW_SECONDS = 30;
const IDENTITY_TTL_MS = 60 * 1000;
const IDENTITY_CACHE_MAX = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GithubIdentity {
  id: number;
  login: string | null;
  name: string | null;
}

export interface GithubIdentitySource {
  lookup(subject: string): Promise<Array<{ githubUserId: unknown; githubLogin: unknown; displayName: unknown }>>;
}

export function poolGithubIdentities(db: {
  query(text: string, values: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}): GithubIdentitySource {
  return {
    async lookup(subject) {
      try {
        const rows = await githubIdentityRows(db, subject);
        return rows.map((row) => ({
          githubUserId: row["github_user_id"],
          githubLogin: row["github_login"],
          displayName: row["display_name"],
        }));
      } catch (err) {
        console.error(`github_identity_of failed: ${(err as { code?: string }).code ?? (err as Error).message}`);
        throw err;
      }
    },
  };
}

export function supabaseSessionVerifier(config: SupabaseSessionConfig): SessionVerifier {
  const base = config.url.replace(/\/+$/, "");
  const issuer = `${base}/auth/v1`;
  const doFetch = config.fetch ?? globalThis.fetch;
  const now = config.now ?? Date.now;
  let cache: { at: number; keys: Map<string, { key: KeyObject; alg: string }> } | null = null;
  const identities = new Map<string, { at: number; identity: GithubIdentity | null }>();

  async function githubIdentityOf(subject: string): Promise<GithubIdentity | null | undefined> {
    const hit = identities.get(subject);
    if (hit && now() - hit.at < IDENTITY_TTL_MS) return hit.identity;
    if (!config.githubIdentities || !UUID.test(subject)) return null;
    let rows: Awaited<ReturnType<GithubIdentitySource["lookup"]>>;
    try {
      rows = await config.githubIdentities.lookup(subject);
    } catch {
      return undefined;
    }
    const identity = githubIdentityFrom(rows);
    if (identities.size >= IDENTITY_CACHE_MAX) identities.delete(identities.keys().next().value!);
    identities.set(subject, { at: now(), identity });
    return identity;
  }

  async function keys(force: boolean): Promise<Map<string, { key: KeyObject; alg: string }>> {
    if (!force && cache && now() - cache.at < JWKS_TTL_MS) return cache.keys;
    const response = await doFetch(`${issuer}/.well-known/jwks.json`);
    if (!response.ok) return cache?.keys ?? new Map();
    const body = (await response.json()) as { keys?: Jwk[] };
    const map = new Map<string, { key: KeyObject; alg: string }>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid) continue;
      try {
        const alg = jwk.alg ?? (jwk.kty === "EC" ? "ES256" : "RS256");
        map.set(jwk.kid, { key: createPublicKey({ key: jwk as never, format: "jwk" }), alg });
      } catch {
      }
    }
    cache = { at: now(), keys: map };
    return map;
  }

  return {
    async verify(jwt) {
      const parts = jwt.split(".");
      if (parts.length !== 3) return null;
      const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
      const header = decodeJson(encodedHeader);
      const payload = decodeJson(encodedPayload);
      if (!header || !payload) return null;

      const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8");
      const signature = Buffer.from(encodedSignature, "base64url");
      const alg = header["alg"];

      let valid = false;
      if (alg === "HS256") {
        if (!config.jwtSecret) return null;
        const expected = createHmac("sha256", config.jwtSecret).update(signed).digest();
        valid = expected.length === signature.length && timingSafeEqual(expected, signature);
      } else if (alg === "ES256" || alg === "RS256") {
        const kid = typeof header["kid"] === "string" ? header["kid"] : undefined;
        if (!kid) return null;
        const found = (await keys(false)).get(kid) ?? (await keys(true)).get(kid);
        if (!found || found.alg !== alg) return null;
        valid = verify(
          "sha256",
          signed,
          alg === "ES256" ? { key: found.key, dsaEncoding: "ieee-p1363" } : found.key,
          signature,
        );
      } else {
        return null;
      }
      if (!valid) return null;

      const seconds = now() / 1000;
      if (typeof payload["exp"] !== "number" || payload["exp"] + SKEW_SECONDS < seconds) return null;
      if (typeof payload["nbf"] === "number" && payload["nbf"] - SKEW_SECONDS > seconds) return null;
      if (payload["iss"] !== issuer) return null;
      if (!audienceIncludes(payload["aud"], "authenticated")) return null;
      if (typeof payload["sub"] !== "string" || payload["sub"] === "") return null;

      if (!signedInWithGithub(payload)) return claimsFrom(payload, null);
      const identity = await githubIdentityOf(payload["sub"]);
      return identity === undefined ? null : claimsFrom(payload, identity);
    },
  };
}

function claimsFrom(payload: Record<string, unknown>, identity: GithubIdentity | null): SessionClaims {
  const metadata = (payload["user_metadata"] ?? {}) as Record<string, unknown>;
  const typedName = metadata["full_name"] ?? metadata["name"];
  const name = identity?.name ?? (typeof typedName === "string" && typedName.trim() !== "" ? typedName : null);
  return {
    provider: "supabase",
    subject: payload["sub"] as string,
    githubUserId: identity?.id ?? null,
    githubLogin: identity?.login ?? null,
    displayName: name ?? identity?.login ?? null,
    sessionId: typeof payload["session_id"] === "string" && payload["session_id"] !== "" ? payload["session_id"] : null,
    aal: typeof payload["aal"] === "string" ? payload["aal"] : null,
  };
}

const UNAMBIGUOUS_PROVIDERS = new Set(["github", "email", "phone"]);

function signedInWithGithub(payload: Record<string, unknown>): boolean {
  const appMetadata = (payload["app_metadata"] ?? {}) as Record<string, unknown>;
  if (appMetadata["provider"] !== "github") return false;
  const providers = Array.isArray(appMetadata["providers"]) ? (appMetadata["providers"] as unknown[]) : [];
  if (!providers.every((p) => typeof p === "string" && UNAMBIGUOUS_PROVIDERS.has(p))) return false;
  const amr = Array.isArray(payload["amr"]) ? (payload["amr"] as unknown[]) : [];
  return amr.some(
    (entry) =>
      entry === "oauth" ||
      (typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["method"] === "oauth"),
  );
}

function githubIdentityFrom(rows: Awaited<ReturnType<GithubIdentitySource["lookup"]>>): GithubIdentity | null {
  const found = new Map<number, GithubIdentity>();
  for (const row of rows) {
    const id = typeof row.githubUserId === "string" || typeof row.githubUserId === "number" ? String(row.githubUserId) : "";
    if (!/^\d+$/.test(id)) continue;
    const { githubLogin: login, displayName: name } = row;
    found.set(Number(id), {
      id: Number(id),
      login: typeof login === "string" && login !== "" ? login : null,
      name: typeof name === "string" && name.trim() !== "" ? name : null,
    });
  }
  return found.size === 1 ? [...found.values()][0]! : null;
}

function audienceIncludes(aud: unknown, wanted: string): boolean {
  return aud === wanted || (Array.isArray(aud) && aud.includes(wanted));
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
