/**
 * Claude Code's stream-json, normalised (ADR-0027 §3.3, #395 sub-task C). Fixtures are
 * hand-authored (`test/fixtures/claude-code/`); the live proof replaces them with recordings.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readWatermarkedLines } from "../dist/worker/watermark.js";
import { ClaudeCodeEventNormalizer, normalizeClaudeCodeLine } from "../dist/worker/claude-code/events.js";
import { claudeCodeFixture } from "./helpers.js";

function normalize(jsonl) {
  const diagnostics = [];
  const normalizer = new ClaudeCodeEventNormalizer({ onDiagnostic: (d) => diagnostics.push(d) });
  const events = jsonl.split("\n").flatMap((line) => normalizeClaudeCodeLine(normalizer, line, (d) => diagnostics.push(d)));
  return { events, diagnostics, normalizer };
}

test("a successful session maps every block onto the vocabulary, in order", () => {
  const { events, normalizer } = normalize(claudeCodeFixture("successful-session"));
  assert.deepEqual(events.map((e) => e.type), [
    "started",
    "thinking",
    "command_started",
    "command_finished",
    "file_changed",
    "test_started",
    "test_finished",
    "message",
    "completed",
  ]);
  assert.equal(events[0].sessionId, "9f3c1a2e-4b5d-4e6f-8a7b-0c1d2e3f4a5b");
  assert.deepEqual(events[2], { type: "command_started", command: "ls src" });
  assert.equal(events[3].exitCode, 0);
  assert.deepEqual(events[4], { type: "file_changed", path: "/vercel/sandbox/src/pager.js", kind: "update" });
  assert.deepEqual(events[5], { type: "test_started", command: "npm test" }, "Bash tests go through classifyCommand");
  assert.equal(events[6].passed, true);
  assert.equal(events[7].text, "Fixed the off-by-one in the pager and the tests pass.");
  assert.deepEqual(events[8].usage, {
    inputTokens: 20_120,
    cachedInputTokens: 18_000,
    cacheWriteInputTokens: 2_000,
    outputTokens: 640,
    totalTokens: 20_760,
  });
  assert.equal(normalizer.reportedCostUsd, 0.0421, "kept aside for comparison");
});

test("a failed turn: a failing test, a retry as a diagnostic, and one failed", () => {
  const { events, diagnostics } = normalize(claudeCodeFixture("failed-turn"));
  const finished = events.find((e) => e.type === "test_finished");
  assert.equal(finished.exitCode, 1, "Claude Code's `Exit code N` is the exit code");
  assert.equal(finished.passed, false);
  assert.equal(events.filter((e) => e.type === "failed").length, 1);
  assert.match(events.at(-1).error, /error_during_execution/);
  assert.ok(diagnostics.some((d) => d.kind === "api_retry" && /529/.test(d.detail)), "api_retry is a diagnostic, never passthrough");
  assert.ok(!events.some((e) => e.type === "completed"));
});

test("malformed lines and unknown types are dropped with diagnostics; a torn tail is not a failure", () => {
  const { events, diagnostics } = normalize(claudeCodeFixture("malformed-and-unknown"));
  assert.deepEqual(events.map((e) => e.type), ["started", "message", "completed"]);
  const kinds = diagnostics.map((d) => d.kind);
  assert.ok(kinds.includes("malformed_line"));
  assert.ok(kinds.includes("unknown_event_type"));
  assert.ok(kinds.includes("permission_denied"));
});

test("a stream read mid-line is resumed at the watermark without losing or doubling an event", () => {
  const jsonl = claudeCodeFixture("successful-session");
  const cut = jsonl.indexOf('"type":"result"') + 10;
  const normalizer = new ClaudeCodeEventNormalizer();
  const first = readWatermarkedLines(Buffer.from(jsonl.slice(0, cut)), 0);
  const early = first.lines.flatMap((line) => normalizeClaudeCodeLine(normalizer, line));
  assert.ok(!early.some((e) => e.type === "completed"), "the torn result line is not consumed");
  const rest = readWatermarkedLines(Buffer.from(jsonl), first.watermark);
  const late = rest.lines.flatMap((line) => normalizeClaudeCodeLine(normalizer, line));
  assert.equal([...early, ...late].filter((e) => e.type === "completed").length, 1);
});

test("two result lines are one terminal event; usage merges upward and a later failure still fails the turn", () => {
  const ok = '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":10,"cache_read_input_tokens":500,"output_tokens":5}}';
  const forged = '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":1,"cache_read_input_tokens":900,"output_tokens":1}}';
  const { events, normalizer, diagnostics } = normalize([ok, forged].join("\n"));
  assert.equal(events.filter((e) => e.type === "completed" || e.type === "failed").length, 1);
  assert.ok(diagnostics.some((d) => d.kind === "duplicate_result"));
  // The larger of every count, the smaller cached-read count: a forged line can only raise the bill.
  assert.deepEqual(normalizer.usage, { inputTokens: 901, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 5, totalTokens: 902 }, "a forged line cannot understate the turn");

  const failing = '{"type":"result","subtype":"error_max_turns","is_error":true}';
  const after = normalize([ok, failing].join("\n"));
  assert.equal(after.events.filter((e) => e.type === "completed" || e.type === "failed").length, 1);
  assert.equal(after.normalizer.verdict.kind, "failed", "a failure in any result line fails the turn");
});

test("an OAuth or claude.ai auth source is refused; only an API key is accepted", () => {
  const { events, normalizer } = normalize(claudeCodeFixture("oauth-auth-source"));
  assert.equal(events[0].type, "started");
  assert.equal(events[1].type, "failed");
  assert.match(events[1].error, /auth source "none".*API key only/);
  assert.equal(normalizer.authRefused, true);
  assert.equal(events.filter((e) => e.type === "completed" || e.type === "failed").length, 1, "the later success is not a second verdict");
  assert.equal(normalizer.verdict.kind, "failed");

  for (const source of ["/login managed key", "claude.ai", "oauth"]) {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "s", apiKeySource: source });
    assert.equal(normalize(line).events[1]?.type, "failed", source);
  }
  const unreported = normalize(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }));
  assert.deepEqual(unreported.events.map((e) => e.type), ["started"]);
  assert.ok(unreported.diagnostics.some((d) => d.kind === "auth_source_unreported"));
});

test("Write is a file change without a claimed kind; an is_error result is failed even with subtype success", () => {
  const { events } = normalize(claudeCodeFixture("resumed-turn"));
  assert.deepEqual(events.find((e) => e.type === "file_changed"), { type: "file_changed", path: "/vercel/sandbox/src/pager.edge.test.js" });
  const apiError = normalize('{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Fix external API key"}');
  assert.equal(apiError.events[0].type, "failed");
  assert.match(apiError.events[0].error, /Invalid API key/);
});
