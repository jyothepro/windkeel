# Spike B: sweep-then-push as the person from a human workspace (#368)

This spike covers ADR-0029 §3 steps 6–7 (*Submit for verification* and *Hand back to Windkeel*) and
flip condition 3. Date: 2026-10-17.

## Verdict (short)

- **The order works, and it's tested.** The order is:
  1. close the session;
  2. sweep;
  3. enumerate;
  4. check config;
  5. commit as the person;
  6. sweep and enumerate again;
  7. mint the token;
  8. push;
  9. remove the token;
  10. revoke it;
  11. confirm the remote head.

  It's built (`sweep-then-push.ts`) and tested against fakes with real git: 27 tests, all pass.
- **The token's safety doesn't come from the order.** It comes from whether the person can become
  root. Today's image gives the default user passwordless `sudo`, and a person in a terminal will
  use it (`sudo apt install …`). The sweep and the enumeration catch a root *process*. They can't
  catch *persistent* root changes, and any one of these takes the token during the push window:
  - a replaced `/usr/bin/git`;
  - `/etc/ld.so.preload`;
  - an `/etc/hosts` entry plus a CA in the trust store;
  - a tampered platform daemon.
- **Flip condition 3: can't be signed off as ADR-0029 §3 step 6 is written.** As written, the token
  is minted into a VM where the person may hold root. Condition 3 *can* be signed off, pending the
  audit and one live run, if §3 step 6 is amended to one of:
  1. **Preferred: the token never enters the human workspace.** Commit in the workspace, which needs
     no token. Read the commit out as a `git bundle` through the file API. Push from the API host.
     ADR-0014 already names this fix for the maker, and the human workspace needs it more.
  2. **Fallback: the person runs as a separate user without sudo** (`Sandbox.createUser`). Git and
     the token run as a user the person can't become. Keep the sweep, the baseline enumeration and
     the scheduler check from this spike.

## Live or not

**Not run live.** No `VERCEL_*` variables were set in the environment this spike was written in.
They exist in the main checkout's `.env`, but the instructions said to use the environment only.
Nothing here is a live result. `live-vercel.ts` is ready for a human to run:

```sh
npx tsc -p research/spikes/sweep-then-push
VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… \
  node research/spikes/sweep-then-push/.build/research/spikes/sweep-then-push/live-vercel.js
```

The harness creates one sandbox with a 10-minute timeout and stops it at the end. It pushes over
`file://` to a bare repository *inside* the sandbox. A fake token issuer hands out a canary value,
so no GitHub and no real token are involved. It prints a JSON report for three scenarios:

| Scenario | Expect |
|---|---|
| A, single-user (today's image) | The person plants a `setsid` daemon, a `nohup` loop that copies `/tmp/windkeel-push-*` to `/tmp/stolen`, a double fork, hooks, and staged, unstaged, untracked and ignored edits. Expect `pushed`, `hooksRan: ""`, `stolen: false`, `tokenFilesLeft: ""`, `remoteHead` equal to `result.candidateSha`, and `afterSurvivors: []`. |
| B, root survivor | Run `sudo setsid sleep` after the baseline. Expect `error` at `survivors` (`not-in-baseline`) and an empty `tokenLog`. |
| C, two-user | `createUser("person")`. This answers the two questions the spike couldn't: `personHasSudo` and `personCanReadWindkeelFile` must both be `false`. Then the sweep runs as the person and git runs as root. Expect `pushed`. |

The `environment` entry records `id`, the kernel, `ptrace_scope`, and whether any cron directories
exist.

These also stay unverified until that run:
- the `/proc` enumeration script (`PROCESS_ENUMERATION`);
- running `STRAY_PROCESS_SWEEP` under `sudo -u person`;
- whether the baseline is stable. If the platform starts root processes of its own between hand-off
  and submit, the baseline check has false positives and needs an allow-list by `comm`.

## How to run the tests

```sh
npm ci && npm run build -w @windkeel/verification
npx tsc -p research/spikes/sweep-then-push
node --test research/spikes/sweep-then-push/.build/research/spikes/sweep-then-push/*.test.js
```

Git is real: the tests use a temp checkout and a bare `file://` remote, through
`LocalExecutionEnvironment`. Processes and the token issuer are fakes. Everything logs to one shared
array, so the tests can assert *order*.

- **Order.**
  - The token is minted only after the last sweep and the last enumeration.
  - The session is closed before anything else.
  - The commit happens between the two sweeps.
  - The push comes before removing the token, and removing comes before revoking.
  - The full sequence of trace events is pinned.
- **The sweep and the enumeration fail closed.**
  - An unconfirmed sweep stops everything before git runs. That includes the local-mode `noSandbox`
    answer, which the maker accepts.
  - A survivor with the person's uid aborts the push. The tests use a `setsid` daemon reparented to
    init, both before the commit and when it appears only at the final enumeration.
  - A new root process that isn't in the baseline aborts the push.
  - A running `crond` aborts the push.
  - Ancestry, kernel threads, zombies and reused pids are handled.
- **Identity.**
  - The author is `The Octocat <583231+octocat@users.noreply.github.com>`, the committer is Windkeel,
    and the parent is the seed.
  - Commits the person made in the terminal are folded into one commit authored by the person. One
    of those commits is authored as `WINDKEEL_GIT_AUTHOR_EMAIL`.
  - `personAuthor` refuses a bad login, a bad id, and an email that collides with Windkeel's.
- **What gets pushed.**
  - Staged, unstaged and untracked edits are pushed, and where they differ the worktree version wins.
  - The ignored `.env` isn't pushed.
  - A write after the commit is refused at `tree`. The test simulates an editor autosave that
    survived.
  - With no change, no token is minted.
  - Gitlinks are refused.
  - Planted hooks never run. The tests cover `pre-commit`, `commit-msg`, `post-commit`, `pre-push`,
    `reference-transaction` and `post-index-change`.
  - `include.path`, `core.hooksPath`, `alias.*`, `url.*.insteadOf` and `filter.*.clean` each fail at
    `git-config`, and no token is minted.
- **The token.**
  - It reaches the workspace only as a file named `push-<run>-<sha12>`, outside the checkout, with
    `chmod 600`. It's never in argv.
  - Repository credential helpers are reset before `store --file`, and the push is never forced:
    it carries `--force-with-lease=refs/heads/<branch>:<seed>`.
  - The file's path is recorded before anything is written to it, so a `chmod` failure after the
    write still removes the file and revokes the token (tested).
  - A throwing `trace` callback is swallowed; it cannot skip removal and revocation (tested).
  - The token is revoked as well as deleted.
  - If the push fails because the branch moved, was deleted, or was rewound to an ancestor of the
    seed since hand-off, the push is refused and the token is still removed and revoked.
  - If `rm` fails, that's an error, and the token is still revoked.
  - A push failure and a revoke failure are both reported.
  - A remote head that doesn't match fails at `remote-head`.

## Design

`sweepThenPush(input)` in `sweep-then-push.ts` reuses existing code rather than copying it:
- `assertSafeGitConfig`, `hardenedGit` and the `HARDENED_GIT_*` settings from
  `src/sandbox/git-hardening.ts`;
- the `ProcessSweep` contract from `src/sandbox/provider.ts`;
- `STRAY_PROCESS_SWEEP` from `src/sandbox/vercel.ts`, which the live adapter imports.

Nothing in `src/` was changed. The steps:

0. **`closeSession()`.** The API revokes the workspace's capability token (ADR-0029 §4). This has to
   come before the sweep, or the console can reconnect and start a shell the sweep never saw.
1. **Sweep every process of the person's uid(s).** This is `terminateStrayProcesses`' own script:
   `SIGSTOP` everything, then `SIGKILL`, in passes. An unconfirmed sweep fails closed. Unlike the
   maker's capture, there's no `noSandbox` exception, because a human workspace is always a real
   sandbox.
2. **Enumerate independently.** `findSurvivors` runs over a `/proc` listing taken as root. It fails
   on any of these:
   - a process with a person uid that isn't a zombie and isn't in the enumerator's own ancestry;
   - a process of another uid whose `(pid, starttime)` wasn't in the **baseline**. The baseline is
     the listing taken when the workspace was handed over (ADR-0029 §3 step 4). The maker has no
     such moment. A human workspace does, and that's what makes root *processes* detectable here;
   - a job scheduler (`cron`, `crond`, `atd`, `anacron`, `systemd`, …), because it could start one
     of the person's jobs inside the push window, after the sweep.
3. **Check the git layout and config** with `assertSafeGitConfig`. It requires an allowlisted
   config, no redirected `.git`, and no legacy remotes. It runs only once nothing is left that could
   rewrite the config after the check.
4. **Commit with plumbing:** `add -A`, then `write-tree`, then `commit-tree <tree> -p <seedSha>`.
   - The author is set through `GIT_AUTHOR_*`, and the committer is Windkeel through `GIT_COMMITTER_*`.
   - No porcelain command runs, so no hook can run. HEAD doesn't matter, so neither does any ref the
     person moved.
   - The person's own terminal commits are folded in and take the person's authorship.
   - The new commit is parsed back with `cat-file`. Its tree, parent, author and committer must
     match, and the author must not be `WINDKEEL_GIT_AUTHOR_EMAIL`.
   - If the tree equals the seed's tree, no token is minted.
5. **Sweep, enumerate and check config again.** Then **re-derive the tree**, which must equal the
   commit's. This proves ADR-0029's "uncommitted editor state never reaches the verifier" instead of
   assuming it: nothing is left out, and nothing changed underneath.
6. **Mint the token**, scoped to the repository with `contents: write` and named after the push
   (`windkeel-push:<run>:<sha12>`). Install it through the file API into a fresh `mkdtemp` outside the
   checkout, as a `0600` file named `push-<run>-<sha12>`.
7. **Push `<sha>:refs/heads/<run-branch>`.**
   - The target is the workspace row's URL, not `origin`. The push has no `--force`; it is leased
     to the seed with `--force-with-lease=refs/heads/<run-branch>:<seed>`.
   - It passes `-c credential.helper=store --file <path>` after `hardenedGit`'s reset, plus
     `--no-verify`, `GIT_NO_REPLACE_OBJECTS=1` and `GIT_LITERAL_PATHSPECS=1`.
   - The lease makes the push land **only if the branch still holds the candidate the workspace
     was seeded from**. A plain fast-forward check is not enough: a non-force push recreates a
     deleted branch, and fast-forwards a branch rewound to an ancestor of the seed. The parent is
     exactly the seed, so when the lease holds the update is a fast-forward. That's the
     human-cycle counterpart of "PR_CREATING pins the branch".
8. **In a `finally`, remove the token, then revoke it.**
   - Remove the directory and prove it's gone.
   - Then call `DELETE /installation/token`, authenticated as the token itself.
   - If either step fails, the failure is kept. A failure to remove means "destroy the workspace".
9. **Confirm the remote head.** `getBranchHead` must equal the SHA. The function then returns
   `{ candidateSha, parentSha, branch, author, nextState: "VERIFYING" }`. *Hand back to Windkeel* uses
   the same call and moves to `IMPLEMENTING` instead.

**Revoking the token is new, and the maker's capture should adopt it.** `git-credentials.ts` says
GitHub has "no cheap per-token revocation", because `DELETE /installation/token` revokes "the token
making the call". In a just-in-time design the orchestrator *is* holding that token, so it can make
the call. That cuts the token's life from about an hour to the length of the push. A stolen copy dies
with the push rather than an hour later.

### Topologies

| | Single-user (today's image) | Two-user (recommended fallback) | Bundle-out (preferred) |
|---|---|---|---|
| Person runs as | the default user, with passwordless sudo | `createUser("person")`, with no sudo (verify live) | either |
| Git and the token run as | the same user | root or the default user, which the person can't become | the API host |
| What protects the token | the sweep, until the person uses sudo | uid separation, plus the sweep against TOCTOU on `.git` | the token is never in the VM |
| The sweep is still needed for | the token, the config and the commit | config and commit consistency | config and commit consistency |

Two-user has a cost: the person owns the checkout.
- If git runs as root, it writes root-owned files (the index) into the person's `.git`. That's
  harmless because the session has already ended. Chown the files back, or destroy the workspace.
- If git runs as the default user instead, the checkout has to be group-writable (umask 002 and a
  shared group).

A sketch of bundle-out:
1. After step 5, run `git bundle create /tmp/x.bundle <seedSha>..<sha>` as the git user.
2. Read the bundle through the file API.
3. On the API host, run `git bundle verify` against a bare mirror at `seedSha`, fetch, and check the
   parent, author and committer again.
4. Push with the token held in API memory, then revoke the token.

A bundle contains objects only, so there are no hooks or config to inject. The git on the host runs
hardened anyway.

## Threat analysis

The adversary isn't the person, who is a trusted principal (ADR-0029 §3 step 5). It's *code running
as the person*, such as:
- a dependency the person installed;
- a test or dev server they ran;
- a hostile repository's tooling;
- someone who stole the capability token.

What the adversary wants is the push token, which grants `contents: write` on the whole repository.
It isn't scoped to a branch, so it can push to any unprotected branch, create tags, or delete
branches.

| Vector | What this spike does | What's left |
|---|---|---|
| **`sudo` in the VM** | Catches root *processes* started after hand-off, by diffing `(pid, starttime)` against the baseline. It doesn't escalate to kill them; it refuses the push. | **This is the deciding vector.** Persistent root changes aren't processes, and in-VM checks can't rule them out: a replaced `git` or `libcurl`, `/etc/ld.so.preload`, an `/etc/hosts` entry plus a trusted CA (which sends the token to a local "github.com"), a tampered platform exec daemon or its config, sudoers, or a kernel module. **Fix: bundle-out, or a person without sudo.** |
| **ptrace** | Every process with the person's uid is dead before the token exists, so nothing with that uid is left to attach to git. | Root can attach. With two users, git runs as another uid, and attaching across uids needs root. Record `ptrace_scope` in the live run. |
| **cron, at and timers** | Any scheduler process aborts the push. A user can't schedule a job without a daemon. | `systemd --user` and lingering units need systemd, which the same name check covers. A scheduler that root starts after the baseline is caught as not-in-baseline. A scheduler already in the image would block every submit, so the image must not ship one. |
| **Background daemons, `setsid`, double forks, `nohup`** | The sweep finds processes by uid, not by process group, so it finds reparented processes. `SIGSTOP` before `SIGKILL` stops respawning. After 10 passes it gives up and fails closed. An independent enumeration confirms the result. | Only processes of other uids, which is the `sudo` row. |
| **A new process the platform starts as the person**, such as a terminal reconnect or an editor restart | `closeSession()` runs first, and if it fails the push aborts. | The API must not run commands as the person during the window. Nothing may supervise or auto-respawn the terminal server. Audit item. |
| **Git hooks** | `core.hooksPath=/dev/null` and `--no-verify` are set, and the commit uses plumbing (`commit-tree` runs no hooks). Tested with six hook types. | None found. |
| **Git config injection** from the person's edits | The `assertSafeGitConfig` allowlist runs after each sweep. System and global config aren't read. `GIT_NO_REPLACE_OBJECTS` is set. `.gitattributes` can name a filter driver, but nothing can define one, so it does nothing. | **Usability, not safety.** An ordinary *local* `alias.*`, `core.editor` or `merge.tool` makes the submit fail closed. Options: tell the person to use `~/.gitconfig`, which hardened git doesn't read. Or, with bundle-out, build the commit with a fresh `GIT_DIR` that Windkeel creates after the sweep, so the person's `.git/config` is never read. |
| **TOCTOU on `.git`** | The config is checked again after the final sweep, and the tree is re-derived and must equal the commit's. | Only processes of other uids. |
| **Nested repositories and submodules** | Gitlinks are refused, and `push.recurseSubmodules=no` is set. | A person who needs a submodule gets a clear refusal. Whether that's acceptable is a product question. |
| **Identity** | The author comes from the GitHub user-to-server identity, never from the terminal. Terminal commits are folded in. An email equal to `WINDKEEL_GIT_AUTHOR_EMAIL` is refused twice, by `personAuthor` and by `verifyCommit`. | `human_commits_after_pr` counts one human commit per submit, not one per commit the person made. That's acceptable, but ADR-0013 should say so. |
| **The token's lifetime** | The token is minted after the last check. It exists as a file only for the push, is removed in a `finally` and proven gone, and is **revoked right after**. It never appears in argv or logs, and stderr is redacted. | GitHub can't mint an installation token for less than an hour, so revocation is what limits its life. If revocation fails, the token lives out its hour. That failure is reported, and the workspace should be destroyed. A token can't be scoped to a branch. A GitHub ruleset limiting the App to `windkeel/*` would limit what a stolen token can do. |
| **Egress during the window** | Not relied on. The human workspace uses the install allowlist, which can include the git host. | Matters only if something survives. Bundle-out removes the question. |
| **The branch moved, was deleted or was rewound since hand-off** | The push is leased to the seed (`--force-with-lease=refs/heads/<branch>:<seed>`), so it is rejected in all three cases (tested). The remote head is read back. | None. |

## What the security audit should check

1. **Is the person root in the human workspace?**
   - Check whether users made by `createUser` have sudo, including through a sudoers drop-in or a
     group.
   - Check the image for setuid binaries a person could use to escalate (`find / -perm -4000`).
   - If the person keeps sudo, require bundle-out.
2. **The baseline.** It must be taken after install (§3 step 4) and before the capability token is
   issued. Confirm that the platform doesn't start root processes on its own afterwards, using
   scenario B's report plus a run with an idle person.
3. **`closeSession`.** Revoking the capability token must also kill or refuse a WebSocket that's
   already open. Nothing may respawn the terminal server.
4. **No scheduler in the image** (`crond`, `atd`, `systemd`), and no user crontab spool.
5. **The token file.**
   - It must be written by a uid the person can't become, in a `0700` `mkdtemp`, and never logged.
   - Revoke must be called.
   - Look at what `store --file` does on a failed push. Git may *erase* the credential through the
     helper, which is harmless but noisy.
6. **`assertSafeGitConfig` under the human threat model.** It was written for the maker. Review its
   allowlist again assuming a person who edits `.git/` by hand. Decide whether to switch to
   committing with a fresh `GIT_DIR`.
7. **The push refspec and target.** Confirm the push uses an explicit SHA, the workspace row's URL,
   no force, and a lease equal to the seed. Confirm that `PR_CREATING` pins the branch to the *new* verified SHA on the second
   cycle (`WAITING_FOR_HUMAN → HUMAN_EDITING → VERIFYING → PR_CREATING`).
8. **§4's capability-token gate**, the other half of flip condition 3. This spike doesn't cover it.

## Files

- `sweep-then-push.ts`: the sequence, `personAuthor`, `findSurvivors`, and the seams.
- `vercel-workspace.ts`: the seams over a real `@vercel/sandbox`. It holds `PROCESS_ENUMERATION`
  and runs the sweep as the person.
- `live-vercel.ts`: the live harness. Not run yet.
- `fakes.ts` and `sweep-then-push.test.ts`: the tests, with real git and fake processes and tokens.
- `tsconfig.json`: builds the spike, and the `src/` modules it imports, into `.build/`, which is
  gitignored.
