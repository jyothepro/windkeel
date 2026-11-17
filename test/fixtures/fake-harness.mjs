#!/usr/bin/env node
/**
 * A fake maker harness for the conformance suite (#395, ADR-0027 §3): it stands in for `codex` or
 * `claude` inside a `FakeSandboxProvider` sandbox, replays a recorded JSONL fixture to stdout and
 * records exactly what it was given, so the suite can assert on the adapter's argv, environment and
 * stdin without a real CLI.
 *
 *     node fake-harness.mjs <state-dir> [harness argv…]
 *
 * `<state-dir>` holds `config.json` (`{ versionLine, mode }`), `stream-<n>.jsonl` per turn
 * (falling back to `stream-1.jsonl`), and optionally `write-<n>.json` — `{ path: contents }` files the
 * turn writes into its working directory, so the workspace can disagree with what the stream claims.
 * Each invocation appends `{ argv, env, stdin, cwd }` to `invocations.jsonl`. `mode: "hang"` keeps
 * the process alive after replaying, for `cancel()`.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const [, , stateDir, ...argv] = process.argv;
const config = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));

if (argv[0] === "--version") {
  process.stdout.write(`${config.versionLine}\n`);
  process.exit(0);
}

let stdin = "";
try {
  stdin = readFileSync(0, "utf8");
} catch {
  stdin = "";
}

appendFileSync(
  join(stateDir, "invocations.jsonl"),
  `${JSON.stringify({ argv, env: process.env, stdin, cwd: process.cwd() })}\n`,
);

const turnFile = join(stateDir, "turn");
const turn = (existsSync(turnFile) ? Number(readFileSync(turnFile, "utf8")) : 0) + 1;
writeFileSync(turnFile, String(turn));

const writes = join(stateDir, `write-${turn}.json`);
if (existsSync(writes)) {
  for (const [path, contents] of Object.entries(JSON.parse(readFileSync(writes, "utf8")))) {
    const target = isAbsolute(path) ? path : join(process.cwd(), path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

const streamFile = existsSync(join(stateDir, `stream-${turn}.jsonl`))
  ? join(stateDir, `stream-${turn}.jsonl`)
  : join(stateDir, "stream-1.jsonl");
const lines = readFileSync(streamFile, "utf8").split("\n");
// The fixture's last line is written without its newline when the fixture has none: a torn tail.
const torn = !readFileSync(streamFile, "utf8").endsWith("\n");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const [index, line] of lines.entries()) {
  if (line === "" && index === lines.length - 1) break;
  process.stdout.write(index === lines.length - 1 && torn ? line : `${line}\n`);
  await sleep(10);
}
if (config.mode === "hang") await sleep(120_000);
process.exit(0);
