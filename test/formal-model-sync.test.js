import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TERMINAL_STATES, isLegalTransition } from "../dist/factory/run-state-machine.js";

const spec = readFileSync(new URL("../formal/RunLifecycle.tla", import.meta.url), "utf8");

function definition(name) {
  const match = new RegExp(`^${name} ==\\s*\\{([^}]*)\\}`, "m").exec(spec);
  assert.ok(match, `formal/RunLifecycle.tla defines ${name} as a set literal`);
  return match[1];
}

function stringSet(name) {
  return new Set([...definition(name).matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]));
}

function pairSet(name) {
  return new Set([...definition(name).matchAll(/<<"([A-Z_]+)",\s*"([A-Z_]+)">>/g)].map((m) => `${m[1]}->${m[2]}`));
}

const STATES = stringSet("States");
const TERMINAL = stringSet("Terminal");
const FAILED_ELIGIBLE = stringSet("FailedEligible");
const NAMED = pairSet("NamedPairs");

function modelLegal(from, to, blockedFrom) {
  const nonTerminalExcludingBlocked = !TERMINAL.has(from) && from !== "BLOCKED";
  return (
    NAMED.has(`${from}->${to}`) ||
    (nonTerminalExcludingBlocked && (to === "BLOCKED" || to === "CANCELLED")) ||
    (FAILED_ELIGIBLE.has(from) && to === "FAILED") ||
    (from === "BLOCKED" && to === blockedFrom)
  );
}

test("the model's Legal clause is the shape this test re-implements", () => {
  const legal = /^Legal\(from, to, bf\) ==\n([\s\S]*?)\n\n/m.exec(spec);
  assert.ok(legal);
  assert.equal(
    legal[1].replace(/\s+/g, " ").trim(),
    [
      '\\/ <<from, to>> \\in NamedPairs',
      '\\/ (from \\in NonTerminalExcludingBlocked /\\ to \\in {"BLOCKED", "CANCELLED"})',
      '\\/ (from \\in FailedEligible /\\ to = "FAILED")',
      "\\/ (from = \"BLOCKED\" /\\ to = bf)",
    ].join(" "),
  );
  assert.match(spec, /^NonTerminalExcludingBlocked == States \\ \(Terminal \\cup \{"BLOCKED"\}\)$/m);
});

test("the model has the code's states and terminal states", () => {
  assert.equal(STATES.size, 17);
  assert.deepEqual(TERMINAL, new Set(TERMINAL_STATES));
  for (const s of [...TERMINAL, ...FAILED_ELIGIBLE]) assert.ok(STATES.has(s), s);
  for (const pair of NAMED) for (const s of pair.split("->")) assert.ok(STATES.has(s), s);
});

test("the model's transition table equals run-state-machine.ts for every pair and blockedFrom", () => {
  const mismatches = [];
  for (const from of STATES) {
    for (const to of STATES) {
      for (const blockedFrom of [null, ...STATES]) {
        const code = isLegalTransition(from, to, blockedFrom);
        const model = modelLegal(from, to, blockedFrom);
        if (code !== model) mismatches.push(`${from} -> ${to} (blockedFrom ${blockedFrom}): code ${code}, model ${model}`);
      }
    }
  }
  assert.deepEqual(mismatches, []);
});

test("the model checker runs on every config in formal/", () => {
  const cfg = readFileSync(new URL("../formal/RunLifecycle.cfg", import.meta.url), "utf8");
  for (const name of ["SafetyInvariants", "StepsAreLegal", "TerminalIsAbsorbing", "EventuallyQuiet"]) {
    assert.match(cfg, new RegExp(`\\b${name}\\b`));
    assert.match(spec, new RegExp(`^${name} ==`, "m"));
  }
});
