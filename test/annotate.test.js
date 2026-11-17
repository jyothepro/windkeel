import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureRepo, runCli, tempDir } from "./helpers.js";

const SCRIPTS = { test: "node -e \"console.log('ok')\"" };

const REVIEW = {
  summary: "one blocker, one nit",
  findings: [
    {
      id: "F1",
      severity: "blocking",
      category: "correctness",
      claim: "add() overflows for large inputs",
      location: "src.js:1",
      failure_scenario: "add(2**53, 1) returns 2**53",
    },
    {
      id: "F2",
      severity: "non_blocking",
      category: "naming",
      claim: "the parameter names a and b carry no meaning",
    },
  ],
};

function packagedRun() {
  const repo = fixtureRepo(SCRIPTS);
  writeFileSync(join(repo, "src.js"), "export const add = (a, b) => a + b;\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "feat: add()"], { cwd: repo });
  const out = join(tempDir("out"), "evidence");
  const review = join(tempDir("review"), "review.json");
  writeFileSync(review, JSON.stringify(REVIEW));
  runCli(["verify", "--repo", repo, "--out", out], { env: { WINDKEEL_FAKE_REVIEWER: review } });
  return out;
}

test("annotate emits an error per blocking finding and a warning per non-blocking one", () => {
  const out = packagedRun();
  const summaryPath = join(tempDir("summary"), "summary.md");
  writeFileSync(summaryPath, "");

  const result = runCli(["annotate", out], { env: { GITHUB_STEP_SUMMARY: summaryPath } });

  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^::error file=src\.js,line=1,title=windkeel F1 \(correctness\)::/);
  assert.match(lines[0], /add\(\) overflows.* — add\(2\*\*53, 1\) returns 2\*\*53$/);
  assert.match(lines[1], /^::warning title=windkeel F2 \(naming\)::/);

  const summary = readFileSync(summaryPath, "utf8");
  assert.match(summary, /## ❌ Windkeel Gate — FAIL/);
  assert.match(summary, /\| review \| completed_with_findings \|/);
});

test("annotate on a directory that is not a package is a usage error", () => {
  const result = runCli(["annotate", tempDir("empty")]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /not an evidence package/);
});
