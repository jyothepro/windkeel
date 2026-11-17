/**
 * #387: the environment snapshot's cache key — deterministic, sensitive to exactly the inputs that
 * shape an environment, blind to ordinary source commits and to every secret value.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  canonicalJson,
  computeSnapshotKey,
  readKeyBlobs,
  snapshotKeyPaths,
  SNAPSHOT_FORMAT_VERSION,
} from "../dist/sandbox/environment-snapshot.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { fixtureRepo } from "./helpers.js";

const SETUP = {
  commands: [{ name: "bootstrap", run: "make bootstrap", timeoutSec: 900 }],
  services: [],
  secrets: ["NPM_TOKEN"],
  egress: [],
  cacheKeyFiles: ["scripts/bootstrap.sh"],
};
const T0 = new Date("2026-10-01T00:00:00Z");
const base = {
  provider: { name: "vercel", image: "vercel" },
  setup: SETUP,
  blobs: { "package-lock.json": "a".repeat(40), "windkeel.config.json": "b".repeat(40) },
  secrets: [{ key: "NPM_TOKEN", updatedAt: T0 }],
};

test("the key is deterministic, and object key order does not matter", () => {
  assert.equal(computeSnapshotKey(base), computeSnapshotKey({ ...base }));
  assert.match(computeSnapshotKey(base), /^[0-9a-f]{64}$/);
  const reordered = {
    secrets: [...base.secrets],
    blobs: { "windkeel.config.json": "b".repeat(40), "package-lock.json": "a".repeat(40) },
    setup: { cacheKeyFiles: SETUP.cacheKeyFiles, egress: [], secrets: SETUP.secrets, services: [], commands: SETUP.commands },
    provider: { image: "vercel", name: "vercel" },
  };
  assert.equal(computeSnapshotKey(reordered), computeSnapshotKey(base));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test("the key changes for every input it covers", () => {
  const key = computeSnapshotKey(base);
  const variants = {
    lockfile: { ...base, blobs: { ...base.blobs, "package-lock.json": "c".repeat(40) } },
    setup: { ...base, setup: { ...SETUP, commands: [{ ...SETUP.commands[0], run: "make setup" }] } },
    cacheKeyFile: { ...base, blobs: { ...base.blobs, "scripts/bootstrap.sh": "d".repeat(40) } },
    secretUpdated: { ...base, secrets: [{ key: "NPM_TOKEN", updatedAt: new Date(T0.getTime() + 1000) }] },
    secretAdded: { ...base, secrets: [...base.secrets, { key: "PIP_INDEX_URL", updatedAt: T0 }] },
    provider: { ...base, provider: { name: "fake", image: "fake" } },
    image: { ...base, provider: { name: "vercel", image: "node24" } },
    formatVersion: { ...base, formatVersion: SNAPSHOT_FORMAT_VERSION + 1 },
  };
  for (const [name, inputs] of Object.entries(variants)) {
    assert.notEqual(computeSnapshotKey(inputs), key, `${name} should change the key`);
  }
});

test("secret values are never inputs: a value that changes with updated_at held equal leaves the key alone", () => {
  // The type has no value field; a caller that smuggles one in is ignored, not hashed.
  const withValue = { ...base, secrets: [{ key: "NPM_TOKEN", updatedAt: T0, value: "npm_one_value_123456" }] };
  const otherValue = { ...base, secrets: [{ key: "NPM_TOKEN", updatedAt: T0, value: "npm_another_value_987" }] };
  assert.equal(computeSnapshotKey(withValue), computeSnapshotKey(base));
  assert.equal(computeSnapshotKey(otherValue), computeSnapshotKey(base));
});

test("blob SHAs come from git at the commit: a source commit changes none, a lockfile edit does", async () => {
  const repo = fixtureRepo(
    { test: "true" },
    {
      "package-lock.json": JSON.stringify({ name: "fixture", lockfileVersion: 3, requires: true, packages: {} }),
      "windkeel.config.json": JSON.stringify({ checks: [], setup: SETUP }),
      "index.js": "module.exports = 1;\n",
    },
  );
  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, "nested"));
  writeFileSync(join(repo, "scripts", "bootstrap.sh"), "echo hi\n");
  writeFileSync(join(repo, "nested", ".npmrc"), "fund=false\n");
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("add", "-A");
  git("commit", "-qm", "scripts");
  const c1 = git("rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(repo, "index.js"), "module.exports = 2;\n");
  git("commit", "-qam", "an ordinary source change");
  const c2 = git("rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(repo, "scripts", "bootstrap.sh"), "echo changed\n");
  git("commit", "-qam", "bootstrap changes");
  const c3 = git("rev-parse", "HEAD").stdout.trim();

  const handle = await new FakeSandboxProvider().create({ role: "verifier", repoUrl: repo });
  try {
    const b1 = await readKeyBlobs(handle, c1, SETUP);
    const b2 = await readKeyBlobs(handle, c2, SETUP);
    const b3 = await readKeyBlobs(handle, c3, SETUP);
    assert.deepEqual(Object.keys(b1).sort(), [
      "nested/.npmrc",
      "package-lock.json",
      "package.json",
      "scripts/bootstrap.sh",
      "windkeel.config.json",
    ]);
    assert.ok(!("index.js" in b1), "source files are not key inputs");
    assert.deepEqual(b1, b2);
    const key = (blobs) => computeSnapshotKey({ ...base, blobs });
    assert.equal(key(b1), key(b2), "an ordinary source commit keeps the snapshot");
    assert.notEqual(key(b2), key(b3), "a cacheKeyFiles edit invalidates it");
    assert.ok(snapshotKeyPaths(SETUP).includes(":(literal)scripts/bootstrap.sh"));
    assert.ok(snapshotKeyPaths(null).includes("windkeel.config.json"));
  } finally {
    await handle.destroy();
  }
});
