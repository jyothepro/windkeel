import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureRepo, readJson, runCli, tempDir } from "./helpers.js";

const SCRIPTS = { test: "node -e \"console.log('ok')\"" };

/** A fixture repo with a second commit, so base..head yields a non-empty diff. */
function repoWithDiff() {
  const repo = fixtureRepo(SCRIPTS);
  writeFileSync(join(repo, "src.js"), "export const add = (a, b) => a - b;\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "feat: add()"], { cwd: repo });
  return repo;
}

function scriptedReviewer(response) {
  const path = join(tempDir("reviewer"), "response.json");
  writeFileSync(path, JSON.stringify(response));
  return path;
}

function verifyWithReviewer(response, extraEnv = {}) {
  const repo = repoWithDiff();
  const out = join(tempDir("out"), "evidence");
  const env = { ...extraEnv };
  if (response) env.WINDKEEL_FAKE_REVIEWER = scriptedReviewer(response);
  const result = runCli(["verify", "--repo", repo, "--out", out, "--gate"], { env });
  return { repo, out, result };
}

test("a blocking review finding fails the gate", () => {
  const { out, result } = verifyWithReviewer({
    summary: "add() subtracts",
    findings: [
      {
        id: "F1",
        severity: "blocking",
        category: "correctness",
        claim: "add() returns a - b",
        location: "src.js:1",
        failure_scenario: "add(2, 1) returns 1 instead of 3",
      },
    ],
  });

  assert.equal(result.code, 1);
  const verdict = readJson(out, "verdict.json");
  assert.equal(verdict.verdict, "fail");
  assert.deepEqual(verdict.blocking_findings, ["F1"]);
});

test("only non-blocking findings warn instead of failing", () => {
  const { out, result } = verifyWithReviewer({
    summary: "naming nit",
    findings: [{ id: "F1", severity: "non_blocking", category: "naming", claim: "rename add()" }],
  });

  assert.equal(result.code, 0);
  assert.equal(readJson(out, "verdict.json").verdict, "warn");
});

test("a clean review passes and records reviewer independence metadata", () => {
  const { out, result } = verifyWithReviewer({ summary: "no defects found", findings: [] });

  assert.equal(result.code, 0, result.stderr);
  const review = readJson(out, "evidence/ev-02.json");
  assert.equal(review.stage, "review");
  assert.equal(review.status, "passed");
  assert.equal(review.reviewer.independence.clean_context, true);
  // #241 added the third. The record has to say what the reviewer actually saw: an evidence
  // package that claimed "diff, acceptance criteria" while the reviewer also read the checkout
  // would misdescribe the independence property this field exists to document.
  assert.deepEqual(review.reviewer.independence.inputs, [
    "diff",
    "acceptance criteria",
    "repository context",
  ]);
  assert.match(review.reviewer.independence.posture, /adversarial/);
  assert.equal(readJson(out, "verdict.json").verdict, "pass");
});

/**
 * The semantics corpus case 10 rests on. A reviewer that ran and found nothing has to be
 * distinguishable from one that never ran: if "no findings" collapsed into a skip or a
 * warning, the review-stage false-positive control would be testing nothing.
 */
test("a reviewer that runs and returns nothing is a completed pass, not a skip", () => {
  const { out, result } = verifyWithReviewer({ summary: "no defects found", findings: [] });

  assert.equal(result.code, 0, result.stderr);
  const review = readJson(out, "evidence/ev-02.json");
  assert.equal(review.status, "passed");
  assert.notEqual(review.status, "skipped");
  assert.notEqual(review.status, "warning");
  assert.equal(review.reason, undefined);
  assert.deepEqual(review.findings, []);
  // The reviewer block is the record that a review happened at all.
  assert.ok(review.reviewer.model);
  assert.equal(review.reviewer.independence.clean_context, true);
  assert.equal(readJson(out, "verdict.json").verdict, "pass");
});

/*
 * Behaviour change (gate isolation fix, E): this was `skipped`, which the verdict ignores, so a
 * run with no model key passed on the repo's own checks alone — checks the candidate controls.
 * A diff nobody reviewed is now `warning` evidence, and the verdict warns.
 */
test("no reviewer configured is a warning, not a skip, so the verdict cannot be pass", () => {
  const { out, result } = verifyWithReviewer(null, {
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
  });

  assert.equal(result.code, 0, result.stderr);
  const review = readJson(out, "evidence/ev-02.json");
  assert.equal(review.status, "warning");
  assert.match(review.reason, /^no_reviewer_configured/);
  assert.equal(readJson(out, "verdict.json").verdict, "warn");
  const recomputed = runCli(["verify-package", out, "--gate=warn"]);
  assert.equal(recomputed.code, 1, recomputed.stdout);
});

test("a reviewer from the PR author's own vendor is refused, not silently used", () => {
  const repo = repoWithDiff();
  const out = join(tempDir("out"), "evidence");
  const eventPath = join(tempDir("event"), "event.json");
  writeFileSync(
    eventPath,
    JSON.stringify({
      repository: { full_name: "jyothepro/windkeel" },
      pull_request: {
        number: 7,
        title: "feat: add()",
        body: "",
        head: { sha: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim() },
        base: { sha: spawnSync("git", ["rev-parse", "HEAD~1"], { cwd: repo, encoding: "utf8" }).stdout.trim() },
        user: { login: "codex-cloud[bot]", type: "Bot" },
      },
    }),
  );

  const result = runCli(["verify", "--repo", repo, "--out", out, "--gate"], {
    env: { GITHUB_EVENT_PATH: eventPath, OPENAI_API_KEY: "sk-not-used", ANTHROPIC_API_KEY: "" },
  });

  assert.equal(result.code, 1);
  const review = readJson(out, "evidence/ev-02.json");
  assert.equal(review.status, "failed");
  assert.equal(review.findings[0].severity, "blocking");
  assert.match(review.findings[0].claim, /only configured reviewer vendor \(openai\)/);
});
