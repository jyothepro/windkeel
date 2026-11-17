import { test } from "node:test";
import assert from "node:assert/strict";
import { activityOf, costText, splitEarlier, withoutIds, type ActivityTurn, type StageHeader } from "./activity.ts";
import { usd } from "./format.ts";
import type { AgentStep, RunEvent } from "./types.ts";

let seq = 0;
const at = (s: number) => new Date(Date.UTC(2026, 9, 17, 0, 0, s)).toISOString();
const transition = (from: RunEvent["from"], to: RunEvent["to"], reason: string | null = null): RunEvent => ({ kind: "transition", cursor: String(++seq), at: at(seq), from, to, reason });
const cost = (usdValue: number | null, costKind = "model"): RunEvent => ({ kind: "cost", cursor: String(++seq), at: at(seq), usd: usdValue, costKind, stageType: "implementing" });
const agent = (event: AgentStep, agentRunId = "ar-1"): RunEvent => ({ kind: "agent", cursor: String(++seq), at: at(seq), agentRunId, role: "implementer", event });

const UUID = "3f2a9c10-1b2c-4d5e-8f90-a1b2c3d4e5f6";

test("state changes become stage headers, and nothing in the feed is a raw state line", () => {
  const items = activityOf([transition("CREATED", "CLASSIFYING"), transition("CLASSIFYING", "PLANNING")], false);
  assert.deepEqual(
    items.map((i) => i.kind === "stage" && i.to),
    ["CLASSIFYING", "PLANNING"],
  );
  assert.equal((items[1] as StageHeader).title, "CLASSIFYING → PLANNING");
});

test("cost folds into the turn that was running when it was spent, by time", () => {
  const items = activityOf(
    [
      transition("PROVISIONING", "IMPLEMENTING"),
      agent({ type: "started" }),
      agent({ type: "command_started", command: "npm test" }),
      agent({ type: "command_finished", command: "npm test", exitCode: 0 }),
      agent({ type: "completed" }),
      cost(0.3),
      cost(0.01, "sandbox"),
    ],
    false,
  );
  assert.equal(items.length, 2, "no cost line of its own");
  const turn = items[1] as ActivityTurn;
  assert.equal(turn.kind, "turn");
  assert.ok(Math.abs(turn.cost!.usd - 0.31) < 1e-9);
  assert.deepEqual(Object.keys(turn.cost!.byKind), ["model", "sandbox"]);
});

test("cost in a stage with no turn goes to the stage header, never to an earlier stage's turn", () => {
  const items = activityOf(
    [transition("PROVISIONING", "IMPLEMENTING"), agent({ type: "started" }), agent({ type: "completed" }), transition("IMPLEMENTING", "VERIFYING"), cost(0.05, "sandbox")],
    false,
  );
  const turn = items[1] as ActivityTurn;
  const verifying = items[2] as StageHeader;
  assert.equal(turn.cost, null);
  assert.equal(verifying.cost!.usd, 0.05);
});

test("an unpriced call makes the footer a lower bound", () => {
  const [header] = activityOf([transition("CREATED", "PROVISIONING"), cost(0.01, "sandbox"), cost(null)], false) as [StageHeader];
  assert.equal(header.cost!.unpriced, 1);
  assert.deepEqual(costText(header.cost!, usd), { short: "at least $0.01", detail: "sandbox $0.01 · 1 unpriced call" });
});

test("cost before the first state change the feed holds is one quiet line", () => {
  const items = activityOf([cost(0.01, "sandbox"), cost(0.02, "sandbox"), transition("PROVISIONING", "IMPLEMENTING")], false);
  assert.equal(items[0]!.kind, "cost");
  assert.equal(items.length, 2);
});

test("a UUID never reaches the visible text; it stays on hover", () => {
  assert.deepEqual(withoutIds(`verification ${UUID} failed`), { text: "verification failed", ids: [UUID] });
  assert.equal(withoutIds(`stopped (agent run ${UUID})`).text, "stopped (agent run)");
  assert.equal(withoutIds(`superseded by ${UUID}`).text, "superseded by");
  assert.equal(withoutIds("pull request merged").text, "pull request merged");
  const [header] = activityOf([transition("VERIFYING", "REPAIRING", `verification ${UUID} found 2 issues`)], false) as [StageHeader];
  assert.doesNotMatch(header.reason!, /[0-9a-f]{8}-[0-9a-f]{4}/);
  assert.match(header.title, new RegExp(UUID), "the whole reason is kept for the title");
});

test("earlier stages fold behind one line, keeping the newest two", () => {
  const items = activityOf(
    [transition("CREATED", "CLASSIFYING"), transition("CLASSIFYING", "PLANNING"), transition("PLANNING", "PROVISIONING"), transition("PROVISIONING", "IMPLEMENTING"), agent({ type: "started" })],
    true,
  );
  const { earlier, recent } = splitEarlier(items);
  assert.equal(earlier.length, 2);
  assert.deepEqual(
    recent.map((i) => i.kind),
    ["stage", "stage", "turn"],
  );
  assert.equal(earlier.length + recent.length, items.length, "nothing is dropped");
  assert.deepEqual(splitEarlier(items.slice(0, 2)).earlier, []);
});

test("a turn still running is never folded away with the earlier stages", () => {
  const items = activityOf(
    [transition("PROVISIONING", "IMPLEMENTING"), agent({ type: "started" }, "ar-9"), transition("IMPLEMENTING", "VERIFYING"), transition("VERIFYING", "REPAIRING"), transition("REPAIRING", "VERIFYING")],
    true,
  );
  const { earlier, recent } = splitEarlier(items);
  assert.equal(earlier.length, 1, "only the header before the running turn");
  assert.equal(recent[0]!.kind, "turn");
});
