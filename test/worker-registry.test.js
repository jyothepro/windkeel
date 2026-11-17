/**
 * The maker registry (ADR-0027 §2, #395 sub-task A): a stage obtains its adapter only from the
 * harness the run's snapshot froze, and a harness the deployment does not register is a named,
 * run-fatal error — never another agent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultHarnessId,
  HarnessUnavailableError,
  harnessOf,
  LEGACY_HARNESS_ID,
  makerIneligibility,
  singleWorkerRegistry,
  UNVERSIONED,
  workerFor,
} from "../dist/worker/registry.js";
import { makerDepsFor, MakerRouteError, makerRouteErrorOf } from "../dist/factory/workflow/maker-route.js";
import { assertEligibleMakers, buildWorkerRegistry } from "../dist/factory/stage-wiring.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import { loadWorkerConfig } from "../dist/factory/worker-config.js";
import { CodexWorkerAdapter } from "../dist/worker/codex/adapter.js";
import { ClaudeCodeWorkerAdapter } from "../dist/worker/claude-code/adapter.js";

const codex = { name: "codex", version: "0.154.0" };
const claude = { name: "claude-code", version: "2.1.304" };
const both = { workers: new Map([["codex", codex], ["claude-code", claude]]) };
const snapshotOn = (maker) => ({ version: 1, maker: { provider: "openai", vendor: "openai", model: "gpt-5", keySource: "orqon", source: "operator", ...maker }, checker: [], resolvedAt: "", policyIds: [] });

test("workerFor picks the snapshot's harness", () => {
  assert.equal(workerFor(both, snapshotOn({ worker: "claude-code", harness: { id: "claude-code", version: "2.1.304" } })), claude);
  assert.equal(workerFor(both, snapshotOn({ worker: "codex", harness: { id: "codex", version: "0.154.0" } })), codex);
  // `harness` outranks a disagreeing `worker`; intake never writes one, but the frozen pair is the rule.
  assert.equal(workerFor(both, snapshotOn({ worker: "codex", harness: { id: "claude-code", version: "2.1.304" } })), claude);
});

test("a snapshot without a harness — every run before ADR-0027 — is Codex", () => {
  assert.equal(workerFor(both, snapshotOn({})), codex);
  assert.equal(workerFor(both, null), codex);
  assert.equal(LEGACY_HARNESS_ID, "codex");
  assert.deepEqual(harnessOf(snapshotOn({})), { id: "codex", version: UNVERSIONED });
  assert.deepEqual(harnessOf(snapshotOn({ worker: "codex" }), () => "0.154.0"), { id: "codex", version: "0.154.0" });
  assert.deepEqual(harnessOf(snapshotOn({ harness: { id: "claude-code", version: "2.1.299" } }), () => "x"), { id: "claude-code", version: "2.1.299" });
});

test("a harness the deployment does not register is a named error, not another agent", () => {
  const codexOnly = { workers: singleWorkerRegistry(codex) };
  assert.throws(
    () => workerFor(codexOnly, snapshotOn({ worker: "claude-code", harness: { id: "claude-code", version: "2.1.304" } })),
    (error) => error instanceof HarnessUnavailableError && error.harnessId === "claude-code" && /registers codex/.test(error.message),
  );
  assert.throws(() => workerFor({ workers: new Map() }, null), HarnessUnavailableError);
});

test("a registry of one serves a snapshot that names no harness; a hand-built legacy `worker` still works", () => {
  const fake = { name: "fake" };
  assert.equal(workerFor({ workers: singleWorkerRegistry(fake) }, null), fake);
  assert.equal(workerFor({ workers: singleWorkerRegistry(fake) }, snapshotOn({})), fake);
  assert.equal(workerFor({ worker: fake }, snapshotOn({ worker: "codex" })), fake, "test doubles predate the registry");
});

test("defaultHarnessId prefers the operator's default when registered", () => {
  assert.equal(defaultHarnessId(both.workers, "claude-code"), "claude-code");
  assert.equal(defaultHarnessId(both.workers, "opencode"), "codex");
  assert.equal(defaultHarnessId(new Map()), "codex");
});

test("makerDepsFor binds the run's adapter, and an unregistered harness is a MakerRouteError (stop_reason model_policy)", async () => {
  const deps = { ...both, pool: null, runModels: async () => snapshotOn({ worker: "claude-code", harness: { id: "claude-code", version: "2.1.299" } }) };
  const bound = await makerDepsFor(deps, "run-1");
  assert.equal(bound.worker, claude);
  assert.equal(bound.harnessVersion, "2.1.299");
  const gone = { workers: singleWorkerRegistry(codex), pool: null, runModels: deps.runModels };
  await assert.rejects(makerDepsFor(gone, "run-1"), (error) => error instanceof MakerRouteError && makerRouteErrorOf(error) === error);
});

test("the default deployment registers only Codex; enabling claude-code adds the Claude Code adapter", () => {
  const config = loadWorkerConfig({ DATABASE_URL: "postgres://x", WINDKEEL_REPOSITORY_URL: "/tmp/x", OPENAI_API_KEY: "k" });
  const defaults = buildWorkerRegistry(config, () => {}, {});
  assert.deepEqual([...defaults.keys()], ["codex"]);
  assert.ok(defaults.get("codex") instanceof CodexWorkerAdapter);

  const two = buildWorkerRegistry(config, () => {}, { WINDKEEL_MAKER_HARNESSES: "codex,claude-code" });
  assert.deepEqual([...two.keys()], ["codex", "claude-code"]);
  assert.ok(two.get("claude-code") instanceof ClaudeCodeWorkerAdapter);
  assert.equal(two.get("claude-code").version, config.claudeCode.pinnedVersion);
  for (const worker of two.values()) assert.deepEqual(makerIneligibility(worker.capabilities), []);

  assert.throws(() => buildWorkerRegistry(config, () => {}, { WINDKEEL_MAKER_HARNESSES: "codex,opencode" }), /no maker adapter for/);
});

test("the stage host refuses a malformed harness list or a default it does not enable (#342)", () => {
  const config = loadWorkerConfig({ DATABASE_URL: "postgres://x", WINDKEEL_REPOSITORY_URL: "/tmp/x", OPENAI_API_KEY: "k" });
  assert.throws(() => buildWorkerRegistry(config, () => {}, { WINDKEEL_MAKER_HARNESSES: "codex,Claude Code" }), /not a harness id/);
  assert.throws(
    () => buildWorkerRegistry(config, () => {}, { WINDKEEL_MAKER_HARNESSES: "codex", WINDKEEL_DEFAULT_MAKER_HARNESS: "claude-code" }),
    /WINDKEEL_DEFAULT_MAKER_HARNESS is "claude-code"/,
  );
  assert.throws(() => buildWorkerRegistry(config, () => {}, { WINDKEEL_DEFAULT_MAKER_HARNESS: "claude-code" }), /does not enable/);
  const two = buildWorkerRegistry(config, () => {}, { WINDKEEL_MAKER_HARNESSES: "codex,claude-code", WINDKEEL_DEFAULT_MAKER_HARNESS: "claude-code" });
  assert.deepEqual([...two.keys()], ["codex", "claude-code"]);
});

test("production wiring refuses an adapter that is not an eligible maker (ADR-0027 §3)", () => {
  const fake = new FakeWorkerAdapter([]);
  assert.throws(
    () => assertEligibleMakers(new Map([[fake.name, fake]])),
    (error) => /not eligible as a production maker/.test(error.message) && /resumableSessions/.test(error.message),
  );
  const config = loadWorkerConfig({ DATABASE_URL: "postgres://x", WINDKEEL_REPOSITORY_URL: "/tmp/x", OPENAI_API_KEY: "k" });
  const two = buildWorkerRegistry(config, () => {}, { WINDKEEL_MAKER_HARNESSES: "codex,claude-code" });
  assert.equal(assertEligibleMakers(two), two);
});
