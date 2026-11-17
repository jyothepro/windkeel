// @ts-check
/**
 * The human-workspace server (ADR-0029 §4): one exposed port, a PTY over WebSocket, an optional
 * OpenVSCode-class editor reverse-proxied from loopback, and the capability-token gate in front of
 * all of it. Everything that decides "may this request through" lives in ./token-gate.mjs; this
 * file only wires sockets to those decisions.
 *
 * Environment (set by the API — here, lib/workspace.mjs — when it starts the server):
 *   WINDKEEL_WS_TOKEN_SHA256   sha256 hex of the session token. The token itself never enters the VM.
 *   WINDKEEL_WS_EXPIRES_AT     epoch ms; the gate (and every socket) dies then, unless the API renews it
 *                           (POST /__windkeel/renew, bearer token) when it extends the sandbox.
 *   WINDKEEL_WS_PUBLIC_ORIGIN  the sandbox's public origin for this port, e.g. https://sb-x.vercel.run
 *   WINDKEEL_WS_PORT           listen port (default 3000)
 *   WINDKEEL_WS_CWD            the checkout; where shells start
 *   WINDKEEL_WS_EDITOR_PORT    optional; loopback port of an editor started with no auth of its own
 *   WINDKEEL_WS_HOST           listen host (default 0.0.0.0)
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { COOKIE_NAME, createGate, isPublicRoute, securityHeaders } from "./token-gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is required`);
  }
  return v;
}

const config = {
  tokenSha256: env("WINDKEEL_WS_TOKEN_SHA256"),
  expiresAt: Number(env("WINDKEEL_WS_EXPIRES_AT")),
  publicOrigin: env("WINDKEEL_WS_PUBLIC_ORIGIN"),
  port: Number(env("WINDKEEL_WS_PORT", "3000")),
  host: env("WINDKEEL_WS_HOST", "0.0.0.0"),
  cwd: env("WINDKEEL_WS_CWD", process.cwd()),
  editorPort: process.env.WINDKEEL_WS_EDITOR_PORT ? Number(process.env.WINDKEEL_WS_EDITOR_PORT) : null,
};

const gate = createGate(config);
const baseHeaders = securityHeaders(config.publicOrigin);
// xterm.js writes a <style> element for its renderer; inline styles are the one relaxation.
baseHeaders["Content-Security-Policy"] = baseHeaders["Content-Security-Policy"].replace(
  "style-src 'self'",
  "style-src 'self' 'unsafe-inline'",
);

/** Static files: [path on disk, content type]. Read once at boot. */
const files = {
  open: [join(here, "public/open.html"), "text/html; charset=utf-8"],
  boot: [join(here, "public/boot.js"), "text/javascript; charset=utf-8"],
  term: [join(here, "public/term.html"), "text/html; charset=utf-8"],
  termJs: [join(here, "public/term.js"), "text/javascript; charset=utf-8"],
  xtermJs: [require.resolve("@xterm/xterm/lib/xterm.js"), "text/javascript; charset=utf-8"],
  xtermCss: [require.resolve("@xterm/xterm/css/xterm.css"), "text/css; charset=utf-8"],
  fitJs: [require.resolve("@xterm/addon-fit/lib/addon-fit.js"), "text/javascript; charset=utf-8"],
};
const cache = Object.fromEntries(Object.entries(files).map(([k, [p, t]]) => [k, { body: readFileSync(p), type: t }]));

/** Gated static routes. */
const gatedStatic = {
  "/__windkeel/term": "term",
  "/__windkeel/term.js": "termJs",
  "/__windkeel/vendor/xterm.js": "xtermJs",
  "/__windkeel/vendor/xterm.css": "xtermCss",
  "/__windkeel/vendor/addon-fit.js": "fitJs",
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...baseHeaders, ...headers });
  res.end(body);
}

function sendFile(res, key, extra = {}) {
  const f = cache[key];
  send(res, 200, { "Content-Type": f.type, ...extra }, f.body);
}

const clearCookie = `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

function deny(res, decision) {
  const headers = { "Content-Type": "text/plain; charset=utf-8" };
  if (decision.status === 401 || decision.status === 410) headers["Set-Cookie"] = clearCookie;
  // The reason is for the person and the spike's probes; it never contains a secret.
  send(res, decision.status, headers, `${decision.status} ${decision.reason}\nOpen this workspace from the Windkeel console.\n`);
}

async function readJson(req, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function one(v) {
  return Array.isArray(v) ? v[0] : v;
}

/** Strips the gate's cookie before a request reaches the editor: the editor never sees it. */
function withoutGateCookie(headers) {
  const out = { ...headers };
  if (out.cookie) {
    const kept = String(out.cookie)
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith(`${COOKIE_NAME}=`));
    if (kept.length) out.cookie = kept.join("; ");
    else delete out.cookie;
  }
  return out;
}

function proxyToEditor(req, res, extra = {}) {
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: config.editorPort,
      method: req.method,
      path: req.url,
      headers: withoutGateCookie(req.headers),
    },
    (up) => {
      const headers = { ...up.headers };
      // Keep the editor's CSP; add the rest of ours.
      for (const [k, v] of Object.entries(baseHeaders)) {
        if (k !== "Content-Security-Policy" && k !== "Cache-Control") headers[k] = v;
      }
      if (extra["Set-Cookie"]) {
        const prior = headers["set-cookie"] ?? [];
        headers["set-cookie"] = [...(Array.isArray(prior) ? prior : [prior]), extra["Set-Cookie"]];
      }
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => send(res, 502, { "Content-Type": "text/plain" }, "editor unavailable\n"));
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://placeholder");
  const method = (req.method ?? "GET").toUpperCase();
  const origin = one(req.headers.origin);
  const cookie = one(req.headers.cookie);

  if (isPublicRoute(method, url.pathname)) {
    if (url.pathname === "/__windkeel/open") return sendFile(res, "open");
    if (url.pathname === "/__windkeel/boot.js") return sendFile(res, "boot");
    if (url.pathname === "/__windkeel/session") {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return deny(res, { status: 400, reason: "body too large" });
      }
      const d = gate.exchange({ origin, contentType: one(req.headers["content-type"]), body });
      if (!d.ok) return deny(res, d);
      return send(res, 204, { "Set-Cookie": d.setCookie }, "");
    }
    if (url.pathname === "/__windkeel/revoke") {
      const d = gate.revoke({ authorization: one(req.headers.authorization), cookie, origin });
      if (!d.ok) return deny(res, d);
      return send(res, 204, { "Set-Cookie": clearCookie }, "");
    }
    if (url.pathname === "/__windkeel/renew") {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return deny(res, { status: 400, reason: "body too large" });
      }
      const d = gate.renew({ authorization: one(req.headers.authorization), body });
      if (!d.ok) return deny(res, d);
      return send(res, 200, { "Content-Type": "application/json" }, JSON.stringify({ expiresAt: d.expiresAt }));
    }
  }

  const d = gate.authorize({ method, cookie, origin });
  if (!d.ok) return deny(res, d);

  /** @type {Record<string, string>} a refreshed cookie after a renewal */
  const extra = d.setCookie ? { "Set-Cookie": d.setCookie } : {};
  const key = gatedStatic[url.pathname];
  if (key && method === "GET") return sendFile(res, key, extra);
  if (url.pathname === "/__windkeel/whoami" && method === "GET") {
    return send(res, 200, { "Content-Type": "application/json", ...extra }, JSON.stringify({ expiresAt: gate.expiresAt }));
  }
  if (url.pathname.startsWith("/__windkeel/")) return send(res, 404, { "Content-Type": "text/plain", ...extra }, "not found\n");
  if (config.editorPort) return proxyToEditor(req, res, extra);
  if (url.pathname === "/") return send(res, 302, { Location: "/__windkeel/term", ...extra }, "");
  return send(res, 404, { "Content-Type": "text/plain", ...extra }, "not found\n");
});

// ---- PTY over WebSocket -------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
/** @type {Set<{ ws: import("ws").WebSocket, child: import("node:child_process").ChildProcess }>} */
const live = new Set();

function closeAll(code, reason) {
  for (const { ws, child } of live) {
    try {
      ws.close(code, reason);
    } catch {}
    child.kill("SIGHUP");
  }
  live.clear();
}

gate.onRevoke(() => closeAll(4001, "revoked"));
let expiryTimer = armExpiry(config.expiresAt);
function armExpiry(at) {
  const t = setTimeout(() => closeAll(4002, "expired"), Math.max(0, at - Date.now()));
  t.unref();
  return t;
}
// A renewal moves the deadline for live sockets too.
gate.onRenew((at) => {
  clearTimeout(expiryTimer);
  expiryTimer = armExpiry(at);
});

wss.on("connection", (ws) => {
  const child = spawn("python3", [join(here, "pty-bridge.py")], {
    cwd: config.cwd,
    env: { ...process.env, WINDKEEL_WS_CWD: config.cwd },
    stdio: ["pipe", "pipe", "inherit", "pipe"],
  });
  const entry = { ws, child };
  live.add(entry);
  const ctrl = /** @type {import("node:stream").Writable} */ (child.stdio[3]);
  child.stdout?.on("data", (buf) => {
    if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true });
  });
  child.on("exit", (code) => {
    live.delete(entry);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: "exit", code }));
      ws.close(1000, "shell exited");
    }
  });
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      child.stdin?.write(/** @type {Buffer} */ (data));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (msg.t === "in" && typeof msg.d === "string") child.stdin?.write(msg.d);
    else if (msg.t === "resize") ctrl.write(`${msg.rows | 0} ${msg.cols | 0}\n`);
    else if (msg.t === "ping") ws.send(JSON.stringify({ t: "pong", id: msg.id }));
  });
  ws.on("close", () => {
    live.delete(entry);
    child.kill("SIGHUP");
  });
});

function rejectUpgrade(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\nX-Windkeel-Reason: ${reason.replace(/[^\x20-\x7e]/g, "?")}\r\n\r\n`);
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://placeholder");
  const d = gate.authorize({
    method: "GET",
    upgrade: true,
    cookie: one(req.headers.cookie),
    origin: one(req.headers.origin),
  });
  if (!d.ok) return rejectUpgrade(socket, d.status, d.reason);

  if (url.pathname === "/__windkeel/pty") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }
  if (!config.editorPort) return rejectUpgrade(socket, 404, "no such socket");
  // Editor WebSocket: replay the request to loopback and splice the sockets.
  const upstream = net.connect(config.editorPort, "127.0.0.1", () => {
    const headers = withoutGateCookie(req.headers);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) {
      for (const value of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${value}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(config.port, config.host, () => {
  // Never log the hash, the origin's token, or a cookie — only that we are up.
  console.log(`windkeel-ws listening on ${config.host}:${config.port} (editor: ${config.editorPort ?? "off"})`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    closeAll(1001, "server stopping");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
    server.closeAllConnections();
  });
}
