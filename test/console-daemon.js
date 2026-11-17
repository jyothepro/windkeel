import { spawn } from "node:child_process";
import { createWriteStream, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";

const [cwd, nextBin, port, statePath, logPath, idleMs, fingerprint] = process.argv.slice(2);
const PLACEHOLDER_TOKEN = "windkeel-shared-console";

let target = null;
let idleTimer = null;

function holderGone() {
  if (target === null) return false;
  try {
    process.kill(target.holder, 0);
    return false;
  } catch (err) {
    return err.code !== "EPERM";
  }
}

setInterval(() => {
  if (holderGone()) {
    target = null;
    armIdle();
  }
}, 5_000).unref();

function armIdle() {
  clearTimeout(idleTimer);
  if (target === null) idleTimer = setTimeout(shutdown, Number(idleMs));
}

function forward(req, res) {
  if (target === null) {
    res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "no test holds the shared console", code: "no_target" }));
    return;
  }
  const upstream = new URL(req.url ?? "/", target.apiUrl);
  const headers = { ...req.headers, host: upstream.host };
  if (headers.authorization === `Bearer ${PLACEHOLDER_TOKEN}`) headers.authorization = `Bearer ${target.token}`;
  const proxied = request(upstream, { method: req.method, headers }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  proxied.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err), code: "upstream_unreachable" }));
  });
  req.pipe(proxied);
}

const proxy = createServer(async (req, res) => {
  if (req.url === "/__windkeel-console/target" && req.method === "PUT") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    target = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    armIdle();
    res.writeHead(204).end();
    return;
  }
  forward(req, res);
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

const log = createWriteStream(logPath, { mode: 0o600 });
const child = spawn(process.execPath, [nextBin, "dev", "--port", port, "--hostname", "127.0.0.1"], {
  cwd,
  env: {
    ...process.env,
    WINDKEEL_API_URL: proxyUrl,
    WINDKEEL_API_TOKEN: PLACEHOLDER_TOKEN,
    NEXT_PUBLIC_SUPABASE_URL: "",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
    NEXT_TELEMETRY_DISABLED: "1",
    VERCEL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(log);
child.stderr.pipe(log);

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  rmSync(statePath, { force: true });
  proxy.close();
  if (child.exitCode !== null) process.exit(0);
  child.once("exit", () => process.exit(0));
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
}

child.once("exit", () => {
  rmSync(statePath, { force: true });
  process.exit(0);
});
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

writeFileSync(statePath, JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${port}`, proxyUrl, logPath, fingerprint }), { mode: 0o600 });
armIdle();
