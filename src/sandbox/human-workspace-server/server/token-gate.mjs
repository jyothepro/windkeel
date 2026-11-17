import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "__Host-windkeel_ws";

const PUBLIC_ROUTES = Object.freeze([
  { method: "GET", path: "/__windkeel/open" },
  { method: "GET", path: "/__windkeel/boot.js" },
  { method: "POST", path: "/__windkeel/session" },
  { method: "POST", path: "/__windkeel/revoke" },
  { method: "POST", path: "/__windkeel/renew" },
]);

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function sha256(secret) {
  return createHash("sha256").update(secret).digest();
}

function sha256Hex(secret) {
  return sha256(secret).toString("hex");
}

function randomSecret() {
  return randomBytes(32).toString("base64url");
}

function isWellFormedToken(value) {
  return typeof value === "string" && TOKEN_RE.test(value);
}

function secretMatches(presented, expectedDigest) {
  const got = sha256(presented);
  return got.length === expectedDigest.length && timingSafeEqual(got, expectedDigest);
}

function parseCookies(header) {
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

export function isPublicRoute(method, pathname) {
  return PUBLIC_ROUTES.some((r) => r.method === method && r.path === pathname);
}

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
  const sessions = new Map();
  let exchanges = 0;
  let revoked = false;
  const revokeListeners = [];
  const renewListeners = [];

  function dead() {
    if (revoked) return { ok: false, status: 410, reason: "session revoked" };
    if (now() >= expiresAt) return { ok: false, status: 401, reason: "session expired" };
    return null;
  }

  function checkOrigin(requestOrigin) {
    if (requestOrigin !== origin) {
      return { ok: false, status: 403, reason: `origin ${requestOrigin ?? "(none)"} is not ${origin}` };
    }
    return null;
  }

  function sessionFrom(cookieHeader) {
    const values = parseCookies(cookieHeader).get(COOKIE_NAME);
    if (!values || values.length !== 1) return null;
    const value = values[0];
    if (!isWellFormedToken(value)) return null;
    const key = sha256Hex(value);
    if (!sessions.has(key)) return null;
    return key;
  }

  function cookieFor(sessionId) {
    const maxAge = Math.max(0, Math.floor((expiresAt - now()) / 1000));
    return `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
  }

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

    exchange(req) {
      const gone = dead();
      if (gone) return gone;
      const badOrigin = checkOrigin(req.origin);
      if (badOrigin) return badOrigin;
      if (!/^application\/json(\s*;|$)/i.test(req.contentType ?? "")) {
        return { ok: false, status: 415, reason: "content-type must be application/json" };
      }
      const token =
        req.body && typeof req.body === "object" ?  (req.body).token : undefined;
      if (!isWellFormedToken(token)) return { ok: false, status: 400, reason: "malformed token" };
      if (!secretMatches( (token), tokenDigest)) {
        return { ok: false, status: 401, reason: "token does not match" };
      }
      if (exchanges >= maxExchanges) return { ok: false, status: 401, reason: "token already used" };
      exchanges += 1;
      const sessionId = randomSecret();
      sessions.set(sha256Hex(sessionId), expiresAt);
      return { ok: true, sessionId, setCookie: cookieFor(sessionId) };
    },

    authorize(req) {
      const gone = dead();
      if (gone) return gone;
      const stateChanging = !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase());
      if (req.upgrade || stateChanging) {
        const badOrigin = checkOrigin(req.origin);
        if (badOrigin) return badOrigin;
      } else if (req.origin !== undefined && req.origin !== origin) {
        return { ok: false, status: 403, reason: `origin ${req.origin} is not ${origin}` };
      }
      const key = sessionFrom(req.cookie);
      if (!key) return { ok: false, status: 401, reason: "no valid session" };
      if (sessions.get(key) !== expiresAt) {
        sessions.set(key, expiresAt);
        const value =  (parseCookies(req.cookie).get(COOKIE_NAME))[0];
        return { ok: true, setCookie: cookieFor(value) };
      }
      return { ok: true };
    },

    renew(req) {
      if (bearerMatches(req.authorization) !== true) return { ok: false, status: 401, reason: "not allowed to renew" };
      const gone = dead();
      if (gone) return gone;
      const wanted =
        req.body && typeof req.body === "object" ?  (req.body).expiresAt : undefined;
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

    onRenew(fn) {
      renewListeners.push(fn);
    },

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

    onRevoke(fn) {
      if (revoked) fn();
      else revokeListeners.push(fn);
    },
  };
}
