import type { GitHubClient, PullRequestCommit, RepositoryRef } from "../github/client.js";

export const GITHUB_PR_COMMITS_CAP = 250;

export type HumanCommitCount =
  | { kind: "counted"; count: number }
  | { kind: "unknown"; reason: string };

export interface HumanReworkIdentity {
  authorEmail: string;
}

function isWindkeel(commit: PullRequestCommit, identity: HumanReworkIdentity): boolean {
  return commit.authorEmail.toLowerCase() === identity.authorEmail.toLowerCase();
}

export function countHumanCommits(
  commits: readonly PullRequestCommit[],
  identity: HumanReworkIdentity,
): HumanCommitCount {
  if (commits.length >= GITHUB_PR_COMMITS_CAP) {
    return {
      kind: "unknown",
      reason:
        `the pull request has at least ${GITHUB_PR_COMMITS_CAP} commits, which is GitHub's cap ` +
        "on the commits endpoint — any count from a truncated list is a floor, not a number",
    };
  }

  const authored = commits.filter((commit) => commit.parentCount === 1);
  const unattributable = authored.find((commit) => commit.authorEmail.trim() === "");
  if (unattributable) {
    return {
      kind: "unknown",
      reason:
        `commit ${unattributable.sha.slice(0, 7)} carries no author email, so it cannot be ` +
        "attributed to Windkeel or to anyone else",
    };
  }

  return { kind: "counted", count: authored.filter((c) => !isWindkeel(c, identity)).length };
}

export async function measureHumanCommits(
  github: Pick<GitHubClient, "listPullRequestCommits">,
  repository: RepositoryRef,
  pullNumber: number,
  identity: HumanReworkIdentity,
): Promise<HumanCommitCount> {
  try {
    const commits = await github.listPullRequestCommits(repository, pullNumber);
    return countHumanCommits(commits, identity);
  } catch (error) {
    return {
      kind: "unknown",
      reason: `the pull request's commits could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
