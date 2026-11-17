/**
 * Spike B (#368): ADR-0029 §3 steps 6–7 — *Submit for verification* from a human workspace.
 *
 * The maker's capture (`src/factory/workflow/handlers/candidate-capture.ts`) already does
 * sweep → check config → commit → sweep → token → push → remove token, for a sandbox the agent
 * had its hands on. This module is the same order for a sandbox a *person* had their hands on,
 * plus what a human workspace needs that the maker's does not:
 *
 * - **The session is closed first** (`closeSession`), so the capability-token server cannot open a
 *   new terminal between the sweep and the push.
 * - **Survivors are enumerated, not assumed** (`findSurvivors`). The sweep says what it killed; an
 *   independent `/proc` listing says what is left, and anything of the person's uid(s), any process
 *   of another uid that was not running when the person was handed the workspace (the baseline —
 *   a human workspace has a natural one, ADR-0029 §3 step 4), and any job scheduler fails closed.
 *   The maker cannot do the baseline check: it has no moment before untrusted code runs.
 * - **The commit is built with plumbing** (`add -A`, `write-tree`, `commit-tree -p <seed>`), so no
 *   hook can run and no ref the person may have moved matters. Whatever the person committed in the
 *   terminal is folded into one commit whose parent is exactly the candidate the workspace was
 *   seeded from, authored by the person's GitHub noreply identity, committed by Windkeel. A commit the
 *   person made with `WINDKEEL_GIT_AUTHOR_EMAIL` as author (by accident or to dodge
 *   `human_commits_after_pr`) never reaches GitHub.
 * - **The tree is re-derived after the commit**, and must equal the commit's: nothing uncommitted is
 *   left behind, and nothing changed underneath.
 * - **The token is revoked, not only deleted.** Windkeel minted it for this push and holds its value,
 *   so `DELETE /installation/token` with that token ends its life at the push instead of an hour
 *   later.
 * - **The push names the SHA**, not `HEAD`, leased to the seed:
 *   `--force-with-lease=refs/heads/<branch>:<seedSha>`, so it lands only if the remote branch still
 *   equals the seed candidate. A plain non-force push would also land on a branch that was deleted
 *   (it recreates it) or rewound to an ancestor of the seed (still a fast-forward). The commit's
 *   parent is the seed, so when the lease holds the update is a fast-forward anyway. The remote head
 *   is read back and must equal the pushed SHA — the candidate-SHA handoff to VERIFYING.
 * - **Tracing never changes the outcome.** A throwing `trace` callback is swallowed, so it cannot
 *   skip the token's removal and revocation.
 *
 * Reused, not reimplemented: `assertSafeGitConfig`, `hardenedGit`, `HARDENED_GIT_*` from
 * `src/sandbox/git-hardening.ts`, `ProcessSweep` (and, in the live harness, `STRAY_PROCESS_SWEEP`)
 * from `src/sandbox`.
 */

import type { ExecOptions, ExecResult } from "@windkeel/verification/exec/environment.js";
import {
  assertSafeGitConfig,
  hardenedGit,
  type GitExec,
} from "../../../src/sandbox/git-hardening.js";
import type { ProcessSweep } from "../../../src/sandbox/provider.js";

// ---------------------------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------------------------

/** What the module needs of the workspace, as the user that runs git and holds the token. */
export interface WorkspaceExec {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  writeFile(path: string, data: Buffer | string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdtemp(prefix: string): Promise<string>;
}

/*
 * Promoted to `src/factory/human-push.ts` (#369), which production uses with the bundle-out push
 * path; the spike keeps its token-in-the-workspace sequence for its own tests and live harness.
 */
import type {
  ProcInfo,
  ProcessSnapshot,
  ProcessControl,
  QuietPolicy,
  PersonIdentity,
  WindkeelIdentity,
  Survivor,
} from "../../../src/factory/human-push.js";
import {
  DEFAULT_SCHEDULERS as PROMOTED_SCHEDULERS,
  HumanPushError,
  findSurvivors as promotedFindSurvivors,
  personAuthor as promotedPersonAuthor,
} from "../../../src/factory/human-push.js";
export type { ProcInfo, ProcessSnapshot, ProcessControl, QuietPolicy, PersonIdentity, WindkeelIdentity, Survivor };

export interface PushToken {
  username: string;
  token: string;
  expiresAt: string;
}

export interface PushTokenIssuer {
  /** Repository-scoped, `contents: write`, minted for exactly this push. */
  mint(request: { repositoryUrl: string; branch: string; purpose: string }): Promise<PushToken>;
  /** `DELETE /installation/token`, authenticated *as the token*. */
  revoke(token: PushToken): Promise<void>;
}

export type Stage =
  | "identity"
  | "session"
  | "sweep"
  | "survivors"
  | "git-config"
  | "commit"
  | "tree"
  | "mint"
  | "push"
  | "remove-token"
  | "revoke-token"
  | "remote-head";

export type TraceEvent =
  | { type: "session-closed" }
  | { type: "swept"; sweep: ProcessSweep }
  | { type: "quiet"; checked: number }
  | { type: "git-config-ok" }
  | { type: "committed"; sha: string; tree: string }
  | { type: "tree-verified"; tree: string }
  | { type: "token-minted"; purpose: string }
  | { type: "token-installed"; path: string }
  | { type: "pushed"; sha: string }
  | { type: "token-removed" }
  | { type: "token-revoked" }
  | { type: "remote-head-confirmed"; sha: string };

export interface SweepThenPushInput {
  runId: string;
  workspace: WorkspaceExec;
  processes: ProcessControl;
  policy: QuietPolicy;
  checkoutPath: string;
  /** The workspace row's repository URL — never `origin`, which the person can rewrite. */
  repositoryUrl: string;
  /** The run branch (`workingBranchFor(runId)`). */
  branch: string;
  /** The candidate the workspace was seeded from, i.e. the branch's head at hand-off; the push's lease. */
  seedSha: string;
  person: PersonIdentity;
  windkeel: WindkeelIdentity;
  tokens: PushTokenIssuer;
  /** Revokes the workspace's capability token so no new terminal or editor session can start. */
  closeSession?: () => Promise<void>;
  /** `GitHubClient.getBranchHead`; absent on a local remote. */
  readRemoteHead?: (branch: string) => Promise<string | null>;
  message?: string;
  /** Observability only: a throw from it is swallowed and never changes the outcome. */
  trace?: (event: TraceEvent) => void;
}

export type SweepThenPushResult =
  | {
      kind: "pushed";
      /** The candidate SHA handed to VERIFYING. */
      candidateSha: string;
      parentSha: string;
      branch: string;
      author: { name: string; email: string };
      nextState: "VERIFYING";
      killed: number;
    }
  | { kind: "empty"; candidateSha: string; nextState: null; killed: number };

export class SweepThenPushError extends Error {
  constructor(
    readonly stage: Stage,
    message: string,
    readonly cleanup: Error[] = [],
  ) {
    super(`sweep-then-push [${stage}]: ${message}${cleanup.length ? `; cleanup: ${cleanup.map((e) => e.message).join("; ")}` : ""}`);
    this.name = "SweepThenPushError";
  }
}

// ---------------------------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------------------------

/** Promoted (`src/factory/human-push.ts`); refusals keep the spike's error type. */
export function personAuthor(person: PersonIdentity, windkeel: WindkeelIdentity): { name: string; email: string } {
  try {
    return promotedPersonAuthor(person, windkeel);
  } catch (error) {
    if (error instanceof HumanPushError) {
      throw new SweepThenPushError("identity", error.message.replace(/^human push \[identity\]: /, ""));
    }
    throw error;
  }
}

export const DEFAULT_SCHEDULERS = PROMOTED_SCHEDULERS;

/** Promoted (`src/factory/human-push.ts`). */
export const findSurvivors = promotedFindSurvivors;

// ---------------------------------------------------------------------------------------------
// The sequence
// ---------------------------------------------------------------------------------------------

/** Extra environment for every git call: replace refs could make history read differently. */
const SPIKE_GIT_ENV = { GIT_NO_REPLACE_OBJECTS: "1", GIT_LITERAL_PATHSPECS: "1" };

export async function sweepThenPush(input: SweepThenPushInput): Promise<SweepThenPushResult> {
  const trace = safeTrace(input.trace);
  const author = personAuthor(input.person, input.windkeel);
  if (!/^[0-9a-f]{40}$/.test(input.seedSha)) throw new SweepThenPushError("commit", "seedSha is not a full sha");

  // 0. No new sessions. Before the sweep, or a reconnect could start a shell the sweep never saw.
  if (input.closeSession) {
    try {
      await input.closeSession();
    } catch (error) {
      throw new SweepThenPushError("session", `could not close the workspace session: ${messageOf(error)}`);
    }
    trace({ type: "session-closed" });
  }

  const git = gitIn(input);

  // 1–2. Stop everything of the person's, and prove it.
  let killed = await quiesce(input, trace);
  // 3. Only now read git config: nothing is left that could rewrite it after the check.
  await checkConfig(git, input.checkoutPath);
  trace({ type: "git-config-ok" });

  // 4. Build the commit with plumbing.
  must(await git(["rev-parse", "--verify", "--end-of-options", `${input.seedSha}^{commit}`]), "commit", "the seed candidate is not in the workspace");
  const seedTree = line(must(await git(["rev-parse", "--verify", "--end-of-options", `${input.seedSha}^{tree}`]), "commit", "could not read the seed's tree"));
  const tree = await snapshotTree(git);
  if (tree === seedTree) return { kind: "empty", candidateSha: input.seedSha, nextState: null, killed };

  const message = input.message ?? `Human edits for run ${input.runId}\n\nSubmitted for verification from the human workspace.\n`;
  const sha = line(
    must(
      await git(["commit-tree", tree, "-p", input.seedSha, "-m", message], {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: input.windkeel.name,
        GIT_COMMITTER_EMAIL: input.windkeel.email,
      }),
      "commit",
      "commit-tree failed",
    ),
  );
  await verifyCommit(git, sha, { tree, parent: input.seedSha, author, committer: input.windkeel });
  trace({ type: "committed", sha, tree });

  // 5. Sweep and enumerate again, immediately before the token exists; this is the one the token rests on.
  killed += await quiesce(input, trace);
  await checkConfig(git, input.checkoutPath);
  // Nothing uncommitted is left behind and nothing changed underneath: the worktree is the commit.
  const after = await snapshotTree(git);
  if (after !== tree) {
    throw new SweepThenPushError("tree", `the worktree changed after the commit (${tree} → ${after}); refusing to push`);
  }
  trace({ type: "tree-verified", tree });

  // 6–8. The push window.
  const purpose = `windkeel-push:${input.runId}:${sha.slice(0, 12)}`;
  let token: PushToken;
  try {
    token = await input.tokens.mint({ repositoryUrl: input.repositoryUrl, branch: input.branch, purpose });
  } catch (error) {
    throw new SweepThenPushError("mint", messageOf(error));
  }

  // From here on the token exists: everything up to the push runs inside the region whose
  // `finally` removes and revokes it.
  let primary: SweepThenPushError | null = null;
  const cleanup: Error[] = [];
  let tokenPath: string | null = null;
  try {
    trace({ type: "token-minted", purpose });
    // The path is known (and so cleaned up) before anything is written to it.
    tokenPath = await tokenFilePath(input, sha);
    await writeToken(input.workspace, tokenPath, token, input.repositoryUrl);
    trace({ type: "token-installed", path: tokenPath });
    const ref = `refs/heads/${input.branch}`;
    const pushed = await git(
      ["push", "--porcelain", "--no-verify", `--force-with-lease=${ref}:${input.seedSha}`, input.repositoryUrl, `${sha}:${ref}`],
      {},
      [`credential.helper=store --file ${tokenPath}`],
    );
    if (pushed.error || pushed.status !== 0) {
      throw new SweepThenPushError("push", `git push exited ${pushed.status ?? pushed.error}: ${redact(pushed.stderr, token).trim()}`);
    }
    trace({ type: "pushed", sha });
  } catch (error) {
    primary = error instanceof SweepThenPushError ? error : new SweepThenPushError("push", messageOf(error));
  } finally {
    // The file first, then the token itself. Each failure is kept; neither hides the other.
    try {
      await removeToken(input.workspace, tokenPath);
      trace({ type: "token-removed" });
    } catch (error) {
      cleanup.push(new SweepThenPushError("remove-token", messageOf(error)));
    }
    try {
      await input.tokens.revoke(token);
      trace({ type: "token-revoked" });
    } catch (error) {
      cleanup.push(new SweepThenPushError("revoke-token", messageOf(error)));
    }
  }
  if (primary) throw new SweepThenPushError(primary.stage, primary.message.replace(/^sweep-then-push \[[^\]]+\]: /, ""), cleanup);
  if (cleanup.length) {
    const first = cleanup[0] as SweepThenPushError;
    throw new SweepThenPushError(first.stage, "the push landed but the token was not cleaned up; destroy the workspace", cleanup);
  }

  // 9. The candidate-SHA handoff: the branch must hold exactly what was committed.
  if (input.readRemoteHead) {
    const head = await input.readRemoteHead(input.branch);
    if (head !== sha) {
      throw new SweepThenPushError("remote-head", `the branch is at ${head ?? "nothing"}, not the pushed ${sha}`);
    }
    trace({ type: "remote-head-confirmed", sha });
  }

  return { kind: "pushed", candidateSha: sha, parentSha: input.seedSha, branch: input.branch, author, nextState: "VERIFYING", killed };
}

async function quiesce(input: SweepThenPushInput, trace: (e: TraceEvent) => void): Promise<number> {
  const sweep = await input.processes.sweep();
  trace({ type: "swept", sweep });
  // No `noSandbox` exception: a human workspace is always a real sandbox, and the capture's local
  // mode has no human workspace.
  if (!sweep.ensured) {
    throw new SweepThenPushError("sweep", `the sweep could not confirm the workspace is quiet: ${sweep.reason}`);
  }
  const snapshot = await input.processes.snapshot();
  const survivors = findSurvivors(snapshot, input.policy);
  if (survivors.length) {
    throw new SweepThenPushError(
      "survivors",
      `still running after the sweep: ${survivors
        .map((s) => `${s.process.pid}/${s.process.comm} uid=${s.process.uid} (${s.reason})`)
        .join(", ")}`,
    );
  }
  trace({ type: "quiet", checked: snapshot.processes.length });
  return sweep.killed;
}

async function checkConfig(git: GitRun, checkoutPath: string): Promise<void> {
  try {
    await assertSafeGitConfig(git.exec, checkoutPath);
  } catch (error) {
    throw new SweepThenPushError("git-config", messageOf(error));
  }
}

/** `add -A` then `write-tree`: the tree of the worktree as git sees it, ignored files excluded. */
async function snapshotTree(git: GitRun): Promise<string> {
  must(await git(["add", "-A", "--", "."]), "commit", "could not stage the worktree");
  // A nested repository becomes a gitlink the verifier cannot fetch. Refused rather than pushed.
  const gitlinks = must(await git(["ls-files", "-s", "-z"]), "commit", "could not list the index").stdout
    .split("\0")
    .filter((entry) => entry.startsWith("160000 "));
  if (gitlinks.length) {
    throw new SweepThenPushError("commit", `the worktree contains nested repositories (gitlinks): ${gitlinks.map((g) => g.split("\t")[1]).join(", ")}`);
  }
  return line(must(await git(["write-tree"]), "commit", "write-tree failed"));
}

async function verifyCommit(
  git: GitRun,
  sha: string,
  expected: { tree: string; parent: string; author: { name: string; email: string }; committer: WindkeelIdentity },
): Promise<void> {
  const raw = must(await git(["cat-file", "commit", sha]), "commit", "could not read the new commit").stdout;
  const header = raw.slice(0, raw.indexOf("\n\n"));
  const field = (name: string) => header.split("\n").filter((l) => l.startsWith(`${name} `)).map((l) => l.slice(name.length + 1));
  const ident = (value: string | undefined) => /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(value ?? "");
  const authorLine = ident(field("author")[0]);
  const committerLine = ident(field("committer")[0]);
  const problems: string[] = [];
  if (field("tree")[0] !== expected.tree) problems.push("tree");
  if (field("parent").join(" ") !== expected.parent) problems.push("parent");
  if (authorLine?.[1] !== expected.author.name || authorLine?.[2] !== expected.author.email) problems.push("author");
  if (committerLine?.[1] !== expected.committer.name || committerLine?.[2] !== expected.committer.email) problems.push("committer");
  if (authorLine?.[2]?.toLowerCase() === expected.committer.email.toLowerCase()) problems.push("author is WINDKEEL_GIT_AUTHOR_EMAIL");
  if (problems.length) throw new SweepThenPushError("commit", `the new commit does not match: ${problems.join(", ")}`);
}

/**
 * A fresh `mkdtemp` outside the checkout, and the token file's path in it, named after this push.
 * A fresh directory per push, so nothing a previous session prepared is reused. Nothing secret is
 * written yet: the caller records the path first, so a failure in `writeToken` is still cleaned up.
 */
async function tokenFilePath(input: SweepThenPushInput, sha: string): Promise<string> {
  const dir = await input.workspace.mkdtemp("windkeel-push-");
  return `${dir}/push-${input.runId.replace(/[^A-Za-z0-9_-]/g, "_")}-${sha.slice(0, 12)}`;
}

/** Through the file API (never argv), then `0600`. On failure the caller's `finally` removes the directory. */
async function writeToken(workspace: WorkspaceExec, path: string, token: PushToken, repositoryUrl: string): Promise<void> {
  const host = new URL(repositoryUrl).host || "localhost";
  await workspace.writeFile(path, `https://${token.username}:${token.token}@${host}\n`);
  const chmod = await workspace.exec("chmod", { args: ["600", path] });
  if (chmod.error || chmod.status !== 0) throw new Error(`could not chmod the token file (${chmod.status ?? chmod.error})`);
}

async function removeToken(workspace: WorkspaceExec, path: string | null): Promise<void> {
  if (!path) return;
  const dir = path.slice(0, path.lastIndexOf("/"));
  const removed = await workspace.exec("rm", { args: ["-rf", dir] });
  if (removed.error || removed.status !== 0 || (await workspace.exists(path))) {
    throw new Error(`could not confirm the token file was removed (${removed.error ?? `rm exited ${removed.status}`})`);
  }
}

// ---------------------------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------------------------

type GitRun = ((args: string[], env?: Record<string, string>, extraConfig?: string[]) => Promise<ExecResult>) & {
  exec: GitExec;
};

function gitIn(input: SweepThenPushInput): GitRun {
  const exec: GitExec = (command, options) =>
    input.workspace.exec(command, { ...options, env: { ...SPIKE_GIT_ENV, ...options?.env } });
  const run = ((args: string[], env: Record<string, string> = {}, extraConfig: string[] = []) =>
    hardenedGit(exec, args, { cwd: input.checkoutPath, env, extraConfig })) as GitRun;
  run.exec = exec;
  return run;
}

function must(result: ExecResult, stage: Stage, what: string): ExecResult {
  if (result.error || result.status !== 0) {
    throw new SweepThenPushError(stage, `${what} (${result.error ?? `exit ${result.status}`}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""})`);
  }
  return result;
}

function line(result: ExecResult): string {
  return result.stdout.trim().split("\n").pop()!.trim();
}

function redact(text: string, token: PushToken): string {
  return token.token ? text.split(token.token).join("***") : text;
}

/** A trace callback that cannot throw into the sequence. */
function safeTrace(trace: ((event: TraceEvent) => void) | undefined): (event: TraceEvent) => void {
  return (event) => {
    try {
      trace?.(event);
    } catch {
      // Observability must not change what happens to the token or the push.
    }
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
