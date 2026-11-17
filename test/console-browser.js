/**
 * What a browser test of the console needs, on one machine: the control plane API served over real
 * HTTP from the real router, and the console's dev server pointed at it.
 *
 * `next dev` rather than a build, deliberately. A build inlines every `NEXT_PUBLIC_*` variable it
 * sees, so a console built with sign-in configured would send this test to /login. The dev server
 * reads its environment per request, which is what lets the test say "no sign-in, this token".
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import { repoRoot } from "./helpers.js";
import { privateConsoleStateDirectory } from "./console-state.js";

/** Why a browser test can't run here, or null when it can. */
export async function browserSkip() {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    return "playwright-core is not installed";
  }
  // Launched rather than looked for: headless runs use the headless shell, not `executablePath()`.
  try {
    const browser = await chromium.launch();
    await browser.close();
  } catch {
    return "no Chromium for playwright-core: run `npx playwright-core install chromium-headless-shell`";
  }
  return false;
}

/**
 * `/v1` on 127.0.0.1, through `handleApiRequest` with the deps the caller gives — the same
 * handler Vercel runs, minus the SSE transport, which only a run still in flight would open.
 */
export async function serveApi(deps, auth) {
  // The most requests in flight at once: each is a pooled connection on a real deployment.
  let inFlight = 0;
  let peak = 0;
  const server = createServer(async (req, res) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    res.on("close", () => inFlight--);
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.searchParams.get("stream") === "sse") {
        res.writeHead(501, { "content-type": "application/json" }).end(JSON.stringify({ error: "no stream in this test", code: "no_stream" }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
      const result = await handleApiRequest(deps, auth, {
        method: req.method ?? "GET",
        path: url.pathname,
        query: { get: (name) => url.searchParams.get(name) ?? undefined },
        headers,
        body: raw ? JSON.parse(raw) : undefined,
      });
      // As api/v1.ts: a maker screenshot's body is bytes, with its own headers (#392).
      if (Buffer.isBuffer(result.body)) {
        res.writeHead(result.status, result.headers ?? {});
        res.end(result.body);
        return;
      }
      res.writeHead(result.status, { "content-type": "application/json", ...(result.headers ?? {}) });
      // A file response (an audit export) is sent as is, like api/v1.ts does.
      res.end(result.raw !== undefined ? result.raw : JSON.stringify(result.body ?? null));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(err), code: "internal" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    peakInFlight: () => peak,
    resetPeak: () => (peak = inFlight),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A port nothing is listening on, for the console. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * One `next dev` per console directory at a time, across test processes. Next 16 refuses a second
 * dev server in the same app directory ("Another next dev server is already running"), and
 * `node --test` runs test files in parallel processes, so two browser test files starting their
 * consoles together fail one of them. A directory created atomically is the lock; a lock whose
 * holder process is gone is stale and taken over.
 */
async function lockConsoleDir(cwd, timeoutMs) {
  const lock = join(privateConsoleStateDirectory(cwd), "dev.lock");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    let holder = NaN;
    try {
      holder = Number(readFileSync(join(lock, "pid"), "utf8"));
    } catch {
      // Being created or removed right now.
    }
    if (Number.isInteger(holder) && holder > 0 && !alive(holder)) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`another test's console held ${cwd} for over ${timeoutMs} ms (${lock})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * The console's dev server against `apiUrl`, ready once `readyPath` answers 200 — the first
 * request compiles the page, which is the slow part and why the wait is generous.
 */
export async function startConsole(apiUrl, token, readyPath, { timeoutMs = 240_000 } = {}) {
  const cwd = join(repoRoot, "apps", "console");
  const unlock = await lockConsoleDir(cwd, 900_000);
  process.once("exit", unlock);
  const release = () => {
    process.removeListener("exit", unlock);
    unlock();
  };
  let shared;
  try {
    shared = await sharedConsole(cwd);
    await setTarget(shared, { apiUrl, token, holder: process.pid });
  } catch (err) {
    release();
    throw err;
  }
  const output = () => {
    try {
      return readFileSync(shared.logPath, "utf8");
    } catch {
      return "";
    }
  };
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await setTarget(shared, null).catch(() => {});
    release();
  };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!alive(shared.pid)) {
      await stop();
      throw new Error(`the console exited:\n${output().slice(-2000)}`);
    }
    try {
      const res = await fetch(`${shared.url}${readyPath}`);
      if (res.status === 200) break;
    } catch {}
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`the console did not answer ${readyPath} within ${timeoutMs} ms:\n${output().slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return { url: shared.url, stop, output };
}

function consoleStatePath(cwd) {
  return join(privateConsoleStateDirectory(cwd), "daemon.json");
}

const CONSOLE_ENV = /^(WINDKEEL_|GITHUB_|NEXT_|SUPABASE_|VERCEL|NODE_ENV$)/;

function consoleEnvFingerprint() {
  const picked = Object.entries(process.env)
    .filter(([key]) => CONSOLE_ENV.test(key) && key !== "WINDKEEL_API_URL" && key !== "WINDKEEL_API_TOKEN")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(picked)).digest("hex");
}

async function stopDaemon(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 15_000;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

async function sharedConsole(cwd) {
  const statePath = consoleStatePath(cwd);
  const fingerprint = consoleEnvFingerprint();
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (alive(state.pid)) {
      if (state.fingerprint === fingerprint) return state;
      await stopDaemon(state.pid);
    }
  } catch {}
  rmSync(statePath, { force: true });
  const port = await freePort();
  const logPath = `${statePath}.${process.pid}.log`;
  const daemon = spawn(
    process.execPath,
    [join(repoRoot, "test", "console-daemon.js"), cwd, join(repoRoot, "node_modules", "next", "dist", "bin", "next"), String(port), statePath, logPath, "120000", fingerprint],
    { cwd, detached: true, stdio: "ignore" },
  );
  daemon.unref();
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      if (state.pid === daemon.pid) return state;
    } catch {}
    if (daemon.exitCode !== null || Date.now() > deadline) throw new Error(`the shared console did not start (${statePath})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function setTarget(shared, target) {
  const res = await fetch(`${shared.proxyUrl}/__windkeel-console/target`, { method: "PUT", body: JSON.stringify(target) });
  if (res.status !== 204) throw new Error(`the shared console refused its target: ${res.status}`);
}
