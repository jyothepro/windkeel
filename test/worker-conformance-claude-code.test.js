/**
 * ADR-0027 §3's conformance suite against the Claude Code adapter (#395). The fixtures in
 * `test/fixtures/claude-code/` are hand-authored from Claude Code's headless documentation, not
 * recorded; the live proof replaces them.
 */

import { ClaudeCodeWorkerAdapter, PINNED_CLAUDE_CODE_VERSION } from "../dist/worker/claude-code/adapter.js";
import { claudeCodeFixture as claudeFixture } from "./helpers.js";
import { runConformance } from "./worker-conformance/suite.js";

const success = claudeFixture("successful-session");
const lastResult = /\{"type":"result".*\}\n?$/m;

runConformance({
  name: "claude-code",
  workerType: "claude-code",
  binaryName: "claude",
  pinnedVersion: PINNED_CLAUDE_CODE_VERSION,
  versionLine: (version) => `${version} (Claude Code)`,
  makeAdapter: (binary, options) => new ClaudeCodeWorkerAdapter({ binary, pinnedVersion: PINNED_CLAUDE_CODE_VERSION, ...options }),
  fixtures: {
    success,
    resumed: claudeFixture("resumed-turn"),
    failed: claudeFixture("failed-turn"),
    duplicateTerminal: `${success}${success.match(lastResult)[0].trimEnd()}\n`,
    usageless: success.replace(lastResult, '{"type":"result","subtype":"success","is_error":false,"session_id":"9f3c1a2e-4b5d-4e6f-8a7b-0c1d2e3f4a5b"}\n'),
  },
  sessionId: "9f3c1a2e-4b5d-4e6f-8a7b-0c1d2e3f4a5b",
  selfReported: "src/pager.js",
  model: "claude-sonnet-4-5",
  provider: "anthropic",
  modelApiDomain: "api.anthropic.com",
  authHeader: "x-api-key",
  keyEnvVars: ["ANTHROPIC_API_KEY"],
  configHomeVar: "CLAUDE_CONFIG_DIR",
  ignoreArgs: ["--bare", "--strict-mcp-config"],
  ignoreEnv: {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
  },
});
