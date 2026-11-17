import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readJson, runCli, tempDir } from "./helpers.js";

const UPSTREAM_AUTHOR = "Upstream Maintainer";
const HEAD_SUBJECT = "perf: reuse the fragment buffer (#3284)";
const HEAD_BODY = "Speeds up the hot path.\n\n- [ ] compressed frames are still decoded correctly\n";

/**
 * A local git repo standing in for the upstream. The replay harness takes any git URL, so
 * the whole fetch/materialise/verify path runs here without a network.
 */
function localUpstream() {
  const dir = tempDir("upstream");
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return (r.stdout ?? "").trim();
  };
  git("init", "-q");
  git("config", "user.email", "maintainer@example.com");
  git("config", "user.name", UPSTREAM_AUTHOR);

  writeFileSync(join(dir, "receiver.js"), "export const size = (parts) => parts.length;\n");
  writeFileSync(join(dir, "doomed.js"), "export const gone = true;\n");
  git("add", "-A");
  git("commit", "-qm", "base commit");
  const base = git("rev-parse", "HEAD");

  writeFileSync(join(dir, "receiver.js"), "export const size = () => 0;\n");
  spawnSync("git", ["rm", "-q", "doomed.js"], { cwd: dir });
  git("add", "-A");
  git("commit", "-qm", `${HEAD_SUBJECT}\n\n${HEAD_BODY}`);
  const head = git("rev-parse", "HEAD");

  return { dir, base, head };
}

function caseDir(upstream, overrides = {}) {
  const cases = tempDir("replay-cases");
  const dir = join(cases, "local-fixture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "case.json"),
    JSON.stringify(
      {
        id: "local-fixture",
        kind: "replay",
        upstream: {
          repo: "example/fixture",
          clone_url: upstream.dir,
          pr: 3284,
          base_sha: upstream.base,
          head_sha: upstream.head,
          subject: HEAD_SUBJECT,
          ...overrides,
        },
        surfaced: {
          how: "reverted",
          commit: "0".repeat(40),
          subject: 'Revert "perf: reuse the fragment buffer"',
          description: "size() stopped counting, so every compressed frame decoded as empty.",
        },
        expect: "fail",
      },
      null,
      2,
    ),
  );
  return cases;
}

function replay(cases, options = {}) {
  const out = options.out ?? join(tempDir("replay-out"), "packages");
  const args = ["replay", cases, "--json", "--cache", tempDir("replay-cache"), "--out", out];
  const result = runCli(args, { env: options.env ?? {} });
  return { out, result, report: result.code === 0 ? JSON.parse(result.stdout) : null };
}

test("a replay case is fetched, rebuilt as base..head, and put to the reviewer", () => {
  const upstream = localUpstream();
  const reviewer = join(tempDir("reviewer"), "reviewer.json");
  writeFileSync(
    reviewer,
    JSON.stringify({
      summary: "The counter is never incremented on the compressed path.",
      findings: [
        {
          id: "F-empty-frames",
          severity: "blocking",
          category: "logic",
          claim: "size() now always returns 0, so compressed frames decode as empty",
          failure_scenario: "Every permessage-deflate message is delivered as an empty buffer",
        },
      ],
    }),
  );

  const { report } = replay(caseDir(upstream), { env: { WINDKEEL_FAKE_REVIEWER: reviewer } });

  assert.equal(report.errors, 0, JSON.stringify(report.cases));
  const [replayed] = report.cases;
  assert.equal(replayed.evaluated, true);
  assert.equal(replayed.caught, true);
  assert.equal(replayed.verdict, "fail");
  assert.deepEqual(
    replayed.findings.map((f) => f.id),
    ["F-empty-frames"],
  );
  assert.equal(report.caught, 1);
  assert.equal(report.evaluated, 1);
});

test("the replayed package carries the upstream author, subject, and stated intent", () => {
  const upstream = localUpstream();
  const { out, report } = replay(caseDir(upstream));

  assert.equal(report.errors, 0);
  const pkg = join(out, "local-fixture");
  const { subject } = readJson(pkg, "manifest.json");
  assert.equal(subject.title, HEAD_SUBJECT);
  assert.equal(subject.author.login, UPSTREAM_AUTHOR);
  // The package describes the checkout it actually verified, which is a two-commit
  // reconstruction — not the upstream commit. Only the replay report ties the two
  // together, so a replay package must never be read as if it were an upstream one.
  assert.match(subject.head_sha, /^[0-9a-f]{40}$/);
  assert.notEqual(subject.head_sha, report.cases[0].upstream.head_sha);
  // The upstream commit body stands in for the PR description, so its checklist is intent.
  assert.deepEqual(
    readJson(pkg, "intent.json").criteria.map((c) => c.text),
    ["compressed frames are still decoded correctly"],
  );
});

test("replaying without a reviewer records the case as unevaluated, not as a miss", () => {
  const upstream = localUpstream();

  const { report, result } = replay(caseDir(upstream));

  assert.equal(result.code, 0, result.stderr);
  const [replayed] = report.cases;
  assert.equal(replayed.evaluated, false);
  assert.equal(replayed.review_status, "warning");
  assert.equal(report.evaluated, 0);
  assert.equal(report.caught, 0, "an unasked question is not a caught defect");
});

test("the upstream checks never run, so a missing toolchain cannot fake a catch", () => {
  const upstream = localUpstream();
  const { out, report } = replay(caseDir(upstream));

  const checks = readJson(join(out, "local-fixture"), "evidence/ev-01.json");
  assert.equal(checks.stage, "checks");
  assert.equal(checks.status, "warning");
  assert.match(checks.reason, /^no_checks_discovered/);
  // Warning, not failure: the package says plainly that nothing was executed, but an
  // uninstalled upstream toolchain must not arrive at the same verdict as a caught defect.
  assert.notEqual(report.cases[0].verdict, "fail");
  assert.equal(report.caught, 0);
});

test("an upstream that cannot be fetched is an error, and the run exits non-zero", () => {
  const upstream = localUpstream();
  const cases = caseDir(upstream, { clone_url: join(tempDir("nowhere"), "missing.git") });

  const result = runCli(["replay", cases, "--cache", tempDir("replay-cache")]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /ERROR/);
});

test("a missing cases directory is a usage error", () => {
  const result = runCli(["replay", "/tmp/windkeel-no-such-replay-cases"]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /no replay cases at/);
});
