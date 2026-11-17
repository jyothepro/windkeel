

import { runInExecutionPhase } from "../../../sandbox/lifecycle.js";
import { UnsafePushError as UnsafePushErrorImpl, assertRunBranch as assertRunBranchImpl, runBranchFor } from "../branch.js";
import type { CredentialBrokerRule, SandboxHandle } from "../../../sandbox/provider.js";
import {
  installGitCredential,
  removeGitCredential,
  type SandboxGitCredentials,
} from "../../../sandbox/git-credentials.js";
import { assertSafeGitConfig, hardenedGit } from "../../../sandbox/git-hardening.js";
import type { RepositoryRef } from "../../../github/client.js";
import { resolveRepositoryContext } from "../repository-target.js";
import type { StageDeps } from "../stage-deps.js";
import type { WorkerDiff } from "../../../worker/adapter.js";
import type { EvidenceStorage } from "../../evidence-storage.js";
import { updateWorkspace, type Workspace } from "../../repositories.js";
import { MAKER_BROWSER_OUT_DIR } from "../../../sandbox/maker-browser/install.js";
import {
  assertOk,
  commitMessage,
  hardenedArgs,
  hardenedEnv,
  phasedGit,
  quiesce,
  revParse,
  revParseHead,
  storeDiff,
  withoutMakerBrowserOutput,
} from "./candidate-capture-git.js";

export {
  workingBranchFor,
  isMakerBrowserOutput,
  withoutMakerBrowserOutput,
  preservedNote,
} from "./candidate-capture-git.js";

export {
  UnsafePushError,
  assertRunBranch,
  runBranchFor,
  slugify,
} from "../branch.js";

export type CaptureMode = "create" | "advance";

export interface CandidateCapture {
  candidateSha: string | null;
  workingBranch: string | null;

  diffRef: string | null;

  diffTruncated: boolean;
  filesChanged: string[];
  empty: boolean;
}

export const EMPTY_CHANGE_POLICY = {
  runState: "BLOCKED",
  reason: "the agent session completed without changing any files; a human decides what next",
} as const;

export async function gitCredentialsFor(
  deps: StageDeps,
  engineeringRunId: string,
): Promise<
  { broker: SandboxGitCredentials; repository: RepositoryRef; host: string } | undefined
> {
  if (!deps.gitCredentials) return undefined;
  const { repository } = await resolveRepositoryContext(
    deps.pool,
    engineeringRunId,
    deps.config.repository,
  );
  if (!repository) return undefined;
  return {
    broker: deps.gitCredentials.broker,
    repository: { owner: repository.owner, name: repository.name },
    host: deps.gitCredentials.host,
  };
}

export function gitCredentialInstallerFor(
  credentials: { broker: SandboxGitCredentials; repository: RepositoryRef; host: string } | undefined,
  workspace: { id: string; role: "maker" | "verifier" },
  handle: SandboxHandle,
): (() => Promise<string>) | undefined {
  if (!credentials) return undefined;
  return async () => {
    const credential = await credentials.broker.forWorkspace(
      workspace.id,
      workspace.role,
      credentials.repository,
    );
    return installGitCredential(handle, credentials.host, credential);
  };
}

export interface CaptureOptions {
  handle: SandboxHandle;
  workspace: Workspace;
  engineeringRunId: string;
  diff: WorkerDiff;
  modelApiDomain: string;
  credentialRules: CredentialBrokerRule[];

  gitHost: string;
  authorName: string;
  authorEmail: string;
  workdir?: string;

  task?: Pick<import("../../repositories.js").EngineeringTask, "sourceType" | "sourceReference" | "title"> | null;

  installGitCredential?: (() => Promise<string>) | undefined;
  storage?: { storage: EvidenceStorage; bucket: string } | undefined;

  mode?: CaptureMode;
}

export async function captureCandidate(
  pool: import("pg").Pool,
  options: CaptureOptions,
): Promise<CandidateCapture> {
  const { handle, workspace, engineeringRunId } = options;

  const diff = withoutMakerBrowserOutput(options.diff);

  if (diff.error) {

    throw new Error(`candidate capture: the workspace diff is not trustworthy: ${diff.error}`);
  }

  if (diff.filesChanged.length === 0 && diff.patch.trim() === "") {
    return {
      candidateSha: null,
      workingBranch: null,
      diffRef: null,
      diffTruncated: false,
      filesChanged: [],
      empty: true,
    };
  }

  if (handle.role !== "maker") {
    throw new UnsafePushErrorImpl(
      `refusing to publish a candidate from a ${handle.role}-role sandbox: only the maker holds ` +
        "contents:write (ADR-0014 §2)",
    );
  }

  const branch = runBranchFor(engineeringRunId, options.task ?? null);
  assertRunBranchImpl(branch, engineeringRunId, options.task ?? null);
  const mode: CaptureMode = options.mode ?? "create";

  if (mode === "create" && workspace.workingBranch) {
    assertRunBranchImpl(workspace.workingBranch, engineeringRunId, options.task ?? null);
    const sha = await revParse(options, workspace.workingBranch);
    return {
      candidateSha: sha,
      workingBranch: workspace.workingBranch,
      diffRef: null,
      diffTruncated: diff.truncated,
      filesChanged: diff.filesChanged,
      empty: false,
    };
  }

  await quiesce(options, "before reading the checkout's git configuration");
  const git = phasedGit(options);
  try {
    await assertSafeGitConfig(git, options.workdir);
  } catch (error) {
    throw new Error(`candidate capture: ${error instanceof Error ? error.message : String(error)}`);
  }

  const before = mode === "advance" ? await revParseHead(options) : null;

  const identity = [`user.name=${options.authorName}`, `user.email=${options.authorEmail}`];
  const at = options.workdir !== undefined ? { cwd: options.workdir } : {};
  const createBranch = await hardenedGit(git, ["checkout", "-q", "-b", branch], at);
  if (createBranch.status !== 0) {
    assertOk(await hardenedGit(git, ["checkout", "-q", branch], at), `could not check out ${branch}`);
  }
  assertOk(await hardenedGit(git, ["add", "-A"], at), `could not stage the change on ${branch}`);

  assertOk(
    await hardenedGit(git, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", MAKER_BROWSER_OUT_DIR], at),
    `could not keep ${MAKER_BROWSER_OUT_DIR} out of the commit on ${branch}`,
  );

  const staged = await hardenedGit(git, ["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv"], at);
  if (staged.status !== 0) {
    assertOk(
      await hardenedGit(
        git,
        [
          "commit",
          "-q",
          "--no-verify",
          "-m",
          commitMessage(engineeringRunId, diff),
          "--author",
          `${options.authorName} <${options.authorEmail}>`,
        ],
        { ...at, extraConfig: identity },
      ),
      `could not commit ${branch}`,
    );
  }

  if (mode === "advance") {
    const after = await revParseHead(options);
    if (after === before) {
      return {
        candidateSha: after,
        workingBranch: branch,
        diffRef: null,
        diffTruncated: diff.truncated,
        filesChanged: [],
        empty: true,
      };
    }
  }

  await quiesce(options, "before installing the git credential for the push");
  try {
    const credentialFile = await options.installGitCredential?.();
    const pushed = await runInExecutionPhase(
      handle,
      options.modelApiDomain,
      options.credentialRules,
      "git",
      {
        args: [
          ...hardenedArgs(credentialFile),
          "push",
          options.workspace.repository,
          `HEAD:refs/heads/${branch}`,
        ],
        ...at,
        env: hardenedEnv(),
      },
      { additionalAllowedDomains: [options.gitHost] },
    );
    assertOk(pushed, `could not push ${branch}`);
  } finally {

    try {
      if (options.installGitCredential) {
        try {
          await removeGitCredential(handle);
        } catch (error) {
          throw new Error(`candidate capture: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      await runInExecutionPhase(handle, options.modelApiDomain, options.credentialRules, "true");
    }
  }

  const candidateSha = await revParseHead(options);

  await updateWorkspace(pool, workspace.id, { workingBranch: branch });

  const diffRef = await storeDiff(options, candidateSha, diff);

  return {
    candidateSha,
    workingBranch: branch,
    diffRef,
    diffTruncated: diff.truncated,
    filesChanged: diff.filesChanged,
    empty: false,
  };
}
