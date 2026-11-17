import { test } from "node:test";
import assert from "node:assert/strict";
import { foldFeed, stepCount, turnDuration, type Turn } from "./agent-steps.ts";
import type { AgentStep, RunEvent } from "./types.ts";

let seq = 0;
const at = (s: number) => new Date(Date.UTC(2026, 8, 24, 0, 0, s)).toISOString();
const agent = (event: AgentStep, agentRunId = "ar-1", second = seq): RunEvent => ({
  kind: "agent",
  cursor: String(++seq),
  at: at(second),
  agentRunId,
  role: "implementer",
  event,
});
const transition = (): RunEvent => ({ kind: "transition", cursor: String(++seq), at: at(seq), from: "PROVISIONING", to: "IMPLEMENTING", reason: null });

const turnsOf = (items: ReturnType<typeof foldFeed>) => items.filter((i): i is Turn => i.kind === "turn");

test("a command's start and finish are one step, placed where it started", () => {
  const items = foldFeed(
    [
      transition(),
      agent({ type: "started" }),
      agent({ type: "command_started", command: "rg settleMerged" }),
      agent({ type: "file_changed", path: "src/a.ts", kind: "update" }),
      agent({ type: "command_finished", command: "rg settleMerged", exitCode: 0 }),
      agent({ type: "completed" }),
    ],
    true,
  );
  assert.equal(items[0]!.kind, "event");
  const [turn] = turnsOf(items);
  assert.ok(turn);
  assert.deepEqual(
    turn.rows.map((r) => (r.kind === "step" ? `${r.verb} ${r.target} ${r.state} ${r.meta ?? ""}`.trim() : r.kind)),
    ["run rg settleMerged done exit 0", "edit src/a.ts done"],
  );
  assert.equal(turn.ended, true);
});

test("only the newest turn of a live run has a running step", () => {
  const events = [
    agent({ type: "command_started", command: "npm test" }, "ar-1"),
    agent({ type: "test_started", command: "npm test" }, "ar-2"),
  ];
  const [first, second] = turnsOf(foldFeed(events, true));
  assert.equal(first!.rows[0]!.kind === "step" && first!.rows[0]!.state, "done", "an older turn's open command isn't running");
  assert.equal(second!.rows[0]!.kind === "step" && second!.rows[0]!.state, "running");
  const [, ended] = turnsOf(foldFeed(events, false));
  assert.equal(ended!.rows[0]!.kind === "step" && ended!.rows[0]!.state, "done", "nothing runs on a run that has ended");
});

test("a failing test and a non-zero exit are failed steps; a message is not a step", () => {
  const [turn] = turnsOf(
    foldFeed(
      [
        agent({ type: "test_started", command: "npm test" }),
        agent({ type: "test_finished", command: "npm test", exitCode: 1, passed: false }),
        agent({ type: "command_finished", command: "tsc", exitCode: 2 }),
        agent({ type: "message", text: "Done." }),
      ],
      false,
    ),
  );
  const states = turn!.rows.map((r) => (r.kind === "step" ? r.state : "message"));
  assert.deepEqual(states, ["failed", "failed", "message"]);
  assert.equal(stepCount(turn!), 2);
});

test("a long reasoning item shows its first line and keeps the rest behind the chevron", () => {
  const [turn] = turnsOf(foldFeed([agent({ type: "thinking", text: "Read the adopt path first.\nThen the test." })], false));
  const row = turn!.rows[0]!;
  assert.ok(row.kind === "step");
  assert.equal(row.target, "Read the adopt path first.");
  assert.equal(row.detail, "Read the adopt path first.\nThen the test.");
});

test("a turn's duration comes from its own events", () => {
  const [turn] = turnsOf(foldFeed([agent({ type: "started" }, "ar-9", 0), agent({ type: "completed" }, "ar-9", 75)], false));
  assert.equal(turnDuration(turn!), "1m");
});

test("Codex's reconnects are retries, and a turn that carries on to completed didn't fail", () => {
  const reconnect = (n: number): AgentStep => ({
    type: "failed",
    error: `Reconnecting... ${n}/5 (stream disconnected before completion: Attack attempt detected)`,
  });
  const [turn] = turnsOf(
    foldFeed(
      [
        agent({ type: "started" }),
        agent(reconnect(2)),
        agent(reconnect(3)),
        agent({ type: "command_started", command: "npm test" }),
        agent({ type: "command_finished", command: "npm test", exitCode: 0 }),
        agent({ type: "completed" }),
      ],
      false,
    ),
  );
  assert.equal(turn!.failed, false);
  const rows = turn!.rows.map((r) => (r.kind === "step" ? [r.verb, r.state, r.meta, r.target] : [r.kind]));
  assert.deepEqual(rows, [
    ["retry", "done", "2/5", "stream disconnected before completion: Attack attempt detected"],
    ["retry", "done", "3/5", "stream disconnected before completion: Attack attempt detected"],
    ["run", "done", "exit 0", "npm test"],
  ]);
});

test("a real failure is the turn's last word only until the session carries on", () => {
  const failedLast = turnsOf(foldFeed([agent({ type: "command_started", command: "x" }, "ar-f"), agent({ type: "failed", error: "model refused" }, "ar-f")], true))[0]!;
  assert.equal(failedLast.failed, true);
  assert.equal(failedLast.ended, true);
  const row = failedLast.rows.at(-1)!;
  assert.ok(row.kind === "step" && row.state === "failed" && row.target === "model refused");

  const resumed = turnsOf(
    foldFeed([agent({ type: "failed", error: "model refused" }, "ar-g"), agent({ type: "command_started", command: "npm test" }, "ar-g")], true),
  )[0]!;
  assert.equal(resumed.failed, false, "guidance restarted the session after the failure");
  assert.equal(resumed.ended, false);
});

test("#392: a maker screenshot is a row of its turn, and Windkeel's notes after the end don't reopen it", () => {
  const items = foldFeed(
    [
      agent({ type: "browser_unavailable", reason: "Chromium could not be downloaded" }, "ar-shots"),
      agent({ type: "started" }, "ar-shots"),
      agent({ type: "completed" }, "ar-shots"),
      agent({ type: "screenshot", screenshotId: "s-1", name: "home", url: "http://localhost:3000/" }, "ar-shots"),
      agent({ type: "screenshot", name: "no id" }, "ar-shots"),
    ],
    true,
  );
  const [turn] = turnsOf(items);
  assert.equal(turn!.ended, true, "a screenshot harvested after `completed` leaves the turn ended");
  const shots = turn!.rows.filter((r) => r.kind === "screenshot");
  assert.deepEqual(shots.map((r) => r.kind === "screenshot" && [r.screenshotId, r.name, r.url]), [["s-1", "home", "http://localhost:3000/"]]);
  const browser = turn!.rows.find((r) => r.kind === "step" && r.tool === "browser");
  assert.ok(browser && browser.kind === "step" && browser.detail === "Chromium could not be downloaded");
  assert.equal(stepCount(turn!), 1, "a screenshot is not a step");
});
