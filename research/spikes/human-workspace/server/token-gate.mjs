// @ts-check
/**
 * The capability-token gate for a human workspace (ADR-0029 §4). Pure: no sockets, no I/O, no
 * globals except `node:crypto` — the clock is injected — so every decision the workspace server
 * makes about a request is unit-testable without a sandbox (test/token-gate.test.mjs).
 *
 * The model:
 *
 * - **The token.** 256 random bits, base64url (43 chars), minted by the API (here: the harness)
 *   for one principal and one human session. The workspace server is never given the token: it
 *   is started with only `sha256(token)` and an expiry. Anyone who can read the server's
 *   environment (the person, who has sudo in the VM) learns a hash, not a credential.
 * - **Delivery.** The console opens `https://<sandbox>/__windkeel/open#t=<token>`. A fragment is
 *   never sent to any server or proxy, so it cannot reach a proxy log. The bootstrap page
 *   strips it from the address bar and history, then POSTs it (same-origin, JSON) to
 *   `/__windkeel/session`, which answers with an `HttpOnly; Secure; SameSite=Strict` cookie on the
 *   sandbox's own origin. A token in a query string is never read.
 * - **The cookie is not the token.** The exchange mints a separate 256-bit session id; the
 *   token is single-use by default (`maxExchanges`), so a fragment left in a history entry, a
 *   screenshot or a shoulder-surf cannot be replayed once the person's tab has used it.
 * - **Comparison.** Secrets are compared as SHA-256 digests with `timingSafeEqual` (equal length
 *   by construction). Sessions are looked up by the hex digest of the cookie value, so a timing
 *   side channel on the Map lookup can at most reveal a prefix of a hash.
 * - **Expiry, renewal and revocation.** Everything dies at `expiresAt`. While a person is using
 *   the workspace the API keeps the sandbox alive (`extendTimeout`) and, in the same step, calls
 *   `renew()` with the token as a bearer to push `expiresAt` forward — so an actively used session
 *   is not cut off at the initial TTL. Renewal only ever extends, is capped at `maxRenewMs` from
 *   now, and cannot bring back an expired or revoked gate. `revoke()` (called by the API on
 *   hand-back, submit or cancel, or by the person) is terminal: no token, no session, nothing
 *   works afterwards, and the server closes live sockets via `onRevoke`.
 * - **Cross-origin.** State-changing requests and WebSocket upgrades must carry an `Origin` equal
 *   to the sandbox's own public origin. WebSockets are not covered by CORS, so this is what stops
 *   a page on another site from opening a PTY with the person's cookie (CSWSH) — SameSite=Strict
 *   already stops it in current browsers, and `vercel.run` is on the Public Suffix List (so each
 *   sandbox is its own site), but the Origin check does not depend on either.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** `__Host-` forces Secure, Path=/ and no Domain — no sibling host can set or shadow it. */
export const COOKIE_NAME = "__Host-windkeel_ws";

/** The only routes served without a session. Both are static and identical for every caller. */
export const PUBLIC_ROUTES = Object.freeze([
  { method: "GET", path: "/__windkeel/open" },
  { method: "GET", path: "/__windkeel/boot.js" },
  { method: "POST", path: "/__windkeel/session" },
  // Revocation authenticates itself (bearer token or session), so it is reachable without a cookie.
  { method: "POST", path: "/__windkeel/revoke" },
  // Renewal is API-only (bearer token), so it is reachable without a cookie.
  { method: "POST", path: "/__windkeel/renew" },
]);

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** @param {string | Buffer} secret */
export function sha256(secret) {
  return createHash("sha256").update(secret).digest();
}

/** @param {string} secret */
export function sha256Hex(secret) {
  return sha256(secret).toString("hex");
}

/** 256 random bits, base64url without padding (43 characters). */
export function randomSecret() {
  return randomBytes(32).toString("base64url");
}

/**
 * What the API does when a human session starts: a fresh token and the hash the workspace server
 * is started with. The token goes to the console (and then the person's browser) only.
 */
export function mintToken() {
  const token = randomSecret();
  return { token, tokenSha256: sha256Hex(token) };
}

/** @param {unknown} value */
export function isWellFormedToken(value) {
  return typeof value === "string" && TOKEN_RE.test(value);
}

/**
 * Constant-time equality of a presented secret against a stored SHA-256 hex digest.
 * @param {string} presented
 * @param {Buffer} expectedDigest 32 bytes
 */
export function secretMatches(presented, expectedDigest) {
  const got = sha256(presented);
  return got.length === expectedDigest.length && timingSafeEqual(got, expectedDigest);
}

/**
 * RFC 6265 cookie header → map. Last duplicate wins is not good enough for a credential: a
 * duplicated session cookie is refused outright (see `authorize`).
 * @param {string | undefined} header
 * @returns {Map<string, string[]>}
 */
export function parseCookies(header) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const value = part.slice(eq + 1).trim();
    const list = out.get(name) ?? [];
    list.push(value);
    out.set(name, list);
  }
  return out;
}

/** @param {string} method @param {string} pathname */
export function isPublicRoute(method, pathname) {
  return PUBLIC_ROUTES.some((r) => r.method === method && r.path === pathname);
}

/**
 * Headers every gated and bootstrap response carries. Proxied editor responses keep their own
 * CSP (OpenVSCode needs workers and inline styles) but get the rest.
 * @param {string} publicOrigin e.g. `https://sb-abc.vercel.run`
 */
export function securityHeaders(publicOrigin) {
  const wsOrigin = publicOrigin.replace(/^http/, "ws");
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      `connect-src 'self' ${wsOrigin}`,
      "img-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "object-src 'none'",
    ].join("; "),
  };
}

/**
 * @typedef {{ ok: true, sessionId?: string, setCookie?: string }} Allow
 * @typedef {{ ok: false, status: 400 | 401 | 403 | 410 | 415, reason: string }} Deny
 * @typedef {Allow | Deny} Decision
 */

/**
 * @param {{
 *   tokenSha256: string,
 *   expiresAt: number,
 *   publicOrigin: string,
 *   now?: () => number,
 *   maxExchanges?: number,
 *   maxRenewMs?: number,
 * }} options
 */
export function createGate(options) {
  if (!/^[0-9a-f]{64}$/.test(options.tokenSha256)) {
    throw new Error("tokenSha256 must be a 64-char lowercase hex SHA-256 digest");
  }
  if (!Number.isFinite(options.expiresAt)) throw new Error("expiresAt must be epoch milliseconds");
  const origin = new URL(options.publicOrigin).origin;
  if (origin !== options.publicOrigin) {
    throw new Error(`publicOrigin must be a bare origin (got ${options.publicOrigin}, want ${origin})`);
  }
  const tokenDigest = Buffer.from(options.tokenSha256, "hex");
  const now = options.now ?? Date.now;
  const maxExchanges = options.maxExchanges ?? 1;
  const maxRenewMs = options.maxRenewMs ?? 60 * 60_000;
  let expiresAt = options.expiresAt;
  /** sha256hex(sessionId) → the expiry its cookie's Max-Age was last set to */
  const sessions = new Map();
  let exchanges = 0;
  let revoked = false;
  /** @type {Array<() => void>} */
  const revokeListeners = [];
  /** @type {Array<(expiresAt: number) => void>} */
  const renewListeners = [];

  /** @returns {Deny | null} */
  function dead() {
    if (revoked) return { ok: false, status: 410, reason: "session revoked" };
    if (now() >= expiresAt) return { ok: false, status: 401, reason: "session expired" };
    return null;
  }

  /** @param {string | undefined} requestOrigin @returns {Deny | null} */
  function checkOrigin(requestOrigin) {
    if (requestOrigin !== origin) {
      return { ok: false, status: 403, reason: `origin ${requestOrigin ?? "(none)"} is not ${origin}` };
    }
    return null;
  }

  /** @param {string | undefined} cookieHeader @returns {string | null} the session digest */
  function sessionFrom(cookieHeader) {
    const values = parseCookies(cookieHeader).get(COOKIE_NAME);
    if (!values || values.length !== 1) return null;
    const value = values[0];
    if (!isWellFormedToken(value)) return null;
    const key = sha256Hex(value);
    if (!sessions.has(key)) return null;
    return key;
  }

  /** @param {string} sessionId */
  function cookieFor(sessionId) {
    const maxAge = Math.max(0, Math.floor((expiresAt - now()) / 1000));
    return `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
  }

  /** @param {string | undefined} authorization */
  function bearerMatches(authorization) {
    const bearer = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
    if (bearer === undefined) return null;
    return isWellFormedToken(bearer) && secretMatches(bearer, tokenDigest);
  }

  return {
    get expiresAt() {
      return expiresAt;
    },
    get revoked() {
      return revoked;
    },
    get liveSessions() {
      return sessions.size;
    },

    /**
     * `POST /__windkeel/session` with body `{ "token": "..." }`.
     * @param {{ origin?: string, contentType?: string, body: unknown }} req
     * @returns {Decision}
     */
    exchange(req) {
      const gone = dead();
      if (gone) return gone;
      const badOrigin = checkOrigin(req.origin);
      if (badOrigin) return badOrigin;
      // A JSON content type makes a cross-origin fetch a preflighted one, which this server never
      // approves; a classic HTML form cannot send it.
      if (!/^application\/json(\s*;|$)/i.test(req.contentType ?? "")) {
        return { ok: false, status: 415, reason: "content-type must be application/json" };
      }
      const token =
        req.body && typeof req.body === "object" ? /** @type {Record<string, unknown>} */ (req.body).token : undefined;
      if (!isWellFormedToken(token)) return { ok: false, status: 400, reason: "malformed token" };
      if (!secretMatches(/** @type {string} */ (token), tokenDigest)) {
        return { ok: false, status: 401, reason: "token does not match" };
      }
      if (exchanges >= maxExchanges) return { ok: false, status: 401, reason: "token already used" };
      exchanges += 1;
      const sessionId = randomSecret();
      sessions.set(sha256Hex(sessionId), expiresAt);
      return { ok: true, sessionId, setCookie: cookieFor(sessionId) };
    },

    /**
     * Every request other than the public routes.
     * @param {{ method: string, cookie?: string, origin?: string, upgrade?: boolean }} req
     * @returns {Decision}
     */
    authorize(req) {
      const gone = dead();
      if (gone) return gone;
      const stateChanging = !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase());
      if (req.upgrade || stateChanging) {
        const badOrigin = checkOrigin(req.origin);
        if (badOrigin) return badOrigin;
      } else if (req.origin !== undefined && req.origin !== origin) {
        // A cross-origin GET carrying an Origin header is a script fetch from another site.
        return { ok: false, status: 403, reason: `origin ${req.origin} is not ${origin}` };
      }
      const key = sessionFrom(req.cookie);
      if (!key) return { ok: false, status: 401, reason: "no valid session" };
      // After a renewal the browser's cookie still carries the old Max-Age and would be dropped at
      // the old expiry; re-issue it (same value, new Max-Age) on the next request that carries it.
      if (sessions.get(key) !== expiresAt) {
        sessions.set(key, expiresAt);
        const value = /** @type {string[]} */ (parseCookies(req.cookie).get(COOKIE_NAME))[0];
        return { ok: true, setCookie: cookieFor(value) };
      }
      return { ok: true };
    },

    /**
     * `POST /__windkeel/renew` with `Authorization: Bearer <token>` and body `{ "expiresAt": <ms> }`.
     * API-only: the person's cookie cannot renew (the API decides how long a session lives, and
     * extends the sandbox in the same step). Only extends; capped at `maxRenewMs` from now; a dead
     * gate stays dead.
     * @param {{ authorization?: string, body: unknown }} req
     * @returns {Decision | { ok: true, expiresAt: number }}
     */
    renew(req) {
      if (bearerMatches(req.authorization) !== true) return { ok: false, status: 401, reason: "not allowed to renew" };
      const gone = dead();
      if (gone) return gone;
      const wanted =
        req.body && typeof req.body === "object" ? /** @type {Record<string, unknown>} */ (req.body).expiresAt : undefined;
      if (typeof wanted !== "number" || !Number.isFinite(wanted)) {
        return { ok: false, status: 400, reason: "expiresAt must be epoch milliseconds" };
      }
      if (wanted > now() + maxRenewMs) {
        return { ok: false, status: 400, reason: `expiresAt is more than ${maxRenewMs} ms away` };
      }
      if (wanted > expiresAt) {
        expiresAt = wanted;
        for (const fn of renewListeners) fn(expiresAt);
      }
      return { ok: true, expiresAt };
    },

    /** @param {(expiresAt: number) => void} fn */
    onRenew(fn) {
      renewListeners.push(fn);
    },

    /**
     * `POST /__windkeel/revoke`. The API authenticates with `Authorization: Bearer <token>` (it holds
     * the token even after the browser consumed it); the person's own "end session" button
     * authenticates with the session cookie and a same-origin `Origin`. Idempotent: revoking a
     * revoked or expired gate succeeds for a valid caller.
     * @param {{ authorization?: string, cookie?: string, origin?: string }} req
     * @returns {Decision}
     */
    revoke(req) {
      const bearer = bearerMatches(req.authorization);
      let allowed = false;
      if (bearer !== null) {
        allowed = bearer;
      } else if (!revoked && checkOrigin(req.origin) === null && sessionFrom(req.cookie)) {
        allowed = true;
      }
      if (!allowed) return { ok: false, status: 401, reason: "not allowed to revoke" };
      if (!revoked) {
        revoked = true;
        sessions.clear();
        for (const fn of revokeListeners.splice(0)) fn();
      }
      return { ok: true };
    },

    /** @param {() => void} fn */
    onRevoke(fn) {
      if (revoked) fn();
      else revokeListeners.push(fn);
    },
  };
}
