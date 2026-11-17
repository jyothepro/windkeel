/**
 * #387: `buildEnvironmentSnapshot` against `FakeSandboxProvider` — the setup sandbox is
 * verifier-scoped with a read token and no model key, the clone credential is scrubbed, setup runs
 * with the secrets, a secret on disk fails the build by *name*, a missing required secret fails by
 * name, and nothing is ever snapshotted from a maker-role handle.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { buildEnvironmentSnapshot, listSnapshots } from "../dist/factory/environment-snapshots.js";
import { FakeSandboxProvider, snapshotDirFor } from "../dist/sandbox/fake.js";
import { bareFixtureRepo, FIXTURE_REPOSITORY_ID, seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
let counter = 0;

const SECRET = "npm_Zq8vB3mN7xK2pL9wR4tY";
const TOKEN = "ghs_setupclonetoken_ABCDEF123456";

/** A provider that records what it was asked for, and (optionally) leaves the token in `.git/config`. */
class SpyProvider extends FakeSandboxProvider {
  constructor({ persistToken = false, role } = {}) {
    super();
    this.creates = [];
    this.persistToken = persistToken;
    this.forceRole = role;
  }
  async create(options) {
    this.creates.push({
      role: options.role,
      operatorModelKey: options.operatorModelKey,
      permission: options.gitCredentials?.permission,
      gitRevision: options.gitRevision,
    });
    const handle = await super.create(options);
    if (this.persistToken) {
      // A platform that kept the clone credential in the remote URL, as ADR-0014 §2 fears.
      spawnSync("git", ["remote", "set-url", "origin", `https://x-access-token:${TOKEN}@github.com/acme/widgets.git`], { cwd: handle.root });
    }
    if (this.forceRole) Object.defineProperty(handle, "role", { value: this.forceRole });
    this.last = handle;
    return handle;
  }
}

const broker = {
  roles: [],
  async forWorkspace(_id, role) {
    this.roles.push(role);
    return { username: "x-access-token", token: TOKEN, permission: role === "maker" ? "write" : "read", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  },
};

function secrets(values) {
  return async () => ({
    values,
    unopenable: [],
    versions: Object.keys(values).map((key) => ({ key, updatedAt: new Date("2026-10-01T00:00:00Z") })),
  });
}

async function withRepo(setup, fn) {
  const schema = `windkeel_env_build_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    const { bare } = bareFixtureRepo({ test: "true" }, { "windkeel.config.json": JSON.stringify({ checks: [], setup }), Makefile: "bootstrap:\n\ttrue\n" });
    await seedFixtureRepository(pool, { cloneUrl: bare, defaultBranch: "HEAD" });
    const { rows } = await pool.query("select id from organization where is_default");
    await fn(pool, rows[0].id, bare);
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

const target = (org) => ({ organizationId: org, repositoryId: FIXTURE_REPOSITORY_ID });

test("a clean build: read token, no model key, scrubbed, setup run with the secrets, snapshot ready", { skip }, async () => {
  const setup = {
    commands: [{ name: "bootstrap", run: 'test -n "$NPM_TOKEN" && echo built > built.txt' }],
    secrets: ["NPM_TOKEN"],
  };
  await withRepo(setup, async (pool, org) => {
    broker.roles = [];
    const provider = new SpyProvider({ persistToken: true });
    const outcome = await buildEnvironmentSnapshot(pool, provider, {
      secrets: secrets({ NPM_TOKEN: SECRET }),
      gitCredentials: { broker, host: "github.com" },
      ttlDays: 14,
    }, target(org));
    assert.equal(outcome.status, "ready", JSON.stringify(outcome));
    assert.deepEqual(broker.roles, ["verifier"], "the setup sandbox's token is minted with the verifier's (read) scope");
    assert.deepEqual(provider.creates, [{ role: "verifier", operatorModelKey: false, permission: "read", gitRevision: "HEAD" }]);

    const snap = outcome.snapshot;
    assert.equal(snap.status, "ready");
    assert.match(snap.baseSha, /^[0-9a-f]{40}$/);
    assert.match(snap.detail, /setup ran bootstrap; 1 untracked setup output path\(s\) excluded from git; secret scan clean over 1 secret/);
    assert.ok(!snap.detail.includes(SECRET));
    const dir = snapshotDirFor(snap.providerSnapshotId);
    assert.equal(readFileSync(join(dir, "built.txt"), "utf8"), "built\n", "setup ran with the secret in its environment");
    assert.ok(!readFileSync(join(dir, ".git", "config"), "utf8").includes(TOKEN), "the clone credential was scrubbed before the snapshot");
    assert.ok(provider.last.calls.some((c) => c.type === "snapshot"));
    // The draft suggestion was stored, and nothing in it ran.
    assert.ok(snap.proposedSetup.reasons.some((r) => /Makefile has a `bootstrap` target/.test(r)));

    // The same inputs again: the key is held, no second build.
    const again = await buildEnvironmentSnapshot(pool, new SpyProvider(), { secrets: secrets({ NPM_TOKEN: SECRET }), ttlDays: 14 }, target(org));
    assert.equal(again.status, "exists");
    assert.equal(again.cacheKey, snap.cacheKey);
  });
});

for (const [name, run] of [
  ["raw", 'echo "$NPM_TOKEN" > .token-cache'],
  ["base64", 'printf %s "$NPM_TOKEN" | base64 > nested.b64'],
  ["inside .npmrc", 'printf "//registry.example.com/:_authToken=%s\\n" "$NPM_TOKEN" > .npmrc'],
]) {
  test(`the secret-leak scan fails the build when setup writes the value to disk (${name})`, { skip }, async () => {
    await withRepo({ commands: [{ name: "leak", run }], secrets: ["NPM_TOKEN"] }, async (pool, org) => {
      const provider = new SpyProvider();
      const outcome = await buildEnvironmentSnapshot(pool, provider, { secrets: secrets({ NPM_TOKEN: SECRET }), ttlDays: 14 }, target(org));
      assert.equal(outcome.status, "failed");
      assert.match(outcome.detail, /NPM_TOKEN in /, "the detail names the secret");
      assert.ok(!outcome.detail.includes(SECRET), "and never its value");
      const [row] = await listSnapshots(pool, org, FIXTURE_REPOSITORY_ID);
      assert.equal(row.status, "failed");
      assert.equal(row.providerSnapshotId, null);
      assert.ok(!provider.last.calls.some((c) => c.type === "snapshot"), "nothing was snapshotted");
      assert.equal(existsSync(provider.last.root), false, "the setup sandbox was destroyed");
    });
  });
}

test("a missing required secret fails the build with a named reason", { skip }, async () => {
  await withRepo({ commands: [{ name: "bootstrap", run: "true" }], secrets: ["NPM_TOKEN", "PIP_INDEX_URL"] }, async (pool, org) => {
    const outcome = await buildEnvironmentSnapshot(pool, new SpyProvider(), { secrets: secrets({ NPM_TOKEN: SECRET }), ttlDays: 14 }, target(org));
    assert.equal(outcome.status, "failed");
    assert.match(outcome.detail, /requires repository secret\(s\) PIP_INDEX_URL, which are not set/);
  });
});

test("a failing setup command fails the build, redacted", { skip }, async () => {
  await withRepo({ commands: [{ name: "boom", run: 'echo "token was $NPM_TOKEN" >&2; exit 3' }] }, async (pool, org) => {
    const outcome = await buildEnvironmentSnapshot(pool, new SpyProvider(), { secrets: secrets({ NPM_TOKEN: SECRET }), ttlDays: 14 }, target(org));
    assert.equal(outcome.status, "failed");
    assert.match(outcome.detail, /setup command boom exited 3: token was \[REDACTED\]/);
  });
});

test("no snapshot is ever taken from a handle whose role is maker", { skip }, async () => {
  await withRepo({ commands: [] }, async (pool, org) => {
    const provider = new SpyProvider({ role: "maker" });
    const outcome = await buildEnvironmentSnapshot(pool, provider, { secrets: secrets({}), ttlDays: 14 }, target(org));
    assert.equal(outcome.status, "failed");
    assert.match(outcome.detail, /refusing to snapshot a sandbox whose role is not the setup role/);
    assert.ok(!provider.last.calls.some((c) => c.type === "snapshot"));
  });
});

test("a provider that cannot snapshot is refused before anything is created", { skip }, async () => {
  await withRepo({ commands: [] }, async (pool, org) => {
    const provider = new SpyProvider();
    provider.capabilities.snapshots = false;
    const outcome = await buildEnvironmentSnapshot(pool, provider, { secrets: secrets({}), ttlDays: 14 }, target(org));
    assert.equal(outcome.status, "unsupported");
    assert.deepEqual(provider.creates, []);
  });
});

/**
 * #433: a provider whose sandbox has a filesystem of its own, as Vercel's does, so the build scans
 * `$HOME` and the system roots too — played on this machine by a temp directory standing in for `/`.
 * The handle maps the scan's system roots (and `$HOME`) under that directory; the scan itself,
 * `grep` and all, runs for real. `unsearchable` plays a root the unprivileged scan could not enter.
 */
class IsolatedSpyProvider extends SpyProvider {
  constructor({ sys, unsearchable } = {}) {
    super();
    this.capabilities = { ...this.capabilities, isolatedFilesystem: true };
    this.sys = sys;
    this.unsearchable = unsearchable;
  }
  async create(options) {
    const handle = await super.create(options);
    const exec = handle.exec.bind(handle);
    const { sys, unsearchable } = this;
    handle.exec = async (command, opts = {}) => {
      const args = opts.args ?? [];
      if (command === "sh" && args[1] === 'printf %s "$HOME"') return { status: 0, signal: null, stdout: "/home/setup", stderr: "" };
      if (command === "id") return { status: 0, signal: null, stdout: "1000\n", stderr: "" };
      if (command === "sudo") return { status: 1, signal: null, stdout: "", stderr: "sudo: a password is required\n" };
      if (command === "sh" && args[2] === "windkeel-leak-scan" && args[3] === "roots") {
        const mapped = args.slice(4).map((p) => (p.startsWith(sys) || p.startsWith(handle.root) ? p : `${sys}${p}`));
        // The fake's checkout lives under this machine's /tmp, so `leakScanRoots` (rightly) folds it
        // into `/tmp`; mapping `/tmp` away from this machine would leave it out, so add it back.
        if (!mapped.some((p) => handle.root.startsWith(`${p}/`) || p === handle.root)) mapped.push(handle.root);
        const result = await exec(command, { ...opts, args: [...args.slice(0, 4), ...mapped] });
        return unsearchable ? { ...result, stderr: `windkeel-leak-scan: unsearchable ${unsearchable}\n${result.stderr}` } : result;
      }
      return exec(command, opts);
    };
    return handle;
  }
}

function fakeSystem() {
  const sys = mkdtempSync(join(tmpdir(), "windkeel-env-build-sys-"));
  for (const dir of ["etc", "tmp", "var/tmp", "usr/local/etc", "opt", "var/lib", "root", "home/setup"]) mkdirSync(join(sys, dir), { recursive: true });
  return sys;
}

test("#433: a secret setup wrote to /etc, /tmp and /usr/local/etc/npmrc fails the build, by name and file, never the value", { skip }, async () => {
  const sys = fakeSystem();
  try {
    const run =
      `printf "token=%s\\n" "$NPM_TOKEN" > ${sys}/etc/x && ` +
      `node -e 'process.stdout.write(encodeURIComponent(process.env.NPM_TOKEN))' > ${sys}/tmp/y && ` +
      `echo "$NPM_TOKEN" | base64 > ${sys}/usr/local/etc/npmrc && ` +
      `echo "$NPM_TOKEN" > ${sys}/home/setup/.netrc && echo "$NPM_TOKEN" > .token`;
    await withRepo({ commands: [{ name: "leak", run }], secrets: ["NPM_TOKEN"] }, async (pool, org) => {
      const provider = new IsolatedSpyProvider({ sys });
      const outcome = await buildEnvironmentSnapshot(pool, provider, { secrets: secrets({ NPM_TOKEN: SECRET }), ttlDays: 14 }, target(org));
      assert.equal(outcome.status, "failed", JSON.stringify(outcome));
      for (const file of ["etc/x", "tmp/y", "usr/local/etc/npmrc", "home/setup/.netrc"]) {
        assert.ok(outcome.detail.includes(join(sys, file)), `names ${file}: ${outcome.detail}`);
      }
      assert.ok(outcome.detail.includes(join(provider.last.root, ".token")), "and the checkout, still");
      assert.match(outcome.detail, /NPM_TOKEN in /);
      assert.ok(!outcome.detail.includes(SECRET));
      assert.ok(!outcome.detail.includes(Buffer.from(SECRET).toString("base64").slice(0, 16)), "nor its base64");
      assert.ok(!provider.last.calls.some((c) => c.type === "snapshot"), "nothing was snapshotted");
    });
  } finally {
    rmSync(sys, { recursive: true, force: true });
  }
});

test("#433: a root the scan could not search fails the build; a clean whole-disk scan passes and is timed", { skip }, async () => {
  const sys = fakeSystem();
  try {
    await withRepo({ commands: [{ name: "bootstrap", run: "true" }], secrets: ["NPM_TOKEN"] }, async (pool, org) => {
      const blocked = await buildEnvironmentSnapshot(
        pool,
        new IsolatedSpyProvider({ sys, unsearchable: "/var/lib" }),
        { secrets: secrets({ NPM_TOKEN: SECRET }), ttlDays: 14 },
        target(org),
      );
      assert.equal(blocked.status, "failed");
      assert.match(blocked.detail, /the secret scan could not look everywhere a snapshot keeps \(without root, [0-9.]+s\): \/var\/lib: root could not be searched/);

      const logs = [];
      const clean = await buildEnvironmentSnapshot(
        pool,
        new IsolatedSpyProvider({ sys }),
        { secrets: secrets({ NPM_TOKEN: SECRET }), ttlDays: 14, log: (message, fields) => logs.push({ message, fields }) },
        target(org),
      );
      assert.equal(clean.status, "ready", JSON.stringify(clean));
      assert.match(clean.snapshot.detail, /secret scan clean over 1 secret\(s\) across 8 root\(s\) without root in [0-9.]+s/);
      const scanLog = logs.find((l) => l.message === "environment snapshot secret scan");
      assert.equal(typeof scanLog.fields.durationMs, "number");
      for (const root of ["/home/setup", "/etc", "/tmp", "/var/lib", "/root"]) assert.ok(scanLog.fields.searched.includes(root), root);
    });
  } finally {
    rmSync(sys, { recursive: true, force: true });
  }
});

test("#433: a maker's new file inside a directory setup created is still captured after a restore", { skip }, async () => {
  const setup = { commands: [{ name: "gen", run: "mkdir -p generated && echo out > generated/a.txt && echo top > setup-marker" }] };
  await withRepo(setup, async (pool, org, bare) => {
    const provider = new SpyProvider();
    const outcome = await buildEnvironmentSnapshot(pool, provider, { secrets: secrets({}), ttlDays: 14 }, target(org));
    assert.equal(outcome.status, "ready", JSON.stringify(outcome));
    assert.match(outcome.snapshot.detail, /2 untracked setup output path\(s\) excluded from git/);

    const restored = await provider.create({ role: "maker", repoUrl: bare, gitRevision: "HEAD", fromSnapshot: outcome.snapshot.providerSnapshotId });
    try {
      const exclude = readFileSync(join(restored.root, ".git", "info", "exclude"), "utf8");
      assert.match(exclude, /^\/generated\/a\.txt$/m, "excluded file by file");
      assert.doesNotMatch(exclude, /^\/generated$/m, "never the whole directory");
      await restored.writeFile("generated/new.txt", "the maker's change\n");
      const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: restored.root, encoding: "utf8" });
      assert.match(status.stdout, /^\?\? generated\/new\.txt$/m, "the maker's new file is visible to the capture");
      assert.doesNotMatch(status.stdout, /a\.txt|setup-marker/, "setup's own outputs stay out of it");
    } finally {
      await restored.destroy();
      await provider.deleteSnapshot(outcome.snapshot.providerSnapshotId);
    }
  });
});
