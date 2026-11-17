#!/usr/bin/env node
// @ts-check
/**
 * Spike A measurements (#367): one command, against a live Vercel Sandbox.
 *
 *   cd research/spikes/human-workspace && npm install
 *   VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… npm run measure
 *
 * Options: --repo <https url> --base <sha> --candidate <sha> --vcpus 2 --install "<cmd>" | --no-install
 *          --rtt 50 --editor --keep --git-token-env NAME
 *
 * Measures cold start (create+clone, fetch candidate, install, server setup, server ready), time
 * to first PTY byte, app round trip and keystroke echo from wherever this runs, the gate's
 * negative checks against the public URL, revocation, sleep (stop) → wake (resume) with
 * persistence of uncommitted work, and cost. Writes results/<timestamp>.json.
 *
 * Latency is measured from the machine running this script to iad1 — which is what the person's
 * browser sees. Run it from where your users are, and once from a host in us-east-1 for the floor.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { appRtt, echoRtt, exchange, negativeChecks, openPty, revokeCheck, runInPty } from "./lib/probe.mjs";
import { costOfSession, costTable } from "./lib/cost.mjs";
import {
  createWorkspace,
  destroyWorkspace,
  execFor,
  resolveShas,
  vercelCredentials,
  sleepWorkspace,
  startServer,
  wakeWorkspace,
} from "./lib/workspace.mjs";

const { values: args } = parseArgs({
  options: {
    repo: { type: "string", default: "https://github.com/expressjs/cors" },
    base: { type: "string" },
    candidate: { type: "string" },
    vcpus: { type: "string", default: "2" },
    install: { type: "string" },
    "no-install": { type: "boolean", default: false },
    rtt: { type: "string", default: "50" },
    editor: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    "git-token-env": { type: "string" },
  },
});

const log = (m) => console.error(`[measure] ${m}`);
const vcpus = Number(args.vcpus);
const n = Number(args.rtt);
const results = {
  spike: "#367 human workspace",
  at: new Date().toISOString(),
  from: { host: hostname(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
  repo: args.repo,
  vcpus,
};

try {
  vercelCredentials();
} catch (e) {
  console.error(String(/** @type {Error} */ (e).message));
  process.exit(2);
}

const { base, candidate } = await resolveShas(args.repo, args.base, args.candidate);
Object.assign(results, { base, candidate });

const tStart = performance.now();
const ws = await createWorkspace({
  repo: args.repo,
  base,
  candidate,
  vcpus,
  install: args["no-install"] ? null : args.install,
  editor: args.editor,
  gitTokenEnv: args["git-token-env"],
  log,
});
let sandbox = ws.sandbox;
results.sandbox = ws.name;
let deleted = false;

async function cleanup() {
  if (deleted || args.keep) return;
  deleted = true;
  log(`deleting ${ws.name}`);
  await destroyWorkspace(sandbox).catch((e) => log(`delete failed: ${e}`));
}
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

try {
  const server = await startServer(ws);
  results.coldStart = {
    ...ws.timings,
    serverReadyMs: server.readyMs,
    totalToReadyMs: Math.round(performance.now() - tStart),
  };
  log(`ready in ${results.coldStart.totalToReadyMs} ms at ${server.origin}`);

  // The person's browser, scripted.
  const tEx = performance.now();
  const ex = await exchange(server.origin, server.origin, server.token);
  if (ex.status !== 204 || !ex.cookie) throw new Error(`token exchange failed: ${ex.status}`);
  const exchangeMs = performance.now() - tEx;
  const pty = await openPty(server.origin, { origin: server.origin, cookie: ex.cookie });
  results.firstPty = {
    exchangeMs: Math.round(exchangeMs),
    wsOpenMs: Math.round(pty.openMs),
    firstByteMs: Math.round(pty.firstByteMs),
    fromExchangeToFirstByteMs: Math.round(exchangeMs + pty.firstByteMs),
  };
  results.latency = { appRoundTrip: await appRtt(pty.ws, n), keystrokeEcho: await echoRtt(pty.ws, Math.min(n, 40)) };
  log(`rtt p50 ${results.latency.appRoundTrip.p50} ms, echo p50 ${results.latency.keystrokeEcho.p50} ms`);
  results.inVm = {
    whoami: await runInPty(pty.ws, "whoami"),
    sudoWithoutPassword: await runInPty(pty.ws, "sudo -n true 2>/dev/null && echo yes || echo no"),
    head: await runInPty(pty.ws, "git rev-parse HEAD"),
    listeners: await runInPty(pty.ws, "(ss -ltnp 2>/dev/null || netstat -ltn 2>/dev/null) | tail -n +2 | awk '{print $4}' | sort -u | tr '\\n' ' '"),
    tokenHashInShellEnv: await runInPty(pty.ws, "env | grep -c WINDKEEL_WS_ || true"),
  };

  results.gate = await negativeChecks(server.origin, server.origin, server.token, ex.cookie);
  const failed = results.gate.filter((c) => !c.pass);
  log(`gate checks: ${results.gate.length - failed.length}/${results.gate.length} pass`);

  // Uncommitted work the person would expect to find after a sleep.
  await runInPty(pty.ws, "echo spike-367 > .windkeel-uncommitted && git status --porcelain | head -5");
  results.revocation = await revokeCheck(server.origin, server.origin, server.token, ex.cookie, pty.ws);

  // Sleep → wake. Record the server's PID first, to compare with whatever is running after the wake.
  const before = await execFor(sandbox, ws.checkout)("sh", { args: ["-c", "pgrep -f '[s]erver\\.mjs' || true"] });
  const serverPidBeforeSleep = before.stdout.trim().split(/\s+/).filter(Boolean)[0];
  const sessionWallMs = performance.now() - tStart;
  const slept = await sleepWorkspace(sandbox);
  const usage = {
    activeCpuMs: sandbox.activeCpuUsageMs ?? null,
    networkTransfer: sandbox.networkTransfer ?? null,
    snapshot: slept.result?.snapshot ?? null,
  };
  // One clock from "wake" to the first PTY byte, so everything in between (the persistence checks,
  // the server restart, the token exchange) is counted rather than summed piecemeal.
  const tWake = performance.now();
  const woke = await wakeWorkspace(ws.name, ws.creds);
  sandbox = woke.sandbox;
  const tCmd = performance.now();
  const exec = execFor(sandbox, ws.checkout);
  const marker = await exec("cat .windkeel-uncommitted");
  const firstCommandMs = Math.round(performance.now() - tCmd);
  const deps = await exec("test -d node_modules && echo kept || echo missing");
  // `[s]erver\.mjs` matches the server's command line but not the `sh -c` (or pgrep) running it,
  // whose own argv holds the bracketed text. The PID from before the sleep is recorded alongside.
  const serverAlive = await exec("sh", { args: ["-c", "pgrep -f '[s]erver\\.mjs' || true"] });
  const pidsAfterWake = serverAlive.stdout.trim().split(/\s+/).filter(Boolean);
  const resumed = await startServer({ ...ws, sandbox });
  const ex2 = await exchange(resumed.origin, resumed.origin, resumed.token);
  if (ex2.status !== 204 || !ex2.cookie) throw new Error(`token exchange after wake failed: ${ex2.status}`);
  const pty2 = await openPty(resumed.origin, { origin: resumed.origin, cookie: ex2.cookie });
  const wakeToFirstPtyByteMs = Math.round(performance.now() - tWake);
  results.sleepWake = {
    stopMs: slept.stopMs,
    resumeGetMs: woke.getMs,
    firstCommandAfterResumeMs: firstCommandMs,
    uncommittedWorkSurvived: marker.stdout.trim() === "spike-367",
    installedDepsSurvived: deps.stdout.trim(),
    serverPidBeforeSleep: serverPidBeforeSleep ?? null,
    serverPidsAfterWake: pidsAfterWake,
    serverProcessSurvived: pidsAfterWake.length > 0 ? "yes" : "no",
    restartServerReadyMs: resumed.readyMs,
    firstPtyByteAfterRestartMs: Math.round(pty2.firstByteMs),
    sameOriginAfterResume: resumed.origin === server.origin,
    wakeToFirstPtyByteMs,
  };
  pty2.ws.close();

  results.cost = {
    measuredFirstSession:
      usage.activeCpuMs !== null
        ? costOfSession({ vcpus, wallMs: sessionWallMs, activeCpuMs: usage.activeCpuMs, egressBytes: usage.networkTransfer?.egress ?? 0 })
        : null,
    usage,
    perHourTable: costTable(vcpus),
  };
} catch (err) {
  results.error = String(err?.stack ?? err);
  log(`FAILED: ${err}`);
} finally {
  await cleanup();
  mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
  const file = new URL(`./results/${results.at.replace(/[:.]/g, "-")}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results, null, 2));
  log(`wrote ${file.pathname}`);
  process.exit(results.error ? 1 : 0);
}
