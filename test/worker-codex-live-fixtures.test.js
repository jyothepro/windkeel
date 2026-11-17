import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PINNED_CODEX_VERSION, parseCodexVersion } from "../dist/worker/codex/adapter.js";
import { normalizeCodexStream } from "../dist/worker/codex/events.js";
import { auditCodexTranscript, findCredentials } from "../dist/worker/codex/transcript.js";
import { codexFixture, repoRoot, tempDir } from "./helpers.js";

/**
 * Real `codex exec --json` transcripts as fixtures (#386 sub-task A, the leftover of #116).
 *
 * `test/fixtures/codex/live-*.jsonl` are captured from live runs with `windkeel capture` and imported
 * with `test/tools/import-codex-capture.mjs`; `live-sources.json` records which run and turn each
 * came from. Until the operator has captured them there are none, and the per-fixture tests below
 * report themselves skipped with the reason — never passing over nothing. The auditor they rely on
 * is tested here against the hand-authored fixtures either way.
 */

const FIXTURES = join(repoRoot, "test", "fixtures", "codex");
const sources = JSON.parse(readFileSync(join(FIXTURES, "live-sources.json"), "utf8"));
const live = readdirSync(FIXTURES)
  .filter((f) => /^live-.+\.jsonl$/.test(f))
  .map((f) => f.slice(0, -".jsonl".length))
  .sort();

async function streamed(text) {
  async function* lines() {
    for (const line of text.split("\n")) yield line;
  }
  const events = [];
  for await (const event of normalizeCodexStream(lines())) events.push(event);
  return events;
}

/** `turn.completed`'s keys, as the normalizer is documented to map them. */
const USAGE_KEYS = {
  input_tokens: "inputTokens",
  cached_input_tokens: "cachedInputTokens",
  output_tokens: "outputTokens",
  reasoning_output_tokens: "reasoningOutputTokens",
  total_tokens: "totalTokens",
};

// --- the auditor ---------------------------------------------------------------------------------

test("the auditor reads a clean session: no diagnostics, its ending, its usage as Codex spelled it", () => {
  const audit = auditCodexTranscript(codexFixture("successful-session"));
  assert.deepEqual(audit.unexpectedDiagnostics, []);
  assert.equal(audit.ending, "completed");
  assert.equal(audit.truncatedTail, false);
  assert.deepEqual(audit.itemKinds, ["assistant_message", "command_execution", "file_change", "reasoning"]);
  assert.deepEqual(audit.rawFinalUsage, { input_tokens: 12400, cached_input_tokens: 8000, output_tokens: 980, reasoning_output_tokens: 420 });
  assert.equal(audit.finalUsage.inputTokens, 12400);
  assert.deepEqual(audit.credentials, []);
});

test("the auditor tolerates a torn final line — a killed process's shape — and nothing else", () => {
  const torn = `${codexFixture("successful-session").trimEnd().split("\n").slice(0, 6).join("\n")}\n{"type":"item.comple`;
  const audit = auditCodexTranscript(torn);
  assert.equal(audit.truncatedTail, true);
  assert.equal(audit.diagnostics.length, 1);
  assert.deepEqual(audit.unexpectedDiagnostics, [], "the torn tail is expected");
  assert.equal(audit.ending, "none", "a cancelled turn never reports completed");

  const unknown = auditCodexTranscript(codexFixture("malformed-and-unknown"));
  assert.ok(unknown.unexpectedDiagnostics.length > 0, "unknown types and mid-stream garbage stay visible");
});

test("the auditor finds credential-shaped strings by line, without echoing them", () => {
  const text = [
    '{"type":"item.completed","item":{"item_type":"assistant_message","text":"the token is fine"}}',
    `{"type":"item.completed","item":{"item_type":"command_execution","command":"env","aggregated_output":"OPENAI_API_KEY=sk-proj-${"a".repeat(30)}"}}`,
    `{"x":"ghs_${"b".repeat(36)}"}`,
  ].join("\n");
  const findings = findCredentials(text);
  assert.deepEqual(findings, [
    { line: 2, kind: "model key (sk-…)" },
    { line: 3, kind: "GitHub token" },
  ]);
  assert.ok(!JSON.stringify(findings).includes("aaaa"));
});

test("parseCodexVersion reads `codex --version` output the way the adapter does", () => {
  assert.equal(parseCodexVersion("codex-cli 0.154.0\n"), "0.154.0");
  assert.equal(parseCodexVersion("0.154.0"), "0.154.0");
  assert.equal(parseCodexVersion("codex-cli 0.155.0-alpha.2"), "0.155.0-alpha.2");
});

// --- the importer ------------------------------------------------------------------------------

function fakeCapture(transcript, ref = {}) {
  const capture = tempDir("codex-capture");
  mkdirSync(join(capture, "sandbox"), { recursive: true });
  writeFileSync(join(capture, "sandbox", "turn-1.events.jsonl"), transcript);
  writeFileSync(
    join(capture, "session-ref.json"),
    JSON.stringify({ engineeringRunId: "run-123", workerSessionId: "thread-1", adapterState: { codexVersion: "0.154.0" }, capturedAt: "2026-10-21T00:00:00Z", ...ref }),
  );
  const fixtures = tempDir("codex-fixtures");
  writeFileSync(join(fixtures, "live-sources.json"), JSON.stringify({ fixtures: {} }));
  return { capture, fixtures };
}

const importer = (args) =>
  spawnSync(process.execPath, [join(repoRoot, "test", "tools", "import-codex-capture.mjs"), ...args], { encoding: "utf8" });

test("the importer writes the fixture and its provenance from the capture", () => {
  const { capture, fixtures } = fakeCapture(codexFixture("successful-session"));
  const result = importer(["--capture", capture, "--name", "live-successful-session", "--outcome", "completed", "--expect", "started,completed", "--fixtures", fixtures]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /normalizer: no diagnostics/);
  assert.equal(readFileSync(join(fixtures, "live-successful-session.jsonl"), "utf8"), codexFixture("successful-session"));
  const entry = JSON.parse(readFileSync(join(fixtures, "live-sources.json"), "utf8")).fixtures["live-successful-session"];
  assert.deepEqual(entry, {
    run_id: "run-123",
    turn: 1,
    worker_session_id: "thread-1",
    codex_version: "0.154.0",
    outcome: "completed",
    captured_at: "2026-10-21T00:00:00Z",
    expect_events: ["started", "completed"],
  });
});

test("the importer refuses a transcript with a credential in it, and writes nothing", () => {
  const { capture, fixtures } = fakeCapture(`{"type":"thread.started","thread_id":"t"}\n{"leak":"ghp_${"c".repeat(36)}"}\n`);
  const result = importer(["--capture", capture, "--name", "live-leaky", "--outcome", "completed", "--fixtures", fixtures]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refused: credential-shaped strings on line\(s\) 2 \(GitHub token\)/);
  assert.ok(!readdirSync(fixtures).includes("live-leaky.jsonl"));
});

// --- the live fixtures themselves ---------------------------------------------------------------------

test("every live fixture has provenance, and every provenance entry has its fixture", () => {
  assert.deepEqual(Object.keys(sources.fixtures).sort(), live);
});

const NONE_YET = "no live Codex captures committed yet — #386 sub-task A, an operator step (docs/running-the-factory.md, 'Capturing Codex fixtures')";

if (live.length === 0) {
  test("live fixtures normalize with no unknown diagnostics", { skip: NONE_YET }, () => {});
}

for (const name of live) {
  const provenance = sources.fixtures[name] ?? {};
  const text = readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8");

  test(`${name}: cites a live run and the pinned Codex version`, () => {
    assert.match(String(provenance.run_id ?? ""), /^[0-9a-f-]{36}$/, "the run id it was captured from");
    assert.equal(
      parseCodexVersion(String(provenance.codex_version ?? "")),
      PINNED_CODEX_VERSION,
      "PINNED_CODEX_VERSION is the version this transcript was produced by; update one or the other",
    );
  });

  test(`${name}: carries no credential`, () => {
    assert.deepEqual(findCredentials(text), []);
  });

  test(`${name}: the normalizer understands every line (no unknown item kinds, no unexpected diagnostics)`, () => {
    const audit = auditCodexTranscript(text);
    assert.deepEqual(audit.unexpectedDiagnostics, [], `item kinds seen: ${audit.itemKinds.join(", ")}`);
  });

  test(`${name}: the streaming entry point yields what the auditor saw, including the expected events`, async () => {
    const audit = auditCodexTranscript(text);
    const events = await streamed(text);
    assert.deepEqual(events, audit.events);
    for (const type of provenance.expect_events ?? []) {
      assert.ok(events.some((e) => e.type === type), `expected a ${type} event; got ${[...new Set(events.map((e) => e.type))].join(", ")}`);
    }
  });

  test(`${name}: ends the way the run did`, () => {
    const audit = auditCodexTranscript(text);
    if (provenance.outcome === "completed") {
      assert.equal(audit.ending, "completed");
    } else if (provenance.outcome === "cancelled") {
      // The adapter, which did the killing, reports `cancelled`; the stream itself never completes.
      assert.notEqual(audit.ending, "completed");
    } else {
      assert.equal(audit.ending, "failed");
    }
  });

  if (provenance.outcome === "completed") {
    test(`${name}: usage on \`completed\` is the transcript's final usage line, key for key`, () => {
      const audit = auditCodexTranscript(text);
      assert.ok(audit.rawFinalUsage, "a completed turn reports usage");
      for (const [raw, value] of Object.entries(audit.rawFinalUsage)) {
        const key = USAGE_KEYS[raw];
        assert.ok(key, `Codex reports a usage key the normalizer does not read: ${raw}`);
        assert.equal(audit.finalUsage[key], value, raw);
      }
    });
  }
}
