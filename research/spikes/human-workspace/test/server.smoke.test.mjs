// End-to-end against a local server process (no Vercel): the real server.mjs, the real Python PTY
// bridge, the same probes measure.mjs runs against a sandbox. Skips when python3 is unavailable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { mintToken } from "../server/token-gate.mjs";
import { appRtt, echoRtt, exchange, negativeChecks, openPty, revokeCheck, runInPty } from "../lib/probe.mjs";
import { renewGate } from "../lib/workspace.mjs";

const hasPython = spawnSync("python3", ["-c", "import pty"]).status === 0;

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });
}

test("local server: gate, PTY, latency probes, revocation", { skip: !hasPython && "python3 with pty is required" }, async (t) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const { token, tokenSha256 } = mintToken();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server/server.mjs", import.meta.url))], {
    env: {
      ...process.env,
      WINDKEEL_WS_TOKEN_SHA256: tokenSha256,
      WINDKEEL_WS_EXPIRES_AT: String(Date.now() + 10 * 60_000),
      WINDKEEL_WS_PUBLIC_ORIGIN: base,
      WINDKEEL_WS_PORT: String(port),
      WINDKEEL_WS_HOST: "127.0.0.1",
      WINDKEEL_WS_SHELL: "/bin/bash",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => child.kill("SIGTERM"));
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("listening") && resolve(undefined));
    child.once("exit", (code) => reject(new Error(`server exited ${code}`)));
  });

  // The bootstrap is public and contains no secret.
  const open = await fetch(`${base}/__windkeel/open`);
  assert.equal(open.status, 200);
  assert.equal(open.headers.get("cache-control"), "no-store");
  assert.equal(open.headers.get("referrer-policy"), "no-referrer");

  const ex = await exchange(base, base, token);
  assert.equal(ex.status, 204);
  assert.ok(ex.cookie);

  const pty = await openPty(base, { origin: base, cookie: ex.cookie });
  assert.ok(pty.firstByteMs > 0);
  assert.equal(await runInPty(pty.ws, "echo $((6*7))"), "42");
  // The hash of the token is the server's business, not the shell's.
  assert.equal(await runInPty(pty.ws, "env | grep -c WINDKEEL_WS_ || true"), "0");

  const rtt = await appRtt(pty.ws, 10);
  const echo = await echoRtt(pty.ws, 5);
  assert.equal(rtt.n, 10);
  assert.equal(echo.n, 5);

  const negatives = await negativeChecks(base, base, token, ex.cookie);
  for (const c of negatives) assert.ok(c.pass, `${c.name}: expected ${c.expected}, got ${c.got}`);

  // Renewal (what the harness does when it extends the sandbox): the API's bearer moves the expiry,
  // the person's cookie cannot, and the next gated response re-issues the cookie with the new Max-Age.
  const until = Date.now() + 20 * 60_000;
  assert.equal(await renewGate(base, token, until), until);
  const byCookie = await fetch(`${base}/__windkeel/renew`, {
    method: "POST",
    headers: { Cookie: ex.cookie, Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresAt: until + 60_000 }),
  });
  assert.equal(byCookie.status, 401);
  const who = await fetch(`${base}/__windkeel/whoami`, { headers: { Cookie: ex.cookie } });
  assert.equal((await who.json()).expiresAt, until);
  const refreshed = who.headers.getSetCookie().find((c) => c.startsWith(`${ex.cookie};`));
  assert.ok(refreshed, "cookie re-issued after renewal");
  assert.ok(Number(/Max-Age=(\d+)/.exec(refreshed)?.[1]) > 15 * 60, refreshed);
  assert.equal(await runInPty(pty.ws, "echo still-here"), "still-here");

  const revoked = await revokeCheck(base, base, token, ex.cookie, pty.ws);
  assert.ok(revoked.pass, JSON.stringify(revoked));
});

test("local server: editor reverse proxy is gated and never forwards the gate cookie", async (t) => {
  const http = await import("node:http");
  const { WebSocketServer, WebSocket } = await import("ws");
  // A stand-in editor on loopback that echoes what it received.
  const seen = [];
  const editor = http.createServer((req, res) => {
    seen.push(req.headers.cookie ?? "");
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`editor ${req.url}`);
  });
  const ewss = new WebSocketServer({ server: editor });
  ewss.on("connection", (sock, req) => {
    seen.push(req.headers.cookie ?? "");
    sock.on("message", (m) => sock.send(`echo:${m}`));
  });
  const editorPort = await freePort();
  await new Promise((r) => editor.listen(editorPort, "127.0.0.1", r));
  t.after(() => editor.close());

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const { token, tokenSha256 } = mintToken();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server/server.mjs", import.meta.url))], {
    env: {
      ...process.env,
      WINDKEEL_WS_TOKEN_SHA256: tokenSha256,
      WINDKEEL_WS_EXPIRES_AT: String(Date.now() + 60_000),
      WINDKEEL_WS_PUBLIC_ORIGIN: base,
      WINDKEEL_WS_PORT: String(port),
      WINDKEEL_WS_HOST: "127.0.0.1",
      WINDKEEL_WS_EDITOR_PORT: String(editorPort),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => child.kill("SIGTERM"));
  await new Promise((resolve) => child.stdout.on("data", (d) => String(d).includes("listening") && resolve(undefined)));

  assert.equal((await fetch(`${base}/workbench`)).status, 401);
  const { cookie } = await exchange(base, base, token);
  const res = await fetch(`${base}/workbench?x=1`, { headers: { Cookie: `${cookie}; editor-own=1` } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "editor /workbench?x=1");

  const reply = await new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}/editor-socket`, { origin: base, headers: { Cookie: cookie } });
    sock.once("open", () => sock.send("hi"));
    sock.once("message", (m) => {
      resolve(String(m));
      sock.close();
    });
    sock.once("error", reject);
  });
  assert.equal(reply, "echo:hi");
  await assert.rejects(
    new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/editor-socket`, { origin: "https://evil.example", headers: { Cookie: cookie } });
      sock.once("open", resolve);
      sock.once("error", reject);
    }),
  );
  assert.deepEqual(seen, ["editor-own=1", ""], "the editor never sees __Host-windkeel_ws");
});
