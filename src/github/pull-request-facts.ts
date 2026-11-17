import { repositoryPath, type GitHubClient, type RepositoryRef } from "./client.js";
import { changedPaths, userClient, type FetchLike } from "./user-client.js";
import { mergeStateFromRest, type PullRequestFacts } from "../factory/merge-eligibility.js";

export interface AppPullRequestFacts extends Required<Pick<PullRequestFacts, "state" | "headSha" | "isDraft" | "mergeStateStatus" | "changedPaths" | "changedPathsComplete">> {
  htmlUrl: string | null;
}

export type PullRequestFactsReader = (repository: RepositoryRef, pullNumber: number) => Promise<AppPullRequestFacts>;

class PullRequestFactsError extends Error {
  override name = "PullRequestFactsError";
}

export function appPullRequestFacts(
  github: Pick<GitHubClient, "mintInstallationToken">,
  options: { apiBase?: string; fetchImpl?: FetchLike } = {},
): PullRequestFactsReader {
  return async (repository, pullNumber) => {
    const token = await github.mintInstallationToken({ repository, permissions: { pull_requests: "read" } });
    const client = userClient({ token: token.token, ...(options.apiBase ? { apiBase: options.apiBase } : {}), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    const where = { owner: repository.owner, name: repository.name, number: pullNumber };
    const pr = await client.call("GET", `/repos/${repositoryPath(repository)}/pulls/${pullNumber}`);
    if (pr.status !== 200) throw new PullRequestFactsError(`GitHub answered ${pr.status} reading ${repositoryPath(repository)}#${pullNumber}`);
    const files = await changedPaths(client, where);
    if (!files.ok) throw new PullRequestFactsError(`GitHub answered ${files.status} listing the files of ${repositoryPath(repository)}#${pullNumber}`);
    const body = pr.body as { state?: string; merged?: boolean; draft?: boolean; head?: { sha?: string }; mergeable_state?: string; html_url?: string };
    return {
      state: body.merged ? "MERGED" : body.state === "open" ? "OPEN" : "CLOSED",
      headSha: body.head?.sha ?? "",
      isDraft: body.draft === true,
      mergeStateStatus: mergeStateFromRest(body.mergeable_state),
      changedPaths: files.paths,
      changedPathsComplete: files.complete,
      htmlUrl: body.html_url ?? null,
    };
  };
}
