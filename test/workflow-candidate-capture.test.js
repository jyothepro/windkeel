import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { FakeSandboxProvider } from "../dist/sandbox/fake.js";
import { insertEngineeringRun, insertEngineeringTask, listWorkspaces } from "../dist/factory/repositories.js";
import { provisionWorkspace } from "../dist/factory/workspace-service.js";
import {
  UnsafePushError,
  assertRunBranch,
  captureCandidate,
  withoutMakerBrowserOutput,
  workingBranchFor,
} from "../dist/factory/workflow/handlers/candidate-capture.js";
import { bareFixtureRepo, seedFixtureRepository, tempDir, TEST_POOL } from "./helpers.js";
import { isGitPush } from "../dist/sandbox/lifecycle.js";
import { installGitCredential } from "../dist/sandbox/git-credentials.js";
import { createMigratedDatabase, dropMigratedDatabase } from "./migrated-db.js";

/**
 * `FakeSandboxProvider` clones a real local git repo into a real temp directory, and
 * `bareFixtureRepo` gives it a real bare remote — so real commits, real branches, and a real
 * `git push` all happen here with **no network and no `SANDBOX_GIT_TOKEN`**. Gating this
 * behaviour behind a credential nobody has locally would have meant never exercising the most
 * destructive code in M4.
 *
 * Postgres-gated because the idempotency guard is a `Workspace.working_branch` state check.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const skip = dbUrl ? false : "TEST_DATABASE_URL not set";

let counter = 0;

const CAPTURE_DEFAULTS = {
  modelApiDomain: "api.openai.com",
  credentialRules: [],
  gitHost: "github.com",
  authorName: "Windkeel Factory",
  authorEmail: "factory@windkeel.invalid",
};

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: result.stderr ?? "" };
}

async function withCapture(fn, options = {}) {
  const schema = `windkeel_capture_${Date.now()}_${process.pid}_${counter++}`;
  const schemaDbUrl = await createMigratedDatabase(schema);

  const pool = new Pool({ connectionString: schemaDbUrl, ...TEST_POOL, options: `-c search_path=${schema}` });
  const remote = bareFixtureRepo({ test: "node --test" });
  const sandboxes = new FakeSandboxProvider();
  let handle;
  try {
    await seedFixtureRepository(pool);
    const task = await insertEngineeringTask(pool, {
      repositoryId: "11111111-1111-1111-1111-111111111111",
      sourceType: "local",
      sourceReference: "m4.5",
      title: "t",
      description: "d",
      acceptanceCriteria: [],
      riskLevel: "low",
      priority: null,
      status: "OPEN",
    });
    const run = await insertEngineeringRun(pool, {
      taskId: task.id,
      spendCapUsd: 25,
      wallClockCapSeconds: 7200,
    });

    const provisioned = await provisionWorkspace(pool, sandboxes, {
      engineeringRunId: run.id,
      role: options.role ?? "maker",
      repository: remote.bare,
      baseSha: "HEAD",
    });
    handle = provisioned.handle;

    await fn({
      pool,
      remote,
      handle,
      runId: run.id,
      workspace: provisioned.workspace,
      capture: (overrides = {}) =>
        captureCandidate(pool, {
          ...CAPTURE_DEFAULTS,
          handle,
          workspace: overrides.workspace ?? provisioned.workspace,
          engineeringRunId: run.id,
          ...overrides,
        }),
    });
  } finally {
    await handle?.destroy().catch(() => {});
    await pool.end();
    await dropMigratedDatabase(schema);
  }
}

const DIFF = (files) => ({
  patch: files.map((f) => `--- a/${f}\n+++ b/${f}\n+changed\n`).join(""),
  filesChanged: files,
  truncated: false,
});

test("branch naming is deterministic from the run", () => {
  assert.equal(workingBranchFor("abc"), "windkeel/run/abc");
  assert.equal(workingBranchFor("abc"), workingBranchFor("abc"));
  assert.notEqual(workingBranchFor("abc"), workingBranchFor("def"));
});

test("assertRunBranch refuses main, another run's branch, and protected refs", () => {
  const runId = "11111111-1111-1111-1111-111111111111";
  assert.doesNotThrow(() => assertRunBranch(workingBranchFor(runId), runId));

  for (const bad of ["main", "master", "HEAD", "develop", workingBranchFor("some-other-run")]) {
    assert.throws(() => assertRunBranch(bad, runId), UnsafePushError, `expected ${bad} to be refused`);
  }
  // The namespaced form of a protected ref is refused too, so `windkeel/run/main` cannot sneak past
  // by satisfying the name check for a run whose id is literally "main".
  assert.throws(() => assertRunBranch("windkeel/run/main", "main"), UnsafePushError);
});

test(
  "a session that modifies a tracked file produces a candidate SHA a fresh clone reproduces",
  { skip },
  async () => {
    await withCapture(async ({ handle, remote, runId, capture }) => {
      await handle.writeFile("package.json", '{"name":"fixture","version":"9.9.9"}\n');

      const result = await capture({ diff: DIFF(["package.json"]) });

      assert.equal(result.empty, false);
      assert.match(result.candidateSha, /^[0-9a-f]{40}$/);
      assert.equal(result.workingBranch, workingBranchFor(runId));

      // A *fresh clone from the bare remote* — no access to the maker's filesystem, which is
      // the whole point of ADR-0004's independence requirement.
      const verifierCheckout = tempDir("verifier");
      assert.equal(
        git(".", "clone", "-q", "--branch", result.workingBranch, remote.bare, verifierCheckout)
          .status,
        0,
      );
      assert.equal(git(verifierCheckout, "rev-parse", "HEAD").stdout, result.candidateSha);
      assert.match(
        readFileSync(join(verifierCheckout, "package.json"), "utf8"),
        /9\.9\.9/,
        "the change is present at the candidate SHA",
      );
    });
  },
);

test("a session that creates an untracked file has it in the candidate commit", { skip }, async () => {
  await withCapture(async ({ handle, remote, capture }) => {
    // The M3.5 `git add -A -N` reasoning carried through to the commit: a plain `git commit -a`
    // would silently drop a brand-new module and its test.
    await handle.writeFile("new-module.js", "export const answer = 42;\n");

    const result = await capture({ diff: DIFF(["new-module.js"]) });

    const verifierCheckout = tempDir("verifier");
    git(".", "clone", "-q", "--branch", result.workingBranch, remote.bare, verifierCheckout);
    assert.equal(existsSync(join(verifierCheckout, "new-module.js")), true);
    assert.equal(git(verifierCheckout, "rev-parse", "HEAD").stdout, result.candidateSha);
  });
});

test("an agent that committed its own work still produces a candidate", { skip }, async () => {
  await withCapture(async ({ handle, remote, capture }) => {
    // src/worker/codex/result.ts diffs against the base revision rather than HEAD precisely
    // because "an agent that commits is unusual but entirely possible" — so this case arrives
    // here with a NON-empty WorkerDiff and nothing left to stage. Committing unconditionally
    // failed the whole run ("nothing to commit", exit 1) with a valid change on disk.
    const dir = handle.root;
    await handle.writeFile("agent-committed.txt", "the agent committed this itself\n");
    git(dir, "config", "user.email", "agent@example.invalid");
    git(dir, "config", "user.name", "Agent");
    git(dir, "add", "-A");
    assert.equal(git(dir, "commit", "-q", "-m", "agent's own commit").status, 0);

    const result = await capture({ diff: DIFF(["agent-committed.txt"]) });

    assert.equal(result.empty, false);
    assert.ok(result.candidateSha, "a self-committing agent must still yield a candidate sha");

    // The change is genuinely fetchable by an independent verifier (ADR-0004), which is the
    // whole point of the capture — not merely that the call returned without throwing.
    const verifierCheckout = tempDir("verifier");
    git(".", "clone", "-q", "--branch", result.workingBranch, remote.bare, verifierCheckout);
    assert.equal(
      readFileSync(join(verifierCheckout, "agent-committed.txt"), "utf8"),
      "the agent committed this itself\n",
    );
    assert.equal(git(verifierCheckout, "rev-parse", "HEAD").stdout, result.candidateSha);
  });
});

test("a session that changed nothing follows the stated empty-change policy", { skip }, async () => {
  await withCapture(async ({ remote, capture, pool, runId }) => {
    const result = await capture({ diff: { patch: "", filesChanged: [], truncated: false } });

    assert.deepEqual(
      {
        empty: result.empty,
        candidateSha: result.candidateSha,
        workingBranch: result.workingBranch,
      },
      { empty: true, candidateSha: null, workingBranch: null },
      "no crash on a null SHA — an empty change is a stated outcome, not an error",
    );

    // Nothing was pushed and nothing was recorded.
    assert.equal(git(remote.bare, "branch", "--list", workingBranchFor(runId)).stdout, "");
    const [workspace] = await listWorkspaces(pool, runId);
    assert.equal(workspace.workingBranch, null);
  });
});

test("a diff that could not be established is not treated as an empty change", { skip }, async () => {
  await withCapture(async ({ capture }) => {
    await assert.rejects(
      () =>
        capture({
          diff: { patch: "", filesChanged: [], truncated: false, error: "git diff exited 128" },
        }),
      /not trustworthy/,
    );
  });
});

test("a retried capture produces one branch and one commit, not two", { skip }, async () => {
  await withCapture(async ({ handle, remote, pool, runId, capture }) => {
    await handle.writeFile("package.json", '{"name":"fixture","version":"2.0.0"}\n');
    const first = await capture({ diff: DIFF(["package.json"]) });

    // At-least-once delivery: the same stage runs again, now seeing the row it already wrote.
    const [reread] = await listWorkspaces(pool, runId);
    assert.equal(reread.workingBranch, workingBranchFor(runId));
    const second = await capture({ diff: DIFF(["package.json"]), workspace: reread });

    assert.equal(second.candidateSha, first.candidateSha, "the same candidate, not a new commit");

    const branches = git(remote.bare, "branch", "--list", "windkeel/run/*").stdout;
    assert.equal(branches.split("\n").filter(Boolean).length, 1, `branches: ${branches}`);

    const verifierCheckout = tempDir("verifier");
    git(".", "clone", "-q", "--branch", first.workingBranch, remote.bare, verifierCheckout);
    const log = git(verifierCheckout, "log", "--oneline", "--format=%s").stdout.split("\n");
    assert.equal(
      log.filter((line) => line.startsWith("windkeel: candidate for run")).length,
      1,
      `one machine commit, got: ${log.join(" | ")}`,
    );
  });
});

test("the working branch is recorded on the Workspace row", { skip }, async () => {
  await withCapture(async ({ handle, pool, runId, capture }) => {
    await handle.writeFile("package.json", '{"name":"fixture","version":"3.0.0"}\n');
    await capture({ diff: DIFF(["package.json"]) });

    const [workspace] = await listWorkspaces(pool, runId);
    assert.equal(workspace.workingBranch, workingBranchFor(runId));
  });
});

test("the commit is obviously machine-authored and names its run", { skip }, async () => {
  await withCapture(async ({ handle, remote, runId, capture }) => {
    await handle.writeFile("package.json", '{"name":"fixture","version":"4.0.0"}\n');
    const result = await capture({ diff: DIFF(["package.json"]) });

    const checkout = tempDir("inspect");
    git(".", "clone", "-q", "--branch", result.workingBranch, remote.bare, checkout);
    assert.equal(git(checkout, "log", "-1", "--format=%an").stdout, "Windkeel Factory");
    assert.equal(git(checkout, "log", "-1", "--format=%ae").stdout, "factory@windkeel.invalid");
    assert.match(git(checkout, "log", "-1", "--format=%s").stdout, new RegExp(runId));
  });
});

test("a truncated diff is stored with its truncation marker intact", { skip }, async () => {
  const puts = [];
  const storage = {
    async putPackage(localDir, bucket, key) {
      puts.push({
        bucket,
        key,
        diff: readFileSync(join(localDir, "candidate.diff"), "utf8"),
        meta: JSON.parse(readFileSync(join(localDir, "candidate.json"), "utf8")),
      });
    },
    async deletePackage() {},
  };

  await withCapture(async ({ handle, capture }) => {
    await handle.writeFile("package.json", '{"name":"fixture","version":"5.0.0"}\n');
    const marker = "\n[windkeel] diff truncated: 9000000 bytes exceeds the 2000000-byte limit\n";
    const result = await capture({
      diff: {
        patch: `--- a/package.json\n+++ b/package.json\n+changed\n${marker}`,
        filesChanged: ["package.json"],
        truncated: true,
      },
      storage: { storage, bucket: "evidence" },
    });

    assert.equal(result.diffTruncated, true, "carried on the result, so a query can filter on it");
    assert.equal(puts.length, 1);
    assert.equal(puts[0].bucket, "evidence");
    assert.match(puts[0].key, new RegExp(`candidate/${result.candidateSha}$`));
    assert.match(puts[0].diff, /\[windkeel\] diff truncated/, "the marker survives storage");
    assert.equal(puts[0].meta.truncated, true, "and is a structured field, not only prose");
    assert.equal(puts[0].meta.candidate_sha, result.candidateSha);
  });
});

test("with no evidence store configured the patch is visibly not stored", { skip }, async () => {
  await withCapture(async ({ handle, capture }) => {
    await handle.writeFile("package.json", '{"name":"fixture","version":"6.0.0"}\n');
    const result = await capture({ diff: DIFF(["package.json"]) });
    assert.equal(result.diffRef, null, "null rather than a silently dropped patch");
  });
});

test(
  "a verifier-role sandbox cannot push a candidate — the ADR-0014 §2 guard still holds",
  { skip },
  async () => {
    await withCapture(
      async ({ handle, capture }) => {
        await handle.writeFile("package.json", '{"name":"fixture","version":"7.0.0"}\n');
        // Two independent refusals, and this asserts the *first* one: the role check inside
        // the capture. It exists because `runInExecutionPhase`'s guard is a best-effort argv
        // scan, and the most destructive code in M4 should not lean on best-effort.
        await assert.rejects(
          () => capture({ diff: DIFF(["package.json"]) }),
          /refusing to publish a candidate from a verifier-role sandbox/,
        );
      },
      { role: "verifier" },
    );
  },
);

test("the push goes through runInExecutionPhase, not a bare handle.exec", { skip }, async () => {
  await withCapture(async ({ handle, capture }) => {
    await handle.writeFile("package.json", '{"name":"fixture","version":"8.0.0"}\n');
    await capture({ diff: DIFF(["package.json"]) });

    // `runInExecutionPhase` always narrows the policy and re-applies broker rules before the
    // command; the sandbox timeline is what proves the push did not bypass it.
    // Argv-form `git push …`, deliberately *not* folded into an `sh -c` script: the verifier
    // push guard is a static argv scan whose own doc comment says it cannot see through a shell
    // string, so hiding the push inside one would have silently disarmed it.
    // `isGitPush` rather than `args[0] === "push"`: the push now leads with the hardening `-c`
    // pairs, and `isGitPush` is the same scan the verifier guard uses, so this also asserts the
    // guard still sees through them.
    const pushIndex = handle.calls.findIndex(
      (c) => c.type === "exec" && isGitPush(c.command, c.options),
    );
    assert.ok(pushIndex > 0, "the push is on the timeline");
    const before = handle.calls.slice(0, pushIndex);
    const policy = before.filter((c) => c.type === "policy").pop();
    assert.ok(policy, "a network policy was applied before the push");
    assert.deepEqual(
      [...policy.policy.allowedDomains].sort(),
      ["api.openai.com", "github.com"],
      "execution-phase egress, extended by exactly the git host and nothing else",
    );
    assert.ok(
      before.some((c) => c.type === "credentialBroker"),
      "and broker rules were re-applied",
    );
  });
});

// --- The checkout is hostile: hooks, repository config, stray processes, the token's window ---

/**
 * A hook that would prove it ran by leaving a file behind. Written exactly where an agent with a
 * shell in the checkout would write it.
 */
function plantHook(checkout, name, marker) {
  const path = join(checkout, ".git", "hooks", name);
  writeFileSync(path, `#!/bin/sh\necho ran > "${marker}"\n`);
  chmodSync(path, 0o755);
}

/**
 * A fake credential hook that really writes the token file through the real installer, so the
 * test can watch it appear and disappear.
 */
function fakeCredential(handle, token = "ghs_capture_test_token_value") {
  const written = [];
  return {
    written,
    token,
    install: async () => {
      const path = await installGitCredential(handle, "github.com", {
        username: "x-access-token",
        token,
        permission: "write",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      written.push(path);
      return path;
    },
  };
}

/** `FakeSandboxProvider` truthfully cannot sweep; these tests stand in a sandbox that can. */
function sweepable(handle, { ensured = true } = {}) {
  handle.terminateStrayProcesses = async () => {
    handle.calls.push({ type: "terminateStrayProcesses" });
    return ensured ? { ensured: true, killed: 0 } : { ensured: false, reason: "sweep could not confirm" };
  };
}

test("capture runs git with hooks disabled: a planted pre-commit and pre-push never run", { skip }, async () => {
  await withCapture(async ({ handle, remote, capture }) => {
    const markers = tempDir("hook-markers");
    for (const hook of ["pre-commit", "commit-msg", "post-commit", "post-checkout", "pre-push", "reference-transaction"]) {
      plantHook(handle.checkoutPath, hook, join(markers, hook));
    }
    await handle.writeFile("package.json", '{"name":"fixture","version":"5.0.0"}\n');

    const result = await capture({ diff: DIFF(["package.json"]) });
    assert.match(result.candidateSha, /^[0-9a-f]{40}$/);
    assert.equal(git(remote.bare, "rev-parse", result.workingBranch).stdout, result.candidateSha);

    for (const hook of ["pre-commit", "commit-msg", "post-commit", "post-checkout", "pre-push", "reference-transaction"]) {
      assert.ok(!existsSync(join(markers, hook)), `the ${hook} hook ran`);
    }

    // Every git the capture ran carried the hardening, and none read global or system config.
    const gits = handle.calls.filter((c) => c.type === "exec" && c.command === "git");
    assert.ok(gits.length >= 4, "commit, stage, push and rev-parse all go through argv-form git");
    for (const call of gits) {
      const args = call.options?.args ?? [];
      assert.ok(args.includes("core.hooksPath=/dev/null"), `unhardened git: ${args.join(" ")}`);
      assert.ok(args.includes("credential.helper="), "every configured helper is reset");
      assert.equal(call.options?.env?.GIT_CONFIG_NOSYSTEM, "1");
      assert.equal(call.options?.env?.GIT_CONFIG_GLOBAL, "/dev/null");
    }
    // The push goes to the workspace's repository, not to whatever `origin` now says.
    const push = gits.find((c) => isGitPush(c.command, c.options));
    assert.ok(push.options.args.includes(remote.bare), "pushed to the recorded repository URL");
    assert.ok(!push.options.args.includes("origin"));
  });
});

test("a .git/config that git -c cannot neutralize fails the capture closed", { skip }, async () => {
  const cases = [
    // A clean filter runs on `git add` for every matching file; `-c` has no "ignore filters".
    { key: "filter.evil.clean", attributes: "* filter=evil\n" },
    { key: "core.hooksPath" },
    { key: "core.fsmonitor" },
    { key: "credential.helper" },
    { key: "include.path" },
    { key: "url.https://github.com/attacker/.insteadOf", value: "https://github.com/" },
    { key: "diff.evil.textconv" },
    { key: "gpg.program" },
    { key: "core.sshCommand" },
    { key: "remote.origin.pushurl", value: "https://github.com/attacker/x" },
  ];
  for (const { key, value, attributes } of cases) {
    await withCapture(async ({ handle, remote, capture }) => {
      const marker = join(tempDir("config-marker"), "ran");
      const set = git(handle.checkoutPath, "config", "--local", key, value ?? `touch ${marker}`);
      assert.equal(set.status, 0, set.stderr);
      if (attributes) writeFileSync(join(handle.checkoutPath, ".gitattributes"), attributes);
      await handle.writeFile("package.json", '{"name":"fixture","version":"6.0.0"}\n');

      await assert.rejects(
        () => capture({ diff: DIFF(["package.json"]) }),
        (error) => {
          assert.match(error.message, /refusing to run git over this checkout/);
          assert.match(error.message, new RegExp(key.split(".")[0], "i"), "names the offending key");
          return true;
        },
        `${key} should be refused`,
      );
      assert.ok(!existsSync(marker), `${key}'s command ran`);
      assert.ok(
        !handle.calls.some((c) => c.type === "exec" && isGitPush(c.command, c.options)),
        "nothing was pushed",
      );
      assert.equal(git(remote.bare, "branch", "--list", "windkeel/*").stdout, "", "no branch on the remote");
    });
  }
});

test("a redirected .git (a gitdir file) is refused before git reads its config", { skip }, async () => {
  await withCapture(async ({ handle, capture }) => {
    // Move the real git dir away and leave a `gitdir:` pointer behind — the shape that would make
    // git read a config file the capture's check never looked at.
    const elsewhere = join(tempDir("elsewhere"), "real.git");
    renameSync(join(handle.checkoutPath, ".git"), elsewhere);
    writeFileSync(join(handle.checkoutPath, ".git"), `gitdir: ${elsewhere}\n`);
    await handle.writeFile("package.json", '{"name":"fixture","version":"6.1.0"}\n');
    await assert.rejects(() => capture({ diff: DIFF(["package.json"]) }), /git directory is not its own/);
  });
});

test("stray processes are stopped before the token is installed and before egress widens", { skip }, async () => {
  await withCapture(async ({ handle, remote, capture }) => {
    sweepable(handle);
    const credential = fakeCredential(handle);
    await handle.writeFile("package.json", '{"name":"fixture","version":"4.0.0"}\n');

    const result = await capture({ diff: DIFF(["package.json"]), installGitCredential: credential.install });
    assert.equal(git(remote.bare, "rev-parse", result.workingBranch).stdout, result.candidateSha);

    // Only the capture's own calls: provisioning's install-phase policy also names github.com.
    const calls = handle.calls.slice(
      handle.calls.findIndex((c) => c.type === "terminateStrayProcesses"),
    );
    const widened = calls.findIndex(
      (c) => c.type === "policy" && (c.policy.allowedDomains ?? []).includes("github.com"),
    );
    const firstGit = calls.findIndex((c) => c.type === "exec" && c.command === "git");
    const sweeps = calls.map((c, i) => (c.type === "terminateStrayProcesses" ? i : -1)).filter((i) => i >= 0);
    const tokenWrite = calls.findIndex((c) => c.type === "exec" && c.command === "chmod");
    assert.ok(widened > 0, "egress was widened for the push");
    assert.equal(sweeps.length, 2, "one sweep before reading git config, one before the token");
    assert.ok(sweeps[0] < firstGit, "the agent's processes are gone before git reads its config");
    assert.ok(sweeps[1] < tokenWrite, "and again before the token file exists");
    assert.ok(tokenWrite < widened, "the token is written only once the sandbox is quiet");
    assert.ok(
      !calls.slice(sweeps[1], widened).some((c) => c.type === "exec" && c.command === "sh"),
      "nothing but the credential write runs between the last sweep and the push",
    );

    // The token was there for the push and is gone after it — and egress is narrow again.
    assert.equal(credential.written.length, 1);
    assert.ok(!existsSync(credential.written[0]), "the credential file is removed after the push");
    const lastPolicy = calls.filter((c) => c.type === "policy").pop();
    assert.ok(!lastPolicy.policy.allowedDomains.includes("github.com"), "egress re-narrowed after the push");

    // The push named that file and nothing else as its helper; no global config was written.
    const push = calls.find((c) => c.type === "exec" && isGitPush(c.command, c.options));
    const helpers = push.options.args.filter((a) => a.startsWith("credential.helper="));
    assert.deepEqual(helpers, ["credential.helper=", `credential.helper=store --file ${credential.written[0]}`]);
    assert.ok(
      !calls.some((c) => c.type === "exec" && (c.options?.args ?? []).includes("--global")),
      "the token is never wired into global git config",
    );
  });
});

test("with a token to hand out, an unconfirmed sweep refuses the capture and installs nothing", { skip }, async () => {
  await withCapture(async ({ handle, capture }) => {
    sweepable(handle, { ensured: false });
    const credential = fakeCredential(handle);
    await handle.writeFile("package.json", '{"name":"fixture","version":"4.1.0"}\n');
    await assert.rejects(
      () => capture({ diff: DIFF(["package.json"]), installGitCredential: credential.install }),
      /refusing to continue .*sweep could not confirm/,
    );
    assert.equal(credential.written.length, 0, "no token was written");
    assert.ok(!handle.calls.some((c) => c.type === "exec" && isGitPush(c.command, c.options)));
  });
});

test("a failed push still removes the token", { skip }, async () => {
  await withCapture(async ({ handle, remote, capture }) => {
    sweepable(handle);
    const credential = fakeCredential(handle);
    // A remote that refuses every update: the push fails after the token has been installed.
    const hook = join(remote.bare, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    await handle.writeFile("package.json", '{"name":"fixture","version":"4.2.0"}\n');
    await assert.rejects(
      () => capture({ diff: DIFF(["package.json"]), installGitCredential: credential.install }),
      /could not push/,
    );
    assert.equal(credential.written.length, 1);
    assert.ok(!existsSync(credential.written[0]), "removed in the finally, not only on success");
  });
});

test("a remote named exactly like the push target cannot redirect the push", { skip }, async () => {
  for (const legacy of [false, true]) {
    await withCapture(async ({ handle, remote, capture }) => {
      // The attack (PR #356 review): git takes `<repository>` as a remote *name* first, so a
      // remote called "<the recorded URL>" would make `git push <recorded URL>` go elsewhere.
      const attacker = bareFixtureRepo({}).bare;
      if (legacy) {
        // The same thing through `$GIT_DIR/remotes/<name>`, which git still reads.
        const file = join(handle.checkoutPath, ".git", "remotes", ...remote.bare.split("/").filter(Boolean));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `URL: ${attacker}\n`);
      } else {
        assert.equal(git(handle.checkoutPath, "config", "--local", `remote.${remote.bare}.url`, attacker).status, 0);
      }
      await handle.writeFile("package.json", '{"name":"fixture","version":"6.2.0"}\n');
      await assert.rejects(() => capture({ diff: DIFF(["package.json"]) }), /refusing to run git over this checkout/);
      assert.equal(git(attacker, "branch", "--list", "windkeel/*").stdout, "", "nothing reached the attacker's remote");
    });
  }
});

test("a credential file that cannot be removed fails the capture after the push", { skip }, async () => {
  await withCapture(async ({ handle, capture }) => {
    sweepable(handle);
    const credential = fakeCredential(handle);
    const exec = handle.exec.bind(handle);
    handle.exec = (command, options) =>
      command === "rm"
        ? Promise.resolve({ status: 1, signal: null, stdout: "", stderr: "rm: Operation not permitted" })
        : exec(command, options);
    await handle.writeFile("package.json", '{"name":"fixture","version":"4.3.0"}\n');
    await assert.rejects(
      () => capture({ diff: DIFF(["package.json"]), installGitCredential: credential.install }),
      /could not confirm the git credential file was removed/,
    );
    // Egress was still narrowed despite the failure.
    const lastPolicy = handle.calls.filter((c) => c.type === "policy").pop();
    assert.ok(!lastPolicy.policy.allowedDomains.includes("github.com"));
    rmSync(credential.written[0], { force: true });
  });
});

// --- #392: the maker's screenshots never reach a candidate ---------------------------------

test("the maker's .windkeel/browser/ screenshots are not in the candidate, even ones the agent committed", { skip }, async () => {
  await withCapture(async ({ handle, remote, capture }) => {
    const dir = handle.root;
    mkdirSync(join(dir, ".windkeel", "browser"), { recursive: true });
    writeFileSync(join(dir, ".windkeel", "browser", "001-home.png"), "png");
    writeFileSync(join(dir, ".windkeel", "browser", "index.jsonl"), "{}\n");
    // The agent forces one past .git/info/exclude and commits it, alongside real work.
    writeFileSync(join(dir, ".windkeel", "browser", "002-forced.png"), "png");
    git(dir, "config", "user.email", "agent@example.invalid");
    git(dir, "config", "user.name", "Agent");
    git(dir, "add", "-f", ".windkeel/browser/002-forced.png");
    assert.equal(git(dir, "commit", "-q", "-m", "agent commits a screenshot").status, 0);
    await handle.writeFile("feature.js", "export const page = 1;\n");

    const result = await capture({
      diff: DIFF(["feature.js", ".windkeel/browser/001-home.png", ".windkeel/browser/002-forced.png", "./.windkeel/browser/index.jsonl"]),
    });
    assert.equal(result.empty, false);
    assert.deepEqual(result.filesChanged, ["feature.js"]);

    const checkout = tempDir("verifier");
    git(".", "clone", "-q", "--branch", result.workingBranch, remote.bare, checkout);
    assert.equal(existsSync(join(checkout, "feature.js")), true);
    assert.equal(existsSync(join(checkout, ".windkeel")), false, "no screenshot in the candidate's tree");
    assert.equal(git(checkout, "ls-tree", "-r", "--name-only", "HEAD").stdout.includes(".windkeel/"), false);
  });
});

test("a turn that only took screenshots is an empty change", { skip }, async () => {
  await withCapture(async ({ handle, remote, capture, runId }) => {
    mkdirSync(join(handle.root, ".windkeel", "browser"), { recursive: true });
    writeFileSync(join(handle.root, ".windkeel", "browser", "001-home.png"), "png");
    const result = await capture({
      diff: {
        patch: "diff --git a/.windkeel/browser/001-home.png b/.windkeel/browser/001-home.png\nBinary files differ\n",
        filesChanged: [".windkeel/browser/001-home.png"],
        truncated: false,
      },
    });
    assert.equal(result.empty, true);
    assert.equal(result.candidateSha, null);
    assert.equal(git(remote.bare, "branch", "--list", workingBranchFor(runId)).stdout, "", "nothing was pushed");
  });
});

test("a mixed diff's recorded patch loses its .windkeel/browser/ sections and keeps the rest", () => {
  const feature = "diff --git a/feature.js b/feature.js\n--- a/feature.js\n+++ b/feature.js\n@@ -0,0 +1 @@\n+x\n";
  const shot = "diff --git a/.windkeel/browser/001-home.png b/.windkeel/browser/001-home.png\nBinary files differ\n";
  const index = "diff --git a/.windkeel/browser/index.jsonl b/.windkeel/browser/index.jsonl\n+{}\n";
  const out = withoutMakerBrowserOutput({
    patch: `${shot}${feature}${index}`,
    filesChanged: [".windkeel/browser/001-home.png", "feature.js", ".windkeel/browser/index.jsonl"],
    truncated: false,
  });
  assert.deepEqual(out.filesChanged, ["feature.js"]);
  assert.equal(out.patch, feature);
});
