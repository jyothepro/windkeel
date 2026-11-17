import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FakeHumanWorkspaceProvider,
  HUMAN_INSTALL_NOTE,
  HUMAN_WORKSPACE_IDLE_SLEEP_MS,
  HUMAN_WORKSPACE_MAX_LIFETIME_MS,
  mintWorkspaceToken,
  provisionHumanWorkspace,
} from "../dist/sandbox/human-workspace.js";
import {
  parseEnumeration,
  PROCESS_ENUMERATION,
  SERVER_INSTALL_SCRIPT,
  SERVER_PARENT,
  serverManifest,
  VercelHumanWorkspaceHandle,
} from "../dist/sandbox/vercel-human-workspace.js";
import { HUMAN_WORKSPACE_SERVER_FILES } from "../dist/sandbox/human-workspace-server-files.js";

/**
 * The human workspace's provisioning order (ADR-0029 §3 steps 3–5), against the fake provider —
 * which records every exec's environment and keeps every file — so "no credential of any kind in
 * the VM" is asserted, not assumed.
 */

const READ_TOKEN = "ghs_READ_TOKEN_for_the_clone_only";
const SECRET = "npm_REPOSITORY_SECRET_value";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

function remote() {
  const root = mkdtempSync(join(tmpdir(), "windkeel-hw-"));
  const work = join(root, "work");
  const bare = join(root, "remote.git");
  git(root, "init", "-q", work);
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  writeFileSync(
    join(work, "package-lock.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fixture", version: "1.0.0" } } }),
  );
  git(work, "add", "-A");
  git(work, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-q", "-m", "base");
  const baseSha = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "index.js"), "console.log('maker');\n");
  git(work, "add", "-A");
  git(work, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-q", "-m", "maker candidate");
  const seedSha = git(work, "rev-parse", "HEAD");
  git(root, "clone", "-q", "--bare", work, bare);
  // The base is what the clone is at; the seed arrives only through the fetch.
  git(bare, "update-ref", "refs/heads/main", baseSha);
  git(bare, "update-ref", "refs/heads/windkeel/run", seedSha);
  return { bare, baseSha, seedSha };
}

test("provisioning: clone at base, fetch the seed through git, install WITHOUT repository secrets — then nothing of Windkeel's is in the VM", async (t) => {
  const r = remote();
  const provider = new FakeHumanWorkspaceProvider();
  t.after(() => provider.cleanup());
  const { handle, baseline, install, installNote } = await provisionHumanWorkspace({
    provider,
    repoUrl: r.bare,
    baseSha: r.baseSha,
    seedSha: r.seedSha,
    gitHost: "github.com",
    readCredential: async () => ({ username: "x-access-token", token: READ_TOKEN, permission: "read", expiresAt: "2030-01-01T00:00:00Z" }),
    // Not part of the input any more (ADR-0029 §3.4 as amended); passed anyway, it must be ignored.
    secrets: { NPM_TOKEN: SECRET },
  });
  const fake = provider.created[0];
  assert.equal(handle, fake);
  assert.equal(provider.createOptions[0].baseSha, r.baseSha, "cloned at base_sha, as the verifier is (ADR-0004)");
  assert.equal(git(fake.checkoutPath, "rev-parse", "HEAD"), r.seedSha, "the seed candidate arrived through git");
  assert.equal(install.status, "installed", install.detail);
  assert.deepEqual(baseline, []);
  assert.equal(installNote, HUMAN_INSTALL_NOTE);
  assert.match(installNote, /without repository secrets — private dependencies may be missing/);

  const installAt = fake.execs.findIndex((e) => e.command === "npm");
  assert.ok(installAt >= 0, "the install ran");
  assert.equal(fake.execs[installAt].env.NPM_TOKEN, undefined, "the install had no repository secret");
  assert.doesNotMatch(install.detail, /NPM_TOKEN|with repository secrets/, "and the install names no secret");
  const fetchAt = fake.execs.findIndex((e) => e.args.includes("fetch"));
  assert.ok(fetchAt >= 0 && fetchAt < installAt, "the seed is fetched before the install runs");

  // A repository secret at no point; the clone's read token in no file, and in no environment but
  // the scrub's own `grep -F` (the value through env, never argv), which runs before the install.
  const secretSeen = fake.contains(SECRET);
  assert.deepEqual([secretSeen.files, secretSeen.envs], [[], []], "a repository secret is nowhere, ever");
  const readSeen = fake.contains(READ_TOKEN);
  assert.deepEqual(readSeen.files, [], "the read token is in no file in the workspace");
  assert.ok(readSeen.envs.every((i) => i < installAt && fake.execs[i].args.join(" ").includes("grep -rlF")), "only the scrub's check saw it");
  assert.ok(!git(fake.checkoutPath, "remote", "get-url", "origin").includes(READ_TOKEN), "the remote URL carries no credential");

  // The install's processes were swept before the person got the workspace; egress is the install allowlist.
  assert.ok(fake.events.includes("sweep"), "nothing the install started survives hand-off");
  assert.equal(fake.policies.at(-1).mode, "allowlist");
  assert.ok(fake.policies.at(-1).allowedDomains.includes("registry.npmjs.org"), "the install allowlist, not model-only egress");
  assert.equal(fake.server, null, "no server runs until a session is minted");
});

test("a platform clone that keeps its credential in .git (URL userinfo and an extraheader) is scrubbed, verified, before the install", async (t) => {
  const r = remote();
  const provider = new FakeHumanWorkspaceProvider({ persistCloneCredential: true });
  t.after(() => provider.cleanup());
  const { handle } = await provisionHumanWorkspace({
    provider,
    repoUrl: r.bare,
    baseSha: r.baseSha,
    seedSha: r.seedSha,
    gitHost: "github.com",
    readCredential: async () => ({ username: "x-access-token", token: READ_TOKEN, permission: "read", expiresAt: "2030-01-01T00:00:00Z" }),
  });
  const fake = provider.created[0];
  assert.equal(handle, fake);
  // The fake really did persist both forms at clone time, and the scrub removed each.
  assert.ok(fake.execs.some((e) => e.args.join(" ") === "remote set-url origin https://github.com/acme/widgets.git"), "userinfo stripped from origin");
  assert.ok(fake.execs.some((e) => e.args.join(" ") === "config --local --unset-all http.https://github.com/.extraheader"), "the extraheader unset");
  const scrubAt = fake.execs.findIndex((e) => e.command === "git" && e.args[0] === "remote" && e.args.length === 1);
  const installAt = fake.execs.findIndex((e) => e.command === "npm");
  assert.ok(scrubAt >= 0 && scrubAt < installAt, "the scrub runs right after the clone, before the install");
  const grepAt = fake.execs.findIndex((e) => e.command === "sh" && e.args.join(" ").includes("grep -rlF"));
  assert.ok(grepAt > scrubAt && grepAt < installAt, "and proves the token is nowhere in .git before the install");
  assert.deepEqual(fake.contains(READ_TOKEN).files, [], "no URL userinfo and no extraheader carries the token");
  assert.throws(() => git(fake.checkoutPath, "config", "--local", "--get-regexp", "^http\\..*extraheader$"), "the extraheader is gone");
  assert.ok(!git(fake.checkoutPath, "remote", "get-url", "origin").includes("@"), "no userinfo on origin");
});

test("a clone credential that cannot be confirmed gone fails provisioning and destroys the workspace", async (t) => {
  const r = remote();
  const provider = new FakeHumanWorkspaceProvider({ persistCloneCredential: true });
  t.after(() => provider.cleanup());
  // The token also sits somewhere in .git the scrub does not know to clean; its final grep must catch it.
  const create = provider.create.bind(provider);
  provider.create = async (options) => {
    const handle = await create(options);
    writeFileSync(join(handle.checkoutPath, ".git", "FETCH_NOTE"), `token=${READ_TOKEN}\n`);
    return handle;
  };
  await assert.rejects(
    provisionHumanWorkspace({
      provider,
      repoUrl: r.bare,
      baseSha: r.baseSha,
      seedSha: r.seedSha,
      gitHost: "github.com",
      readCredential: async () => ({ username: "x-access-token", token: READ_TOKEN, permission: "read", expiresAt: "2030-01-01T00:00:00Z" }),
    }),
    /clone token is still present/,
  );
  const fake = provider.created[0];
  assert.ok(fake.destroyed);
  assert.equal(fake.execs.findIndex((e) => e.command === "npm"), -1, "the install never ran");
});

test("a failed seed fetch destroys the half-made workspace and removes the read credential", async (t) => {
  const r = remote();
  const provider = new FakeHumanWorkspaceProvider();
  t.after(() => provider.cleanup());
  await assert.rejects(
    provisionHumanWorkspace({
      provider,
      repoUrl: r.bare,
      baseSha: r.baseSha,
      seedSha: "0".repeat(40),
      gitHost: "github.com",
      readCredential: async () => ({ username: "x-access-token", token: READ_TOKEN, permission: "read", expiresAt: "2030-01-01T00:00:00Z" }),
    }),
    /could not fetch the seed/,
  );
  const fake = provider.created[0];
  assert.ok(fake.destroyed, "destroyed rather than handed over");
  assert.deepEqual(fake.contains(READ_TOKEN).files, []);
});

test("the capability token: 256 bits, base64url; the VM is only ever given its SHA-256", () => {
  const { token, tokenSha256 } = mintWorkspaceToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(tokenSha256, createHash("sha256").update(token).digest("hex"));
  assert.notEqual(mintWorkspaceToken().token, token);
});

test("lifetimes: sleep after 30 idle minutes, deleted at 24 h", () => {
  assert.equal(HUMAN_WORKSPACE_IDLE_SLEEP_MS, 30 * 60_000);
  assert.equal(HUMAN_WORKSPACE_MAX_LIFETIME_MS, 24 * 60 * 60_000);
});

test("the /proc enumeration parses into a snapshot (promoted from Spike B)", () => {
  assert.match(PROCESS_ENUMERATION, /\/proc/);
  const snapshot = parseEnumeration("self= 7 1 \np 1 0 0 S 10 0 init\np 2 0 0 S 11 1 kthreadd\np 40 1 1001 R 99 0 node\n");
  assert.deepEqual(snapshot.self, [7, 1]);
  assert.equal(snapshot.processes.length, 3);
  assert.deepEqual(snapshot.processes[2], { pid: 40, ppid: 1, uid: 1001, state: "R", startTime: "99", kernel: false, comm: "node" });
});

// --- the Vercel workspace server: rebuilt from trusted files before every launch (#379) ---------

/**
 * A stand-in for `@vercel/sandbox`'s `Sandbox` that runs every command on this machine — the
 * server setup script included, against a temp directory standing in for `/opt` and a stub `npm`
 * — except the detached server launch, which it records.
 */
function localSandbox(t, { npmScript = 'mkdir -p node_modules/ws && echo "module.exports = 1" > node_modules/ws/index.js', serverFiles } = {}) {
  const root = mkdtempSync(join(tmpdir(), "windkeel-vercel-ws-"));
  const opt = join(root, "opt");
  const bin = join(root, "bin");
  mkdirSync(opt);
  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), `#!/bin/sh\n${npmScript}\n`, { mode: 0o755 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const launches = [];
  const sandbox = {
    name: "windkeel-human-test",
    domain: () => "https://windkeel-human-test.vercel.run",
    fs: { writeFile: async (path, data) => writeFileSync(path, data), readFile: async (path) => readFileSync(path) },
    async runCommand({ cmd, args, cwd, env, sudo, detached }) {
      calls.push({ cmd, args, sudo: !!sudo, detached: !!detached });
      if (detached) {
        launches.push({ cmd, args, env, sudo: !!sudo });
        return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
      }
      const setup = cmd === "sh" && args[1] === SERVER_INSTALL_SCRIPT;
      const run = spawnSync(cmd, setup ? [...args.slice(0, -1), opt] : args, {
        cwd: cwd && existsSync(cwd) ? cwd : root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
      });
      const stdout = setup ? (run.stdout ?? "").replaceAll(`${opt}/`, `${SERVER_PARENT}/`) : (run.stdout ?? "");
      return { exitCode: run.status, stdout: async () => stdout, stderr: async () => run.stderr ?? "" };
    },
  };
  const handle = new VercelHumanWorkspaceHandle(sandbox, root, 1000, serverFiles);
  return { handle, calls, launches, opt, root };
}

test("the workspace server is rebuilt from the host's files, hash-checked, before every launch — never taken from what install left", async (t) => {
  const { handle, calls, launches, opt } = localSandbox(t);
  // What a hostile install could have left: a server of its own where an earlier copy lived.
  mkdirSync(join(opt, "windkeel-ws.PLANTED", "server"), { recursive: true });
  writeFileSync(join(opt, "windkeel-ws.PLANTED", "server", "server.mjs"), "// ignores the token\n");

  await handle.startServer({ tokenSha256: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000) });
  assert.ok(!existsSync(join(opt, "windkeel-ws.PLANTED")), "every earlier copy is removed first");
  const first = launches[0].args[0];
  assert.match(first, /^\/opt\/windkeel-ws\.[A-Za-z0-9]{8}\/server\/server\.mjs$/, "launched from a fresh mktemp directory, not $HOME");
  assert.equal(launches[0].sudo, false, "the server itself runs as the person's uid");
  const setup = calls.find((c) => c.cmd === "sh" && c.args[1] === SERVER_INSTALL_SCRIPT);
  assert.equal(setup.sudo, true, "the copy, check and install run as root");
  const local = first.replace(`${SERVER_PARENT}/`, `${opt}/`).replace(/\/server\/server\.mjs$/, "");
  for (const line of serverManifest().trim().split("\n")) {
    const [hash, rel] = line.split(/\s+/);
    assert.equal(createHash("sha256").update(readFileSync(join(local, rel))).digest("hex"), hash, `${rel} is the host's copy`);
  }
  assert.ok(existsSync(join(local, "node_modules", "ws")), "ws installed by npm ci into that directory");
  assert.ok(!existsSync(join(local, ".npm-home")), "npm ran with a throwaway HOME, removed after");

  await handle.startServer({ tokenSha256: "b".repeat(64), expiresAt: new Date(Date.now() + 60_000) });
  assert.equal(launches.length, 2);
  assert.notEqual(launches[1].args[0], first, "a new directory per launch");
  assert.ok(!existsSync(local), "and the previous one is gone");
  assert.match(SERVER_INSTALL_SCRIPT, /--ignore-scripts --userconfig=\/dev\/null --globalconfig=\/dev\/null/);
});

test("a server file that does not match the host's hash after install fails the launch; nothing is started", async (t) => {
  // An install step that rewrote a server file (a poisoned npm, a planted hook): the second check catches it.
  const { handle, launches } = localSandbox(t, { npmScript: 'echo "// tampered" > server/server.mjs' });
  await assert.rejects(handle.startServer({ tokenSha256: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000) }), /server setup failed: hash mismatch: server\/server\.mjs/);
  assert.equal(launches.length, 0, "no server on the public port");
});

test("an embedded server file whose content no longer matches its recorded hash fails the launch before anything is written (#381)", async (t) => {
  const tampered = HUMAN_WORKSPACE_SERVER_FILES.map((f) => (f.path === "server/token-gate.mjs" ? { ...f, content: `${f.content}\n// accept any token\n` } : f));
  const { handle, calls, launches } = localSandbox(t, { serverFiles: tampered });
  await assert.rejects(handle.startServer({ tokenSha256: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000) }), /server\/token-gate\.mjs: embedded content does not match its recorded hash/);
  assert.equal(launches.length, 0, "no server on the public port");
  assert.ok(!calls.some((c) => c.cmd === "mktemp"), "nothing was staged in the VM");
});
