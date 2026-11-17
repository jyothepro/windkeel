#!/usr/bin/env node
/**
 * Turns one turn of a live `windkeel capture` into a Codex fixture (#386 sub-task A, #116).
 *
 *   npm run build
 *   node test/tools/import-codex-capture.mjs \
 *     --capture .windkeel/capture/<run-id> --turn 1 \
 *     --name live-successful-session --outcome completed \
 *     --expect started,file_changed,test_finished,completed
 *
 * `--codex-version` defaults to the version the adapter verified in the sandbox, which the capture's
 * `session-ref.json` carries.
 *
 * Reads `<capture>/sandbox/turn-<N>.events.jsonl` and `<capture>/session-ref.json`, audits the
 * transcript with the same function the suite uses (`dist/worker/codex/transcript.js`), and:
 *
 * - **refuses** — writes nothing, exits 1 — when it finds a credential-shaped string. Scrub the
 *   capture by hand and run it again; this tool never edits a transcript, because a fixture that
 *   was silently rewritten is no longer a recording of what Codex printed;
 * - otherwise writes `test/fixtures/codex/<name>.jsonl` and its provenance entry in
 *   `test/fixtures/codex/live-sources.json` (run id, turn, Codex version, outcome, capture time);
 * - prints any normalizer diagnostic. Those are not a reason to refuse: they are the drift the
 *   capture exists to find, and `test/worker-codex-live-fixtures.test.js` fails on them until the
 *   normalizer (`src/worker/codex/events.ts`) is fixed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { auditCodexTranscript } = await import(join(root, "dist", "worker", "codex", "transcript.js"));

const { values } = parseArgs({
  options: {
    capture: { type: "string" },
    turn: { type: "string", default: "1" },
    name: { type: "string" },
    outcome: { type: "string" },
    "codex-version": { type: "string" },
    expect: { type: "string", default: "" },
    note: { type: "string", default: "" },
    // Where fixtures go. The repository's own by default; the importer's test points it elsewhere.
    fixtures: { type: "string" },
  },
});

const fail = (message) => {
  process.stderr.write(`import-codex-capture: ${message}\n`);
  process.exit(1);
};

if (!values.capture || !values.name || !values.outcome) {
  fail("needs --capture <dir> --name live-<what> --outcome completed|cancelled|failed [--codex-version <codex --version output>]");
}
if (!/^live-[a-z0-9-]+$/.test(values.name)) fail("--name must look like live-<what>, e.g. live-successful-session");
if (!["completed", "cancelled", "failed"].includes(values.outcome)) fail("--outcome must be completed, cancelled or failed");

const transcriptPath = join(values.capture, "sandbox", `turn-${values.turn}.events.jsonl`);
if (!existsSync(transcriptPath)) fail(`no transcript at ${transcriptPath}`);
const refPath = join(values.capture, "session-ref.json");
const ref = existsSync(refPath) ? JSON.parse(readFileSync(refPath, "utf8")) : {};
if (!ref.engineeringRunId) fail(`no engineeringRunId in ${refPath}: the capture's provenance is missing`);

// The adapter records the version it verified in the sandbox on the session (adapterState); a raw
// `codex --version` line given by hand takes precedence, and is parsed the same way either way.
const codexVersion = (values["codex-version"] ?? ref.adapterState?.codexVersion ?? "").trim();
if (!codexVersion) fail("no Codex version: session-ref.json has none, so pass --codex-version");

const text = readFileSync(transcriptPath, "utf8");
const audit = auditCodexTranscript(text);
if (audit.credentials.length) {
  fail(
    `refused: credential-shaped strings on line(s) ${audit.credentials.map((c) => `${c.line} (${c.kind})`).join(", ")}. ` +
      "Scrub the capture by hand and re-run; nothing was written.",
  );
}

const fixtures = values.fixtures ? resolve(values.fixtures) : join(root, "test", "fixtures", "codex");
writeFileSync(join(fixtures, `${values.name}.jsonl`), text);
const sourcesPath = join(fixtures, "live-sources.json");
const sources = JSON.parse(readFileSync(sourcesPath, "utf8"));
sources.fixtures[values.name] = {
  run_id: ref.engineeringRunId,
  turn: Number(values.turn),
  worker_session_id: ref.workerSessionId ?? null,
  codex_version: codexVersion,
  outcome: values.outcome,
  captured_at: ref.capturedAt ?? null,
  expect_events: values.expect ? values.expect.split(",").map((s) => s.trim()).filter(Boolean) : [],
  ...(values.note ? { note: values.note } : {}),
};
writeFileSync(sourcesPath, `${JSON.stringify(sources, null, 2)}\n`);

process.stdout.write(
  [
    `wrote test/fixtures/codex/${values.name}.jsonl (${text.split("\n").filter(Boolean).length} lines) from run ${ref.engineeringRunId}, turn ${values.turn}`,
    `event types: ${audit.eventTypes.join(", ")}`,
    `item kinds:  ${audit.itemKinds.join(", ")}`,
    `ending:      ${audit.ending}${audit.truncatedTail ? " (torn final line)" : ""}`,
    `final usage: ${JSON.stringify(audit.rawFinalUsage)}`,
    ...(audit.unexpectedDiagnostics.length
      ? [
          "",
          `${audit.unexpectedDiagnostics.length} normalizer diagnostic(s) — fix src/worker/codex/events.ts before committing:`,
          ...audit.unexpectedDiagnostics.map((d) => `  ${d.kind}: ${d.detail}`),
        ]
      : ["normalizer: no diagnostics"]),
    "",
  ].join("\n"),
);
