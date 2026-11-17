// @ts-check
/**
 * Creating a human workspace the way ADR-0029 §3 says to: a new Vercel Sandbox that clones the
 * repository at `base_sha` and fetches the candidate **through git**, as the verifier does
 * (ADR-0004) — nothing forked, snapshot-restored or copied from another sandbox. Then the install,
 * then the token-gated server (§4) on the one exposed port.
 *
 * This file plays the part of Windkeel's API: it mints the token, starts the server with only the
 * token's hash, and holds the token. It reuses Windkeel's own git hardening, install-phase network
 * policy and its translation to the SDK's allow map straight from src/ (Node ≥ 22.18 strips the
 * types), so the spike cannot drift from them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "@vercel/sandbox";
import { HARDENED_GIT_ARGS, HARDENED_GIT_ENV, assertSafeGitConfig } from "../../../../src/sandbox/git-hardening.ts";
import { buildPhaseAllowMap } from "../../../../src/sandbox/credential-broker.ts";
import { installPhasePolicy } from "../../../../src/sandbox/network-phase.ts";
import { mintToken } from "../server/token-gate.mjs";

const spikeDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The files the server needs inside the VM, relative to the spike directory. */
const SERVER_FILES = [
  "package.json",
  "package-lock.json",
  "server/server.mjs",
  "server/token-gate.mjs",
  "server/pty-bridge.py",
  "server/public/open.html",
  "server/public/boot.js",
  "server/public/term.html",
  "server/public/term.js",
];

export const WORKSPACE_PORT = 3000;
const EDITOR_PORT = 3001;

/**
 * `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` (how Windkeel's API authenticates), or
 * nothing — the SDK then falls back to `VERCEL_OIDC_TOKEN` from `vercel env pull`.
 */
export function vercelCredentials() {
  const { VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID, VERCEL_OIDC_TOKEN } = process.env;
  if (VERCEL_TOKEN && VERCEL_TEAM_ID && VERCEL_PROJECT_ID) {
    return { token: VERCEL_TOKEN, teamId: VERCEL_TEAM_ID, projectId: VERCEL_PROJECT_ID };
  }
  if (VERCEL_OIDC_TOKEN) return {};
  throw new Error(
    "No Vercel credentials. Set VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID (a Pro team: Hobby " +
      "caps a session at 45 min), or run `vercel link && vercel env pull` for VERCEL_OIDC_TOKEN.",
  );
}

/** "https://github.com/o/r(.git)" → {owner, repo} */
function githubRepo(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new Error(`--base and --candidate are required for a non-GitHub URL (${url})`);
  return { owner: m[1], repo: m[2] };
}

/**
 * When the caller names no SHAs: candidate = the default branch's head, base = its first parent.
 * That is a real "base + one candidate commit" pair on any public GitHub repository.
 */
export async function resolveShas(repoUrl, base, candidate) {
  if (base && candidate) return { base, candidate };
  const { owner, repo } = githubRepo(repoUrl);
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "windkeel-spike-367" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const ref = candidate ?? "HEAD";
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${ref}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status} resolving ${owner}/${repo}@${ref}`);
  const commit = await res.json();
  const parent = commit.parents?.[0]?.sha;
  if (!parent) throw new Error(`${owner}/${repo}@${commit.sha} has no parent to use as a base`);
  return { base: base ?? parent, candidate: commit.sha };
}

/** Same discovery as src/sandbox/vercel.ts: the platform clones into $HOME/<repo>. */
const CHECKOUT_DISCOVERY = [
  'cd "$HOME" 2>/dev/null || exit 1',
  '[ -d .git ] && { pwd; exit 0; }',
  'for d in */; do [ -d "$d/.git" ] && { cd "$d" && pwd; exit 0; }; done',
  "exit 1",
].join("\n");

/** An `ExecutionEnvironment.exec`-shaped adapter over the SDK, for src/sandbox/git-hardening.ts. */
export function execFor(sandbox, defaultCwd) {
  return async (command, options = {}) => {
    const shell = options.args === undefined;
    const done = await sandbox.runCommand({
      cmd: shell ? "sh" : command,
      args: shell ? ["-c", command] : options.args,
      cwd: options.cwd ?? defaultCwd,
      ...(options.env ? { env: options.env } : {}),
      ...(options.sudo ? { sudo: true } : {}),
    });
    const [stdout, stderr] = await Promise.all([done.stdout(), done.stderr()]);
    return { status: done.exitCode, signal: null, stdout, stderr };
  };
}

function must(result, what) {
  if (result.status !== 0) {
    throw new Error(`${what} failed (exit ${result.status}): ${(result.stderr || result.stdout).trim().slice(-2000)}`);
  }
  return result;
}

async function timed(timings, key, fn) {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    timings[key] = Math.round(performance.now() - t0);
  }
}

/** What the install phase runs for a checkout, when the caller does not say. */
const DETECT_INSTALL = [
  "if [ -f package-lock.json ]; then echo 'npm ci --no-audit --no-fund';",
  "elif [ -f pnpm-lock.yaml ]; then echo 'pnpm install --frozen-lockfile';",
  "elif [ -f package.json ]; then echo 'npm install --no-audit --no-fund';",
  "elif [ -f requirements.txt ]; then echo 'pip install -r requirements.txt';",
  "fi",
].join(" ");

/**
 * @param {{
 *   repo: string, base: string, candidate: string,
 *   vcpus?: number, timeoutMs?: number, install?: string | null,
 *   editor?: boolean, gitTokenEnv?: string, log?: (msg: string) => void,
 * }} opts
 */
export async function createWorkspace(opts) {
  const log = opts.log ?? (() => {});
  const creds = vercelCredentials();
  const timings = {};
  const name = `windkeel-human-spike-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const gitToken = opts.gitTokenEnv ? process.env[opts.gitTokenEnv] : undefined;
  if (opts.gitTokenEnv && !gitToken) throw new Error(`${opts.gitTokenEnv} is empty`);

  // ADR-0029 §3.5: the human workspace keeps the install allowlist; the person is trusted. The SDK
  // wants a domain → rules record (`{ "github.com": [] }`), built the way src/ builds it. No
  // credential rules: nothing is brokered into a human workspace (§3.4, §3.5).
  const allow = await buildPhaseAllowMap(installPhasePolicy(), []);

  log(`creating sandbox ${name} (clone ${opts.repo} @ base ${opts.base.slice(0, 12)})`);
  const sandbox = await timed(timings, "createWithCloneMs", () =>
    Sandbox.create({
      name,
      source: {
        type: "git",
        url: opts.repo,
        revision: opts.base,
        ...(gitToken ? { username: "x-access-token", password: gitToken } : {}),
      },
      resources: { vcpus: opts.vcpus ?? 2 },
      timeout: opts.timeoutMs ?? 45 * 60_000,
      ports: [WORKSPACE_PORT],
      persistent: true,
      networkPolicy: { allow },
      tags: { windkeel: "spike-367", role: "human" },
      ...creds,
    }),
  );

  try {
    const probe = await sandbox.runCommand({ cmd: "sh", args: ["-c", CHECKOUT_DISCOVERY] });
    const checkout = (await probe.stdout()).trim();
    if (probe.exitCode !== 0 || !checkout) throw new Error("no checkout found under $HOME");
    const exec = execFor(sandbox, checkout);
    const git = (args, env = {}) =>
      exec("git", { args: [...HARDENED_GIT_ARGS, ...args], env: { ...HARDENED_GIT_ENV, ...env } });

    // The candidate arrives through git, as the verifier's does. The checkout's config is checked
    // with Windkeel's own allowlist before git runs over it with anything resembling a credential.
    await timed(timings, "fetchCandidateMs", async () => {
      await assertSafeGitConfig(exec, checkout);
      const auth = gitToken
        ? ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${gitToken}`).toString("base64")}`]
        : [];
      must(await git([...auth, "fetch", "--no-tags", "origin", opts.candidate]), "git fetch candidate");
      must(await git(["checkout", "--detach", opts.candidate]), "git checkout candidate");
      const head = must(await git(["rev-parse", "HEAD"]), "git rev-parse").stdout.trim();
      if (head !== opts.candidate) throw new Error(`HEAD is ${head}, wanted ${opts.candidate}`);
      const ancestor = await git(["merge-base", "--is-ancestor", opts.base, opts.candidate]);
      if (ancestor.status !== 0) log(`warning: base ${opts.base} is not an ancestor of the candidate`);
    });

    // ADR-0029 §3.4 (amended): the install runs WITHOUT repository secrets — the person gets root
    // in this VM next, so anything an install path stashed would be readable. The install gets no
    // env beyond the image's, and the clone/fetch credential (if any) must not be left behind in
    // the checkout for it to find: it only ever travelled as a `-c` arg / the platform's clone.
    const remote = must(await git(["remote", "get-url", "origin"]), "git remote get-url").stdout.trim();
    if (/^[a-z]+:\/\/[^/]*@/i.test(remote)) {
      must(await git(["remote", "set-url", "origin", opts.repo]), "strip credential from origin URL");
    }
    // Look where an install's own `git` would: the checkout's and the user's config (not our `-c`
    // flags, which also set `credential.helper=`), and a stored-credentials file.
    const leftover = await exec(
      "sh",
      { args: ["-c", 'for s in --local --global; do git config $s --get-regexp "^(credential\\.|http\\..*extraheader)"; done; test -s "$HOME/.git-credentials" && echo .git-credentials; true'] },
    );
    if (leftover.stdout.trim()) {
      throw new Error("a git credential is left in the workspace; refusing to install with it present");
    }
    const install =
      opts.install === undefined ? (await exec(DETECT_INSTALL)).stdout.trim() || null : opts.install;
    timings.installCommand = install ?? "(none)";
    timings.installWithSecrets = false;
    if (install) {
      log(`install: ${install} (no repository secrets)`);
      await timed(timings, "installMs", async () => must(await exec(install), `install (${install})`));
    }

    // The server and its three npm deps. In production these belong in a custom VCR image.
    const serverDir = await timed(timings, "serverSetupMs", async () => {
      const home = must(await exec("sh", { args: ["-c", 'printf %s "$HOME"'] }), "read $HOME").stdout;
      const dir = `${home}/.windkeel-ws`;
      must(await exec("mkdir", { args: ["-p", `${dir}/server/public`] }), "mkdir");
      await sandbox.writeFiles(
        SERVER_FILES.map((rel) => ({ path: `${dir}/${rel}`, content: readFileSync(join(spikeDir, rel)) })),
      );
      must(await exec("npm ci --omit=dev --no-audit --no-fund", { cwd: dir }), "server npm ci");
      return dir;
    });

    if (opts.editor) {
      await timed(timings, "editorSetupMs", () => installEditor(sandbox, exec, serverDir, checkout, log));
    }

    return { sandbox, name, checkout, serverDir, timings, creds, editor: Boolean(opts.editor) };
  } catch (err) {
    await destroyWorkspace(sandbox).catch(() => {});
    throw err;
  }
}

/**
 * OpenVSCode Server, bound to loopback with its own auth off: the gate in front of it is the auth.
 * Its own `--connection-token` is not used because it accepts the token as `?tkn=` in a query
 * string, which is exactly what ADR-0029 §4 forbids.
 */
async function installEditor(sandbox, exec, serverDir, checkout, log) {
  const rel = await (await fetch("https://api.github.com/repos/gitpod-io/openvscode-server/releases/latest", {
    headers: { "User-Agent": "windkeel-spike-367" },
  })).json();
  const asset = rel.assets?.find((a) => /linux-x64\.tar\.gz$/.test(a.name));
  if (!asset) throw new Error("no linux-x64 OpenVSCode Server asset in the latest release");
  log(`editor: ${asset.name}`);
  must(
    await exec("sh", {
      args: ["-c", 'mkdir -p "$0/ovs" && curl -fsSL "$1" | tar -xz -C "$0/ovs" --strip-components=1', serverDir, asset.browser_download_url],
    }),
    "download OpenVSCode Server",
  );
  await sandbox.runCommand({
    cmd: `${serverDir}/ovs/bin/openvscode-server`,
    args: ["--host", "127.0.0.1", "--port", String(EDITOR_PORT), "--without-connection-token", "--telemetry-level", "off", "--default-folder", checkout],
    cwd: checkout,
    detached: true,
  });
}

async function waitReady(url, deadlineMs) {
  const t0 = performance.now();
  let last = "";
  while (performance.now() - t0 < deadlineMs) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      await res.arrayBuffer();
      if (res.status === 200) return Math.round(performance.now() - t0);
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`workspace server not ready at ${url} after ${deadlineMs} ms (${last})`);
}

/**
 * Mints a session token, starts the server with its hash, waits until the public URL answers.
 * Returns the token (the API's to hold) and the URL the console would open.
 * @param {{ sandbox: any, checkout: string, serverDir: string, editor?: boolean }} ws
 * @param {{ ttlMs?: number }} [opts]
 */
export async function startServer(ws, opts = {}) {
  const { token, tokenSha256 } = mintToken();
  const origin = new URL(ws.sandbox.domain(WORKSPACE_PORT)).origin;
  const expiresAt = Date.now() + (opts.ttlMs ?? 40 * 60_000);
  const t0 = performance.now();
  const cmd = await ws.sandbox.runCommand({
    cmd: "node",
    args: [`${ws.serverDir}/server/server.mjs`],
    cwd: ws.checkout,
    detached: true,
    env: {
      WINDKEEL_WS_TOKEN_SHA256: tokenSha256,
      WINDKEEL_WS_EXPIRES_AT: String(expiresAt),
      WINDKEEL_WS_PUBLIC_ORIGIN: origin,
      WINDKEEL_WS_PORT: String(WORKSPACE_PORT),
      WINDKEEL_WS_CWD: ws.checkout,
      ...(ws.editor ? { WINDKEEL_WS_EDITOR_PORT: String(EDITOR_PORT) } : {}),
    },
  });
  await waitReady(`${origin}/__windkeel/open`, 60_000);
  return {
    token,
    origin,
    expiresAt,
    commandId: cmd.cmdId,
    readyMs: Math.round(performance.now() - t0),
    openUrl: `${origin}/__windkeel/open#t=${token}`,
  };
}

/**
 * What the API does each time it extends the sandbox for a person who is still working: push the
 * gate's expiry forward too (bearer = the session token, which the API holds), so the server does
 * not cut off an actively used session at its initial TTL. Throws if the gate refuses (expired,
 * revoked) — the caller should then stop extending and end the session.
 * @param {string} base the server's base URL (the public origin, or a local one in tests)
 * @param {string} token
 * @param {number} expiresAt epoch ms
 * @returns {Promise<number>} the gate's expiry after the call
 */
export async function renewGate(base, token, expiresAt) {
  const res = await fetch(`${base}/__windkeel/renew`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresAt }),
    redirect: "manual",
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`gate renew refused: ${text.trim()}`);
  return JSON.parse(text).expiresAt;
}

/** Sleep: `stop()` snapshots the filesystem (persistent sandbox). Processes do not survive. */
export async function sleepWorkspace(sandbox) {
  const t0 = performance.now();
  const result = await sandbox.stop();
  return { stopMs: Math.round(performance.now() - t0), result };
}

/** Wake: `Sandbox.get({ name, resume: true })`. */
export async function wakeWorkspace(name, creds) {
  const t0 = performance.now();
  const sandbox = await Sandbox.get({ name, resume: true, ...creds });
  return { sandbox, getMs: Math.round(performance.now() - t0) };
}

export async function destroyWorkspace(sandbox) {
  let usage = null;
  try {
    const stopped = await sandbox.stop();
    usage = stopped;
  } catch {}
  await sandbox.delete();
  return usage;
}
