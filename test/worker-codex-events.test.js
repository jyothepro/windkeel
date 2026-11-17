import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexEventNormalizer, COMMAND_OUTPUT_LIMIT, normalizeCodexStream } from "../dist/worker/codex/events.js";
import { codexFixture } from "./helpers.js";

/** Feeds fixture text through the streaming entry point the way the adapter does. */
async function normalizeFixture(name, options = {}) {
  const text = codexFixture(name);
  async function* lines() {
    for (const line of text.split("\n")) yield line;
  }
  const events = [];
  for await (const event of normalizeCodexStream(lines(), options)) events.push(event);
  return events;
}

test("a complete successful session normalizes to the expected event sequence", async () => {
  const events = await normalizeFixture("successful-session");
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "started",
      "thinking",
      "command_started",
      "command_finished",
      "file_changed",
      "file_changed",
      "test_started",
      "test_finished",
      "message",
      "completed",
    ],
  );
  assert.equal(events[0].sessionId, "01JQ8Z9Y2K3M4N5P6Q7R8S9T0V");
  assert.match(events[1].text, /off-by-one|one element short/);
  assert.deepEqual(
    events.filter((e) => e.type === "file_changed").map((e) => [e.path, e.kind]),
    [
      ["src/pager.ts", "update"],
      ["test/pager.test.js", "add"],
    ],
  );
  assert.equal(events[8].text, "Fixed the off-by-one in the pager and added a regression test.");
});

test("thread.started and turn.started yield exactly one `started`", async () => {
  const events = await normalizeFixture("successful-session");
  assert.equal(events.filter((e) => e.type === "started").length, 1);
});

test("a resumed stream with no thread.started still opens with `started`", () => {
  const normalizer = new CodexEventNormalizer();
  assert.deepEqual(normalizer.normalize({ type: "turn.started" }), [{ type: "started" }]);
});

test("a command_execution item carries its command and exit code through", async () => {
  const events = await normalizeFixture("successful-session");
  assert.deepEqual(
    events.filter((e) => e.type === "command_started").map((e) => e.command),
    ["npm ci"],
  );
  assert.deepEqual(
    events.filter((e) => e.type === "command_finished").map((e) => [e.command, e.exitCode]),
    [["npm ci", 0]],
  );
});

test("`npm test` in the same fixture becomes a test pair, not a command pair", async () => {
  const events = await normalizeFixture("successful-session");
  const finished = events.find((e) => e.type === "test_finished");
  assert.equal(events.find((e) => e.type === "test_started").command, "npm test");
  assert.deepEqual([finished.command, finished.exitCode, finished.passed], ["npm test", 0, true]);
});

test("token usage from turn.completed rides on the normalized `completed` event", async () => {
  const events = await normalizeFixture("successful-session");
  const completed = events.at(-1);
  assert.equal(completed.type, "completed");
  assert.deepEqual(completed.usage, {
    inputTokens: 12400,
    cachedInputTokens: 8000,
    outputTokens: 980,
    reasoningOutputTokens: 420,
    totalTokens: 13380,
  });
});

test("a turn.failed fixture produces `failed` with the provider's message", async () => {
  const events = await normalizeFixture("failed-turn");
  const failed = events.at(-1);
  assert.equal(failed.type, "failed");
  assert.match(failed.error, /429/);
  // The failing command before it is still reported, exit code intact.
  const finished = events.find((e) => e.type === "command_finished");
  assert.equal(finished.exitCode, 1);
});

test("a bare `error` event also normalizes to `failed`", () => {
  const normalizer = new CodexEventNormalizer();
  assert.deepEqual(normalizer.normalize({ type: "error", message: "stream closed" }), [
    { type: "failed", error: "stream closed" },
  ]);
});

test("a malformed line mid-stream does not abort the run", async () => {
  const diagnostics = [];
  const events = await normalizeFixture("malformed-and-unknown", {
    onDiagnostic: (d) => diagnostics.push(d),
  });
  // Events after the bad line still arrive.
  assert.deepEqual(
    events.map((e) => e.type),
    ["started", "message", "completed"],
  );
  assert.ok(diagnostics.some((d) => d.kind === "malformed_line"));
});

test("a truncated final line — the expected shape of a killed run — is skipped", async () => {
  const diagnostics = [];
  const events = await normalizeFixture("malformed-and-unknown", {
    onDiagnostic: (d) => diagnostics.push(d),
  });
  assert.ok(
    !events.some((e) => e.type === "failed"),
    "a truncated line must not be reported as a worker failure",
  );
  assert.ok(diagnostics.filter((d) => d.kind === "malformed_line").length >= 2);
});

test("unknown event and item types are ignored, but reported as diagnostics", async () => {
  const diagnostics = [];
  await normalizeFixture("malformed-and-unknown", { onDiagnostic: (d) => diagnostics.push(d) });
  assert.ok(
    diagnostics.some(
      (d) => d.kind === "unknown_item_type" && d.detail.includes("holographic_thought"),
    ),
  );
  assert.ok(
    diagnostics.some(
      (d) => d.kind === "unknown_event_type" && d.detail.includes("quantum.entangled"),
    ),
  );
});

test("known-but-unmapped item types are dropped without a drift diagnostic", async () => {
  const diagnostics = [];
  await normalizeFixture("malformed-and-unknown", { onDiagnostic: (d) => diagnostics.push(d) });
  assert.ok(!diagnostics.some((d) => d.detail.includes("web_search")));
});

test("an unrecognized schema version is a diagnostic, not a stream failure", () => {
  const diagnostics = [];
  const normalizer = new CodexEventNormalizer({ onDiagnostic: (d) => diagnostics.push(d) });
  const events = normalizer.normalize({
    type: "thread.started",
    thread_id: "t1",
    schema_version: "99",
  });
  assert.deepEqual(events, [{ type: "started", sessionId: "t1" }]);
  assert.equal(diagnostics[0].kind, "unknown_schema_version");
});

test("in-flight reasoning updates do not each become an event", () => {
  const normalizer = new CodexEventNormalizer();
  assert.deepEqual(
    normalizer.normalize({
      type: "item.updated",
      item: { id: "r1", item_type: "reasoning", text: "half a thought" },
    }),
    [],
  );
});

test("an item.completed whose command text is only on item.started still reports it", () => {
  const normalizer = new CodexEventNormalizer();
  normalizer.normalize({
    type: "item.started",
    item: { id: "c1", item_type: "command_execution", command: "go build ./..." },
  });
  assert.deepEqual(
    normalizer.normalize({
      type: "item.completed",
      item: { id: "c1", item_type: "command_execution", exit_code: 2 },
    }),
    [{ type: "command_finished", command: "go build ./...", exitCode: 2 }],
  );
});

test("a completion with no exit code reports null rather than inventing success", () => {
  const normalizer = new CodexEventNormalizer();
  assert.deepEqual(
    normalizer.normalize({
      type: "item.completed",
      item: { id: "c9", item_type: "command_execution", command: "sleep 100" },
    }),
    [{ type: "command_finished", command: "sleep 100", exitCode: null }],
  );
});

test("a finished command keeps the tail of its output, for the console's Terminal tab", () => {
  const normalizer = new CodexEventNormalizer();
  assert.deepEqual(
    normalizer.normalize({
      type: "item.completed",
      item: { id: "o1", item_type: "command_execution", command: "npm ci", exit_code: 0, aggregated_output: "added 210 packages" },
    }),
    [{ type: "command_finished", command: "npm ci", exitCode: 0, output: "added 210 packages" }],
  );
  assert.deepEqual(
    normalizer.normalize({
      type: "item.completed",
      item: { id: "o2", item_type: "command_execution", command: "ls", exit_code: 0, aggregated_output: "" },
    }),
    [{ type: "command_finished", command: "ls", exitCode: 0 }],
    "no output, no field",
  );
  const long = "first line\n" + "x".repeat(10_000) + "\nAssertionError: the last line";
  const [test] = normalizer.normalize({
    type: "item.completed",
    item: { id: "o3", item_type: "command_execution", command: "npm test", exit_code: 1, aggregated_output: long },
  });
  assert.equal(test.type, "test_finished");
  assert.equal(test.output.length, COMMAND_OUTPUT_LIMIT);
  assert.ok(test.output.startsWith("… (earlier output cut)\n"), "a cut is marked");
  assert.ok(test.output.endsWith("AssertionError: the last line"), "the tail is what's kept");
});

test("ORQ-09: a negative, fractional or non-finite token count is not a count", () => {
  // The stream is a file the agent can append to, and these numbers price the spend rail: a
  // negative count would book a turn as a refund and keep the cap from ever tripping.
  const [completed] = new CodexEventNormalizer().normalize({
    type: "turn.completed",
    usage: { input_tokens: -9000000, output_tokens: 1.5, cached_input_tokens: -1, total_tokens: -9000000 },
  });
  assert.equal(completed.type, "completed");
  assert.equal(completed.usage, undefined, "no usable count survives, so no usage is reported");

  const [mixed] = new CodexEventNormalizer().normalize({
    type: "turn.completed",
    usage: { input_tokens: 100, output_tokens: -50 },
  });
  assert.deepEqual(mixed.usage, { inputTokens: 100, totalTokens: 100 });
});
