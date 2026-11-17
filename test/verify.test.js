import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureRepo, readJson, runCli, tempDir } from "./helpers.js";

const PASSING_SCRIPTS = { typecheck: "node -e \"console.log('0 errors')\"", test: "node -e \"console.log('2 passing')\"" };
const FAILING_SCRIPTS = { test: "node -e \"console.error('1 failing'); process.exit(1)\"" };

function verifyFixture(scripts, extraArgs = []) {
  const repo = fixtureRepo(scripts);
  const out = join(tempDir("out"), "evidence");
  const result = runCli(["verify", "--repo", repo, "--out", out, ...extraArgs]);
  return { repo, out, result };
}

test("verify writes the four spine files and a pass verdict when the repo's checks pass", () => {
  const { out, result } = verifyFixture(PASSING_SCRIPTS);

  assert.equal(result.code, 0, result.stderr);
  for (const file of ["manifest.json", "intent.json", "mapping.json", "verdict.json", "hashes.json"]) {
    assert.ok(existsSync(join(out, file)), `expected ${file}`);
  }
  const manifest = readJson(out, "manifest.json");
  assert.equal(manifest.format, "dev.orqon.evidence/v0");
  assert.deepEqual(manifest.pipeline, ["checks", "review", "intent", "security", "browser"]);
  assert.equal(readJson(out, "verdict.json").verdict, "pass");
});

test("each repo check is evidence with a transcript, and stages that did not run say why", () => {
  const { out } = verifyFixture(PASSING_SCRIPTS);

  const evidence = ["ev-01", "ev-02", "ev-03", "ev-04", "ev-05"].map((id) =>
    readJson(out, `evidence/${id}.json`),
  );
  const checks = evidence.filter((e) => e.stage === "checks");
  assert.equal(checks.length, 2);
  for (const check of checks) {
    assert.equal(check.status, "passed");
    assert.equal(check.producer.exit_code, 0);
    assert.ok(existsSync(join(out, check.transcript)));
  }
  const skipped = evidence.filter((e) => e.status === "skipped");
  assert.deepEqual(
    skipped.map((e) => e.stage).sort(),
    ["browser", "review", "security"],
  );
  for (const item of skipped) {
    assert.match(item.reason, /^(no_reviewer_configured|no_scanner_available|no_flows_declared|empty_diff)/);
  }
});

test("a failing repo check produces a blocking finding and a fail verdict, and --gate exits 1", () => {
  const { out, result } = verifyFixture(FAILING_SCRIPTS, ["--gate"]);

  assert.equal(result.code, 1);
  const verdict = readJson(out, "verdict.json");
  assert.equal(verdict.verdict, "fail");
  assert.deepEqual(verdict.blocking_findings, ["F-tests"]);
  const evidence = readJson(out, "evidence/ev-01.json");
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.findings[0].severity, "blocking");
});

test("verify without --gate reports a fail verdict but exits 0", () => {
  const { result } = verifyFixture(FAILING_SCRIPTS);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /verdict: FAIL/);
});

test("acceptance criteria are extracted from the PR description and linked issue", () => {
  const repo = fixtureRepo(PASSING_SCRIPTS);
  const out = join(tempDir("out"), "evidence");
  const prBody = join(tempDir("body"), "pr.md");
  const issueBody = join(tempDir("body"), "issue.md");
  writeFileSync(prBody, "## Summary\n\nStuff.\n\n- [ ] exits non-zero on blocking findings\n- [x] no new runtime dependencies\n");
  writeFileSync(issueBody, "## Acceptance criteria\n\n- the manifest schema validates all fixtures\n\n## Notes\n\n- unrelated bullet\n");

  const result = runCli([
    "verify", "--repo", repo, "--out", out, "--pr-body", prBody, "--issue-body", issueBody,
  ]);

  assert.equal(result.code, 0, result.stderr);
  const intent = readJson(out, "intent.json");
  assert.deepEqual(
    intent.criteria.map((c) => [c.id, c.text, c.source.kind]),
    [
      ["AC1", "exits non-zero on blocking findings", "pr_description"],
      ["AC2", "no new runtime dependencies", "pr_description"],
      ["AC3", "the manifest schema validates all fixtures", "linked_issue"],
    ],
  );
});

test("provenance names the authoring agent from the GitHub event payload", () => {
  const repo = fixtureRepo(PASSING_SCRIPTS);
  const out = join(tempDir("out"), "evidence");
  const eventPath = join(tempDir("event"), "event.json");
  writeFileSync(
    eventPath,
    JSON.stringify({
      repository: { full_name: "jyothepro/windkeel" },
      pull_request: {
        number: 12,
        title: "evidence: add manifest schema",
        body: "- [ ] criterion from the event payload",
        head: { sha: "9f3c2a1d8e4b7c6a5f0e1d2c3b4a5968778899aa" },
        base: { sha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d" },
        user: { login: "codex-cloud[bot]", type: "Bot" },
      },
    }),
  );

  const result = runCli(["verify", "--repo", repo, "--out", out], {
    env: { GITHUB_EVENT_PATH: eventPath, GITHUB_ACTIONS: "true" },
  });

  assert.equal(result.code, 0, result.stderr);
  const { subject } = readJson(out, "manifest.json");
  assert.equal(subject.pr, 12);
  assert.equal(subject.repo, "github.com/jyothepro/windkeel");
  assert.deepEqual(subject.author, {
    login: "codex-cloud[bot]",
    kind: "agent",
    agent: "openai-codex",
  });
  assert.equal(readJson(out, "intent.json").criteria[0].text, "criterion from the event payload");
});

test("a package produced by verify passes verify-package", () => {
  const { out } = verifyFixture(PASSING_SCRIPTS);

  const result = runCli(["verify-package", out]);

  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /integrity: ok/);
  assert.match(result.stdout, /verdict: PASS/);
});

test("a check emitting megabytes of output is still judged by its exit code", () => {
  const { out, result } = verifyFixture({
    test: "node -e \"process.stdout.write('x'.repeat(5*1024*1024))\"",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /verdict: PASS/);
  const evidence = readJson(out, "evidence/ev-01.json");
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.producer.exit_code, 0);
  assert.ok(statSync(join(out, evidence.transcript)).size > 5 * 1024 * 1024);
});
