/**
 * ADR-0027 §3's conformance suite against the Codex adapter (#395), and the replay fakes declared
 * ineligible as production makers. The suite is in `test/worker-conformance/suite.js`.
 */

import { CodexWorkerAdapter, PINNED_CODEX_VERSION } from "../dist/worker/codex/adapter.js";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";
import { ScriptedWorkerAdapter } from "../dist/worker/scripted.js";
import { codexFixture } from "./helpers.js";
import { assertIneligible, runConformance } from "./worker-conformance/suite.js";

const success = codexFixture("successful-session");

runConformance({
  name: "codex",
  workerType: "codex",
  binaryName: "codex",
  pinnedVersion: PINNED_CODEX_VERSION,
  versionLine: (version) => `codex-cli ${version}`,
  makeAdapter: (binary, options) => new CodexWorkerAdapter({ binary, pinnedVersion: PINNED_CODEX_VERSION, ...options }),
  fixtures: {
    success,
    resumed: codexFixture("resumed-turn"),
    failed: codexFixture("failed-turn"),
    duplicateTerminal: `${success}${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n`,
    usageless: success.replace(/\{"type":"turn\.completed".*\}\n?$/m, '{"type":"turn.completed"}\n'),
  },
  sessionId: "01JQ8Z9Y2K3M4N5P6Q7R8S9T0V",
  selfReported: "src/pager.ts",
  model: "gpt-5-codex",
  provider: "openai",
  modelApiDomain: "api.openai.com",
  authHeader: "Authorization",
  keyEnvVars: ["CODEX_API_KEY", "OPENAI_API_KEY"],
  configHomeVar: "CODEX_HOME",
  // `--ignore-user-config` keeps any `~/.codex` out; CODEX_HOME in scratch is checked above.
  ignoreArgs: ["--ignore-user-config"],
  ignoreEnv: {},
});

assertIneligible("FakeWorkerAdapter", new FakeWorkerAdapter([]));
assertIneligible("ScriptedWorkerAdapter", new ScriptedWorkerAdapter([{ events: [{ type: "completed" }], diff: { patch: "", filesChanged: [], truncated: false } }]));
