/**
 * The deployed control plane's narration.
 *
 * `buildStageDeps` defaults its logger to `() => {}`, and `deployed-runner.ts` did not pass one
 * — so on Vercel every line the factory wrote about itself was discarded, `codex diagnostic`
 * included. Nothing fails when a log is dropped, which is exactly why it went unnoticed: the
 * only symptom is that a misbehaving deployed run leaves no account of itself beyond what
 * reached the database.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deployedLog } from "../dist/factory/workflow/deployed-runner.js";

/** Captures stdout for the duration of `fn`, because that is where Vercel reads logs from. */
function captureStdout(fn) {
  const written = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return written;
}

test("a logged line is one JSON object, with the message and the caller's fields", () => {
  const written = captureStdout(() => deployedLog("codex diagnostic", { runId: "r-1", kind: "recovered_error" }));

  assert.equal(written.length, 1);
  assert.ok(written[0].endsWith("\n"), "one line per record, so interleaved runs stay parseable");

  const record = JSON.parse(written[0]);
  assert.equal(record.message, "codex diagnostic");
  assert.equal(record.runId, "r-1");
  assert.equal(record.kind, "recovered_error");
  assert.equal(record.src, "windkeel");
  assert.ok(!Number.isNaN(Date.parse(record.at)), "every line is timestamped");
});

test("a field that cannot be serialised loses the field, never the line", () => {
  const cyclic = { name: "sandbox" };
  cyclic.self = cyclic;

  const written = captureStdout(() => deployedLog("workspace ready", { cyclic }));

  // The substance: the run is still told about, even though the field was unloggable.
  assert.equal(written.length, 1);
  assert.equal(JSON.parse(written[0]).message, "workspace ready");
});

test("logging never throws, because a logger that can fail can end a run", () => {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => {
    throw new Error("stdout is gone");
  };
  try {
    assert.doesNotThrow(() => deployedLog("anything", { a: 1 }));
  } finally {
    process.stdout.write = original;
  }
});
