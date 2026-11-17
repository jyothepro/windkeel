#!/usr/bin/env node
// @ts-check
/**
 * Spike A interactive harness (#367): stand up a human workspace and open it in a browser.
 *
 *   cd research/spikes/human-workspace && npm install
 *   VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… npm run harness -- [--editor]
 *
 * Same options as measure.mjs (--repo --base --candidate --vcpus --install --no-install --editor
 * --git-token-env --keep). Prints the URL the console would open — it carries the session token
 * in its fragment, so treat the printed line as a secret. Ctrl-C revokes the token and deletes
 * the sandbox (unless --keep).
 */

import { parseArgs } from "node:util";
import { createWorkspace, destroyWorkspace, renewGate, resolveShas, startServer, vercelCredentials } from "./lib/workspace.mjs";

const { values: args } = parseArgs({
  options: {
    repo: { type: "string", default: "https://github.com/expressjs/cors" },
    base: { type: "string" },
    candidate: { type: "string" },
    vcpus: { type: "string", default: "2" },
    install: { type: "string" },
    "no-install": { type: "boolean", default: false },
    editor: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    "git-token-env": { type: "string" },
  },
});
const log = (m) => console.error(`[harness] ${m}`);

try {
  vercelCredentials();
} catch (e) {
  console.error(String(/** @type {Error} */ (e).message));
  process.exit(2);
}

const { base, candidate } = await resolveShas(args.repo, args.base, args.candidate);
const t0 = performance.now();
const ws = await createWorkspace({
  repo: args.repo,
  base,
  candidate,
  vcpus: Number(args.vcpus),
  install: args["no-install"] ? null : args.install,
  editor: args.editor,
  gitTokenEnv: args["git-token-env"],
  log,
});
const server = await startServer(ws);
log(`ready in ${Math.round(performance.now() - t0)} ms: ${JSON.stringify({ ...ws.timings, serverReadyMs: server.readyMs })}`);
log(`sandbox ${ws.name}; candidate ${candidate} checked out at ${ws.checkout}`);
log("open this in a browser (new tab, not an iframe) — the fragment is the session token:");
console.log(server.openUrl);
log(`terminal at ${server.origin}/__windkeel/term${ws.editor ? `, editor at ${server.origin}/` : ""}. Ctrl-C to revoke and delete.`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  log("revoking token");
  await fetch(`${server.origin}/__windkeel/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.token}` },
  }).catch(() => {});
  if (args.keep) {
    log(`kept ${ws.name}`);
  } else {
    log(`deleting ${ws.name}`);
    await destroyWorkspace(ws.sandbox).catch((e) => log(`delete failed: ${e}`));
  }
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// While a person is using it, keep the sandbox's own timeout ahead of us — and, in the same step,
// the gate's expiry, or the server would cut the session off at its initial 40-minute TTL even
// though the sandbox is still alive. The sandbox is extended first so the gate never outlives it.
const GATE_TTL_MS = 40 * 60_000;
setInterval(async () => {
  try {
    await ws.sandbox.extendTimeout(10 * 60_000);
    const until = await renewGate(server.origin, server.token, Date.now() + GATE_TTL_MS);
    log(`extended sandbox; gate now expires ${new Date(until).toISOString()}`);
  } catch (e) {
    log(`extend/renew failed: ${e}`);
  }
}, 10 * 60_000);
