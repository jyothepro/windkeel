import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "@windkeel/verification/exec/environment.js";
import { LocalExecutionEnvironment } from "@windkeel/verification/exec/local.js";
import { assertSafeGitConfig, hardenedGit, type GitExec } from "../sandbox/git-hardening.js";
import type { ProcessSweep } from "../sandbox/provider.js";

export interface WorkspaceExec {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer | string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdtemp(prefix: string): Promise<string>;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  uid: number;
  state: string;
  startTime: string;
  comm: string;
  kernel?: boolean;
}

export interface ProcessSnapshot {
  self: number[];
  processes: ProcInfo[];
}

export interface ProcessControl {
  sweep(): Promise<ProcessSweep>;
  snapshot(): Promise<ProcessSnapshot>;
}

export interface QuietPolicy {
  personUids: number[];
  baseline: ProcInfo[] | null;
  schedulerComms?: string[];
}

export interface PushToken {
  username: string;
  token: string;
  expiresAt: string;
}

export interface PushTokenIssuer {
  mint(request: { repositoryUrl: string; branch: string; purpose: string }): Promise<PushToken>;
  revoke(token: PushToken): Promise<void>;
}

export interface PersonIdentity {
  githubId: number;
  login: string;
  name?: string | undefined;
}

export interface WindkeelIdentity {
  name: string;
  email: string;
}

export type HumanPushStage =
  | "identity"
  | "session"
  | "sweep"
  | "survivors"
  | "git-config"
  | "commit"
  | "tree"
  | "bundle"
  | "verify"
  | "mint"
  | "branch-moved"
  | "push"
  | "revoke-token";

export class HumanPushError extends Error {
  constructor(
    readonly stage: HumanPushStage,
    message: string,
    readonly cleanup: Error[] = [],
  ) {
    super(`human push [${stage}]: ${message}${cleanup.length ? `; cleanup: ${cleanup.map((e) => e.message).join("; ")}` : ""}`);
    this.name = "HumanPushError";
  }
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function personAuthor(person: PersonIdentity, windkeel: WindkeelIdentity): { name: string; email: string } {
  if (!Number.isSafeInteger(person.githubId) || person.githubId <= 0) {
    throw new HumanPushError("identity", `not a GitHub user id: ${person.githubId}`);
  }
  if (!GITHUB_LOGIN.test(person.login)) {
    throw new HumanPushError("identity", `not a GitHub login: ${JSON.stringify(person.login)}`);
  }
  const email = `${person.githubId}+${person.login}@users.noreply.github.com`;
  const candidate = person.name?.trim();
  const name = candidate && !/[<>\n\r\0]/.test(candidate) ? candidate : person.login;
  if (email.toLowerCase() === windkeel.email.trim().toLowerCase()) {
    throw new HumanPushError("identity", "the person's author email equals WINDKEEL_GIT_AUTHOR_EMAIL");
  }
  return { name, email };
}

const DEFAULT_SCHEDULERS = ["cron", "crond", "atd", "anacron", "systemd", "incrond", "fcron"];

export interface Survivor {
  process: ProcInfo;
  reason: "person-uid" | "not-in-baseline" | "scheduler";
}

export function findSurvivors(snapshot: ProcessSnapshot, policy: QuietPolicy): Survivor[] {
  const self = new Set(snapshot.self);
  const person = new Set(policy.personUids);
  const baseline = policy.baseline ? new Set(policy.baseline.map(processKey)) : null;
  const schedulers = new Set(policy.schedulerComms ?? DEFAULT_SCHEDULERS);
  const survivors: Survivor[] = [];
  for (const p of snapshot.processes) {
    if (self.has(p.pid) || p.kernel || p.pid === 2 || p.ppid === 2) continue;
    if (p.state === "Z" || p.state === "X") continue;
    if (schedulers.has(p.comm)) survivors.push({ process: p, reason: "scheduler" });
    else if (person.has(p.uid)) survivors.push({ process: p, reason: "person-uid" });
    else if (baseline && !baseline.has(processKey(p))) survivors.push({ process: p, reason: "not-in-baseline" });
  }
  return survivors;
}

function processKey(p: ProcInfo): string {
  return `${p.pid}:${p.startTime}`;
}

export interface CommitAndBundleInput {
  runId: string;
  workspace: WorkspaceExec;
  processes: ProcessControl;
  policy: QuietPolicy;
  checkoutPath: string;
  seedSha: string;
  person: PersonIdentity;
  windkeel: WindkeelIdentity;
  closeSession?: () => Promise<void>;
  message?: string;
  date?: Date | undefined;
}

export const BUNDLE_REF = "refs/windkeel/human-candidate";

export type CommitAndBundleResult =
  | { kind: "bundle"; sha: string; tree: string; bundle: Buffer; author: { name: string; email: string }; killed: number }
  | { kind: "empty"; sha: string; killed: number };

const WORKSPACE_GIT_ENV = { GIT_NO_REPLACE_OBJECTS: "1", GIT_LITERAL_PATHSPECS: "1" };

export async function commitAndBundle(input: CommitAndBundleInput): Promise<CommitAndBundleResult> {
  const author = personAuthor(input.person, input.windkeel);
  if (!/^[0-9a-f]{40}$/.test(input.seedSha)) throw new HumanPushError("commit", "seedSha is not a full sha");

  if (input.closeSession) {
    try {
      await input.closeSession();
    } catch (error) {
      throw new HumanPushError("session", `could not close the workspace session: ${messageOf(error)}`);
    }
  }

  const git = gitIn(input.workspace, input.checkoutPath);

  let killed = await quiesce(input);
  await checkConfig(git, input.checkoutPath);

  must(await git(["rev-parse", "--verify", "--end-of-options", `${input.seedSha}^{commit}`]), "commit", "the seed candidate is not in the workspace");
  const seedTree = line(must(await git(["rev-parse", "--verify", "--end-of-options", `${input.seedSha}^{tree}`]), "commit", "could not read the seed's tree"));
  const tree = await snapshotTree(git);
  if (tree === seedTree) return { kind: "empty", sha: input.seedSha, killed };

  const message =
    input.message ?? `Human edits for run ${input.runId}\n\nMade in Windkeel's human workspace (ADR-0029 §3).\n`;
  const date = input.date ? `@${Math.floor(input.date.getTime() / 1000)} +0000` : null;
  const sha = line(
    must(
      await git(["commit-tree", tree, "-p", input.seedSha, "-m", message], {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: input.windkeel.name,
        GIT_COMMITTER_EMAIL: input.windkeel.email,
        ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
      }),
      "commit",
      "commit-tree failed",
    ),
  );
  const parsed = parseCommit(must(await git(["cat-file", "commit", sha]), "commit", "could not read the new commit").stdout);
  const problems = commitProblems(parsed, { tree, parent: input.seedSha, author, committer: input.windkeel });
  if (problems.length) throw new HumanPushError("commit", `the new commit does not match: ${problems.join(", ")}`);

  killed += await quiesce(input);
  await checkConfig(git, input.checkoutPath);
  const after = await snapshotTree(git);
  if (after !== tree) {
    throw new HumanPushError("tree", `the worktree changed after the commit (${tree} → ${after}); refusing to submit`);
  }

  const dir = await input.workspace.mkdtemp("windkeel-bundle-");
  try {
    const base = `${dir}/pack`;
    const run = await input.workspace.exec("sh", {
      args: [
        "-c",
        'printf "%s\\n^%s\\n" "$1" "$2" | git -c core.hooksPath=/dev/null pack-objects --revs -q "$3"',
        "windkeel-pack",
        sha,
        input.seedSha,
        base,
      ],
      cwd: input.checkoutPath,
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...WORKSPACE_GIT_ENV },
    });
    const hash = line(must(run, "bundle", "pack-objects failed"));
    if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new HumanPushError("bundle", "pack-objects did not name a pack");
    const pack = await input.workspace.readFile(`${base}-${hash}.pack`);
    const bundle = Buffer.concat([
      Buffer.from(`# v2 git bundle\n-${input.seedSha} seed\n${sha} ${BUNDLE_REF}\n\n`, "utf8"),
      pack,
    ]);
    return { kind: "bundle", sha, tree, bundle, author, killed };
  } finally {
    await input.workspace.exec("rm", { args: ["-rf", dir] }).catch(() => undefined);
  }
}

async function quiesce(input: CommitAndBundleInput): Promise<number> {
  const sweep = await input.processes.sweep();
  if (!sweep.ensured) {
    throw new HumanPushError("sweep", `the sweep could not confirm the workspace is quiet: ${sweep.reason}`);
  }
  const survivors = findSurvivors(await input.processes.snapshot(), input.policy);
  if (survivors.length) {
    throw new HumanPushError(
      "survivors",
      `still running after the sweep: ${survivors
        .map((s) => `${s.process.pid}/${s.process.comm} uid=${s.process.uid} (${s.reason})`)
        .join(", ")}`,
    );
  }
  return sweep.killed;
}

async function checkConfig(git: GitRun, checkoutPath: string): Promise<void> {
  try {
    await assertSafeGitConfig(git.exec, checkoutPath);
  } catch (error) {
    throw new HumanPushError("git-config", messageOf(error));
  }
}

async function snapshotTree(git: GitRun): Promise<string> {
  must(await git(["add", "-A", "--", "."]), "commit", "could not stage the worktree");
  const gitlinks = must(await git(["ls-files", "-s", "-z"]), "commit", "could not list the index").stdout
    .split("\0")
    .filter((entry) => entry.startsWith("160000 "));
  if (gitlinks.length) {
    throw new HumanPushError("commit", `the worktree contains nested repositories (gitlinks): ${gitlinks.map((g) => g.split("\t")[1]).join(", ")}`);
  }
  return line(must(await git(["write-tree"]), "commit", "write-tree failed"));
}

export type HostExec = GitExec;

function localHostExec(): HostExec {
  const env = new LocalExecutionEnvironment();
  return (command, options) => env.exec(command, options);
}

export interface VerifyBundleInput {
  bundle: Buffer;
  seedSha: string;
  person: PersonIdentity;
  windkeel: WindkeelIdentity;
  host?: HostExec;
}

export interface VerifiedBundle {
  sha: string;
  tree: string;
  repoDir: string;
  author: { name: string; email: string };
}

export async function verifyBundle(input: VerifyBundleInput): Promise<VerifiedBundle> {
  const host = input.host ?? localHostExec();
  const author = personAuthor(input.person, input.windkeel);
  const refuse = (why: string): never => {
    throw new HumanPushError("verify", why);
  };
  if (!/^[0-9a-f]{40}$/.test(input.seedSha)) refuse("seedSha is not a full sha");

  const split = input.bundle.indexOf("\n\n");
  if (split < 0) refuse("not a git bundle: no header");
  const header = input.bundle.subarray(0, split).toString("utf8").split("\n");
  if (header[0] !== "# v2 git bundle") refuse(`not a v2 git bundle (${JSON.stringify(header[0]?.slice(0, 40))})`);
  const prerequisites = header.slice(1).filter((l) => l.startsWith("-")).map((l) => l.slice(1).split(" ")[0]);
  const refs = header.slice(1).filter((l) => !l.startsWith("-") && l.trim() !== "").map((l) => l.split(" "));
  if (prerequisites.length !== 1 || prerequisites[0] !== input.seedSha) {
    refuse(`the bundle must build on exactly the seed candidate ${input.seedSha} (it names ${prerequisites.join(", ") || "nothing"})`);
  }
  if (refs.length !== 1 || refs[0]![1] !== BUNDLE_REF || !/^[0-9a-f]{40}$/.test(refs[0]![0] ?? "")) {
    refuse(`the bundle must carry exactly one ref, ${BUNDLE_REF}`);
  }
  const sha = refs[0]![0]!;
  const pack = input.bundle.subarray(split + 2);

  const repoDir = mkdtempSync(join(tmpdir(), "windkeel-human-push-"));
  try {
    const git = (args: string[], env: Record<string, string> = {}) => hardenedGit(host, args, { cwd: repoDir, env: { GIT_NO_REPLACE_OBJECTS: "1", ...env } });
    must(await git(["init", "-q", "--bare", "."]), "verify", "could not create the host repository");
    const packPath = join(repoDir, "incoming.pack");
    writeFileSync(packPath, pack);
    const indexed = await git(["index-pack", "-o", join(repoDir, "objects", "pack", "pack-incoming.idx"), packPath]);
    if (indexed.error || indexed.status !== 0) refuse(`the bundle's pack does not index on its own (${indexed.stderr.trim() || indexed.error})`);
    rmSync(packPath, { force: true });
    writeFileSync(join(repoDir, "objects", "pack", "pack-incoming.pack"), pack);

    const listed = must(await git(["verify-pack", "-v", join(repoDir, "objects", "pack", "pack-incoming.idx")]), "verify", "could not list the pack");
    const objects = listed.stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => /^[0-9a-f]{40}$/.test(f[0] ?? "") && ["commit", "tree", "blob", "tag"].includes(f[1] ?? ""));
    const commits = objects.filter((f) => f[1] === "commit").map((f) => f[0]!);
    if (objects.some((f) => f[1] === "tag")) refuse("the bundle carries a tag object");
    if (commits.length !== 1) refuse(`the bundle must carry exactly one commit (it carries ${commits.length})`);
    if (commits[0] !== sha) refuse("the bundle's only commit is not the commit its ref names");

    const parsed = parseCommit(must(await git(["cat-file", "commit", sha]), "verify", "could not read the commit").stdout);
    if (parsed.parents.length !== 1 || parsed.parents[0] !== input.seedSha) {
      refuse(`the commit's parent must be exactly the seed candidate ${input.seedSha} (it has ${parsed.parents.join(", ") || "none"})`);
    }
    if (parsed.author?.email.toLowerCase() === input.windkeel.email.trim().toLowerCase()) {
      refuse("the commit is authored as Windkeel (WINDKEEL_GIT_AUTHOR_EMAIL); a person's commit must carry their own identity");
    }
    const problems = commitProblems(parsed, { tree: parsed.tree ?? "", parent: input.seedSha, author, committer: input.windkeel });
    if (problems.length) refuse(`the commit does not match: ${problems.join(", ")}`);

    for (const tree of objects.filter((f) => f[1] === "tree").map((f) => f[0]!)) {
      const entries = must(await git(["ls-tree", tree]), "verify", "could not read a tree").stdout;
      if (entries.split("\n").some((e) => e.startsWith("160000 "))) refuse("the commit adds a nested repository (gitlink)");
    }
    return { sha, tree: parsed.tree!, repoDir, author };
  } catch (error) {
    rmSync(repoDir, { recursive: true, force: true });
    if (error instanceof HumanPushError) throw error;
    throw new HumanPushError("verify", messageOf(error));
  }
}

export interface PushInput {
  verified: VerifiedBundle;
  seedSha: string;
  repositoryUrl: string;
  branch: string;
  runId: string;
  tokens: PushTokenIssuer;
  host?: HostExec;
  landed?: string | null | undefined;
}

export interface PushResult {
  sha: string;
  alreadyLanded?: boolean;
  revokeError: string | null;
}

export async function pushVerifiedBundle(input: PushInput): Promise<PushResult> {
  const host = input.host ?? localHostExec();
  const { verified } = input;
  const url = remoteUrl(input.repositoryUrl);
  const purpose = `windkeel-push:${input.runId}:${verified.sha.slice(0, 12)}`;
  let token: PushToken;
  try {
    token = await input.tokens.mint({ repositoryUrl: input.repositoryUrl, branch: input.branch, purpose });
  } catch (error) {
    rmSync(verified.repoDir, { recursive: true, force: true });
    throw new HumanPushError("mint", messageOf(error));
  }

  const auth = authEnv(url, token);
  const git = (args: string[]) => hardenedGit(host, args, { cwd: verified.repoDir, env: { GIT_NO_REPLACE_OBJECTS: "1", ...auth } });
  let primary: HumanPushError | null = null;
  let alreadyLanded = false;
  try {
    const fetched = await git(["fetch", "-q", "--no-tags", "--depth=1", url, `+refs/heads/${input.branch}:refs/windkeel/remote-head`]);
    if (fetched.error || fetched.status !== 0) {
      throw new HumanPushError("branch-moved", `could not read the run branch ${input.branch}: ${redact(fetched.stderr, token).trim()}`);
    }
    const head = line(must(await git(["rev-parse", "--verify", "refs/windkeel/remote-head"]), "branch-moved", "could not read the fetched head"));
    if (input.landed && head === input.landed && head === verified.sha) {
      alreadyLanded = true;
    } else if (head !== input.seedSha) {
      throw new HumanPushError(
        "branch-moved",
        `the run branch moved since the workspace was seeded (it is at ${head}, not ${input.seedSha}); nothing was pushed`,
      );
    } else {
      const pushed = await git([
        "push",
        "--porcelain",
        "--no-verify",
        `--force-with-lease=refs/heads/${input.branch}:${input.seedSha}`,
        url,
        `${verified.sha}:refs/heads/${input.branch}`,
      ]);
      if (pushed.error || pushed.status !== 0) {
        const detail = `${redact(pushed.stderr, token).trim()} ${redact(pushed.stdout, token).trim()}`.trim();
        if (/stale info|rejected/i.test(detail)) {
          throw new HumanPushError(
            "branch-moved",
            `the run branch moved (deleted or rewound) between the check and the push; nothing was pushed (${detail})`,
          );
        }
        throw new HumanPushError("push", `git push exited ${pushed.status ?? pushed.error}: ${detail}`);
      }
    }
  } catch (error) {
    primary = error instanceof HumanPushError ? error : new HumanPushError("push", messageOf(error));
  } finally {
    rmSync(verified.repoDir, { recursive: true, force: true });
  }

  let revokeError: string | null = null;
  try {
    await input.tokens.revoke(token);
  } catch (error) {
    revokeError = messageOf(error);
  }
  if (primary) {
    throw new HumanPushError(primary.stage, primary.message.replace(/^human push \[[^\]]+\]: /, ""), revokeError ? [new HumanPushError("revoke-token", revokeError)] : []);
  }
  return { sha: verified.sha, revokeError, ...(alreadyLanded ? { alreadyLanded: true } : {}) };
}

function authEnv(url: string, token: PushToken): Record<string, string> {
  if (!/^https:/i.test(url)) return {};
  const basic = Buffer.from(`${token.username}:${token.token}`, "utf8").toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

function remoteUrl(url: string): string {
  return url.startsWith("/") ? `file://${url}` : url;
}

interface ParsedCommit {
  tree: string | undefined;
  parents: string[];
  author: { name: string; email: string } | null;
  committer: { name: string; email: string } | null;
}

function parseCommit(raw: string): ParsedCommit {
  const header = raw.slice(0, raw.indexOf("\n\n") < 0 ? raw.length : raw.indexOf("\n\n"));
  const field = (name: string) => header.split("\n").filter((l) => l.startsWith(`${name} `)).map((l) => l.slice(name.length + 1));
  const ident = (value: string | undefined) => {
    const m = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(value ?? "");
    return m ? { name: m[1]!, email: m[2]! } : null;
  };
  return { tree: field("tree")[0], parents: field("parent"), author: ident(field("author")[0]), committer: ident(field("committer")[0]) };
}

function commitProblems(
  parsed: ParsedCommit,
  expected: { tree: string; parent: string; author: { name: string; email: string }; committer: WindkeelIdentity },
): string[] {
  const problems: string[] = [];
  if (parsed.tree !== expected.tree) problems.push("tree");
  if (parsed.parents.join(" ") !== expected.parent) problems.push("parent");
  if (parsed.author?.name !== expected.author.name || parsed.author?.email !== expected.author.email) problems.push("author");
  if (parsed.committer?.name !== expected.committer.name || parsed.committer?.email !== expected.committer.email) problems.push("committer");
  if (parsed.author?.email.toLowerCase() === expected.committer.email.toLowerCase()) problems.push("author is WINDKEEL_GIT_AUTHOR_EMAIL");
  return problems;
}

type GitRun = ((args: string[], env?: Record<string, string>) => Promise<ExecResult>) & { exec: GitExec };

function gitIn(workspace: WorkspaceExec, checkoutPath: string): GitRun {
  const exec: GitExec = (command, options) =>
    workspace.exec(command, { ...options, env: { ...WORKSPACE_GIT_ENV, ...options?.env } });
  const run = ((args: string[], env: Record<string, string> = {}) => hardenedGit(exec, args, { cwd: checkoutPath, env })) as GitRun;
  run.exec = exec;
  return run;
}

function must(result: ExecResult, stage: HumanPushStage, what: string): ExecResult {
  if (result.error || result.status !== 0) {
    throw new HumanPushError(stage, `${what} (${result.error ?? `exit ${result.status}`}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""})`);
  }
  return result;
}

function line(result: ExecResult): string {
  return result.stdout.trim().split("\n").pop()!.trim();
}

function redact(text: string, token: PushToken): string {
  return token.token ? text.split(token.token).join("***") : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function githubPushTokenIssuer(
  github: {
    mintInstallationToken(input: {
      repository: { owner: string; name: string };
      permissions: { contents?: "read" | "write" };
    }): Promise<{ token: string; expiresAt: string }>;
  },
  options: { apiBase?: string; fetch?: typeof fetch } = {},
): PushTokenIssuer {
  const apiBase = options.apiBase ?? "https://api.github.com";
  const doFetch = options.fetch ?? fetch;
  return {
    async mint({ repositoryUrl }) {
      const match = /^https:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repositoryUrl);
      if (!match) throw new Error(`not a GitHub repository URL: ${repositoryUrl}`);
      const minted = await github.mintInstallationToken({
        repository: { owner: match[1]!, name: match[2]! },
        permissions: { contents: "write" },
      });
      return { username: "x-access-token", token: minted.token, expiresAt: minted.expiresAt };
    },
    async revoke(token) {
      if (!token.token) return;
      const response = await doFetch(`${apiBase}/installation/token`, {
        method: "DELETE",
        headers: { authorization: `token ${token.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      });
      if (response.status !== 204) throw new Error(`DELETE /installation/token answered ${response.status}`);
    },
  };
}
