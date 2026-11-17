/**
 * #387 on the Vercel provider, with the SDK stubbed (the property under test is what this code
 * *sends*): `fromSnapshot` becomes `source: { type: "snapshot" }`, the restore's fetch and checkout
 * go through the hardened git invocation with the token named to that one command, `snapshot()`
 * passes the expiration, and the provider refuses snapshots unless the feature flag turned them on.
 */

import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { Sandbox, Snapshot } from "@vercel/sandbox";
import { VercelSandboxProvider } from "../dist/sandbox/vercel.js";

const realCreate = Sandbox.create;
const realGetSnapshot = Snapshot.get;
let creates = [];
let commands = [];
let written = [];
let snapshots = [];

function stubSandbox(params) {
  return {
    name: params.name,
    createdAt: new Date(),
    activeCpuUsageMs: 5,
    networkTransfer: { egress: 7 },
    update: async () => {},
    fs: {
      writeFile: async (path, data) => void written.push({ path, data: String(data) }),
      readFile: async () => Buffer.from(""),
    },
    runCommand: async ({ cmd, args = [], env }) => {
      commands.push({ cmd, args, env });
      let stdout = "";
      let exitCode = 0;
      if (cmd === "sh" && String(args[1] ?? "").includes('cd "$HOME"')) stdout = "/home/vercel-sandbox/repo\n";
      else if (cmd === "mktemp") stdout = "/tmp/windkeel-git-abc\n";
      else if (cmd === "test") exitCode = 1;
      else if (cmd === "git" && args.includes("symbolic-ref")) stdout = "origin/main\n";
      return { exitCode, stdout: async () => stdout, stderr: async () => "" };
    },
    snapshot: async (opts) => {
      snapshots.push(opts);
      return { snapshotId: "snap_abc123", sizeBytes: 4096 };
    },
    stop: async () => {},
    delete: async () => {},
  };
}

beforeEach(() => {
  creates = [];
  commands = [];
  written = [];
  snapshots = [];
  Sandbox.create = async (params) => {
    creates.push(params);
    return stubSandbox(params);
  };
});

after(() => {
  Sandbox.create = realCreate;
  Snapshot.get = realGetSnapshot;
});

const credentials = { token: "t", teamId: "team", projectId: "prj" };
const TOKEN = "ghs_restoretoken_0123456789";
const gitCredentials = { username: "x-access-token", token: TOKEN, permission: "read", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };

test("fromSnapshot maps to source: { type: 'snapshot' } and is refused while the flag is off", async () => {
  const off = new VercelSandboxProvider(credentials);
  await assert.rejects(
    off.create({ role: "verifier", repoUrl: "https://github.com/acme/widgets.git", fromSnapshot: "snap_1" }),
    /WINDKEEL_ENVIRONMENT_SNAPSHOTS/,
  );
  assert.equal(creates.length, 0, "nothing was created on a refused restore");

  const provider = new VercelSandboxProvider({ ...credentials, environmentSnapshots: true });
  const handle = await provider.create({
    role: "verifier",
    repoUrl: "https://github.com/acme/widgets.git",
    gitRevision: "0123456789abcdef0123456789abcdef01234567",
    fromSnapshot: "snap_1",
    gitCredentials,
  });
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].source, { type: "snapshot", snapshotId: "snap_1" });
  assert.equal(creates[0].persistent, true);
  assert.equal(JSON.stringify(creates[0]).includes(TOKEN), false, "the token is not part of a snapshot create");
  assert.equal(handle.checkoutPath, "/home/vercel-sandbox/repo");
});

test("the restore fetches and checks out with hardened git, the token named to the fetch alone", async () => {
  const provider = new VercelSandboxProvider({ ...credentials, environmentSnapshots: true });
  await provider.create({
    role: "maker",
    repoUrl: "https://github.com/acme/widgets.git",
    gitRevision: "HEAD",
    fromSnapshot: "snap_2",
    gitCredentials: { ...gitCredentials, permission: "write" },
  });
  const git = commands.filter((c) => c.cmd === "git");
  const setUrl = git.find((c) => c.args.includes("set-url"));
  const fetch = git.find((c) => c.args.includes("fetch"));
  const checkout = git.find((c) => c.args.includes("checkout"));
  assert.ok(setUrl && fetch && checkout, `expected set-url, fetch and checkout: ${JSON.stringify(git.map((c) => c.args))}`);
  for (const c of [setUrl, fetch, checkout]) {
    assert.ok(c.args.includes("core.hooksPath=/dev/null"), "every restore git command is hardened");
    assert.equal(c.env.GIT_CONFIG_NOSYSTEM, "1");
  }
  assert.ok(setUrl.args.includes("https://github.com/acme/widgets.git"));
  assert.ok(
    fetch.args.includes("credential.helper=store --file /tmp/windkeel-git-abc/credentials") ||
      fetch.args.some((a) => a.startsWith("credential.helper=store --file /tmp/windkeel-git-abc/")),
    "the fetch names the credential file",
  );
  assert.ok(!checkout.args.some((a) => a.startsWith("credential.helper=store")), "the checkout holds no credential");
  assert.ok(checkout.args.includes("-B") && checkout.args.includes("main") && checkout.args.includes("origin/main"));
  for (const c of commands) assert.ok(!c.args.some((a) => String(a).includes(TOKEN)), "the token never reaches argv");
  assert.ok(written.some((w) => w.data.includes(TOKEN)), "the token went through the file API");
  assert.ok(commands.some((c) => c.cmd === "rm"), "the credential file is removed after the fetch");
});

test("a restore whose fetch fails ends the restored sandbox instead of leaking it", async () => {
  const ended = [];
  Sandbox.create = async (params) => {
    creates.push(params);
    const sandbox = stubSandbox(params);
    const run = sandbox.runCommand;
    sandbox.runCommand = async (command) => {
      if (command.cmd === "git" && command.args.includes("fetch")) {
        return { exitCode: 128, stdout: async () => "", stderr: async () => "fatal: could not read from remote" };
      }
      return run(command);
    };
    sandbox.stop = async () => void ended.push("stop");
    sandbox.delete = async () => void ended.push("delete");
    return sandbox;
  };
  const provider = new VercelSandboxProvider({ ...credentials, environmentSnapshots: true });
  await assert.rejects(
    provider.create({ role: "maker", repoUrl: "https://github.com/acme/widgets.git", fromSnapshot: "snap_3", gitCredentials }),
    /fetch failed/,
  );
  assert.deepEqual(ended, ["stop", "delete"], "the restored sandbox was stopped and deleted");
});

test("snapshot() passes the expiration and ends the handle", async () => {
  const provider = new VercelSandboxProvider({ ...credentials, environmentSnapshots: true });
  const handle = await provider.create({ role: "verifier", repoUrl: "https://github.com/acme/widgets.git" });
  const snap = await handle.snapshot({ expirationMs: 14 * 86_400_000 });
  assert.deepEqual(snapshots, [{ expiration: 14 * 86_400_000 }]);
  assert.deepEqual(snap, { snapshotId: "snap_abc123", sizeBytes: 4096 });
  await assert.rejects(handle.snapshot({ expirationMs: 1 }), /gone/);
});

test("deleteSnapshot deletes, and a snapshot that is already gone is not an error", async () => {
  const deleted = [];
  Snapshot.get = async ({ snapshotId }) => {
    if (snapshotId === "snap_gone") throw Object.assign(new Error("snapshot not found"), { status: 404 });
    return { delete: async () => void deleted.push(snapshotId) };
  };
  const provider = new VercelSandboxProvider({ ...credentials, environmentSnapshots: true });
  await provider.deleteSnapshot("snap_live");
  await provider.deleteSnapshot("snap_gone");
  assert.deepEqual(deleted, ["snap_live"]);
  Snapshot.get = async () => {
    throw new Error("500 upstream");
  };
  await assert.rejects(provider.deleteSnapshot("snap_x"), /500/);
});

test("#439: usage is the sandbox's wall clock from creation to stop, frozen once it is stopped", async () => {
  const created = Date.now() - 90_000;
  Sandbox.create = async (params) => {
    creates.push(params);
    return { ...stubSandbox(params), createdAt: new Date(created) };
  };
  const provider = new VercelSandboxProvider({ ...credentials, environmentSnapshots: true });
  const handle = await provider.create({ role: "maker", repoUrl: "https://github.com/acme/widgets.git" });
  const running = await handle.usage();
  assert.ok(running.wallClockMs >= 90_000 && running.wallClockMs < 120_000, `running: ${running.wallClockMs}`);
  assert.equal(running.activeCpuMs, 5, "CPU time is still reported, for the dollar cost");
  await handle.destroy();
  const stopped = await handle.usage();
  assert.ok(stopped.wallClockMs >= running.wallClockMs);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await handle.usage()).wallClockMs, stopped.wallClockMs, "a stopped sandbox's clock stops");

  const snapped = await provider.create({ role: "verifier", repoUrl: "https://github.com/acme/widgets.git" });
  await snapped.snapshot({ expirationMs: 1 });
  const atSnapshot = (await snapped.usage()).wallClockMs;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await snapped.usage()).wallClockMs, atSnapshot, "a snapshot stops the sandbox, and its clock");
});
