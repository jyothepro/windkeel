import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, PAGES, actionItems, buildIndex, matchScore, runCommands, searchCommands } from "./command-search.ts";
import { RUN_STATES, TERMINAL_STATES } from "./run-states.ts";
import type { RepositorySummary, RunSummary, TaskRow } from "./types.ts";

const REPO: RepositorySummary = {
  id: "r1",
  createdAt: "2026-09-01T00:00:00Z",
  fullName: "acme/widgets",
  defaultBranch: "main",
  openRuns: 1,
};

function run(id: string, taskTitle: string, status: RunSummary["status"] = "IMPLEMENTING"): RunSummary {
  return {
    id,
    createdAt: "2026-09-24T00:00:00Z",
    taskId: `t-${id}`,
    taskTitle,
    repositoryId: "r1",
    status,
    terminal: false,
    finalVerdict: null,
    stopReason: null,
    cost: 0,
    spendCapUsd: 25,
    startedAt: null,
    completedAt: null,
    prNumber: status === "PR_READY" ? 92 : null,
    prMergedAt: null,
  };
}

const TASK = {
  id: "t9",
  repositoryId: "r1",
  sourceType: "github_issue",
  sourceReference: "acme/widgets#7",
  title: "Make the gauge read zero when empty",
} as TaskRow;

const INDEX = buildIndex({
  runs: [run("b409263b-0000-0000-0000-000000000000", "Add a greeting", "PR_READY"), run("d9ff6108-0000-0000-0000-000000000000", "Say goodbye")],
  tasks: [TASK],
  repositories: [REPO],
});

test("prefix beats word prefix beats substring beats subsequence, and a miss is zero", () => {
  assert.ok(matchScore("greeting", "gre") > matchScore("add a greeting", "gre"));
  assert.ok(matchScore("add a greeting", "gre") > matchScore("progress", "gre"));
  assert.ok(matchScore("progress", "gre") > matchScore("gauge reading", "grd"));
  assert.equal(matchScore("gauge reading", "grd") > 0, true);
  assert.equal(matchScore("metrics", "xyz"), 0);
});

test("an empty query lists actions, then pages, in order", () => {
  const first = [...ACTIONS, ...PAGES];
  assert.deepEqual(
    searchCommands(INDEX, "", 50).slice(0, first.length).map((i) => i.label),
    first.map((p) => p.label),
  );
  assert.equal(searchCommands(INDEX, "")[0]?.label, "New task");
});

test("a run is found by its task, by the short id the CLI prints, and by its pull request", () => {
  assert.equal(searchCommands(INDEX, "greeting")[0]?.href, "/runs/b409263b-0000-0000-0000-000000000000");
  assert.equal(searchCommands(INDEX, "b409")[0]?.kind, "run");
  assert.equal(searchCommands(INDEX, "#92")[0]?.label, "Add a greeting");
});

test("every word must match, so a second word narrows", () => {
  const both = searchCommands(INDEX, "say goodbye");
  assert.equal(both.length, 1);
  assert.equal(both[0]?.label, "Say goodbye");
  assert.deepEqual(searchCommands(INDEX, "goodbye widgetsx"), []);
});

test("pages answer to the words people use for them", () => {
  assert.equal(searchCommands(INDEX, "file")[0]?.href, "/tasks/new");
  assert.equal(searchCommands(INDEX, "tokens")[0]?.href, "/settings/tokens");
});

test("tasks and repositories are reachable, and every href stays inside the console", () => {
  assert.equal(searchCommands(INDEX, "gauge")[0]?.href, "/tasks/t9");
  assert.equal(searchCommands(INDEX, "acme/widgets")[0]?.kind, "repository");
  for (const item of INDEX) assert.match(item.href, /^\/([a-z]|$)/, `${item.key} must be an internal path`);
});

test("ids from the API are encoded into the path, never trusted as one", () => {
  const [item] = buildIndex({ runs: [run("../../evil", "x")], tasks: [], repositories: [] }).filter((i) => i.kind === "run");
  assert.equal(item?.href, "/runs/..%2F..%2Fevil");
});

test("a run page offers only what its state allows: approve while waiting, run again once ended, cancel until then", () => {
  assert.deepEqual(runCommands("WAITING_FOR_APPROVAL"), ["approve", "cancel"]);
  assert.deepEqual(runCommands("IMPLEMENTING"), ["cancel"]);
  assert.deepEqual(runCommands("FAILED"), ["run_again"]);
  for (const state of RUN_STATES) {
    const commands = runCommands(state);
    assert.equal(commands.includes("cancel"), !TERMINAL_STATES.has(state), state);
    assert.equal(commands.includes("run_again"), TERMINAL_STATES.has(state), state);
  }
});

test("the open run's actions come first, name the run, and stay on its page", () => {
  const items = actionItems({ runId: "r 1", title: "Add a greeting", commands: ["approve", "cancel"] });
  assert.deepEqual(
    items.map((i) => i.label),
    ["Approve criteria", "Cancel run", "New task"],
  );
  assert.equal(items[1]?.command, "cancel");
  assert.equal(items[1]?.detail, "Add a greeting");
  assert.equal(items[1]?.href, "/runs/r%201");
  assert.equal(searchCommands(items, "stop")[0]?.command, "cancel");
  assert.deepEqual(actionItems(null), ACTIONS, "off a run page, nothing acts on a run");
});
