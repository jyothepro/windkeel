export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
}

export function repositoryPath(repository: RepositoryRef): string {
  return `${repository.owner}/${repository.name}`;
}

export type RepositoryPermission = "read" | "write";

export interface InstallationPermissions {
  readonly metadata?: "read";
  readonly contents?: RepositoryPermission;
  readonly issues?: RepositoryPermission;
  readonly pull_requests?: RepositoryPermission;
  readonly checks?: RepositoryPermission;
}

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly repository: RepositoryRef;
  readonly permissions: InstallationPermissions;
}

export interface MintInstallationTokenInput {
  readonly repository: RepositoryRef;
  readonly permissions: InstallationPermissions;
}

export interface Repository {
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly cloneUrl: string;
  readonly htmlUrl: string;
  readonly fork: boolean;
  readonly permissions: InstallationPermissions;
}

export interface CollaboratorPermission {
  readonly permission: string;
  readonly roleName: string | null;
}

export type IssueState = "open" | "closed";

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: IssueState;
  readonly labels: readonly string[];
  readonly htmlUrl: string;
  readonly authorLogin: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly htmlUrl: string;
  readonly authorLogin: string;
}

export type PullRequestState = "open" | "closed";

export interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: PullRequestState;
  readonly draft: boolean;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly htmlUrl: string;
  readonly merged: boolean;
}

export interface CreatePullRequestInput {
  readonly repository: RepositoryRef;
  readonly headRef: string;
  readonly baseRef: string;
  readonly title: string;
  readonly body: string;
}

export interface ListPullRequestsInput {
  readonly repository: RepositoryRef;
  readonly headRef?: string;
  readonly state?: PullRequestState | "all";
}

export interface PullRequestCommit {
  readonly sha: string;
  readonly authorEmail: string;
  readonly authorLogin: string | null;
  readonly authoredAt: string;
  readonly parentCount: number;
}

export type CheckRunConclusion = "success" | "neutral" | "failure";

export type CheckRunStatus = "queued" | "in_progress" | "completed";

export interface CheckRunOutput {
  readonly title: string;
  readonly summary: string;
  readonly text?: string;
}

export interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly headSha: string;
  readonly status: CheckRunStatus;
  readonly conclusion: CheckRunConclusion | null;
  readonly detailsUrl: string | null;
  readonly output: CheckRunOutput | null;
}

export interface CreateCheckRunInput {
  readonly repository: RepositoryRef;
  readonly headSha: string;
  readonly name: string;
  readonly status: CheckRunStatus;
  readonly conclusion?: CheckRunConclusion;
  readonly detailsUrl?: string;
  readonly output?: CheckRunOutput;
}

export interface UpdateCheckRunInput {
  readonly repository: RepositoryRef;
  readonly checkRunId: number;
  readonly status?: CheckRunStatus;
  readonly conclusion?: CheckRunConclusion;
  readonly detailsUrl?: string;
  readonly output?: CheckRunOutput;
}

export type ForbiddenOperation =
  | "pull_request.ready_for_review"
  | "pull_request.approve"
  | "pull_request.merge"
  | "fork.write";

class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends GitHubError {
  constructor(readonly resource: string) {
    super(`github: not found: ${resource}`);
  }
}

export class PermissionDeniedError extends GitHubError {
  constructor(
    readonly resource: string,
    readonly permission?: keyof InstallationPermissions,
  ) {
    super(
      `github: permission denied on ${resource}${permission ? ` (needs ${permission})` : ""}`,
    );
  }
}

export class RateLimitedError extends GitHubError {
  constructor(
    readonly resource: string,
    readonly retryAfterMs: number,
  ) {
    super(`github: rate limited on ${resource}, retry after ${retryAfterMs}ms`);
  }
}

export class ForkRefusedError extends GitHubError {
  constructor(readonly detail: string) {
    super(`github: refused, forks are out of scope for v1 (ADR-0009 §6): ${detail}`);
  }
}

export class RefusedOperationError extends GitHubError {
  constructor(readonly operation: ForbiddenOperation) {
    super(
      `github: refused ${operation} — the App never marks ready for review, approves, or ` +
        `merges (ADR-0009 §5); a human does`,
    );
  }
}

export class GitHubApiError extends GitHubError {
  constructor(
    readonly status: number,
    readonly resource: string,
    detail: string,
  ) {
    super(`github: ${status} on ${resource}: ${detail}`);
  }
}

export interface GitHubClient {
  readonly name: string;

  mintInstallationToken(input: MintInstallationTokenInput): Promise<InstallationToken>;

  getRepository(repository: RepositoryRef): Promise<Repository>;

  getCollaboratorPermission(repository: RepositoryRef, username: string): Promise<CollaboratorPermission>;

  getIssue(repository: RepositoryRef, issueNumber: number): Promise<Issue>;

  createIssueComment(
    repository: RepositoryRef,
    issueNumber: number,
    body: string,
  ): Promise<IssueComment>;

  updateIssueComment(
    repository: RepositoryRef,
    commentId: number,
    body: string,
  ): Promise<IssueComment>;

  listIssueComments(repository: RepositoryRef, issueNumber: number): Promise<IssueComment[]>;

  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;

  getPullRequest(repository: RepositoryRef, pullNumber: number): Promise<PullRequest>;

  getBranchHead(repository: RepositoryRef, branch: string): Promise<string | null>;

  listPullRequests(input: ListPullRequestsInput): Promise<PullRequest[]>;

  listPullRequestCommits(
    repository: RepositoryRef,
    pullNumber: number,
  ): Promise<PullRequestCommit[]>;

  createCheckRun(input: CreateCheckRunInput): Promise<CheckRun>;

  updateCheckRun(input: UpdateCheckRunInput): Promise<CheckRun>;

  listCheckRuns(repository: RepositoryRef, headSha: string): Promise<CheckRun[]>;

  refuse(operation: ForbiddenOperation): never;
}

export function assertSameRepositoryHead(headRef: string): void {
  if (headRef.includes(":")) {
    throw new ForkRefusedError(
      `head ref "${headRef}" names another repository; v1 opens PRs only from branches in the ` +
        `target repository`,
    );
  }
}
