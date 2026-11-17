import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeWorkerAdapter } from "../dist/worker/fake.js";

const SUCCESSFUL_STREAM = [
  { type: "started", sessionId: "thread-abc123" },
  { type: "thinking", text: "reading the failing test" },
  { type: "command_started", command: "npm ci" },
  { type: "command_finished", command: "npm ci", exitCode: 0 },
  { type: "file_changed", path: "src/index.ts", kind: "update" },
  { type: "message", text: "Fixed the off-by-one in the pager." },
  { type: "completed", usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 } },
];

const startInput = { prompt: "fix the pager off-by-one", sandbox: /** @type {any} */ ({}) };

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("replays a recorded stream in order through events()", async () => {
  const adapter = new FakeWorkerAdapter(SUCCESSFUL_STREAM);
  const session = await adapter.start(startInput);
  const events = await collect(adapter.events(session));
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "started",
      "thinking",
      "command_started",
      "command_finished",
      "file_changed",
      "message",
      "completed",
    ],
  );
  assert.equal(events[3].exitCode, 0);
});

test("a JSONL recording is equivalent to an event array", async () => {
  const jsonl = SUCCESSFUL_STREAM.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const adapter = new FakeWorkerAdapter(jsonl);
  const session = await adapter.start(startInput);
  assert.deepEqual(await collect(adapter.events(session)), SUCCESSFUL_STREAM);
});

test("a malformed JSONL recording is rejected at construction, not mid-replay", () => {
  assert.throws(
    () => new FakeWorkerAdapter('{"type":"started"}\nnot json\n'),
    /line 2 is not valid JSON/,
  );
});

test("result() returns the recorded completion outcome", async () => {
  const adapter = new FakeWorkerAdapter(SUCCESSFUL_STREAM);
  const session = await adapter.start(startInput);
  await collect(adapter.events(session));
  const result = await adapter.result(session);
  assert.equal(result.outcome, "completed");
  assert.equal(result.usage.totalTokens, 1540);
  assert.equal(result.finalMessage, "Fixed the off-by-one in the pager.");
  assert.deepEqual(result.diff, { patch: "", filesChanged: [], truncated: false });
});

test("the worker's own session id is captured onto the session", async () => {
  const adapter = new FakeWorkerAdapter(SUCCESSFUL_STREAM);
  const session = await adapter.start(startInput);
  assert.equal(session.workerSessionId, "thread-abc123");
});

test("cancel() mid-stream stops event delivery and is visible in the call timeline", async () => {
  const adapter = new FakeWorkerAdapter(SUCCESSFUL_STREAM);
  const session = await adapter.start(startInput);

  const delivered = [];
  for await (const event of adapter.events(session)) {
    delivered.push(event);
    if (delivered.length === 2) await adapter.cancel(session);
  }

  assert.equal(delivered.length, 2);
  const cancelIndex = adapter.calls.findIndex((c) => c.type === "cancel");
  assert.ok(cancelIndex > 0, "cancel is recorded in the timeline");
  assert.ok(
    adapter.calls.slice(cancelIndex).every((c) => c.type !== "event"),
    "no event was delivered after cancel",
  );

  const result = await adapter.result(session);
  assert.equal(result.outcome, "cancelled");
});

test("a recording ending in `failed` surfaces as a failed result, not a thrown error", async () => {
  const adapter = new FakeWorkerAdapter([
    { type: "started" },
    { type: "command_started", command: "npm test" },
    { type: "failed", error: "model provider returned 429" },
  ]);
  const session = await adapter.start(startInput);
  await collect(adapter.events(session));
  const result = await adapter.result(session);
  assert.equal(result.outcome, "failed");
  assert.match(result.error, /429/);
});

test("send() refuses rather than pretending a resume happened", async () => {
  const adapter = new FakeWorkerAdapter(SUCCESSFUL_STREAM);
  const session = await adapter.start(startInput);
  assert.equal(adapter.capabilities.resumableSessions, false);
  await assert.rejects(() => adapter.send(session, { text: "try again" }), /cannot resume/);
});
