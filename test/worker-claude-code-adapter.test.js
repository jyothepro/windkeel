/**
 * The Claude Code adapter's invocation and environment (ADR-0027 §3.7–3.9, §5; #395 sub-task C),
 * against the fake harness binary. The conformance suite covers the shared obligations.
 */

import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { test } from "node:test";
import { CODEX_API_KEY_PLACEHOLDER } from "../dist/sandbox/credential-broker.js";
import {
  CLAUDE_CODE_DISALLOWED_TOOLS,
  ClaudeCodeWorkerAdapter,
  claudeCodeEnv,
  PINNED_CLAUDE_CODE_VERSION,
} from "../dist/worker/claude-code/adapter.js";
import { claudeCodeFixture, makerSandbox } from "./helpers.js";
import { BROKERED_SECRET, drain, HOSTILE_CHECKOUT, installFakeHarness, routeFor } from "./worker-conformance/suite.js";

const SPEC = { model: "claude-sonnet-4-5", provider: "anthropic", modelApiDomain: "api.anthropic.com", authHeader: "x-api-key" };

async function setup(handle, streams, extra = {}) {
  const stub = await installFakeHarness(handle, {
    binaryName: "claude",
    versionLine: `${PINNED_CLAUDE_CODE_VERSION} (Claude Code)`,
    streams,
    ...extra,
  });
  const adapter = new ClaudeCodeWorkerAdapter({ binary: stub.binPath, pollIntervalMs: 10 });
  return { stub, adapter };
}

test("turn 1 is `claude -p --bare` with stream-json, the model, no prompts and no web or MCP tools; the prompt is on stdin", async () => {
  const handle = await makerSandbox();
  try {
    const { stub, adapter } = await setup(handle, [claudeCodeFixture("successful-session")]);
    const session = await adapter.start({ prompt: "fix the pager\n-- not a flag", sandbox: handle, route: routeFor(SPEC) });
    await drain(adapter, session);
    const [{ argv, stdin }] = stub.invocations();
    assert.deepEqual(argv.slice(0, 5), ["-p", "--bare", "--output-format", "stream-json", "--verbose"]);
    assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2), ["--model", "claude-sonnet-4-5"]);
    assert.deepEqual(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2), ["--permission-mode", "bypassPermissions"]);
    assert.ok(argv.includes("--strict-mcp-config"));
    assert.equal(argv[argv.indexOf("--disallowedTools") + 1], CLAUDE_CODE_DISALLOWED_TOOLS);
    assert.match(CLAUDE_CODE_DISALLOWED_TOOLS, /WebFetch/);
    assert.match(CLAUDE_CODE_DISALLOWED_TOOLS, /WebSearch/);
    assert.match(CLAUDE_CODE_DISALLOWED_TOOLS, /mcp__/);
    const settings = JSON.parse((await handle.readFile(argv[argv.indexOf("--settings") + 1])).toString("utf8"));
    assert.equal(settings.skipWebFetchPreflight, true);
    assert.ok(!argv.includes("--resume") && !argv.includes("--continue"));
    assert.ok(!argv.some((arg) => arg.includes("fix the pager")), "the prompt is not on the command line");
    assert.equal(stdin, "fix the pager\n-- not a flag");
  } finally {
    await handle.destroy();
  }
});

test("turn 2 resumes with --resume <session_id> and the repair packet on stdin", async () => {
  const handle = await makerSandbox();
  try {
    const { stub, adapter } = await setup(handle, [claudeCodeFixture("successful-session"), claudeCodeFixture("resumed-turn")]);
    const session = await adapter.start({ prompt: "x", sandbox: handle, route: routeFor(SPEC) });
    await drain(adapter, session);
    await adapter.send(session, { repairPacket: { failed_checks: [{ check: "tests" }], repair_constraints: ["keep tests"] } });
    const events = await drain(adapter, session);
    const [, second] = stub.invocations();
    assert.deepEqual(second.argv.slice(second.argv.indexOf("--resume"), second.argv.indexOf("--resume") + 2), ["--resume", "9f3c1a2e-4b5d-4e6f-8a7b-0c1d2e3f4a5b"]);
    assert.ok(second.argv.includes("--bare"), "every turn is bare");
    assert.match(second.stdin, /Repair packet \(JSON\)/);
    assert.equal(events.filter((e) => e.type === "completed").length, 1);
    const result = await adapter.result(session);
    assert.equal(result.outcome, "completed");
    assert.equal(result.cumulativeUsage.inputTokens, 20_120 + 21_360, "the session total sums both turns");
    assert.equal(result.harnessReportedCostUsd, 0.0112, "the harness's own figure, for comparison");
  } finally {
    await handle.destroy();
  }
});

test("the environment holds the placeholder and the off switches, never a key, and no base URL unless the route has one", async () => {
  const handle = await makerSandbox();
  try {
    const { stub, adapter } = await setup(handle, [claudeCodeFixture("successful-session")]);
    const session = await adapter.start({ prompt: "x", sandbox: handle, route: routeFor(SPEC) });
    await drain(adapter, session);
    const [{ env }] = stub.invocations();
    assert.equal(env.ANTHROPIC_API_KEY, CODEX_API_KEY_PLACEHOLDER);
    // What the adapter hands the sandbox (the fake sandbox also passes this host's own environment).
    const launched = handle.calls.find((c) => c.options?.env?.WINDKEEL_RUNNER).options.env;
    assert.equal(launched.ANTHROPIC_BASE_URL, undefined);
    for (const name of ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DISABLE_AUTOUPDATER"]) {
      assert.equal(env[name], "1", name);
    }
    assert.ok(!JSON.stringify(stub.invocations()).includes(BROKERED_SECRET));
    assert.ok(env.CLAUDE_CONFIG_DIR.endsWith("/claude-config"));
    assert.ok(await handle.exists(env.CLAUDE_CONFIG_DIR), "the isolated config home exists before the harness runs");
  } finally {
    await handle.destroy();
  }
  assert.deepEqual(claudeCodeEnv("/s/c", { baseUrl: "https://llm-proxy.example.test/v1/" }).ANTHROPIC_BASE_URL, "https://llm-proxy.example.test");
});

test("a hostile checkout's hooks, MCP servers and settings are not loaded: --bare, and nothing ran", async () => {
  const handle = await makerSandbox();
  try {
    for (const [path, contents] of Object.entries(HOSTILE_CHECKOUT)) {
      const target = `${handle.checkoutPath}/${path}`;
      await handle.exec("mkdir", { args: ["-p", target.slice(0, target.lastIndexOf("/"))] });
      await handle.writeFile(target, contents);
    }
    const { stub, adapter } = await setup(handle, [claudeCodeFixture("successful-session")]);
    const session = await adapter.start({ prompt: "x", sandbox: handle, workdir: handle.checkoutPath, route: routeFor(SPEC) });
    await drain(adapter, session);
    const [{ argv, cwd }] = stub.invocations();
    // realpath: on macOS the temp dir is /var → /private/var, and the harness reports the resolved cwd.
    assert.equal(realpathSync(cwd), realpathSync(handle.checkoutPath));
    assert.ok(argv.includes("--bare") && argv.includes("--strict-mcp-config"));
    assert.ok(!argv.some((arg) => arg.includes(".mcp.json") || arg.includes(".claude/settings.json")), "no repository file is handed to the harness");
  } finally {
    await handle.destroy();
  }
});

test("a non-API-key auth source fails the turn and stops the process", async () => {
  const handle = await makerSandbox();
  try {
    const { adapter } = await setup(handle, [claudeCodeFixture("oauth-auth-source")], { mode: "hang" });
    const session = await adapter.start({ prompt: "x", sandbox: handle, route: routeFor(SPEC) });
    const events = await drain(adapter, session);
    assert.equal(events.filter((e) => e.type === "failed").length, 1);
    const result = await adapter.result(session);
    assert.equal(result.outcome, "failed");
    assert.match(result.error, /API key only/);
    const pgid = Number((await handle.readFile(adapter.describe(session).pidPath)).toString("utf8"));
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(-pgid, 0);
        await new Promise((r) => setTimeout(r, 20));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "the process was stopped rather than left running on a refused login");
  } finally {
    await handle.destroy();
  }
});

test("send() without a session id refuses rather than --continue", async () => {
  const handle = await makerSandbox();
  try {
    const noInit = claudeCodeFixture("successful-session").split("\n").slice(1).join("\n");
    const { adapter } = await setup(handle, [noInit.replace(/"session_id":"[^"]*"/g, '"x":1')]);
    const session = await adapter.start({ prompt: "x", sandbox: handle, route: routeFor(SPEC) });
    await drain(adapter, session);
    await assert.rejects(adapter.send(session, { text: "again" }), /no Claude Code session id.*--continue/s);
  } finally {
    await handle.destroy();
  }
});
