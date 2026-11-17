import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalExecutionEnvironment } from "@windkeel/verification/exec/local.js";
import {
  BUNDLE_REF,
  commitAndBundle,
  findSurvivors,
  githubPushTokenIssuer,
  HumanPushError,
  personAuthor,
  pushVerifiedBundle,
  verifyBundle,
} from "../dist/factory/human-push.js";

/**
 * ADR-0029 §3.6 as amended after Spike B (#368): the person's commit leaves the human workspace as
 * a git bundle; the API host verifies it *before any token exists*, pushes with a just-in-time
 * token, and revokes the token whatever happens. Git is real throughout — a bare `file://` remote,
 * a workspace checkout, a host repository — because author lines, parents and what landed on the
 * remote are exactly what a fake git would get wrong.
 */

const BRANCH = "windkeel/run-r1";
const WINDKEEL = { name: "Windkeel", email: "factory@windkeel.invalid" };
const PERSON = { githubId: 583231, login: "octocat", name: "The Octocat" };
const PERSON_EMAIL = "583231+octocat@users.noreply.github.com";
const TOKEN = "ghs_JIT_TOKEN_VALUE_never_in_the_vm";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "windkeel-human-push-"));
  const remote = join(root, "remote.git");
  const checkout = join(root, "work");
  git(root, "init", "-q", "--bare", remote);
  git(root, "init", "-q", checkout);
  writeFileSync(join(checkout, ".gitignore"), ".env\n");
  writeFileSync(join(checkout, "a.ts"), "export const a = 1;\n".repeat(50));
  git(checkout, "add", "-A");
  git(checkout, "-c", "user.name=Windkeel", "-c", `user.email=${WINDKEEL.email}`, "commit", "-q", "-m", "base");
  const baseSha = git(checkout, "rev-parse", "HEAD");
  writeFileSync(join(checkout, "b.ts"), "export const b = 1;\n");
  git(checkout, "add", "-A");
  git(checkout, "-c", "user.name=Windkeel", "-c", `user.email=${WINDKEEL.email}`, "commit", "-q", "-m", "maker candidate");
  const seedSha = git(checkout, "rev-parse", "HEAD");
  git(checkout, "push", "-q", remote, `HEAD:refs/heads/${BRANCH}`);
  return { root, remote, checkout, baseSha, seedSha };
}

/** The workspace as `commitAndBundle` sees it, recording every exec and write. */
function workspaceOver(checkout) {
  const local = new LocalExecutionEnvironment();
  const record = { execs: [], writes: [] };
  return {
    record,
    exec: async (command, options = {}) => {
      record.execs.push({ command, args: options.args ?? [], env: options.env ?? {} });
      return local.exec(command, { cwd: checkout, ...options });
    },
    readFile: async (path) => readFileSync(path),
    writeFile: async (path, data) => {
      record.writes.push({ path, data: String(data) });
      writeFileSync(path, data);
    },
    exists: async (path) => existsSync(path),
    mkdtemp: async (prefix) => mkdtempSync(join(tmpdir(), prefix)),
  };
}

function quietProcesses(survivors = []) {
  return {
    sweeps: 0,
    async sweep() {
      this.sweeps += 1;
      return { ensured: true, killed: 0 };
    },
    async snapshot() {
      return { self: [], processes: survivors };
    },
  };
}

function issuer(log, options = {}) {
  return {
    minted: 0,
    revoked: 0,
    async mint(request) {
      log.push(`mint:${request.purpose}`);
      this.minted += 1;
      return { username: "x-access-token", token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    },
    async revoke(token) {
      log.push("revoke");
      this.revoked += 1;
      assert.equal(token.token, TOKEN);
      if (options.revokeFails) throw new Error("GitHub answered 500");
    },
  };
}

function hostRecorder(log) {
  const local = new LocalExecutionEnvironment();
  const execs = [];
  const exec = async (command, options = {}) => {
    execs.push({ args: options.args ?? [], env: options.env ?? {} });
    const sub = (options.args ?? []).find((a) => ["fetch", "push", "index-pack", "verify-pack"].includes(a));
    if (sub) log.push(`host:${sub}`);
    return local.exec(command, options);
  };
  exec.execs = execs;
  return exec;
}

async function personBundle(f, edit = () => writeFileSync(join(f.checkout, "a.ts"), "export const a = 2;\n")) {
  edit();
  const workspace = workspaceOver(f.checkout);
  const processes = quietProcesses();
  const result = await commitAndBundle({
    runId: "r1",
    workspace,
    processes,
    policy: { personUids: [1001], baseline: [] },
    checkoutPath: f.checkout,
    seedSha: f.seedSha,
    person: PERSON,
    windkeel: WINDKEEL,
  });
  return { result, workspace, processes };
}

// --- in the workspace -------------------------------------------------------------------------

test("commitAndBundle: one commit on the seed, authored by the person, committed by Windkeel; ignored files stay", async () => {
  const f = fixture();
  writeFileSync(join(f.checkout, ".env"), "SECRET=1\n");
  const { result, processes } = await personBundle(f, () => {
    writeFileSync(join(f.checkout, "a.ts"), "export const a = 2;\n");
    mkdirSync(join(f.checkout, "src"), { recursive: true });
    writeFileSync(join(f.checkout, "src", "new.ts"), "export {};\n");
  });
  assert.equal(result.kind, "bundle");
  assert.equal(processes.sweeps, 2, "swept before the commit and again after it");
  assert.equal(git(f.checkout, "log", "-1", "--format=%P", result.sha), f.seedSha);
  assert.equal(git(f.checkout, "log", "-1", "--format=%an <%ae>", result.sha), `The Octocat <${PERSON_EMAIL}>`);
  assert.equal(git(f.checkout, "log", "-1", "--format=%cn <%ce>", result.sha), `Windkeel <${WINDKEEL.email}>`);
  assert.ok(!git(f.checkout, "ls-tree", "-r", "--name-only", result.sha).includes(".env"), "an ignored file is never committed");
  const header = result.bundle.subarray(0, result.bundle.indexOf("\n\n")).toString();
  assert.equal(header, `# v2 git bundle\n-${f.seedSha} seed\n${result.sha} ${BUNDLE_REF}`);
});

test("commitAndBundle: nothing changed is empty, and nothing is bundled", async () => {
  const f = fixture();
  const { result } = await personBundle(f, () => {});
  assert.deepEqual({ kind: result.kind, sha: result.sha }, { kind: "empty", sha: f.seedSha });
});

test("commitAndBundle: a survivor of the person's uid stops it before git runs", async () => {
  const f = fixture();
  writeFileSync(join(f.checkout, "a.ts"), "x\n");
  const survivor = { pid: 40, ppid: 1, uid: 1001, state: "S", startTime: "9", comm: "node" };
  await assert.rejects(
    commitAndBundle({
      runId: "r1",
      workspace: workspaceOver(f.checkout),
      processes: quietProcesses([survivor]),
      policy: { personUids: [1001], baseline: [] },
      checkoutPath: f.checkout,
      seedSha: f.seedSha,
      person: PERSON,
      windkeel: WINDKEEL,
    }),
    (e) => e instanceof HumanPushError && e.stage === "survivors",
  );
  assert.equal(findSurvivors({ self: [], processes: [survivor] }, { personUids: [1001], baseline: [] })[0].reason, "person-uid");
});

test("commitAndBundle: the session is closed before anything else", async () => {
  const f = fixture();
  writeFileSync(join(f.checkout, "a.ts"), "x\n");
  const order = [];
  const processes = quietProcesses();
  const sweep = processes.sweep.bind(processes);
  processes.sweep = async () => {
    order.push("sweep");
    return sweep();
  };
  await commitAndBundle({
    runId: "r1",
    workspace: workspaceOver(f.checkout),
    processes,
    policy: { personUids: [1001], baseline: [] },
    checkoutPath: f.checkout,
    seedSha: f.seedSha,
    person: PERSON,
    windkeel: WINDKEEL,
    closeSession: async () => order.push("close"),
  });
  assert.deepEqual(order.slice(0, 2), ["close", "sweep"]);
});

test("personAuthor refuses a bad login or id and an email equal to Windkeel's", () => {
  assert.throws(() => personAuthor({ githubId: 1, login: "bad login" }, WINDKEEL), /not a GitHub login/);
  assert.throws(() => personAuthor({ githubId: 0, login: "ok" }, WINDKEEL), /not a GitHub user id/);
  assert.throws(
    () => personAuthor({ githubId: 1, login: "windkeel" }, { name: "Windkeel", email: "1+windkeel@users.noreply.github.com" }),
    /WINDKEEL_GIT_AUTHOR_EMAIL/,
  );
  assert.deepEqual(personAuthor(PERSON, WINDKEEL), { name: "The Octocat", email: PERSON_EMAIL });
});

// --- on the host: verification refusals, all before any token exists ---------------------------

/** Builds a bundle the way an attacker in the VM could: any commits, any header. */
function craftedBundle(f, { commits = 1, parent, authorEmail = PERSON_EMAIL, thin = false, prerequisite } = {}) {
  let tip = parent ?? f.seedSha;
  for (let i = 0; i < commits; i += 1) {
    // A one-line change to a large file, so a thin pack really does delta against the seed's blob.
    writeFileSync(join(f.checkout, "a.ts"), "export const a = 1;\n".repeat(50) + `export const z = ${100 + i};\n`);
    git(f.checkout, "add", "-A");
    const tree = git(f.checkout, "write-tree");
    tip = execFileSync("git", ["commit-tree", tree, "-p", tip, "-m", `c${i}`], {
      cwd: f.checkout,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "The Octocat",
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_COMMITTER_NAME: WINDKEEL.name,
        GIT_COMMITTER_EMAIL: WINDKEEL.email,
      },
    }).trim();
  }
  if (thin) {
    git(f.checkout, "update-ref", BUNDLE_REF, tip);
    const out = join(f.root, "thin.bundle");
    git(f.checkout, "bundle", "create", out, BUNDLE_REF, `^${f.seedSha}`);
    return { bundle: readFileSync(out), tip };
  }
  const base = join(mkdtempSync(join(tmpdir(), "crafted-")), "p");
  const hash = execFileSync("git", ["pack-objects", "--revs", "-q", base], {
    cwd: f.checkout,
    input: `${tip}\n^${f.seedSha}\n`,
    encoding: "utf8",
  }).trim();
  const pack = readFileSync(`${base}-${hash}.pack`);
  const header = `# v2 git bundle\n-${prerequisite ?? f.seedSha} seed\n${tip} ${BUNDLE_REF}\n\n`;
  return { bundle: Buffer.concat([Buffer.from(header), pack]), tip };
}

async function refusal(f, bundle, pattern) {
  await assert.rejects(
    verifyBundle({ bundle, seedSha: f.seedSha, person: PERSON, windkeel: WINDKEEL }),
    (e) => e instanceof HumanPushError && e.stage === "verify" && pattern.test(e.message),
  );
}

test("verifyBundle refuses two commits", async () => {
  const f = fixture();
  await refusal(f, craftedBundle(f, { commits: 2 }).bundle, /exactly one commit \(it carries 2\)/);
});

test("verifyBundle refuses a commit whose parent is not the seed", async () => {
  const f = fixture();
  // Parent is the base (an ancestor of the seed): the pack still holds one commit.
  await refusal(f, craftedBundle(f, { parent: f.baseSha }).bundle, /parent must be exactly the seed/);
});

test("verifyBundle refuses a commit authored as Windkeel", async () => {
  const f = fixture();
  await refusal(f, craftedBundle(f, { authorEmail: WINDKEEL.email }).bundle, /authored as Windkeel/);
});

test("verifyBundle refuses a commit authored as anyone but the person", async () => {
  const f = fixture();
  await refusal(f, craftedBundle(f, { authorEmail: "1+mallory@users.noreply.github.com" }).bundle, /does not match: author/);
});

test("verifyBundle refuses a bundle that builds on something other than the seed, and a thin pack", async () => {
  const f = fixture();
  await refusal(f, craftedBundle(f, { prerequisite: f.baseSha }).bundle, /exactly the seed candidate/);
  await refusal(f, craftedBundle(f, { thin: true }).bundle, /does not index on its own/);
  await refusal(f, Buffer.from("not a bundle"), /no header/);
});

// --- the push window ---------------------------------------------------------------------------

test("verify, then mint, then push, then revoke — and the token is only ever in host git's environment", async () => {
  const f = fixture();
  const { result, workspace } = await personBundle(f);
  const log = [];
  const tokens = issuer(log);
  const host = hostRecorder(log);
  const verified = await verifyBundle({ bundle: result.bundle, seedSha: f.seedSha, person: PERSON, windkeel: WINDKEEL, host });
  log.push("verified");
  const pushed = await pushVerifiedBundle({
    verified,
    seedSha: f.seedSha,
    repositoryUrl: f.remote,
    branch: BRANCH,
    runId: "r1",
    tokens,
    host,
  });
  assert.equal(pushed.sha, result.sha);
  assert.equal(pushed.revokeError, null);
  assert.equal(git(f.remote, "rev-parse", `refs/heads/${BRANCH}`), result.sha, "the branch holds the person's commit");
  const at = (entry) => log.findIndex((e) => e.startsWith(entry));
  assert.ok(at("verified") < at("mint:"), "no token exists until the bundle is verified");
  assert.ok(at("mint:") < at("host:fetch") && at("host:fetch") < at("host:push") && at("host:push") < at("revoke"));
  assert.equal(tokens.revoked, 1, "revoked as soon as the push returned");
  assert.ok(!existsSync(verified.repoDir), "the host repository is removed");

  // Never in the VM: no exec argument, no exec environment, no file written there.
  const inVm = JSON.stringify(workspace.record);
  assert.ok(!inVm.includes(TOKEN), "the push token never entered the workspace");
  // And on the host never in argv.
  assert.ok(host.execs.every((e) => !e.args.join(" ").includes(TOKEN)), "never in a host argv");
});

test("the push lands only if the branch still holds the seed; the token is revoked anyway", async () => {
  const f = fixture();
  const { result } = await personBundle(f);
  // Someone advanced the run branch after the workspace was seeded.
  const other = join(f.root, "other");
  git(f.root, "clone", "-q", "-b", BRANCH, f.remote, other);
  writeFileSync(join(other, "c.ts"), "moved\n");
  git(other, "add", "-A");
  git(other, "-c", "user.name=x", "-c", "user.email=x@y", "commit", "-q", "-m", "moved");
  git(other, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
  const moved = git(f.remote, "rev-parse", `refs/heads/${BRANCH}`);

  const log = [];
  const tokens = issuer(log);
  const verified = await verifyBundle({ bundle: result.bundle, seedSha: f.seedSha, person: PERSON, windkeel: WINDKEEL });
  await assert.rejects(
    pushVerifiedBundle({ verified, seedSha: f.seedSha, repositoryUrl: f.remote, branch: BRANCH, runId: "r1", tokens }),
    (e) => e instanceof HumanPushError && e.stage === "branch-moved",
  );
  assert.equal(git(f.remote, "rev-parse", `refs/heads/${BRANCH}`), moved, "nothing was pushed");
  assert.equal(tokens.revoked, 1, "revoke-on-failure");
});

/** Host git that runs `between` once, right before the push — the window after the head check. */
function hostWithRace(between) {
  const local = new LocalExecutionEnvironment();
  let raced = false;
  return async (command, options = {}) => {
    if (!raced && (options.args ?? []).includes("push")) {
      raced = true;
      between();
    }
    return local.exec(command, options);
  };
}

for (const [name, race] of [
  ["deleted", (f) => git(f.remote, "update-ref", "-d", `refs/heads/${BRANCH}`)],
  ["rewound", (f) => git(f.remote, "update-ref", `refs/heads/${BRANCH}`, f.baseSha)],
]) {
  test(`a branch ${name} between the head check and the push is refused by the lease, not ${name === "deleted" ? "recreated" : "fast-forwarded"}`, async () => {
    const f = fixture();
    const { result } = await personBundle(f);
    const tokens = issuer([]);
    const verified = await verifyBundle({ bundle: result.bundle, seedSha: f.seedSha, person: PERSON, windkeel: WINDKEEL });
    await assert.rejects(
      pushVerifiedBundle({ verified, seedSha: f.seedSha, repositoryUrl: f.remote, branch: BRANCH, runId: "r1", tokens, host: hostWithRace(() => race(f)) }),
      (e) => e instanceof HumanPushError && e.stage === "branch-moved" && /between the check and the push/.test(e.message),
    );
    const after = execFileSync("git", ["for-each-ref", "--format=%(objectname)", `refs/heads/${BRANCH}`], { cwd: f.remote, encoding: "utf8" }).trim();
    assert.equal(after, name === "deleted" ? "" : f.baseSha, `the branch stays ${name}; the person's commit did not land`);
    assert.equal(tokens.revoked, 1, "revoked anyway");
  });
}

test("a push that landed before the worker recorded it is recognised on redelivery by its recorded SHA, and not pushed again", async () => {
  const f = fixture();
  const date = new Date("2026-10-17T12:00:00Z");
  // The same worktree and the same pinned date build the very same commit on a redelivery.
  writeFileSync(join(f.checkout, "a.ts"), "export const a = 2;\n");
  const build = () =>
    commitAndBundle({
      runId: "r1",
      workspace: workspaceOver(f.checkout),
      processes: quietProcesses(),
      policy: { personUids: [1001], baseline: [] },
      checkoutPath: f.checkout,
      seedSha: f.seedSha,
      person: PERSON,
      windkeel: WINDKEEL,
      date,
    });
  const once = await build();
  const again = await build();
  assert.equal(again.sha, once.sha, "deterministic with a pinned date");

  const first = await verifyBundle({ bundle: once.bundle, seedSha: f.seedSha, person: PERSON, windkeel: WINDKEEL });
  await pushVerifiedBundle({ verified: first, seedSha: f.seedSha, repositoryUrl: f.remote, branch: BRANCH, runId: "r1", tokens: issuer([]), landed: null });
  assert.equal(git(f.remote, "rev-parse", `refs/heads/${BRANCH}`), once.sha);

  // The worker died here. The redelivery rebuilds, re-verifies, and finds the branch at the marker.
  const log = [];
  const host = hostRecorder(log);
  const second = await verifyBundle({ bundle: again.bundle, seedSha: f.seedSha, person: PERSON, windkeel: WINDKEEL, host });
  const redelivered = await pushVerifiedBundle({ verified: second, seedSha: f.seedSha, repositoryUrl: f.remote, branch: BRANCH, runId: "r1", tokens: issuer(log), host, landed: once.sha });
  assert.equal(redelivered.sha, once.sha);
  assert.equal(redelivered.alreadyLanded, true);
  assert.ok(!log.includes("host:push"), "nothing pushed again");
  assert.ok(log.includes("revoke"), "the token is still revoked");

  // Without the marker the same head is the branch having moved: the marker is what makes it ours.
  const third = await verifyBundle({ bundle: again.bundle, seedSha: f.seedSha, person: PERSON, windkeel: WINDKEEL });
  await assert.rejects(
    pushVerifiedBundle({ verified: third, seedSha: f.seedSha, repositoryUrl: f.remote, branch: BRANCH, runId: "r1", tokens: issuer([]), landed: null }),
    (e) => e instanceof HumanPushError && e.stage === "branch-moved",
  );
});

test("a push failure and a revoke failure are both reported; a revoke failure after a push is not hidden", async () => {
  const f = fixture();
  const { result } = await personBundle(f);
  const log = [];
  const verified = await verifyBundle({ bundle: result.bundle, seedSha: f.seedSha, person: PERSON, windkeel: WINDKEEL });
  const failing = await assert.rejects(
    pushVerifiedBundle({
      verified,
      seedSha: f.seedSha,
      repositoryUrl: join(f.root, "no-such-remote.git"),
      branch: BRANCH,
      runId: "r1",
      tokens: issuer(log, { revokeFails: true }),
    }),
    (e) => e instanceof HumanPushError && e.cleanup.length === 1 && /revoke-token/.test(e.message),
  );
  void failing;

  const f2 = fixture();
  const second = await personBundle(f2);
  const verified2 = await verifyBundle({ bundle: second.result.bundle, seedSha: f2.seedSha, person: PERSON, windkeel: WINDKEEL });
  const pushed = await pushVerifiedBundle({
    verified: verified2,
    seedSha: f2.seedSha,
    repositoryUrl: f2.remote,
    branch: BRANCH,
    runId: "r1",
    tokens: issuer([], { revokeFails: true }),
  });
  assert.match(pushed.revokeError, /500/);
});

test("githubPushTokenIssuer mints contents:write for the one repository and revokes with DELETE /installation/token as the token", async () => {
  const calls = [];
  const github = {
    async mintInstallationToken(input) {
      calls.push(input);
      return { token: "ghs_x", expiresAt: "2030-01-01T00:00:00Z" };
    },
  };
  const requests = [];
  const tokens = githubPushTokenIssuer(github, {
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { status: 204 };
    },
  });
  const token = await tokens.mint({ repositoryUrl: "https://github.com/acme/widgets.git", branch: "b", purpose: "p" });
  assert.deepEqual(calls, [{ repository: { owner: "acme", name: "widgets" }, permissions: { contents: "write" } }]);
  await tokens.revoke(token);
  assert.equal(requests[0].url, "https://api.github.com/installation/token");
  assert.equal(requests[0].init.method, "DELETE");
  assert.equal(requests[0].init.headers.authorization, "token ghs_x");
  const failing = githubPushTokenIssuer(github, { fetch: async () => ({ status: 401 }) });
  await assert.rejects(failing.revoke(token), /401/);
});
