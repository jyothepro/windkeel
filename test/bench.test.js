import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot, runCli, tempDir } from "./helpers.js";

const CORPUS = join(repoRoot, "bench", "corpus");

/** The defect classes the spec (#14) asks the corpus to cover, one fixture minimum each. */
const REQUIRED_CATEGORIES = [
  "repo-checks",
  "logic-bug",
  "weakened-tests",
  "secret",
  "dependency",
  "dangerous-pattern",
  "intent-mismatch",
  "broken-ui-flow",
];

let cached;
function benchReport() {
  if (!cached) {
    const result = runCli(["bench", "bench/corpus", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    cached = JSON.parse(result.stdout);
  }
  return cached;
}

const readCase = (dir) => JSON.parse(readFileSync(join(CORPUS, dir, "case.json"), "utf8"));

test("the corpus scores 100% catch rate with no false positives", () => {
  const report = benchReport();

  assert.equal(report.catch_rate, 1);
  assert.equal(report.false_positive_rate, 0);
  assert.ok(report.evidence_completeness > 0);
  for (const seeded of report.cases.filter((c) => c.kind === "seeded")) {
    assert.equal(seeded.verdict, "fail", `${seeded.id} was not caught`);
  }
});

test("every seeded defect is caught by the stage its case names", () => {
  const report = benchReport();

  const named = report.cases.filter((c) => c.expect === "fail" && c.stage);
  assert.ok(named.length >= 8, `only ${named.length} seeded cases name a stage`);
  for (const c of named) {
    assert.ok(
      c.caughtBy.includes(c.stage),
      `${c.id}: expected the ${c.stage} stage to catch it, caught by [${c.caughtBy}]`,
    );
  }
});

test("the corpus plants every defect category the spec names, and catches each", () => {
  const report = benchReport();

  const byCategory = new Map(report.coverage.map((c) => [c.category, c]));
  for (const category of REQUIRED_CATEGORIES) {
    const covered = byCategory.get(category);
    assert.ok(covered, `no seeded fixture plants a ${category} defect`);
    assert.equal(covered.caught, covered.planted, `${category}: ${covered.caught}/${covered.planted}`);
  }
  assert.ok(!byCategory.has("uncategorised"), "every seeded case must declare a category");
});

test("the corpus is the size the spec calls for, with controls spread across stages", () => {
  const report = benchReport();

  assert.ok(
    report.cases.length >= 10 && report.cases.length <= 15,
    `the spec calls for 10-15 cases, found ${report.cases.length}`,
  );
  // One control only guards one path: a corpus that never exercises a clean security scan
  // or a passing browser flow cannot claim a false-positive rate for those stages.
  assert.ok(report.controls >= 4, `only ${report.controls} clean controls`);
  const controlStages = new Set(
    report.cases
      .filter((c) => c.kind === "clean")
      .flatMap((c) => Object.keys(c.env ?? {}).concat(c.intent ? ["intent"] : [])),
  );
  assert.ok(controlStages.size >= 3, `controls exercise too few stages: [${[...controlStages]}]`);
});

test("no clean control is flagged by any stage", () => {
  const report = benchReport();

  for (const control of report.cases.filter((c) => c.kind === "clean")) {
    assert.deepEqual(control.caughtBy, [], `${control.id} was flagged by ${control.caughtBy}`);
    assert.deepEqual(control.unsatisfied, [], `${control.id} left criteria unsatisfied`);
  }
});

test("every case on disk declares the fields the report is computed from", () => {
  const dirs = readdirSync(CORPUS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  assert.ok(dirs.length >= 10);
  for (const dir of dirs) {
    const spec = readCase(dir);
    assert.equal(spec.id, dir, `${dir}: case.json id must match its directory`);
    assert.ok(["seeded", "clean", "replay"].includes(spec.kind), `${dir}: bad kind`);
    assert.ok(["pass", "fail"].includes(spec.expect), `${dir}: bad expect`);
    assert.ok(spec.defect, `${dir}: every case must say what it plants, or that it plants nothing`);
    assert.equal(
      spec.category === "none",
      spec.kind === "clean",
      `${dir}: only clean controls carry category "none"`,
    );
  }
});

test("the corpus scores the same inside a workflow as it does locally", () => {
  // Regression: run under a GitHub Actions environment, the gate resolved the *enclosing*
  // PR's head and base SHAs instead of the synthetic case repo's. `git diff` came back
  // empty, the review stage skipped, and both review-dependent seeded defects scored as
  // passes — a corpus that quietly reported 75% in CI and 100% everywhere else.
  const event = join(tempDir("event"), "event.json");
  writeFileSync(
    event,
    JSON.stringify({
      repository: { full_name: "jyothepro/windkeel" },
      pull_request: {
        number: 43,
        title: "some unrelated pull request",
        body: "- [ ] a criterion belonging to some other change entirely",
        head: { sha: "1".repeat(40) },
        base: { sha: "2".repeat(40) },
        user: { login: "someone", type: "User" },
      },
    }),
  );

  const result = runCli(["bench", "bench/corpus", "--json"], {
    // A maintainer with a real key exported must not score the corpus against a live model.
    env: { GITHUB_EVENT_PATH: event, GITHUB_ACTIONS: "true", ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" },
  });

  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.catch_rate, 1);
  assert.deepEqual(
    report.cases.filter((c) => c.expect === "fail" && !c.correct).map((c) => c.id),
    [],
  );
  assert.deepEqual(report.coverage, benchReport().coverage);
});

/**
 * The corpus has to score the same in a workflow as on a laptop. It did not: inside CI,
 * `GITHUB_EVENT_PATH` made subject resolution read the enclosing PR's SHAs, the diff
 * between two commits the case repo has never seen came back empty, and the review stage
 * skipped — so the review-dependent seeded defects scored as passes and only the CI bench
 * step noticed.
 */
test("a threshold that the corpus cannot meet fails the run", () => {
  // 100% catch is the real score, so demanding a fabricated 100% false-positive-free run
  // below the achievable bar must still fail loudly rather than round in our favour.
  const result = runCli(["bench", "bench/corpus", "--max-false-positive", "-1"]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /false positive rate/);
});

test("a missing corpus is a usage error, not an empty perfect score", () => {
  const result = runCli(["bench", "/tmp/windkeel-no-such-corpus"]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /no corpus at/);
});

/** A corpus of one case needing a tool nothing has, so the skip path is deterministic. */
function corpusRequiringMissingTool() {
  const corpus = tempDir("corpus");
  const dir = join(corpus, "99-needs-a-tool");
  mkdirSync(join(dir, "head"), { recursive: true });
  writeFileSync(
    join(dir, "head", "package.json"),
    JSON.stringify({ name: "case-99", version: "1.0.0", scripts: { test: "node -e 0" } }),
  );
  writeFileSync(
    join(dir, "case.json"),
    JSON.stringify({
      id: "99-needs-a-tool",
      kind: "seeded",
      expect: "fail",
      defect: "needs a scanner this runner does not have",
      stage: "security",
      requires: ["windkeel-definitely-not-installed"],
    }),
  );
  return corpus;
}

test("a case needing an absent tool is reported unscored, not counted as a missed defect", () => {
  const corpus = corpusRequiringMissingTool();

  const result = runCli(["bench", corpus]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /skip 99-needs-a-tool/);
  assert.match(result.stdout, /1 case\(s\) not scored/);
  // Nobody looked, so nothing was missed — but the report has to say the corpus shrank.
  assert.match(result.stdout, /catch rate: +100\.0%/);
});

/**
 * CI depends on the bench run being hermetic. A replay clones a real repo over the network
 * and wants a real reviewer key, so the bench must report one rather than run it — even if
 * a manifest ends up somewhere the corpus walk can see.
 */
test("the default bench invocation does not run replays", () => {
  const corpus = tempDir("corpus");
  const dir = join(corpus, "r1-historical-pr");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "case.json"),
    JSON.stringify({
      id: "r1-historical-pr",
      kind: "replay",
      expect: "fail",
      defect: "a real PR whose bug surfaced after merge",
      stage: "review",
    }),
  );
  // A directory that is not a case at all — the replayed area carries manifests and
  // recorded results, not case.json files — must not stop the walk either.
  mkdirSync(join(corpus, "not-a-case"), { recursive: true });
  writeFileSync(join(corpus, "not-a-case", "manifest.json"), "{}\n");

  const result = runCli(["bench", corpus]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /skip r1-historical-pr/);
  assert.match(result.stdout, /replays are non-hermetic; run `windkeel replay/);
  assert.doesNotMatch(result.stdout, /not-a-case/);
});

test("the shipped corpus contains no replay cases at all", () => {
  const report = benchReport();

  assert.deepEqual(
    report.cases.filter((c) => c.kind === "replay"),
    [],
  );
  assert.deepEqual(report.skipped, []);
});

test("--require-tools refuses to score a corpus that could not run in full", () => {
  const corpus = corpusRequiringMissingTool();

  const result = runCli(["bench", corpus, "--require-tools"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /windkeel: 1 corpus case\(s\) could not run: 99-needs-a-tool/);
});
