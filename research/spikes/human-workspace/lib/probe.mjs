// @ts-check
/**
 * A scripted stand-in for the person's browser: exchanges the token, opens the PTY, measures
 * latency, and runs the negative checks the gate must pass. Used by measure.mjs against a live
 * sandbox and by test/server.smoke.test.mjs against a local server — the same probes both ways.
 *
 * Node can set any `Origin` it likes, so the Origin checks here prove the server enforces them;
 * they do not (and cannot) model a token thief, who would simply send the right Origin.
 */

import WebSocket from "ws";

/** @param {Response} res */
function sessionCookieFrom(res) {
  const set = res.headers.getSetCookie().find((c) => c.startsWith("__Host-windkeel_ws="));
  return set ? set.split(";")[0] : null;
}

/**
 * @param {string} base  the server's base URL (for a local run, http://127.0.0.1:port)
 * @param {string} origin the public origin the server was configured with
 * @param {string} token
 */
export async function exchange(base, origin, token) {
  const res = await fetch(`${base}/__windkeel/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ token }),
    redirect: "manual",
  });
  await res.arrayBuffer();
  return { status: res.status, cookie: sessionCookieFrom(res) };
}

/**
 * @param {string} base
 * @param {{ origin?: string, cookie?: string | null }} opts
 * @returns {Promise<{ ws: WebSocket, openMs: number, firstByteMs: number, firstBytes: Buffer }>}
 */
export function openPty(base, { origin, cookie }) {
  const t0 = performance.now();
  const url = base.replace(/^http/, "ws") + "/__windkeel/pty";
  /** @type {Record<string, string>} */
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  const ws = new WebSocket(url, { headers, ...(origin ? { origin } : {}), handshakeTimeout: 15_000 });
  return new Promise((resolve, reject) => {
    let openMs = 0;
    ws.once("open", () => {
      openMs = performance.now() - t0;
      ws.send(JSON.stringify({ t: "resize", rows: 30, cols: 100 }));
    });
    ws.once("unexpected-response", (_req, res) => {
      reject(Object.assign(new Error(`upgrade refused: ${res.statusCode}`), { status: res.statusCode }));
    });
    ws.once("error", reject);
    const onMessage = (data, isBinary) => {
      if (!isBinary) return;
      ws.off("message", onMessage);
      resolve({ ws, openMs, firstByteMs: performance.now() - t0, firstBytes: Buffer.from(data) });
    };
    ws.on("message", onMessage);
  });
}

/** @param {number[]} xs */
export function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const r = (n) => Math.round(n * 10) / 10;
  return { n: s.length, min: r(s[0]), p50: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1]) };
}

/** App-level round trip: a JSON ping answered by the server process, not the shell. */
export async function appRtt(ws, n = 30) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = `p${i}`;
    const t0 = performance.now();
    await new Promise((resolve) => {
      const on = (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString());
        if (msg.t === "pong" && msg.id === id) {
          ws.off("message", on);
          resolve(undefined);
        }
      };
      ws.on("message", on);
      ws.send(JSON.stringify({ t: "ping", id }));
    });
    out.push(performance.now() - t0);
  }
  return stats(out);
}

/** Waits until `needle` appears in PTY output, or rejects after `ms`. */
function waitFor(ws, needle, ms = 10_000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      ws.off("message", on);
      reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; saw ${JSON.stringify(buf.slice(-200))}`));
    }, ms);
    const on = (data, isBinary) => {
      if (!isBinary) return;
      buf += data.toString("utf8");
      if (buf.includes(needle)) {
        clearTimeout(timer);
        ws.off("message", on);
        resolve(buf);
      }
    };
    ws.on("message", on);
  });
}

/** Runs a shell command in the PTY and returns its output between markers. */
export async function runInPty(ws, command, ms = 30_000) {
  const tag = `M${Math.random().toString(36).slice(2, 10)}`;
  // The markers are built by the shell (printf %s%s) so the typed echo of the command line can't match.
  const done = waitFor(ws, `${tag}-END`, ms);
  ws.send(JSON.stringify({ t: "in", d: `printf '%s%s\\n' ${tag} -BEGIN; ${command}; printf '%s%s\\n' ${tag} -END\r` }));
  const out = await done;
  const start = out.lastIndexOf(`${tag}-BEGIN`);
  return out.slice(start + tag.length + 6, out.lastIndexOf(`${tag}-END`)).trim();
}

/**
 * Keystroke echo: what typing feels like. Types one character, waits for the shell's echo,
 * erases it. Waits for a prompt first so readline is ready.
 */
export async function echoRtt(ws, n = 30) {
  await runInPty(ws, "true");
  const out = [];
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < n; i++) {
    const ch = letters[i % letters.length];
    const t0 = performance.now();
    const seen = waitFor(ws, ch, 10_000);
    ws.send(JSON.stringify({ t: "in", d: ch }));
    await seen;
    out.push(performance.now() - t0);
    const erased = waitFor(ws, "\b", 10_000).catch(() => {});
    ws.send(JSON.stringify({ t: "in", d: "\x7f" }));
    await erased;
  }
  return stats(out);
}

async function status(url, init) {
  const res = await fetch(url, { redirect: "manual", ...init });
  await res.arrayBuffer();
  return res.status;
}

async function upgradeStatus(base, opts) {
  try {
    const { ws } = await openPty(base, opts);
    ws.close();
    return 101;
  } catch (e) {
    return /** @type {any} */ (e).status ?? -1;
  }
}

/**
 * The gate's negative checks, against a live server. Run after one successful exchange
 * (`cookie`) with the token already consumed.
 */
export async function negativeChecks(base, origin, token, cookie) {
  const evil = "https://evil.example";
  const checks = [
    ["GET / without a session", () => status(`${base}/`), [401]],
    ["GET /__windkeel/term without a session", () => status(`${base}/__windkeel/term`), [401]],
    ["GET /__windkeel/term?t=<token> (query token is ignored)", () => status(`${base}/__windkeel/term?t=${token}`), [401]],
    ["GET / with the token as the cookie value", () => status(`${base}/`, { headers: { Cookie: `__Host-windkeel_ws=${token}` } }), [401]],
    ["GET / with a session", () => status(`${base}/`, { headers: { Cookie: cookie } }), [200, 302]],
    ["GET /__windkeel/term with a session", () => status(`${base}/__windkeel/term`, { headers: { Cookie: cookie } }), [200]],
    ["GET /__windkeel/term with a session but a foreign Origin", () => status(`${base}/__windkeel/term`, { headers: { Cookie: cookie, Origin: evil } }), [403]],
    ["PTY upgrade without a session", () => upgradeStatus(base, { origin }), [401]],
    ["PTY upgrade with a session but no Origin", () => upgradeStatus(base, { cookie }), [403]],
    ["PTY upgrade with a session but a foreign Origin (CSWSH)", () => upgradeStatus(base, { cookie, origin: evil }), [403]],
    ["Re-exchange of the consumed token", async () => (await exchange(base, origin, token)).status, [401]],
    ["Exchange from a foreign Origin", async () => (await exchange(base, evil, token)).status, [403]],
    [
      "Exchange as a form post",
      () =>
        status(`${base}/__windkeel/session`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
          body: `token=${token}`,
        }),
      [415],
    ],
    ["Revoke without credentials", () => status(`${base}/__windkeel/revoke`, { method: "POST", headers: { Origin: origin } }), [401]],
  ];
  const results = [];
  for (const [name, run, expected] of checks) {
    const got = await run();
    results.push({ name, expected, got, pass: expected.includes(got) });
  }
  return results;
}

/** Revokes as the API would and checks a live PTY is closed and the session is dead. */
export async function revokeCheck(base, origin, token, cookie, ws) {
  const closed = new Promise((resolve) => ws.once("close", (code) => resolve(code)));
  const t0 = performance.now();
  const revokeStatus = await status(`${base}/__windkeel/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const closeCode = await Promise.race([closed, new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
  const closeMs = performance.now() - t0;
  const afterGet = await status(`${base}/`, { headers: { Cookie: cookie } });
  const afterUpgrade = await upgradeStatus(base, { cookie, origin });
  return {
    revokeStatus,
    liveSocketCloseCode: closeCode,
    liveSocketCloseMs: Math.round(closeMs),
    getAfterRevoke: afterGet,
    upgradeAfterRevoke: afterUpgrade,
    pass: revokeStatus === 204 && closeCode === 4001 && afterGet === 410 && afterUpgrade === 410,
  };
}
