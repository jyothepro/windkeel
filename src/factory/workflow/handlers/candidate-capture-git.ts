

import { runInExecutionPhase } from "../../../sandbox/lifecycle.js";
import { runBranchFor } from "../branch.js";
import {
  HARDENED_GIT_ARGS,
  HARDENED_GIT_ENV,
  hardenedGit,
  type GitExec,
} from "../../../sandbox/git-hardening.js";
import type { WorkerDiff } from "../../../worker/adapter.js";
import { MAKER_BROWSER_OUT_DIR } from "../../../sandbox/maker-browser/install.js";
import type { CandidateCapture, CaptureOptions } from "./candidate-capture.js";

export function workingBranchFor(engineeringRunId: string): string {
  return runBranchFor(engineeringRunId, null);
}

export function isMakerBrowserOutput(path: string): boolean {
  const normalized = path.replace(/^\.\//, "");
  return normalized === MAKER_BROWSER_OUT_DIR || normalized.startsWith(`${MAKER_BROWSER_OUT_DIR}/`);
}

export function withoutMakerBrowserOutput(diff: WorkerDiff): WorkerDiff {
  const kept = diff.filesChanged.filter((f) => !isMakerBrowserOutput(f));
  if (kept.length === diff.filesChanged.length) return diff;
  return kept.length === 0
    ? { ...diff, filesChanged: [], patch: "" }
    : { ...diff, filesChanged: kept, patch: withoutMakerBrowserSections(diff.patch) };
}

function withoutMakerBrowserSections(patch: string): string {
  const sections = patch.split(/(?=^diff --git )/m);
  return sections
    .filter((section) => {
      const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(section);
      return !header || !(isMakerBrowserOutput(header[1]!) || isMakerBrowserOutput(header[2]!));
    })
    .join("");
}

export function assertOk(result: { error?: string; status: number | null; stderr: string }, what: string): void {
  if (result.error || result.status !== 0) {
    throw new Error(
      `candidate capture: ${what}: ${result.error ?? `exited ${result.status}`}` +
        `${result.stderr ? ` — ${result.stderr.trim()}` : ""}`,
    );
  }
}

export function commitMessage(engineeringRunId: string, diff: WorkerDiff): string {
  const files = diff.filesChanged.length;
  return [
    `windkeel: candidate for run ${engineeringRunId}`,
    "",
    `${files} file(s) changed${diff.truncated ? " (recorded patch is truncated)" : ""}.`,
    "Authored by an autonomous agent; verified independently before review.",
  ].join("\n");
}

export function phasedGit(options: CaptureOptions): GitExec {
  return (command, execOptions) =>
    runInExecutionPhase(options.handle, options.modelApiDomain, options.credentialRules, command, execOptions);
}

export function hardenedArgs(credentialFile: string | undefined): string[] {
  return [
    ...HARDENED_GIT_ARGS,
    ...(credentialFile ? ["-c", `credential.helper=store --file ${credentialFile}`] : []),
  ];
}

export function hardenedEnv(): Record<string, string> {
  return { ...HARDENED_GIT_ENV };
}

export async function quiesce(options: CaptureOptions, when: string): Promise<void> {
  const sweep = await options.handle.terminateStrayProcesses();
  if (!sweep.ensured && !sweep.noSandbox && options.installGitCredential) {
    throw new Error(
      `candidate capture: refusing to continue ${when}: ${sweep.reason}. The push would put a ` +
        "write token in a sandbox that may still be running the agent's processes.",
    );
  }
}

export async function revParseHead(options: CaptureOptions): Promise<string> {
  const result = await hardenedGit(phasedGit(options), ["rev-parse", "HEAD"], {
    ...(options.workdir !== undefined ? { cwd: options.workdir } : {}),
  });
  const sha = lastLine(result.stdout);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("candidate capture: could not resolve HEAD to a sha");
  }
  return sha;
}

export async function revParse(options: CaptureOptions, branch: string): Promise<string> {
  const result = await hardenedGit(phasedGit(options), ["rev-parse", "--verify", "--end-of-options", branch], {
    ...(options.workdir !== undefined ? { cwd: options.workdir } : {}),
  });
  const sha = lastLine(result.stdout);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`candidate capture: could not resolve ${branch} to a sha`);
  }
  return sha;
}

export async function storeDiff(
  options: CaptureOptions,
  candidateSha: string,
  diff: WorkerDiff,
): Promise<string | null> {
  if (!options.storage) return null;
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "windkeel-candidate-"));
  writeFileSync(join(dir, "candidate.diff"), diff.patch);
  writeFileSync(
    join(dir, "candidate.json"),
    JSON.stringify(
      {
        engineering_run_id: options.engineeringRunId,
        candidate_sha: candidateSha,
        working_branch: workingBranchFor(options.engineeringRunId),
        files_changed: diff.filesChanged,
        truncated: diff.truncated,
      },
      null,
      2,
    ) + "\n",
  );

  const key = `${options.engineeringRunId}/candidate/${candidateSha}`;
  await options.storage.storage.putPackage(dir, options.storage.bucket, key);
  return `${options.storage.bucket}/${key}`;
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return (lines[lines.length - 1] ?? "").trim();
}

export function preservedNote(candidate: CandidateCapture | null): string {
  if (!candidate) return "; nothing could be preserved from the workspace";
  if (candidate.empty || !candidate.candidateSha) {
    return "; the agent had changed nothing, so there was nothing to preserve";
  }
  return `; work preserved on ${candidate.workingBranch} at ${candidate.candidateSha}`;
}
