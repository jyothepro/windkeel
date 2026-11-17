/**
 * The factory's own wiring: does `buildStageDeps` build a **real** worker adapter, and does it
 * hand that adapter the two options whose absence is invisible until a live run?
 *
 * This suite exists because of a gap that survived three milestones: the graph builder threw
 * unless a caller injected a `WorkerAdapter`, so every end-to-end proof in this repo ran on an
 * injected fake and the production path could not do agent work at all. Nothing failed — it
 * simply had no coverage, because the tests were the only callers that supplied the missing
 * piece.
 *
 * It was `worker-container-wiring.test.js` and tested `createFactoryWorker` until #200 deleted
 * `apps/worker`. **None of what it covers went with the container**: `buildStageDeps`,
 * `codexAdapterOptions` and `assertCodexAvailableLocally` are the same functions in
 * `stage-wiring.ts`, and a deployed step reaches them through `deployed-runner.ts`. Deleting
 * this suite with the container would have dropped the only coverage of the seam the gap lived
 * in, which is exactly what #200 asks not to do.
 *
 * So these are wiring assertions, deliberately: no Postgres, no sandbox, no codex. They check
 * the seam between configuration and construction.
 */

import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadWorkerConfig,
  configWarnings,
  InvalidConfigError,
} from "../dist/factory/worker-config.js";
import {
  assertCodexAvailableLocally,
  buildStageDeps,
  codexAdapterOptions,
} from "../dist/factory/stage-wiring.js";
import {
  CodexWorkerAdapter,
  PINNED_CODEX_VERSION,
} from "../dist/worker/codex/adapter.js";
import { tempDir } from "./helpers.js";

/** The minimum that `loadWorkerConfig` accepts; every test starts from this. */
function env(overrides = {}) {
  return {
    DATABASE_URL: "postgres://windkeel:windkeel@127.0.0.1:1/windkeel",
    WINDKEEL_REPOSITORY_URL: "https://github.com/o/r",
    OPENAI_API_KEY: "sk-not-a-real-key",
    ...overrides,
  };
}

/** A `codex` that answers `--version` and nothing else — enough for a PATH probe. */
function stubCodex(version = PINNED_CODEX_VERSION) {
  const dir = tempDir("codex-stub");
  const binPath = join(dir, "codex");
  writeFileSync(binPath, `#!/bin/sh\necho "codex-cli ${version}"\nexit 0\n`);
  chmodSync(binPath, 0o755);
  return binPath;
}

test("the graph builds a real CodexWorkerAdapter with no adapter injected", async () => {
  const config = loadWorkerConfig(env());
  // No VERCEL_* credentials here, so this is also the ADR-0016 local-mode path — the one an
  // operator running the loop against docker-compose takes.
  const { deps, pool } = buildStageDeps(config);
  try {
    // ADR-0027 §1: the default deployment registers exactly one harness, Codex.
    assert.deepEqual([...deps.workers.keys()], ["codex"]);
    assert.ok(
      deps.workers.get("codex") instanceof CodexWorkerAdapter,
      "production wiring must build a real adapter, not throw and not fall back to a fake",
    );
    assert.equal(deps.workers.get("codex").name, "codex");
  } finally {
    // `new Pool` is lazy and nothing above connects, so this closes an idle pool.
    await pool.end().catch(() => {});
  }
});

test("the adapter is given the container's egress domain and brokered-key variable", () => {
  const config = loadWorkerConfig(
    env({
      WINDKEEL_MODEL_API_DOMAIN: "api.example-inference.com",
      WINDKEEL_MODEL_KEY_ENV_VAR: "MY_MAKER_KEY",
      MY_MAKER_KEY: "sk-also-not-real",
      WINDKEEL_CODEX_BINARY: "/opt/codex/bin/codex",
      WINDKEEL_CODEX_VERSION: "0.999.0",
      WINDKEEL_ALLOW_CODEX_VERSION_DRIFT: "true",
    }),
  );
  const options = codexAdapterOptions(config);

  /**
   * These two are the reason this test exists. Neither changes any behaviour that a fake
   * sandbox can observe: a missing `makerModelKeyEnvVar` drops the brokered credential at the
   * execution-phase transition (ADR-0014 §1) and a wrong `modelApiDomain` narrows egress to the
   * wrong host (ADR-0014 §3) — both of which surface only as a live agent failing inside a
   * microVM, which is the most expensive place to learn about a missing constructor argument.
   */
  assert.equal(options.makerModelKeyEnvVar, "MY_MAKER_KEY");
  assert.equal(options.modelApiDomain, "api.example-inference.com");

  assert.equal(options.binary, "/opt/codex/bin/codex");
  assert.equal(options.pinnedVersion, "0.999.0");
  assert.equal(options.allowVersionDrift, true);
});

test("codex configuration defaults to the pinned version and a bare `codex`", () => {
  const config = loadWorkerConfig(env());
  assert.equal(config.codex.binary, "codex");
  assert.equal(config.codex.pinnedVersion, PINNED_CODEX_VERSION);
  assert.equal(config.codex.allowVersionDrift, false);
});

test("a boolean flag spelled `false` is false, and a garbage one is named", () => {
  // The failure direction that matters: an operator who turns drift-tolerance *off* must not
  // get it on because the parser treated any non-empty string as true.
  for (const value of ["false", "0", "no", "off", "FALSE"]) {
    assert.equal(
      loadWorkerConfig(env({ WINDKEEL_ALLOW_CODEX_VERSION_DRIFT: value })).codex.allowVersionDrift,
      false,
      `${value} must read as false`,
    );
  }
  for (const value of ["true", "1", "yes", "on", "TRUE"]) {
    assert.equal(
      loadWorkerConfig(env({ WINDKEEL_ALLOW_CODEX_VERSION_DRIFT: value })).codex.allowVersionDrift,
      true,
      `${value} must read as true`,
    );
  }
  assert.throws(
    () => loadWorkerConfig(env({ WINDKEEL_ALLOW_CODEX_VERSION_DRIFT: "maybe" })),
    (err) =>
      err instanceof InvalidConfigError && err.variable === "WINDKEEL_ALLOW_CODEX_VERSION_DRIFT",
  );
});

test("version-drift tolerance is warned about at startup", () => {
  const warnings = configWarnings(
    loadWorkerConfig(env({ WINDKEEL_ALLOW_CODEX_VERSION_DRIFT: "true" })),
  );
  assert.ok(
    warnings.some((w) => w.includes("WINDKEEL_ALLOW_CODEX_VERSION_DRIFT")),
    "a disarmed guard must announce itself",
  );
  assert.equal(
    configWarnings(loadWorkerConfig(env())).some((w) =>
      w.includes("WINDKEEL_ALLOW_CODEX_VERSION_DRIFT"),
    ),
    false,
  );
});

test("local mode refuses to start without a codex on this host, naming the variable", async () => {
  const config = loadWorkerConfig(env({ WINDKEEL_CODEX_BINARY: "codex-that-does-not-exist" }));
  await assert.rejects(
    () => assertCodexAvailableLocally(config),
    (err) =>
      /WINDKEEL_CODEX_BINARY/.test(err.message) &&
      // The message has to say what to do about it, not just what is wrong.
      /VERCEL_TOKEN/.test(err.message),
  );
});

test("local mode accepts a codex it can execute", async () => {
  const config = loadWorkerConfig(env({ WINDKEEL_CODEX_BINARY: stubCodex() }));
  await assertCodexAvailableLocally(config);
});

test("an injected adapter suppresses the local-mode preflight", async () => {
  /**
   * A test (or the e2e suite) that injects an adapter has already said where the agent runs.
   * Re-deriving that from configuration would make an injected fake fail startup because the
   * *host* lacked a binary it was never going to use.
   */
  const config = loadWorkerConfig(env({ WINDKEEL_CODEX_BINARY: "codex-that-does-not-exist" }));
  const injected = {
    name: "fake",
    capabilities: { resumableSessions: false },
    async start() {
      throw new Error("not used");
    },
    async send() {},
    events() {
      return (async function* () {})();
    },
    async cancel() {},
    async result() {
      throw new Error("not used");
    },
  };
  const { deps, pool } = buildStageDeps(config, { worker: injected });
  try {
    assert.equal(deps.workers.get("fake"), injected);
  } finally {
    await pool.end().catch(() => {});
  }
});

// --- ADR-0027 (#395): Claude Code, per-provider maker keys, and the checker list ------------------

test("Claude Code configuration: the pinned version, its override, and its drift switch", async () => {
  const { PINNED_CLAUDE_CODE_VERSION } = await import("../dist/worker/claude-code/adapter.js");
  const stageWiring = await import("../dist/factory/stage-wiring.js");
  const config = loadWorkerConfig(env());
  assert.deepEqual(config.claudeCode, { binary: "claude", pinnedVersion: PINNED_CLAUDE_CODE_VERSION, allowVersionDrift: false });
  const pinned = loadWorkerConfig(env({ WINDKEEL_CLAUDE_CODE_VERSION: "2.1.400", WINDKEEL_ALLOW_CLAUDE_CODE_VERSION_DRIFT: "1" }));
  assert.equal(pinned.claudeCode.pinnedVersion, "2.1.400");
  assert.equal(pinned.claudeCode.allowVersionDrift, true);
  assert.throws(() => loadWorkerConfig(env({ WINDKEEL_ALLOW_CLAUDE_CODE_VERSION_DRIFT: "maybe" })), InvalidConfigError);

  const keyed = loadWorkerConfig(env({ WINDKEEL_MAKER_KEY_ENV_VAR_ANTHROPIC: "MY_ANTHROPIC_MAKER_KEY", MY_ANTHROPIC_MAKER_KEY: "sk-ant-x" }));
  assert.deepEqual(keyed.makerKeyEnvVars, { anthropic: "MY_ANTHROPIC_MAKER_KEY" });
  assert.equal(stageWiring.claudeCodeAdapterOptions(keyed).makerModelKeyEnvVar, "MY_ANTHROPIC_MAKER_KEY");
  assert.equal(stageWiring.claudeCodeAdapterOptions(keyed).modelApiDomain, "api.anthropic.com");
  assert.throws(
    () => loadWorkerConfig(env({ WINDKEEL_MAKER_KEY_ENV_VAR_ANTHROPIC: "UNSET_ANTHROPIC_MAKER_KEY" })),
    /UNSET_ANTHROPIC_MAKER_KEY/,
    "a per-provider key variable that names nothing is a startup error",
  );
});

test("the operator's checkers are a list in preference order across vendors", () => {
  const both = { ANTHROPIC_API_KEY: "sk-ant-x", WINDKEEL_CHECKER_OPENAI_API_KEY: "sk-openai-x" };
  assert.deepEqual(loadWorkerConfig(env(both)).checkerEndpoints.map((e) => [e.vendor, e.model]), [
    ["anthropic", "claude-sonnet-4-5"],
    ["openai", "gpt-5"],
  ]);
  assert.deepEqual(
    loadWorkerConfig(env({ ...both, WINDKEEL_CHECKER_VENDORS: "openai,anthropic", WINDKEEL_CHECKER_OPENAI_MODEL: "gpt-5-mini" })).checkerEndpoints.map((e) => [e.vendor, e.model]),
    [["openai", "gpt-5-mini"], ["anthropic", "claude-sonnet-4-5"]],
  );
  assert.deepEqual(loadWorkerConfig(env({ ANTHROPIC_API_KEY: "sk-ant-x" })).checkerEndpoints.map((e) => e.vendor), ["anthropic"], "today's default is unchanged");
  assert.throws(() => loadWorkerConfig(env({ WINDKEEL_CHECKER_VENDORS: "anthropic,google" })), InvalidConfigError);
});

test("doctor's warning: an enabled harness with no independent operator checker", () => {
  const anthropicOnly = loadWorkerConfig(env({ ANTHROPIC_API_KEY: "sk-ant-x" }));
  assert.ok(configWarnings(anthropicOnly, ["codex", "claude-code"]).some((w) => /claude-code harness is enabled.*no independent/s.test(w)));
  assert.ok(!configWarnings(anthropicOnly, ["codex"]).some((w) => /harness is enabled/.test(w)), "codex on an OpenAI maker has the Anthropic checker");
  const both = loadWorkerConfig(env({ ANTHROPIC_API_KEY: "sk-ant-x", WINDKEEL_CHECKER_OPENAI_API_KEY: "sk-openai-x" }));
  assert.ok(!configWarnings(both, ["codex", "claude-code"]).some((w) => /harness is enabled/.test(w)));
  assert.ok(!configWarnings(both).some((w) => /uses the maker's vendor/.test(w)), "an OpenAI checker after an Anthropic one is not a warning");
  // No checker at all: intake does not refuse, so the default deployment gets no harness warning.
  const none = loadWorkerConfig(env());
  assert.deepEqual(none.checkerEndpoints, []);
  assert.ok(!configWarnings(none, ["codex"]).some((w) => /harness is enabled/.test(w)));
  assert.ok(configWarnings(none, ["codex"]).some((w) => /no checker model endpoint is configured/.test(w)));
});
