import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COOKIE_NAME,
  createGate,
  isPublicRoute,
  isWellFormedToken,
  mintToken,
  parseCookies,
  secretMatches,
  securityHeaders,
  sha256,
} from "../server/token-gate.mjs";

const ORIGIN = "https://sb-abc123.vercel.run";

function setup(overrides = {}) {
  let clock = 1_000_000;
  const { token, tokenSha256 } = mintToken();
  const gate = createGate({
    tokenSha256,
    expiresAt: clock + 60_000,
    publicOrigin: ORIGIN,
    now: () => clock,
    ...overrides,
  });
  return {
    gate,
    token,
    tick: (ms) => (clock += ms),
    exchange: (body = { token }, extra = {}) =>
      gate.exchange({ origin: ORIGIN, contentType: "application/json", body, ...extra }),
  };
}

function cookieOf(decision) {
  assert.equal(decision.ok, true, decision.reason);
  const m = new RegExp(`^${COOKIE_NAME}=([^;]+)`).exec(decision.setCookie);
  assert.ok(m, decision.setCookie);
  return `${COOKIE_NAME}=${m[1]}`;
}

test("mintToken: 256 bits, base64url, hash matches", () => {
  const { token, tokenSha256 } = mintToken();
  assert.equal(token.length, 43);
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.ok(isWellFormedToken(token));
  assert.equal(sha256(token).toString("hex"), tokenSha256);
  assert.notEqual(mintToken().token, token);
});

test("isWellFormedToken rejects anything that is not 43 base64url chars", () => {
  for (const bad of [undefined, null, 42, "", "a".repeat(42), "a".repeat(44), "a".repeat(42) + "=", "a".repeat(42) + "+"]) {
    assert.equal(isWellFormedToken(bad), false, String(bad));
  }
});

test("secretMatches compares digests in constant time and handles mismatch", () => {
  const { token, tokenSha256 } = mintToken();
  const digest = Buffer.from(tokenSha256, "hex");
  assert.equal(secretMatches(token, digest), true);
  assert.equal(secretMatches(mintToken().token, digest), false);
  assert.equal(secretMatches("", digest), false);
});

test("createGate validates its configuration", () => {
  const { tokenSha256 } = mintToken();
  assert.throws(() => createGate({ tokenSha256: "nope", expiresAt: 1, publicOrigin: ORIGIN }));
  assert.throws(() => createGate({ tokenSha256, expiresAt: NaN, publicOrigin: ORIGIN }));
  assert.throws(() => createGate({ tokenSha256, expiresAt: 1, publicOrigin: `${ORIGIN}/path` }));
});

test("exchange: correct token yields a hardened cookie that is not the token", () => {
  const { exchange, token } = setup();
  const d = exchange();
  assert.equal(d.ok, true);
  assert.match(d.setCookie, new RegExp(`^${COOKIE_NAME}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60$`));
  assert.ok(!d.setCookie.includes(token), "the cookie must not carry the token");
  assert.ok(COOKIE_NAME.startsWith("__Host-"));
});

test("exchange: wrong, malformed or missing token is refused", () => {
  const { exchange } = setup();
  assert.deepEqual(exchange({ token: mintToken().token }).status, 401);
  assert.deepEqual(exchange({ token: "short" }).status, 400);
  assert.deepEqual(exchange({}).status, 400);
  assert.deepEqual(exchange(null).status, 400);
  assert.deepEqual(exchange("token").status, 400);
});

test("exchange: requires same Origin and a JSON content type (no form CSRF, no cross-site fetch)", () => {
  const { exchange } = setup();
  assert.equal(exchange(undefined, { origin: "https://evil.example" }).status, 403);
  assert.equal(exchange(undefined, { origin: "https://sb-other.vercel.run" }).status, 403);
  assert.equal(exchange(undefined, { origin: undefined }).status, 403);
  assert.equal(exchange(undefined, { origin: "null" }).status, 403);
  assert.equal(exchange(undefined, { contentType: "application/x-www-form-urlencoded" }).status, 415);
  assert.equal(exchange(undefined, { contentType: "text/plain" }).status, 415);
  assert.equal(exchange(undefined, { contentType: "application/json; charset=utf-8" }).ok, true);
});

test("exchange: the token is single-use by default; maxExchanges raises it", () => {
  const a = setup();
  assert.equal(a.exchange().ok, true);
  const again = a.exchange();
  assert.equal(again.ok, false);
  assert.equal(again.status, 401);
  assert.equal(again.reason, "token already used");

  const b = setup({ maxExchanges: 2 });
  assert.equal(b.exchange().ok, true);
  assert.equal(b.exchange().ok, true);
  assert.equal(b.exchange().ok, false);
});

test("exchange: a wrong guess does not consume the token", () => {
  const { exchange } = setup();
  assert.equal(exchange({ token: mintToken().token }).ok, false);
  assert.equal(exchange().ok, true);
});

test("authorize: no cookie, unknown cookie, malformed or duplicated cookie → 401", () => {
  const { gate, exchange } = setup();
  const cookie = cookieOf(exchange());
  assert.equal(gate.authorize({ method: "GET" }).status, 401);
  assert.equal(gate.authorize({ method: "GET", cookie: `${COOKIE_NAME}=${mintToken().token}` }).status, 401);
  assert.equal(gate.authorize({ method: "GET", cookie: `${COOKIE_NAME}=x` }).status, 401);
  assert.equal(gate.authorize({ method: "GET", cookie: `${cookie}; ${cookie}` }).status, 401);
  assert.equal(gate.authorize({ method: "GET", cookie: `other=1; ${cookie}` }).ok, true);
});

test("authorize: the token itself is not a session (a token in a cookie or query is not read)", () => {
  const { gate, token } = setup();
  assert.equal(gate.authorize({ method: "GET", cookie: `${COOKIE_NAME}=${token}` }).status, 401);
});

test("authorize: WebSocket upgrades and state-changing requests need the exact Origin", () => {
  const { gate, exchange } = setup();
  const cookie = cookieOf(exchange());
  assert.equal(gate.authorize({ method: "GET", upgrade: true, cookie, origin: ORIGIN }).ok, true);
  assert.equal(gate.authorize({ method: "GET", upgrade: true, cookie }).status, 403);
  assert.equal(gate.authorize({ method: "GET", upgrade: true, cookie, origin: "https://evil.example" }).status, 403);
  assert.equal(gate.authorize({ method: "POST", cookie }).status, 403);
  assert.equal(gate.authorize({ method: "POST", cookie, origin: ORIGIN }).ok, true);
  // Plain navigations carry no Origin; a cross-origin fetch does and is refused.
  assert.equal(gate.authorize({ method: "GET", cookie }).ok, true);
  assert.equal(gate.authorize({ method: "GET", cookie, origin: "https://evil.example" }).status, 403);
});

test("expiry: sessions and unexchanged tokens die at expiresAt", () => {
  const s = setup();
  const cookie = cookieOf(s.exchange());
  s.tick(59_999);
  assert.equal(s.gate.authorize({ method: "GET", cookie }).ok, true);
  s.tick(1);
  const d = s.gate.authorize({ method: "GET", cookie });
  assert.equal(d.status, 401);
  assert.equal(d.reason, "session expired");

  const t = setup();
  t.tick(60_000);
  assert.equal(t.exchange().reason, "session expired");
});

test("revoke by bearer token (the API) kills sessions, the token and fires listeners once", () => {
  const { gate, exchange, token } = setup();
  const cookie = cookieOf(exchange());
  let fired = 0;
  gate.onRevoke(() => fired++);
  assert.equal(gate.revoke({ authorization: `Bearer ${mintToken().token}` }).status, 401);
  assert.equal(gate.revoke({ authorization: "Bearer nope" }).status, 401);
  assert.equal(fired, 0);
  assert.equal(gate.revoke({ authorization: `Bearer ${token}` }).ok, true);
  assert.equal(fired, 1);
  assert.equal(gate.revoked, true);
  assert.equal(gate.liveSessions, 0);
  assert.equal(gate.authorize({ method: "GET", cookie }).status, 410);
  assert.equal(exchange().status, 410);
  // Idempotent for a valid caller; listeners do not fire twice; late listeners fire immediately.
  assert.equal(gate.revoke({ authorization: `Bearer ${token}` }).ok, true);
  assert.equal(fired, 1);
  let late = 0;
  gate.onRevoke(() => late++);
  assert.equal(late, 1);
});

test("revoke by session (the person) needs the cookie and the exact Origin", () => {
  const { gate, exchange } = setup();
  const cookie = cookieOf(exchange());
  assert.equal(gate.revoke({ cookie }).status, 401);
  assert.equal(gate.revoke({ cookie, origin: "https://evil.example" }).status, 401);
  assert.equal(gate.revoke({ origin: ORIGIN }).status, 401);
  assert.equal(gate.revoke({ cookie, origin: ORIGIN }).ok, true);
  assert.equal(gate.authorize({ method: "GET", cookie }).status, 410);
});

test("revoke by bearer still works after expiry (idempotent cleanup)", () => {
  const { gate, token, tick } = setup();
  tick(120_000);
  assert.equal(gate.revoke({ authorization: `Bearer ${token}` }).ok, true);
});

test("renew by bearer (the API, when it extends the sandbox) keeps a live session past the initial expiry", () => {
  const s = setup();
  const cookie = cookieOf(s.exchange());
  let renewedTo = null;
  s.gate.onRenew((at) => (renewedTo = at));
  s.tick(50_000);
  const d = s.gate.renew({ authorization: `Bearer ${s.token}`, body: { expiresAt: 1_000_000 + 120_000 } });
  assert.equal(d.ok, true, d.reason);
  assert.equal(d.expiresAt, 1_120_000);
  assert.equal(s.gate.expiresAt, 1_120_000);
  assert.equal(renewedTo, 1_120_000);
  s.tick(30_000); // past the original 60 s expiry
  const a = s.gate.authorize({ method: "GET", cookie });
  assert.equal(a.ok, true, a.reason);
  // The browser's cookie still has the old Max-Age: it is re-issued, same value, new Max-Age, once.
  assert.ok(a.setCookie?.startsWith(`${cookie};`), a.setCookie);
  assert.match(a.setCookie, /Max-Age=40(;|$)/);
  assert.equal(s.gate.authorize({ method: "GET", cookie }).setCookie, undefined);
  s.tick(40_000);
  assert.equal(s.gate.authorize({ method: "GET", cookie }).reason, "session expired");
});

test("renew: bearer only — no cookie, wrong token or no auth", () => {
  const s = setup();
  const cookie = cookieOf(s.exchange());
  const body = { expiresAt: 1_000_000 + 90_000 };
  assert.equal(s.gate.renew({ body }).status, 401);
  assert.equal(s.gate.renew({ authorization: `Bearer ${mintToken().token}`, body }).status, 401);
  assert.equal(s.gate.renew({ authorization: "Bearer nope", body }).status, 401);
  assert.equal(s.gate.renew({ cookie, origin: ORIGIN, body }).status, 401);
  assert.equal(s.gate.expiresAt, 1_060_000);
});

test("renew: only extends, is capped, validates input, and cannot revive a dead gate", () => {
  const s = setup({ maxRenewMs: 10 * 60_000 });
  const auth = `Bearer ${s.token}`;
  assert.equal(s.gate.renew({ authorization: auth, body: {} }).status, 400);
  assert.equal(s.gate.renew({ authorization: auth, body: { expiresAt: "soon" } }).status, 400);
  assert.equal(s.gate.renew({ authorization: auth, body: { expiresAt: Infinity } }).status, 400);
  assert.equal(s.gate.renew({ authorization: auth, body: { expiresAt: 1_000_000 + 10 * 60_000 + 1 } }).status, 400);
  // An earlier expiry is a no-op, not a shortening.
  const earlier = s.gate.renew({ authorization: auth, body: { expiresAt: 1_030_000 } });
  assert.equal(earlier.ok, true);
  assert.equal(s.gate.expiresAt, 1_060_000);

  const e = setup();
  e.tick(60_000);
  assert.equal(e.gate.renew({ authorization: `Bearer ${e.token}`, body: { expiresAt: 1_120_000 } }).reason, "session expired");

  const r = setup();
  r.gate.revoke({ authorization: `Bearer ${r.token}` });
  assert.equal(r.gate.renew({ authorization: `Bearer ${r.token}`, body: { expiresAt: 1_120_000 } }).status, 410);
});

test("isPublicRoute: only the bootstrap, the exchange, revoke and renew", () => {
  assert.equal(isPublicRoute("GET", "/__windkeel/open"), true);
  assert.equal(isPublicRoute("GET", "/__windkeel/boot.js"), true);
  assert.equal(isPublicRoute("POST", "/__windkeel/session"), true);
  assert.equal(isPublicRoute("POST", "/__windkeel/revoke"), true);
  assert.equal(isPublicRoute("POST", "/__windkeel/renew"), true);
  for (const [m, p] of [["GET", "/"], ["GET", "/__windkeel/session"], ["GET", "/__windkeel/renew"], ["POST", "/__windkeel/open"], ["GET", "/__windkeel/term"], ["GET", "/__windkeel/pty"], ["GET", "/__windkeel/open/"]]) {
    assert.equal(isPublicRoute(m, p), false, `${m} ${p}`);
  }
});

test("parseCookies keeps duplicates so the gate can refuse them", () => {
  const m = parseCookies("a=1; b=2; a=3; junk; =x");
  assert.deepEqual(m.get("a"), ["1", "3"]);
  assert.deepEqual(m.get("b"), ["2"]);
  assert.equal(m.size, 2);
  assert.equal(parseCookies(undefined).size, 0);
});

test("securityHeaders: no-store, no-referrer, no framing, ws limited to own origin", () => {
  const h = securityHeaders(ORIGIN);
  assert.equal(h["Cache-Control"], "no-store");
  assert.equal(h["Referrer-Policy"], "no-referrer");
  assert.match(h["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(h["Content-Security-Policy"], /connect-src 'self' wss:\/\/sb-abc123\.vercel\.run/);
});
