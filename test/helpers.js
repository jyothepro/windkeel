import "./db-guard.js";
import { spawnSync } from "node:child_process";
import { PINNED_CODEX_VERSION } from "../dist/worker/codex/adapter.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { CodexWorkerAdapter } from "../dist/worker/codex/adapter.js";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every API test is a contract test: the ingress router checks each 2xx body against
 * `routeResponses` (packages/api-contract/src/routes.ts) and answers 500 `contract_violation` on a
 * mismatch. Set before any test builds a server, and inherited by any process a test spawns.
 */
process.env.WINDKEEL_VALIDATE_RESPONSES ??= "1";

const repoRootPath = join(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = repoRootPath;
/**
 * The published CLI, which every end-to-end test spawns.
 *
 * `packages/cli/dist/` since the ADR-0005 amendment of 2026-09-24. Worth knowing why this line is
 * dangerous to get wrong: `dist/` is gitignored and never cleaned, so a stale build from before
 * the split left the old path resolvable on a developer's machine and the whole suite passed
 * locally while CI, which builds from nothing, failed 109 tests. `npm run clean` exists now, and
 * `npm test` runs it.
 */
export const cliPath = join(repoRoot, "packages", "cli", "dist", "cli.js");
export const adminCliPath = join(repoRoot, "dist", "admin-cli.js");

/**
 * Provider credentials are cleared unless a test opts in, so no test can hit a real model,
 * and the security stage is scripted for the same reason: whether gitleaks happens to be
 * installed on the runner is not something these tests are asserting about. Tests that do
 * care declare their own scanners; the bench tests clear this and use the real ones.
 */
const NEUTRAL_ENV = {
  WINDKEEL_FAKE_SECURITY: join(repoRootPath, "test", "fixtures", "no-scanners.json"),
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  WINDKEEL_FAKE_REVIEWER: "",
  WINDKEEL_FAKE_MAPPER: "",
  WINDKEEL_REVIEW_MODEL: "",
  GITHUB_EVENT_PATH: "",
  GITHUB_ACTIONS: "",
  // Without this the CLI would really keyless-sign when the suite runs in a workflow
  // that has id-token: write — i.e. under Windkeel's own gate.
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
  ACTIONS_ID_TOKEN_REQUEST_URL: "",
  SIGSTORE_ID_TOKEN: "",
};

/**
 * Spawns the operator binary, `windkeel-admin`.
 *
 * `metrics`, `doctor`, `reap`, `task` and `run` live there since the package split — they hold a
 * direct Postgres connection, which a published CLI must not need. A test that wants one of those
 * calls this; everything else calls `runCli`.
 */
export function runAdminCli(args, options = {}) {
  const result = spawnSync(process.execPath, [adminCliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...NEUTRAL_ENV, ...(options.env ?? {}) },
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...NEUTRAL_ENV, ...(options.env ?? {}) },
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `windkeel-${prefix}-`));
}

export function fixtureCopy(name) {
  const dir = tempDir(name);
  cpSync(join(repoRoot, "test", "fixtures", name), dir, { recursive: true });
  return dir;
}

export function readJson(dir, rel) {
  return JSON.parse(readFileSync(join(dir, rel), "utf8"));
}

export function writeJson(dir, rel, value) {
  writeFileSync(join(dir, rel), JSON.stringify(value, null, 2) + "\n");
}

/**
 * A throwaway git repo whose package.json scripts are the checks the gate re-runs.
 *
 * `files` writes additional tracked files into the initial commit — a repo whose `test` script
 * is `true` proves nothing about a defect, and M5.6 needs one whose own tests actually fail on
 * a bad change and pass on a good one.
 */
export function fixtureRepo(scripts, files = {}) {
  const dir = tempDir("repo");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", scripts }, null, 2) + "\n",
  );
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture Author");
  git("add", "-A");
  git("commit", "-qm", "fixture: initial commit");
  return dir;
}

/**
 * A bare clone of `fixtureRepo`, usable as a real push target. M4.5's candidate capture pushes
 * the maker's working branch, and a bare remote is what lets that be a real `git push` over a
 * real remote with no network and no `SANDBOX_GIT_TOKEN` — rather than gating the whole
 * behaviour behind a credential nobody has locally.
 */
export function bareFixtureRepo(scripts = {}, files = {}) {
  const source = fixtureRepo(scripts, files);
  const bare = tempDir("bare");
  const result = spawnSync("git", ["clone", "--bare", "-q", source, bare], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`bareFixtureRepo: ${result.stderr}`);
  return { bare, source };
}

/**
 * For a test whose sandbox wrapper clones `bare` in place of a GitHub `url`: also points the
 * capture's push at `bare`. The capture pushes to the workspace's recorded repository URL rather
 * than to `origin` (which the agent could have rewritten), so a wrapper that only swaps the clone
 * source would otherwise push to the real GitHub URL.
 */
export function redirectPushes(handle, url, bare) {
  const exec = handle.exec.bind(handle);
  handle.exec = (command, options) =>
    exec(
      command,
      options?.args ? { ...options, args: options.args.map((arg) => (arg === url ? bare : arg)) } : options,
    );
  return handle;
}

/**
 * `FakeGitHubClient`'s `resolveBranchHead` for a run that really pushes to `bare`: the fake then
 * reports exactly what the maker pushed, so PR_CREATING's pin (the branch must still be at the
 * verified SHA) is checked against the same repository the run wrote to.
 */
export function branchHeadsIn(bare) {
  return (_repository, branch) => {
    const result = spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], {
      cwd: bare,
      encoding: "utf8",
    });
    return result.status === 0 ? result.stdout.trim() : null;
  };
}

/** Recorded `codex exec --json` JSONL fixtures, shared by the M3 worker tests. */
export function codexFixture(name) {
  return readFileSync(join(repoRootPath, "test", "fixtures", "codex", `${name}.jsonl`), "utf8");
}

/** Hand-authored Claude Code `stream-json` fixtures (#395); the live proof replaces them. */
export function claudeCodeFixture(name) {
  return readFileSync(join(repoRootPath, "test", "fixtures", "claude-code", `${name}.jsonl`), "utf8");
}

/**
 * The version the stub `codex` reports, tracked from the constant rather than written out.
 *
 * It was the literal `0.148.0` and had to be changed by hand when #116's pin was corrected to the
 * version a real sandbox actually reports. A stub whose version is a copy of the pin is a stub
 * that silently stops matching it — and the adapter's whole job here is to refuse a version it
 * has not seen, so a test fixture drifting from the pin tests the wrong refusal.
 */
export const STUB_VERSION = PINNED_CODEX_VERSION;

/**
 * Installs a stub `codex` in the sandbox: it answers `--version` and, for `exec`, replays a
 * recorded JSONL fixture line by line with a small delay so streaming is genuinely observable
 * rather than an artifact of the whole file landing at once. `mode` picks the behaviour after
 * the replay: exit, or hang (for cancellation tests).
 */
export async function installStubCodex(
  handle,
  { fixture, fixtures, mode = "exit", version = STUB_VERSION },
) {
  const streams = fixtures ?? [fixture];
  const dir = await handle.mkdtemp("windkeel-stub-codex-");
  const binPath = `${dir}/codex`;
  for (const [index, stream] of streams.entries()) {
    await handle.writeFile(`${dir}/stream-${index + 1}.jsonl`, stream);
  }
  await handle.writeFile(
    binPath,
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo "codex-cli ${version}"; exit 0; fi`,
      // Record the invocation so tests can assert on the argv Codex was actually given, and
      // count turns so a resumed turn can replay a different recording.
      `printf '%s\\n' "$*" >> ${dir}/invocations`,
      `n=$(cat ${dir}/turn 2>/dev/null || echo 0)`,
      "n=$((n+1))",
      `echo $n > ${dir}/turn`,
      `f=${dir}/stream-$n.jsonl`,
      `[ -f "$f" ] || f=${dir}/stream-1.jsonl`,
      `while IFS= read -r line; do printf '%s\\n' "$line"; sleep 0.02; done < "$f"`,
      mode === "hang" ? "sleep 120" : "",
      "exit 0",
      "",
    ].join("\n"),
  );
  await handle.exec("chmod", { args: ["+x", binPath] });
  return {
    binPath,
    invocations: async () =>
      (await handle.exists(`${dir}/invocations`))
        ? (await handle.readFile(`${dir}/invocations`)).toString("utf8")
        : "",
  };
}

export async function makerSandbox() {
  const provider = new FakeSandboxProvider();
  return provider.create({ role: "maker", repoUrl: fixtureRepo({ test: "node --test" }) });
}

export function adapterFor(binPath, options = {}) {
  return new CodexWorkerAdapter({
    binary: binPath,
    pinnedVersion: STUB_VERSION,
    pollIntervalMs: 20,
    ...options,
  });
}

/**
 * Pool settings every Postgres-gated test file uses.
 *
 * #140: the suite ran 52 connections deep against `max_connections = 100`, of which **49 were
 * idle** and at most 8 were doing work. Nothing failed and nothing said `too many clients` —
 * which is why the connection hypothesis stayed a hypothesis for so long. But a suite that
 * spends half a database's connection budget holding sockets it is not using has no headroom
 * for one more concurrent file, one `psql` session, or a smaller `max_connections` than this
 * laptop's.
 *
 * `max: 2` because a test file's queries are sequential: it migrates a schema, seeds rows, and
 * asserts. The two are for the case where a helper holds a client while the test opens another.
 * `idleTimeoutMillis` is short because the waste here is *duration*, not count — a connection
 * returned to the pool and never used again should stop costing a slot in a second, not ten.
 */
export const TEST_POOL = { max: 2, idleTimeoutMillis: 1_000 };

/**
 * The uuid every Postgres-gated fixture in this suite uses for "the repository this task is
 * against". It used to point at nothing, which was legal until `migrations/0010` added the
 * foreign key `migrations/0005` deferred.
 */
export const FIXTURE_REPOSITORY_ID = "11111111-1111-1111-1111-111111111111";

/**
 * Inserts the fixture repository row, so a task may reference it.
 *
 * The id is supplied rather than generated, and that is the whole reason this is not
 * `upsertRepository`: the fixtures were written against a fixed uuid, and rewriting two dozen
 * test files to thread a generated id would have obscured the change that actually matters.
 * Idempotent, so a helper may call it without knowing whether the test already did.
 *
 * **Pass `cloneUrl` when the test actually clones.** `resolveRepositoryContext` prefers a task's
 * repository row over `StageConfig.repository`, for local tasks as much as for GitHub ones — and
 * that is what the local CLI produces in production too, since `resolveRepositoryId` creates a
 * real row before the task. A loop test that seeds the default row and then expects the
 * configured fallback is asserting about a code path production no longer takes.
 */
export async function seedFixtureRepository(pool, options = {}) {
  const {
    id = FIXTURE_REPOSITORY_ID,
    cloneUrl = `https://github.com/jyothepro/windkeel-fixture-${String(id).slice(0, 8)}.git`,
    defaultBranch = "main",
  } = typeof options === "string" ? { id: options } : options;
  await pool.query(
    `insert into repository (id, owner, name, default_branch, clone_url)
     values ($1, 'jyothepro', $2, $3, $4)
     on conflict (id) do nothing`,
    [id, `windkeel-fixture-${String(id).slice(0, 8)}`, defaultBranch, cloneUrl],
  );
  // What `upsertRepository` does for a repository nobody has claimed (ADR-0024 §2).
  await pool.query(
    `insert into repository_grant (organization_id, repository_id, intake)
       select id, $1, true from organization where is_default
     on conflict do nothing`,
    [id],
  );
  return id;
}
