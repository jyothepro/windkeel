/**
 * #387's flags, where the handlers read them: `WINDKEEL_ENVIRONMENT_SNAPSHOTS` off means the handlers
 * pass nothing to `provisionWorkspace` (provisioning exactly as before), and
 * `WINDKEEL_SNAPSHOT_FOR_VERIFIER=false` forces every verifier cold — no snapshot offered, no build
 * requested — while makers still restore. Neither question may reach the database; a pool that
 * throws proves it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { environmentFor, requestBuildAfter } from "../dist/factory/workflow/handlers/environment.js";
import { loadWorkerConfig } from "../dist/factory/worker-config.js";

const untouchable = {
  query: async () => {
    throw new Error("the database was consulted");
  },
};

function deps(environmentSnapshots) {
  return {
    pool: untouchable,
    sandboxes: { name: "fake", capabilities: { snapshots: true } },
    config: { repository: { url: "https://github.com/acme/widgets" }, ...(environmentSnapshots ? { environmentSnapshots } : {}) },
  };
}

const BASE_ENV = {
  DATABASE_URL: "postgres://x",
  WINDKEEL_REPOSITORY_URL: "https://github.com/o/r",
  OPENAI_API_KEY: "sk-not-a-real-key",
};

test("the flags parse with the documented defaults", () => {
  assert.deepEqual(loadWorkerConfig(BASE_ENV).environmentSnapshots, { enabled: false, forVerifier: true, ttlDays: 14 });
  assert.deepEqual(
    loadWorkerConfig({ ...BASE_ENV, WINDKEEL_ENVIRONMENT_SNAPSHOTS: "true", WINDKEEL_SNAPSHOT_FOR_VERIFIER: "false", WINDKEEL_SNAPSHOT_TTL_DAYS: "3" })
      .environmentSnapshots,
    { enabled: true, forVerifier: false, ttlDays: 3 },
  );
});

test("flag off: nothing is offered and nothing is requested, for either role", async () => {
  for (const config of [undefined, { enabled: false, forVerifier: true, ttlDays: 14 }]) {
    assert.equal(await environmentFor(deps(config), "run-1", "maker"), undefined);
    assert.equal(await environmentFor(deps(config), "run-1", "verifier"), undefined);
    // `provisionWorkspace` returns no environment when it was given none.
    await requestBuildAfter(deps(config), "run-1", "maker", undefined);
    await requestBuildAfter(deps(config), "run-1", "verifier", undefined);
  }
});

test("WINDKEEL_SNAPSHOT_FOR_VERIFIER=false: the verifier is offered no snapshot and requests no build", async () => {
  const killed = deps({ enabled: true, forVerifier: false, ttlDays: 14 });
  assert.deepEqual(await environmentFor(killed, "run-1", "verifier"), {}, "on, but cold: nothing to restore");
  await requestBuildAfter(killed, "run-1", "verifier", { mode: "cold" });
  // The maker still asks (and so reaches the database, which here refuses).
  await assert.rejects(environmentFor(killed, "run-1", "maker"), /database was consulted/);
});
