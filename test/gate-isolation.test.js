/**
 * The candidate under verification is untrusted — possibly written by a prompt-injected agent —
 * and the Gate's claim is that its verdict is independent of it. Each test here is one way the
 * candidate used to be able to reach past that claim:
 *
 * A. read the verifier's secrets from the environment its checks inherit;
 * B. outlive its check and touch the package after the verdict (process group), or have its
 *    signature accepted by an unanchored identity match;
 * C. define the checks that judge it;
 * D. write outside the evidence package through a crafted name, path or symlink;
 * E. pass with nobody having reviewed it, because no model key was configured.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { candidateEnv, optedInNames } from "@windkeel/verification/exec/candidate-env.js";
import { LocalExecutionEnvironment } from "@windkeel/verification/exec/local.js";
import { configDrift, loadConfig, loadTrustedConfig } from "@windkeel/verification/config.js";
import {
  PackagePathError,
  confinedPath,
  preparePackageDir,
  writeText,
} from "@windkeel/verification/evidence/package.js";
import {
  anchorStart,
  githubWorkflowIdentityRegexp,
} from "@windkeel/verification/attest/sigstore.js";
import { readJson, runCli, tempDir } from "./helpers.js";

/** A repo with a base commit and a head commit, each a full set of top-level files. */
function twoCommitRepo(base, head) {
  const dir = tempDir("iso-repo");
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  const write = (files) => {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) {
        git("rm", "-q", name);
        continue;
      }
      writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content, null, 2));
    }
  };
  git("init", "-q");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture Author");
  write(base);
  git("add", "-A");
  git("commit", "-qm", "base");
  write(head);
  git("add", "-A");
  git("commit", "-qm", "head");
  return dir;
}

const pkg = (scripts) => ({ name: "fixture", version: "0.0.0", scripts });
const FAILING = "node -e \"console.error('1 failing'); process.exit(1)\"";

function verify(repo, env = {}) {
  const out = join(tempDir("iso-out"), "evidence");
  const result = runCli(["verify", "--repo", repo, "--out", out], { env });
  return { out, result };
}

const evidenceOf = (out) =>
  readdirSync(join(out, "evidence"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(out, `evidence/${f}`));

// ---------------------------------------------------------------------------------------------
// A. Secrets do not reach candidate code.
// ---------------------------------------------------------------------------------------------

test("A: a candidate command sees an allowlisted environment, not the verifier's", async () => {
  const execEnv = new LocalExecutionEnvironment({
    PATH: process.env.PATH,
    HOME: "/home/runner",
    LC_ALL: "C",
    WINDKEEL_PLANTED_SECRET: "s3cr3t-planted",
    ANTHROPIC_API_KEY: "sk-ant-planted",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-planted",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/planted",
    ACTIONS_RUNTIME_TOKEN: "runtime-planted",
    GITHUB_ENV: "/tmp/planted-env",
    GITHUB_PATH: "/tmp/planted-path",
    DATABASE_URL: "postgres://service-container",
    WINDKEEL_CHECK_ENV: "DATABASE_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN,GITHUB_ENV",
  });

  const result = await execEnv.exec("env", { env: { CI: "1" } });
  assert.equal(result.status, 0, result.stderr);

  for (const planted of ["s3cr3t-planted", "sk-ant-planted", "oidc-planted", "runtime-planted", "planted-env", "planted-path"]) {
    assert.doesNotMatch(result.stdout, new RegExp(planted), `${planted} leaked into a candidate command`);
  }
  // The explicit, trusted opt-in works — for names that are not on the never-pass list.
  assert.match(result.stdout, /^DATABASE_URL=postgres:\/\/service-container$/m);
  assert.match(result.stdout, /^HOME=\/home\/runner$/m);
  assert.match(result.stdout, /^LC_ALL=C$/m);
  assert.match(result.stdout, /^CI=1$/m);
  assert.doesNotMatch(result.stdout, /WINDKEEL_CHECK_ENV/);
});

test("A: WINDKEEL_CHECK_ENV cannot reopen the signing or file-command channels", () => {
  const names = optedInNames({
    WINDKEEL_CHECK_ENV: "ACTIONS_ID_TOKEN_REQUEST_URL,ACTIONS_RUNTIME_URL,GITHUB_OUTPUT,OPENAI_API_KEY,CODEX_API_KEY,SIGSTORE_ID_TOKEN,NPM_TOKEN",
  });
  assert.deepEqual(names, ["NPM_TOKEN"]);
  assert.deepEqual(candidateEnv({ SECRET: "x", PATH: "/bin" }, { FORCE_COLOR: "0" }), {
    PATH: "/bin",
    FORCE_COLOR: "0",
  });
});

test("A: on Windows names compare case-insensitively, so `Path` and `SystemRoot` survive", () => {
  const env = candidateEnv(
    {
      Path: "C:\\Windows\\system32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      PathExt: ".COM;.EXE",
      UserProfile: "C:\\Users\\runner",
      Secret: "x",
      Actions_Id_Token_Request_Token: "oidc",
      Windkeel_Check_Env: "Database_Url,actions_runtime_token",
      DATABASE_URL: "pg://svc",
      ACTIONS_RUNTIME_TOKEN: "rt",
    },
    {},
    "win32",
  );
  assert.deepEqual(Object.keys(env).sort(), ["ComSpec", "DATABASE_URL", "Path", "PathExt", "SystemRoot", "UserProfile"]);
  // POSIX stays exact: `Path` is not `PATH` there.
  assert.deepEqual(candidateEnv({ Path: "/x", PATH: "/bin" }, {}, "linux"), { PATH: "/bin" });
});

test("A: end to end, a repo check that dumps its environment records no planted secret", () => {
  const repo = twoCommitRepo({ "package.json": pkg({ test: "env" }) }, { "a.js": "1;\n" });
  const { out, result } = verify(repo, {
    WINDKEEL_PLANTED_SECRET: "s3cr3t-planted",
    ANTHROPIC_API_KEY: "",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-planted",
    ACTIONS_ID_TOKEN_REQUEST_URL: "http://127.0.0.1:9/never",
  });
  assert.equal(result.code, 0, result.stderr);
  const check = evidenceOf(out).find((e) => e.type === "tests_result");
  const transcript = readFileSync(join(out, check.transcript), "utf8");
  assert.match(transcript, /PATH=/, "the check did run `env`");
  assert.doesNotMatch(transcript, /s3cr3t-planted|oidc-planted|ACTIONS_ID_TOKEN_REQUEST/);
});

// ---------------------------------------------------------------------------------------------
// B. A check cannot outlive itself; a signature from a sibling repository does not satisfy.
// ---------------------------------------------------------------------------------------------

test("B: a background process a check leaves behind is killed with its process group", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir("iso-stray");
  const marker = join(dir, "late.txt");
  const execEnv = new LocalExecutionEnvironment();
  // Detached from stdio so spawnSync returns while it is still sleeping — the shape of a check
  // that tries to rewrite the package after `verify` has computed the verdict.
  const result = await execEnv.exec(
    `nohup sh -c 'sleep 1; echo late > "${marker}"' >/dev/null 2>&1 & echo started`,
    { cwd: dir },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /started/);
  await delay(1800);
  assert.equal(existsSync(marker), false, "the stray process survived its check");
});

test("B: the GitHub identity is anchored — sibling repositories and lookalikes do not match", () => {
  const re = new RegExp(githubWorkflowIdentityRegexp("jyothepro/windkeel"));
  assert.ok(re.test("https://github.com/jyothepro/windkeel/.github/workflows/windkeel-gate.yml@refs/pull/7/merge"));
  for (const imposter of [
    "https://github.com/jyothepro/windkeel-evil/.github/workflows/x.yml@refs/heads/main",
    "https://github.com/jyothepro/windkeelx/.github/workflows/x.yml@refs/heads/main",
    "https://evil.example/https://github.com/jyothepro/windkeel/.github/workflows/x.yml",
    "https://github.com/jyothepro/windkeel/not-a-workflow",
  ]) {
    assert.equal(re.test(imposter), false, `${imposter} matched`);
  }
  // Dots in names match only dots.
  const dotted = new RegExp(githubWorkflowIdentityRegexp("acme/my.repo"));
  assert.equal(dotted.test("https://github.com/acme/myxrepo/.github/workflows/a.yml@x"), false);
  assert.ok(dotted.test("https://github.com/acme/my.repo/.github/workflows/a.yml@x"));
  assert.throws(() => githubWorkflowIdentityRegexp("not a repo"));
  // A raw regex is anchored at the start before it reaches cosign.
  assert.equal(anchorStart("https://github.com/o/r/.*"), "^https://github.com/o/r/.*");
  assert.equal(anchorStart("^x"), "^x");
});

test("B: --certificate-github-repo and --certificate-identity together is a usage error", () => {
  const repo = twoCommitRepo({ "package.json": pkg({ test: "true" }) }, { "a.js": "1;\n" });
  const { out } = verify(repo);
  const result = runCli([
    "verify-package",
    out,
    "--certificate-github-repo",
    "jyothepro/windkeel",
    "--certificate-identity",
    "https://github.com/jyothepro/windkeel",
  ]);
  assert.equal(result.code, 2, result.stdout + result.stderr);
});

test("B: `sign` refuses a package that does not verify, or is about another commit", () => {
  const repo = twoCommitRepo({ "package.json": pkg({ test: "true" }) }, { "a.js": "1;\n" });
  const { out } = verify(repo);

  const wrongHead = runCli(["sign", out, "--expect-head-sha", "0".repeat(40)]);
  assert.equal(wrongHead.code, 3, wrongHead.stdout + wrongHead.stderr);
  assert.match(wrongHead.stderr, /refusing to sign/);

  // `--verify-only` (seal mode with `sign: false`) runs the same checks and stops before signing.
  const head = readJson(out, "manifest.json").subject.head_sha;
  const ok = runCli(["sign", out, "--verify-only", "--expect-head-sha", head]);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /not signed \(--verify-only\)/);
  const wrongHeadOnly = runCli(["sign", out, "--verify-only", "--expect-head-sha", "0".repeat(40)]);
  assert.equal(wrongHeadOnly.code, 3);

  writeFileSync(join(out, "evidence", "smuggled.log"), "added after verification\n");
  assert.equal(runCli(["sign", out, "--verify-only"]).code, 3);
  const tampered = runCli(["sign", out]);
  assert.equal(tampered.code, 3, tampered.stdout + tampered.stderr);
  assert.match(tampered.stdout, /refusing to sign a package that does not verify/);
});

// ---------------------------------------------------------------------------------------------
// C. The checks come from the base revision.
// ---------------------------------------------------------------------------------------------

test("C: a head that sets `\"test\": \"exit 0\"` still runs the base's test, and is told so", () => {
  const repo = twoCommitRepo(
    { "package.json": pkg({ test: FAILING }) },
    { "package.json": pkg({ test: "exit 0" }) },
  );
  const { out } = verify(repo);

  const verdict = readJson(out, "verdict.json");
  assert.equal(verdict.verdict, "fail", "the candidate's own test script judged it");
  assert.ok(verdict.blocking_findings.includes("F-tests"));
  const check = evidenceOf(out).find((e) => e.type === "tests_result");
  assert.match(readFileSync(join(out, check.transcript), "utf8"), /1 failing/, "the base's body is what ran");
  const config = evidenceOf(out).find((e) => e.type === "check_config");
  assert.equal(config.status, "warning");
  assert.match(config.findings[0].claim, /check configuration changed by the change under review; checks ran from base/);
  // The candidate's package.json is back on disk, byte for byte.
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout;
  assert.doesNotMatch(status, /package\.json/);
});

/*
 * Review follow-up: the first version pinned only the exact discovered form `npm run --silent X`,
 * so a base config that *declares* `npm test` ran the candidate's modified script. Every
 * invocation form now resolves against the base's `scripts`, because the base's block is what is
 * on disk while checks run.
 */
for (const command of [
  "npm test",
  "npm t",
  "npm run test",
  "npm run-script test -- --ci",
  "npm run --silent wrapper",
]) {
  test(`C: a base check declared as \`${command}\` runs the base's script, not the head's`, () => {
    const repo = twoCommitRepo(
      {
        "windkeel.config.json": { checks: [{ name: "tests", command }] },
        "package.json": pkg({ test: FAILING, wrapper: "npm run --silent test" }),
      },
      { "package.json": pkg({ test: "exit 0", wrapper: "exit 0" }) },
    );
    const { out } = verify(repo);
    assert.equal(readJson(out, "verdict.json").verdict, "fail", `${command} ran the candidate's script`);
    assert.ok(readJson(out, "verdict.json").blocking_findings.includes("F-tests"));
  });
}

test("C: a declared flow invoking a package script also gets the base's script", () => {
  const repo = twoCommitRepo(
    {
      "package.json": pkg({ test: "true", e2e: FAILING }),
      "windkeel.config.json": { flows: [{ name: "checkout", command: "npm run e2e" }] },
    },
    { "package.json": pkg({ test: "true", e2e: "exit 0" }) },
  );
  const { out } = verify(repo);
  const browser = evidenceOf(out).find((e) => e.stage === "browser");
  assert.equal(browser.status, "failed");
});

test("C: a head that adds windkeel.config.json with `true` checks does not replace the base's", () => {
  const repo = twoCommitRepo(
    { "package.json": pkg({ test: FAILING }) },
    { "windkeel.config.json": { checks: [{ name: "tests", command: "true" }] } },
  );
  const { out } = verify(repo);
  assert.equal(readJson(out, "verdict.json").verdict, "fail");
  const config = evidenceOf(out).find((e) => e.type === "check_config");
  assert.match(config.findings.map((f) => f.claim).join("\n"), /`tests` changes from `npm run --silent test` to `true`/);
});

test("C: removing a check or switching off `required` is blocking, even though the base's ran", () => {
  const repo = twoCommitRepo(
    {
      "windkeel.config.json": {
        checks: {
          required: true,
          commands: [
            { name: "tests", command: "true" },
            { name: "lint", command: "true" },
          ],
        },
      },
    },
    { "windkeel.config.json": { checks: [{ name: "tests", command: "true" }] } },
  );
  const { out } = verify(repo);

  const verdict = readJson(out, "verdict.json");
  assert.equal(verdict.verdict, "fail");
  const config = evidenceOf(out).find((e) => e.type === "check_config");
  assert.equal(config.status, "failed");
  const claims = config.findings.filter((f) => f.severity === "blocking").map((f) => f.claim).join("\n");
  assert.match(claims, /check `lint`/);
  assert.match(claims, /`checks.required` is switched off/);
  // Both base checks ran.
  assert.deepEqual(
    evidenceOf(out).filter((e) => e.stage === "checks" && e.producer).map((e) => e.type).sort(),
    ["lint_result", "tests_result"],
  );
});

test("C: an unchanged configuration adds no evidence item at all", async () => {
  const repo = twoCommitRepo({ "package.json": pkg({ test: "true" }) }, { "a.js": "1;\n" });
  const trusted = await loadTrustedConfig(new LocalExecutionEnvironment(), repo, sha(repo, "HEAD~1"));
  assert.equal(trusted.source, "base");
  assert.deepEqual(trusted.drift, { changes: [], weakening: [] });
  const { out } = verify(repo);
  assert.equal(evidenceOf(out).some((e) => e.type === "check_config"), false);
});

test("C: an unreadable base is blocking rather than falling back to the head's checks quietly", async () => {
  const repo = twoCommitRepo({ "package.json": pkg({ test: "true" }) }, { "a.js": "1;\n" });
  const trusted = await loadTrustedConfig(new LocalExecutionEnvironment(), repo, "f".repeat(40));
  assert.equal(trusted.source, "head");
  assert.match(trusted.baseUnavailable, /could not be read/);
});

test("C: configDrift reports removal as weakening and edits as changes", () => {
  const base = { checks: [{ name: "a", command: "x" }, { name: "b", command: "y" }], checksRequired: false, flows: [], tools: [], rejectedTools: [] };
  const head = { checks: [{ name: "a", command: "z" }], checksRequired: false, flows: [], tools: [], rejectedTools: [] };
  const drift = configDrift(base, head);
  assert.equal(drift.weakening.length, 1);
  assert.match(drift.weakening[0], /`b`/);
  assert.equal(drift.changes.length, 1);
});

function sha(repo, rev) {
  return spawnSync("git", ["rev-parse", rev], { cwd: repo, encoding: "utf8" }).stdout.trim();
}

// ---------------------------------------------------------------------------------------------
// D. Nothing is written outside the package.
// ---------------------------------------------------------------------------------------------

test("D: check and flow names that are not plain filenames are refused at load", async () => {
  const repo = tempDir("iso-names");
  writeFileSync(
    join(repo, "windkeel.config.json"),
    JSON.stringify({
      checks: [
        { name: "../../../escape", command: "true" },
        { name: "..", command: "true" },
        { name: "ok-name_1.x", command: "true" },
      ],
      flows: [
        { name: "a/b", command: "true" },
        { name: "fine", command: "true", artifacts: "../../home" },
        { name: "good", command: "true", artifacts: "test-results" },
      ],
    }),
  );
  const config = await loadConfig(new LocalExecutionEnvironment(), repo);
  assert.deepEqual(config.checks.map((c) => c.name), ["ok-name_1.x"]);
  assert.deepEqual(config.flows.map((f) => f.name), ["good"]);
  assert.equal(config.rejectedEntries.length, 4);
});

test("D: a refused check name is a blocking finding, and nothing lands outside the package", () => {
  const repo = twoCommitRepo(
    { "windkeel.config.json": { checks: [{ name: "../../../pwned", command: "echo hi" }] } },
    { "a.js": "1;\n" },
  );
  const parent = tempDir("iso-parent");
  const out = join(parent, "pkg", "evidence");
  const result = runCli(["verify", "--repo", repo, "--out", out]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readJson(out, "verdict.json").verdict, "fail");
  const config = evidenceOf(out).find((e) => e.type === "check_config");
  assert.match(config.findings[0].claim, /refused/);
  assert.deepEqual(readdirSync(parent), ["pkg"]);
  assert.deepEqual(readdirSync(join(parent, "pkg")), ["evidence"]);
});

test("D: package writes are confined — traversal, absolute paths and symlinked parents are refused", () => {
  const pkgDir = join(tempDir("iso-pkg"), "evidence");
  preparePackageDir(pkgDir);
  for (const rel of ["../x", "evidence/../../x", "/etc/passwd", ""]) {
    assert.throws(() => confinedPath(pkgDir, rel), PackagePathError, rel);
  }
  const outside = tempDir("iso-outside");
  mkdirSync(join(pkgDir, "evidence"), { recursive: true });
  symlinkSync(outside, join(pkgDir, "evidence", "browser"));
  assert.throws(() => writeText(pkgDir, "evidence/browser/flow/x.txt", "x"), PackagePathError);
  symlinkSync(join(outside, "target.txt"), join(pkgDir, "evidence", "link.txt"));
  assert.throws(() => writeText(pkgDir, "evidence/link.txt", "x"), PackagePathError);
  assert.deepEqual(readdirSync(outside), []);
  writeText(pkgDir, "evidence/ok.txt", "fine");
  assert.equal(readFileSync(join(pkgDir, "evidence", "ok.txt"), "utf8"), "fine");
});

test("D: a checkout that symlinks the package path is refused before anything is removed", () => {
  const repo = tempDir("iso-symrepo");
  const victim = tempDir("iso-victim");
  writeFileSync(join(victim, "keep.txt"), "do not delete");
  symlinkSync(victim, join(repo, ".windkeel"));
  assert.throws(() => preparePackageDir(join(repo, ".windkeel", "evidence"), repo), PackagePathError);
  assert.ok(existsSync(join(victim, "keep.txt")));
});

test("D: a symlink in a flow's artifacts directory is not followed into the package", () => {
  const repo = twoCommitRepo(
    {
      "package.json": pkg({ test: "true" }),
      "windkeel.config.json": { flows: [{ name: "checkout", command: "true" }] },
    },
    { "a.js": "1;\n" },
  );
  const secretDir = tempDir("iso-secret");
  writeFileSync(join(secretDir, "id_ed25519"), "PRIVATE KEY MATERIAL");
  mkdirSync(join(repo, "test-results"));
  writeFileSync(join(repo, "test-results", "shot.png"), "png");
  symlinkSync(join(secretDir, "id_ed25519"), join(repo, "test-results", "key"));
  symlinkSync(secretDir, join(repo, "test-results", "dir"));
  const { out } = verify(repo);
  const browser = evidenceOf(out).find((e) => e.stage === "browser");
  assert.deepEqual(browser.artifacts.map((a) => a.path), ["evidence/browser/checkout/shot.png"]);
});

// ---------------------------------------------------------------------------------------------
// E. Unreviewed is not pass.
// ---------------------------------------------------------------------------------------------

test("E: a diff with no reviewer configured warns, it does not pass", () => {
  const repo = twoCommitRepo({ "package.json": pkg({ test: "true" }) }, { "a.js": "1;\n" });
  const { out } = verify(repo, { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" });
  const review = evidenceOf(out).find((e) => e.stage === "review");
  assert.equal(review.status, "warning");
  assert.equal(readJson(out, "verdict.json").verdict, "warn");
});
