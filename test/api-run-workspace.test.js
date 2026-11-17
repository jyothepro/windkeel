import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { handleApiRequest } from "../apps/ingress/dist/src/api/router.js";
import {
  insertEngineeringRun,
  insertEngineeringTask,
  insertRunStateTransition,
  insertWorkspace,
} from "../dist/factory/repositories.js";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import {
  MAX_WORKSPACE_FILE_BYTES,
  parseEntries,
  readThrough,
  utf8Text,
  workspacePath,
} from "../dist/factory/workspace-read.js";
import { seedFixtureRepository, TEST_POOL } from "./helpers.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * `GET /v1/runs/{id}/workspace?path=` (ADR-0029 §2, G12, #366): a read-only look into the maker's
 * checkout between turns.
 *
 * The maker is hostile (ADR-0014). It chose every name, every byte and every symlink in the tree
 * this reads, so what these tests hold is mostly what the read *refuses*: a path that climbs out,
 * an absolute one, a symlink pointing outside the checkout, `.git`, a FIFO, a file over the cap,
 * a binary — and that a run with no live maker, or one mid-turn, is a 409 with the reason rather
 * than a read of a tree that is changing or gone.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";
const TOKEN = "test-operator-token";
const REPO_ID = "11111111-1111-1111-1111-111111111111";

// --- the path, before anything is attached ---------------------------------------------------

test("a workspace path is relative, inside, and never .git", () => {
  assert.deepEqual(workspacePath(undefined), { path: "" });
  assert.deepEqual(workspacePath(""), { path: "" });
  assert.deepEqual(workspacePath("."), { path: "" });
  assert.deepEqual(workspacePath("src//lib/./a.ts"), { path: "src/lib/a.ts" });
  assert.deepEqual(workspacePath("src/"), { path: "src" });
  assert.deepEqual(workspacePath(".github/workflows/ci.yml"), { path: ".github/workflows/ci.yml" }, ".github is not .git");
  assert.deepEqual(workspacePath("a/.git"), { path: "a/.git" }, "only the repository's own .git is hidden");

  for (const bad of ["/etc/passwd", "~/x", "..", "../x", "a/../../x", "a/..", "a\\b", "a\u0000b", "a\nb", ".git", ".git/config", "./.git/HEAD", "x".repeat(1025)]) {
    assert.ok("refused" in workspacePath(bad), `refuses ${JSON.stringify(bad.slice(0, 20))}`);
  }
});

test("a listing from the sandbox is parsed as hostile text", () => {
  const { entries, truncated } = parseEntries("", [
    "f\t12\tREADME.md",
    "d\t0\tsrc",
    "l\t0\tlink",
    "o\t0\tfifo",
    "d\t0\t.git", // hidden at the root
    "f\t-1\tnegative", // malformed size
    "x\t1\tunknown-type",
    "f\t1\ta/b", // a name with a separator can't be a name
    "f\t1\t..",
    "garbage",
    "f\t3\tname\twith\ttabs",
    "more",
    "",
  ]);
  assert.equal(truncated, true);
  assert.deepEqual(
    entries.map((e) => [e.name, e.type, e.bytes]),
    [
      ["src", "directory", null],
      ["README.md", "file", 12],
      ["fifo", "other", null],
      ["link", "symlink", null],
      ["name\twith\ttabs", "file", 3],
    ],
  );
  assert.equal(parseEntries("src", ["f\t1\ta.ts"]).entries[0].path, "src/a.ts");
  assert.equal(parseEntries("sub", ["d\t0\t.git"]).entries.length, 1, "a nested .git is just a name");
});

test("binary is a NUL or bytes that aren't UTF-8; never a lossy decode", () => {
  assert.equal(utf8Text(Buffer.from("héllo\n")), "héllo\n");
  assert.equal(utf8Text(Buffer.from([0x61, 0x00, 0x62])), null);
  assert.equal(utf8Text(Buffer.from([0xff, 0xfe, 0xfd])), null);
  assert.equal(utf8Text(Buffer.from("")), "");
});

// --- the sandbox half, against a real checkout -------------------------------------------------

/** A fake maker sandbox: `FakeSandboxProvider.attach` derives the root from the id alone. */
function makeTree() {
  const handleId = `workspace-${Math.random().toString(36).slice(2, 10)}`;
  const root = join(tmpdir(), `windkeel-fake-sandbox-${handleId}`);
  const outside = join(tmpdir(), `windkeel-outside-${handleId}`);
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "the agent's scratch, or a credential\n");
  writeFileSync(join(root, ".git", "config"), "[credential]\n");
  writeFileSync(join(root, "README.md"), "# hello\n<script>alert(1)</script>\n");
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "src", "deep", "a b; $(touch pwned).txt"), "odd name\n");
  writeFileSync(join(root, ".env.example"), "A=1\n");
  writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  writeFileSync(join(root, "big.txt"), "x".repeat(2048));
  symlinkSync(join(outside, "secret.txt"), join(root, "escape-abs"));
  symlinkSync("../" + `windkeel-outside-${handleId}` + "/secret.txt", join(root, "escape-rel"));
  symlinkSync(outside, join(root, "escape-dir"));
  symlinkSync("/etc", join(root, "etc"));
  symlinkSync("src/index.ts", join(root, "inside-link"));
  symlinkSync(".git/config", join(root, "git-link"));
  symlinkSync("nowhere", join(root, "dangling"));
  spawnSync("mkfifo", [join(root, "pipe")]);
  return {
    handleId,
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    },
  };
}

test("reads one directory level and one file, and refuses every way out of the checkout", async (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const handle = await new FakeSandboxProvider().attach({ role: "maker", handleId: tree.handleId });
  const read = (path, maxBytes = 1024) => readThrough(handle, path, maxBytes, 100);

  const top = await read("");
  assert.equal(top.kind, "directory");
  const byName = Object.fromEntries(top.entries.map((e) => [e.name, e]));
  assert.ok(!(".git" in byName), "the root listing hides .git");
  assert.equal(byName["src"].type, "directory");
  assert.equal(byName["README.md"].type, "file");
  assert.equal(byName["README.md"].bytes, 34);
  assert.equal(byName[".env.example"].type, "file", "dotfiles are listed");
  assert.equal(byName["escape-abs"].type, "symlink", "a symlink is listed as one, not followed");
  assert.equal(byName["escape-abs"].bytes, null);
  assert.equal(byName["pipe"]?.type ?? "other", "other");
  assert.equal(top.entries[0].type, "directory", "directories first");

  const odd = await read("src/deep");
  assert.equal(odd.entries[0].name, "a b; $(touch pwned).txt");
  const content = await read("src/deep/a b; $(touch pwned).txt");
  assert.equal(content.content, "odd name\n", "a name with shell syntax is data");

  const file = await read("README.md");
  assert.equal(file.kind, "file");
  assert.equal(file.content, "# hello\n<script>alert(1)</script>\n", "content comes back verbatim, for the console to escape");
  assert.equal((await read("inside-link")).content, "export const x = 1;\n", "a symlink inside the checkout is followed");

  for (const path of ["escape-abs", "escape-rel", "escape-dir", "escape-dir/secret.txt", "etc", "etc/hosts", "dangling"]) {
    const refused = await read(path);
    assert.equal(refused.kind, "refused", path);
    assert.equal(refused.code, "path_escapes", path);
    assert.equal(refused.status, 400);
    assert.doesNotMatch(JSON.stringify(refused), /credential|scratch/, "nothing from outside leaks into the refusal");
  }
  const git = await read("git-link");
  assert.equal(git.code, "invalid_path", "a symlink into .git is refused like .git itself");

  const missing = await read("nope.txt");
  assert.equal(missing.status, 404);
  assert.equal(missing.code, "not_found");

  const fifo = await read("pipe");
  assert.equal(fifo.code, "not_a_file", "a FIFO is never opened");

  const big = await read("big.txt");
  assert.equal(big.status, 413);
  assert.equal(big.code, "file_too_large");
  assert.equal(big.bytes, 2048);
  assert.equal(big.cap, 1024);
  assert.match(big.reason, /2,048 bytes; the workspace view reads files up to 1,024 bytes/);

  const binary = await read("logo.png");
  assert.equal(binary.status, 415);
  assert.equal(binary.code, "binary_file");
  assert.equal(binary.reason, "binary, 6 bytes");

  const capped = await readThrough(handle, "", 1024, 3);
  assert.equal(capped.truncated, true);
  assert.equal(capped.entries.length, 3);
});

// --- the endpoint -----------------------------------------------------------------------------

async function withApi(fn, overrides = {}) {
  const schema = `windkeel_ws_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaDbUrl = await createMigratedDatabase(schema);
  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  try {
    await seedFixtureRepository(pool);
    const task = await insertEngineeringTask(pool, {
      repositoryId: REPO_ID,
      sourceType: "github_issue",
      sourceReference: "acme/widgets#7",
      title: "t",
      description: "d",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, { taskId: task.id, spendCapUsd: 25, wallClockCapSeconds: 7200 });
    const deps = {
      pool,
      control: {},
      sandboxes: async () => ({ fake: new FakeSandboxProvider() }),
      ...overrides,
    };
    const auth = { token: TOKEN, subject: "operator" };
    const call = (path, params = {}) =>
      handleApiRequest(deps, auth, {
        method: "GET",
        path,
        query: { get: (name) => params[name] },
        headers: { authorization: `Bearer ${TOKEN}` },
      });
    const setState = (status) => pool.query("update engineering_run set status = $1 where id = $2", [status, run.id]);
    await fn({ pool, run, call, setState });
  } finally {
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

async function seedMaker(pool, run, handleId, status = "ready") {
  await insertWorkspace(pool, {
    engineeringRunId: run.id,
    role: "maker",
    sandboxProvider: "fake",
    providerHandle: handleId,
    repository: "r",
    baseSha: "a".repeat(40),
    workingBranch: null,
    status,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

test("GET /v1/runs/{id}/workspace reads the maker's tree between turns", { skip }, async (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  await withApi(async ({ pool, run, call, setState }) => {
    await seedMaker(pool, run, tree.handleId);
    await setState("VERIFYING");

    const root = await call(`/v1/runs/${run.id}/workspace`);
    assert.equal(root.status, 200, JSON.stringify(root.body));
    assert.equal(root.body.kind, "directory");
    assert.equal(root.body.path, "");
    assert.equal(root.headers["cache-control"], "no-store");
    assert.ok(root.body.entries.some((e) => e.path === "src" && e.type === "directory"));

    const file = await call(`/v1/runs/${run.id}/workspace`, { path: "src/index.ts" });
    assert.equal(file.status, 200);
    assert.deepEqual(
      { kind: file.body.kind, path: file.body.path, bytes: file.body.bytes, content: file.body.content },
      { kind: "file", path: "src/index.ts", bytes: 20, content: "export const x = 1;\n" },
    );

    const traversal = await call(`/v1/runs/${run.id}/workspace`, { path: "../../etc/passwd" });
    assert.equal(traversal.status, 400);
    assert.equal(traversal.body.code, "invalid_path");
    const absolute = await call(`/v1/runs/${run.id}/workspace`, { path: "/etc/passwd" });
    assert.equal(absolute.status, 400);
    assert.equal(absolute.body.code, "invalid_path");
    const dotgit = await call(`/v1/runs/${run.id}/workspace`, { path: ".git/config" });
    assert.equal(dotgit.status, 400);

    const escape = await call(`/v1/runs/${run.id}/workspace`, { path: "escape-abs" });
    assert.equal(escape.status, 400);
    assert.equal(escape.body.code, "path_escapes");

    const binary = await call(`/v1/runs/${run.id}/workspace`, { path: "logo.png" });
    assert.equal(binary.status, 415);
    assert.equal(binary.body.error, "binary, 6 bytes");
    assert.equal(binary.body.bytes, 6);
  });
});

test("a file over the cap is refused with its size and the cap", { skip }, async (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  writeFileSync(join(tree.root, "huge.log"), Buffer.alloc(MAX_WORKSPACE_FILE_BYTES + 1, 0x61));
  await withApi(async ({ pool, run, call, setState }) => {
    await seedMaker(pool, run, tree.handleId);
    await setState("PR_READY");
    const huge = await call(`/v1/runs/${run.id}/workspace`, { path: "huge.log" });
    assert.equal(huge.status, 413);
    assert.equal(huge.body.code, "file_too_large");
    assert.equal(huge.body.bytes, MAX_WORKSPACE_FILE_BYTES + 1);
    assert.equal(huge.body.cap, MAX_WORKSPACE_FILE_BYTES);
  });
});

test("no live maker, or a turn running, is 409 with the reason — and nothing is attached", { skip }, async (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  let attached = 0;
  const counting = new FakeSandboxProvider();
  const attach = counting.attach.bind(counting);
  counting.attach = async (options) => {
    attached += 1;
    return attach(options);
  };
  await withApi(
    async ({ pool, run, call, setState }) => {
      const expect = async (status, code, pattern) => {
        await setState(status);
        const result = await call(`/v1/runs/${run.id}/workspace`);
        assert.equal(result.status, 409, `${status}: ${JSON.stringify(result.body)}`);
        assert.equal(result.body.code, code, status);
        if (pattern) assert.match(result.body.error, pattern);
      };
      await expect("PLANNING", "no_workspace", /no maker sandbox has been made yet/);
      await expect("VERIFYING", "no_workspace", /no maker workspace recorded/);
      await seedMaker(pool, run, tree.handleId);
      await expect("IMPLEMENTING", "turn_running", /mid-turn/);
      await expect("REPAIRING", "turn_running", /between turns/);
      for (const terminal of ["COMPLETED", "CANCELLED", "FAILED", "MAX_REPAIR_ATTEMPTS_REACHED"]) {
        await expect(terminal, "run_terminal", /torn down/);
      }
      assert.equal(attached, 0, "a refusal by state never reaches the sandbox");

      await pool.query("update workspace set status = 'destroyed' where engineering_run_id = $1", [run.id]);
      await expect("PR_READY", "workspace_gone", /destroyed/);
      assert.equal(attached, 0, "a destroyed workspace is not looked for");

      await pool.query("update workspace set status = 'ready', provider_handle = 'reaped-already' where engineering_run_id = $1", [run.id]);
      await expect("WAITING_FOR_HUMAN", "workspace_gone", /couldn't attach/);
    },
    { sandboxes: async () => ({ fake: counting }) },
  );
});

test("a bad path is 400 before the sandbox token is read; no provider is 503", { skip }, async () => {
  let asked = 0;
  await withApi(
    async ({ run, call, setState }) => {
      await setState("VERIFYING");
      assert.equal((await call(`/v1/runs/${run.id}/workspace`, { path: "../x" })).status, 400);
      assert.equal(asked, 0);
      const unconfigured = await call(`/v1/runs/${run.id}/workspace`);
      assert.equal(unconfigured.status, 503);
      assert.equal(unconfigured.body.code, "sandbox_unconfigured");
      assert.equal((await call(`/v1/runs/00000000-0000-0000-0000-000000000000/workspace`)).status, 404);
    },
    {
      sandboxes: async () => {
        asked += 1;
        throw new Error("WINDKEEL_SANDBOX_TOKEN is not set");
      },
    },
  );
});

/**
 * A provider whose maker handle runs `during(n)` before the n-th command it runs: the run's state
 * moves while the sandbox is being read, which is the race a stale state snapshot let through.
 */
function movingProvider(during) {
  const provider = new FakeSandboxProvider();
  const attach = provider.attach.bind(provider);
  let n = 0;
  provider.attach = async (options) => {
    const handle = await attach(options);
    const exec = handle.exec.bind(handle);
    handle.exec = async (...args) => {
      n += 1;
      const outcome = await during(n);
      if (outcome === "throw") throw new Error("sandbox went away mid-read");
      return exec(...args);
    };
    return handle;
  };
  return provider;
}

test("a read the run moves under is discarded as 409 turn_running, never served", { skip }, async (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  let pool;
  let runId;
  let step = async () => undefined;
  const provider = movingProvider((n) => step(n));
  await withApi(
    async (ctx) => {
      pool = ctx.pool;
      runId = ctx.run.id;
      await seedMaker(ctx.pool, ctx.run, tree.handleId);
      await insertRunStateTransition(pool, { engineeringRunId: runId, fromState: "IMPLEMENTING", toState: "VERIFYING", reason: null });
      await ctx.setState("VERIFYING");

      // Unmoved: served.
      assert.equal((await ctx.call(`/v1/runs/${runId}/workspace`)).status, 200);

      // VERIFYING → REPAIRING while the command runs: the half-written tree is not served.
      step = async () => {
        await insertRunStateTransition(pool, { engineeringRunId: runId, fromState: "VERIFYING", toState: "REPAIRING", reason: "repair" });
        await ctx.setState("REPAIRING");
      };
      const repairing = await ctx.call(`/v1/runs/${runId}/workspace`, { path: "src/index.ts" });
      assert.equal(repairing.status, 409, JSON.stringify(repairing.body));
      assert.equal(repairing.body.code, "turn_running");
      assert.equal(repairing.body.content, undefined, "no file content comes back");

      // Out of a turn and back to the same readable state mid-read: the status matches, the
      // transition marker doesn't, and the result is discarded all the same.
      await ctx.setState("VERIFYING");
      step = async () => {
        await insertRunStateTransition(pool, { engineeringRunId: runId, fromState: "VERIFYING", toState: "REPAIRING", reason: "repair" });
        await insertRunStateTransition(pool, { engineeringRunId: runId, fromState: "REPAIRING", toState: "VERIFYING", reason: null });
      };
      const roundTrip = await ctx.call(`/v1/runs/${runId}/workspace`);
      assert.equal(roundTrip.status, 409, JSON.stringify(roundTrip.body));
      assert.equal(roundTrip.body.code, "turn_running");
      assert.match(roundTrip.body.error, /moved \(VERIFYING → VERIFYING\).*discarded/);

      // A command that fails because the run moved under it is the same 409, not a 500.
      step = async () => {
        await ctx.setState("REPAIRING");
        return "throw";
      };
      await ctx.setState("VERIFYING");
      const failed = await ctx.call(`/v1/runs/${runId}/workspace`);
      assert.equal(failed.status, 409);
      assert.equal(failed.body.code, "turn_running");

      // A run that moved between the handler's read and the attach is refused before the command.
      let ran = false;
      step = async () => {
        ran = true;
      };
      await ctx.setState("VERIFYING");
      const attach = provider.attach;
      provider.attach = async (options) => {
        const handle = await attach(options);
        await ctx.setState("IMPLEMENTING");
        return handle;
      };
      const raced = await ctx.call(`/v1/runs/${runId}/workspace`);
      provider.attach = attach;
      assert.equal(raced.status, 409);
      assert.equal(raced.body.code, "turn_running");
      assert.equal(ran, false, "the sandbox command never ran");
    },
    { sandboxes: async () => ({ fake: provider }) },
  );
});
