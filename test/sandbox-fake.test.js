import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { fixtureRepo } from "./helpers.js";

test("create() clones a real local git repo and exec sees its commit", async () => {
  const repoDir = fixtureRepo({});
  const provider = new FakeSandboxProvider();
  const handle = await provider.create({ role: "maker", repoUrl: repoDir });
  try {
    const result = await handle.exec("git", { args: ["log", "--oneline"] });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /fixture: initial commit/);
  } finally {
    await handle.destroy();
  }
});

test("file ops round-trip through the sandbox root", async () => {
  const repoDir = fixtureRepo({});
  const provider = new FakeSandboxProvider();
  const handle = await provider.create({ role: "verifier", repoUrl: repoDir });
  try {
    assert.equal(await handle.exists("no-such-file.txt"), false);
    await handle.writeFile("scratch.txt", "hello sandbox");
    assert.equal(await handle.exists("scratch.txt"), true);
    const contents = await handle.readFile("scratch.txt");
    assert.equal(contents.toString("utf8"), "hello sandbox");

    const files = await handle.listFiles(".");
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes("scratch.txt"));
    assert.ok(paths.includes("package.json"));

    const tmp = await handle.mkdtemp("windkeel-sandbox-test-");
    assert.ok(existsSync(tmp));
  } finally {
    await handle.destroy();
  }
});

test("updateNetworkPolicy and applyCredentialBrokerRules resolve and are recorded", async () => {
  const repoDir = fixtureRepo({});
  const provider = new FakeSandboxProvider();
  const handle = await provider.create({ role: "maker", repoUrl: repoDir });
  try {
    await handle.updateNetworkPolicy({ mode: "deny-all" });
    await handle.applyCredentialBrokerRules([
      { domain: "api.openai.com", header: "Authorization", secretEnvVar: "CODEX_API_KEY" },
    ]);
    await handle.exec("git", { args: ["status"] });

    assert.equal(handle.calls.length, 3);
    assert.equal(handle.calls[0].type, "policy");
    assert.deepEqual(handle.calls[0].policy, { mode: "deny-all" });
    assert.equal(handle.calls[1].type, "credentialBroker");
    assert.equal(handle.calls[1].rules[0].domain, "api.openai.com");
    assert.equal(handle.calls[2].type, "exec");
    assert.equal(handle.calls[2].command, "git");
  } finally {
    await handle.destroy();
  }
});

test("capabilities declare no enforcement, honestly", () => {
  const provider = new FakeSandboxProvider();
  assert.equal(provider.name, "fake");
  assert.deepEqual(provider.capabilities, {
    credentialBrokering: false,
    phasedEgress: false,
    // True, and genuinely so: a fake sandbox's root directory is derived from its id, so the id
    // alone rebuilds a working handle — see the cross-process test below.
    reattachable: true,
    // False, and the most consequential of the four: `exec` is `spawnSync` on this machine and
    // absolute paths resolve to the real filesystem, so anything that installs software "into
    // the sandbox" installs it here (#219).
    isolatedFilesystem: false,
    // #387: the checkout is copied aside by `snapshot()` and back by `create({ fromSnapshot })`.
    snapshots: true,
  });
});

test("destroy() removes the sandbox's temp directory", async () => {
  const repoDir = fixtureRepo({});
  const provider = new FakeSandboxProvider();
  const handle = await provider.create({ role: "maker", repoUrl: repoDir });
  const root = handle.root;
  assert.equal(existsSync(root), true);
  await handle.destroy();
  assert.equal(existsSync(root), false);
});

test("role passed to create() comes back unchanged on the handle", async () => {
  const repoDir = fixtureRepo({});
  const provider = new FakeSandboxProvider();
  const makerHandle = await provider.create({ role: "maker", repoUrl: repoDir });
  const verifierHandle = await provider.create({ role: "verifier", repoUrl: repoDir });
  try {
    assert.equal(makerHandle.role, "maker");
    assert.equal(verifierHandle.role, "verifier");
  } finally {
    await makerHandle.destroy();
    await verifierHandle.destroy();
  }
});

// #387: environment snapshots on the fake — the round trip a restore depends on.

test("snapshot() copies the checkout aside, ends the handle, and create({ fromSnapshot }) brings it back", async () => {
  const { spawnSync } = await import("node:child_process");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const repoDir = fixtureRepo({ test: "true" });
  const provider = new FakeSandboxProvider();
  const setup = await provider.create({ role: "verifier", repoUrl: repoDir });
  // What a setup step leaves behind: an untracked, installed tree.
  await setup.writeFile("installed.txt", "built by setup\n");
  const snap = await setup.snapshot({ expirationMs: 86_400_000 });
  assert.match(snap.snapshotId, /^fakesnap-/);
  assert.ok(snap.sizeBytes > 0);
  assert.deepEqual(setup.calls.at(-1), { type: "snapshot", snapshotId: snap.snapshotId, expirationMs: 86_400_000 });
  assert.equal(existsSync(setup.root), false, "snapshot() is terminal, as on Vercel");

  // A new commit lands on the remote after the snapshot; the restore must check *it* out.
  writeFileSync(join(repoDir, "later.txt"), "after the snapshot\n");
  spawnSync("git", ["add", "-A"], { cwd: repoDir });
  spawnSync("git", ["commit", "-qm", "later"], { cwd: repoDir });
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).stdout.trim();
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir, encoding: "utf8" }).stdout.trim();

  const restored = await provider.create({ role: "maker", repoUrl: repoDir, gitRevision: branch, fromSnapshot: snap.snapshotId });
  try {
    assert.deepEqual(restored.calls[0], { type: "create", fromSnapshot: snap.snapshotId });
    assert.equal(readFileSync(join(restored.root, "installed.txt"), "utf8"), "built by setup\n");
    assert.equal(readFileSync(join(restored.root, "later.txt"), "utf8"), "after the snapshot\n");
    const at = (await restored.exec("git", { args: ["rev-parse", "HEAD"] })).stdout.trim();
    assert.equal(at, head, "the working tree is the revision asked for, not the snapshot's");
  } finally {
    await restored.destroy();
    await provider.deleteSnapshot(snap.snapshotId);
  }
});

test("a restore checks out a different revision, and a read credential gets the read-only remote", async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const repoDir = fixtureRepo({ test: "true" });
  const git = (...args) => spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
  const first = git("rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(repoDir, "candidate.txt"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "candidate");
  const candidate = git("rev-parse", "HEAD").stdout.trim();

  const provider = new FakeSandboxProvider();
  const setup = await provider.create({ role: "verifier", repoUrl: repoDir, gitRevision: first });
  const snap = await setup.snapshot({ expirationMs: 1000 });
  const verifier = await provider.create({
    role: "verifier",
    repoUrl: repoDir,
    gitRevision: candidate,
    fromSnapshot: snap.snapshotId,
    gitCredentials: { username: "x", token: "t", permission: "read", expiresAt: new Date(Date.now() + 60_000).toISOString() },
  });
  try {
    assert.equal((await verifier.exec("git", { args: ["rev-parse", "HEAD"] })).stdout.trim(), candidate);
    const pushed = await verifier.exec("git", { args: ["push", "origin", "HEAD:refs/heads/attempt"] });
    assert.notEqual(pushed.status, 0, "a verifier restored from a snapshot still cannot push");
  } finally {
    await verifier.destroy();
    await provider.deleteSnapshot(snap.snapshotId);
  }
  await assert.rejects(
    provider.create({ role: "maker", repoUrl: repoDir, fromSnapshot: snap.snapshotId }),
    /no snapshot/,
    "a deleted snapshot cannot be restored",
  );
});
