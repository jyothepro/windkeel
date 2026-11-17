import { test } from "node:test";
import assert from "node:assert/strict";
import { commandDuration, filesTouched, terminalOf } from "./terminal.ts";
import type { AgentStep, RunEvent } from "./types.ts";

let seq = 0;
const at = (s: number) => new Date(Date.UTC(2026, 9, 17, 0, 0, s)).toISOString();
const agent = (event: AgentStep, second: number, agentRunId = "ar-1", role = "implementer"): RunEvent => ({
  kind: "agent",
  cursor: String(++seq),
  at: at(second),
  agentRunId,
  role,
  event,
});

test("the Terminal pairs each command with its output, exit and duration, turn by turn", () => {
  const turns = terminalOf(
    [
      agent({ type: "started" }, 0),
      agent({ type: "command_started", command: "npm ci" }, 0),
      agent({ type: "command_finished", command: "npm ci", exitCode: 0, output: "added 210 packages" }, 0),
      agent({ type: "file_changed", path: "src/a.ts", kind: "update" }, 60),
      agent({ type: "test_started", command: "npm test" }, 60),
      agent({ type: "test_finished", command: "npm test", exitCode: 1, passed: false, output: "✖ 1 failing\n<b>not markup</b>" }, 240),
      agent({ type: "message", text: "done" }, 240),
      agent({ type: "completed" }, 240),
      { kind: "transition", cursor: String(++seq), at: at(250), from: "IMPLEMENTING", to: "VERIFYING", reason: null },
      agent({ type: "command_started", command: "git diff" }, 300, "ar-2", "repairer"),
    ],
    true,
  );
  assert.equal(turns.length, 2);
  const [maker, repair] = turns;
  assert.equal(maker!.running, false);
  assert.deepEqual(
    maker!.commands.map((c) => [c.tool, c.command, c.state, c.status, c.output, c.duration?.label]),
    [
      ["run", "npm ci", "done", "exit 0", "added 210 packages", "under a minute"],
      ["test", "npm test", "failed", "failed · exit 1", "✖ 1 failing\n<b>not markup</b>", "~3m"],
    ],
  );
  assert.equal(repair!.role, "repairer");
  assert.equal(repair!.running, true);
  assert.deepEqual(repair!.commands.map((c) => [c.state, c.status, c.duration]), [["running", null, null]]);
});

test("a turn with no commands isn't drawn; a finish with no start has no duration", () => {
  assert.deepEqual(terminalOf([agent({ type: "thinking", text: "hm" }, 0, "ar-9"), agent({ type: "completed" }, 0, "ar-9")], false), []);
  const [turn] = terminalOf([agent({ type: "command_finished", command: "ls", exitCode: 0 }, 5, "ar-8"), agent({ type: "completed" }, 5, "ar-8")], false);
  assert.equal(turn!.commands[0]!.duration, null);
  assert.equal(turn!.commands[0]!.output, null, "no output recorded reads as none, not as an empty string");
});

test("durations come from Windkeel's reads and say so", () => {
  assert.equal(commandDuration(at(0), at(0))!.label, "under a minute");
  assert.equal(commandDuration(at(0), at(20))!.label, "20s");
  assert.equal(commandDuration(at(0), at(61))!.label, "~61s");
  assert.equal(commandDuration(at(0), at(600))!.label, "~10m");
  assert.equal(commandDuration(at(0), at(3 * 3600 + 120))!.label, "~3h 2m");
  assert.match(commandDuration(at(0), at(600))!.title, /reads of the agent's log/);
  assert.equal(commandDuration(null, at(1)), null);
});

test("the files a turn touched, in order, once each, from its own steps only", () => {
  const events = [
    agent({ type: "file_changed", path: "src/a.ts" }, 0, "ar-1"),
    agent({ type: "file_changed", path: "src/b.ts" }, 0, "ar-2"),
    agent({ type: "file_changed", path: "src/a.ts" }, 1, "ar-1"),
    agent({ type: "file_changed", path: "test/a.test.ts", kind: "add" }, 2, "ar-1"),
  ];
  assert.deepEqual(filesTouched(events, "ar-1"), ["src/a.ts", "test/a.test.ts"]);
  assert.deepEqual(filesTouched(events, "ar-3"), []);
});
