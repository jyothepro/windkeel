import { createHash } from "node:crypto";
import {
  type CheckRun,
  type CheckRunConclusion,
  type CheckRunOutput,
  type CheckRunStatus,
  type CollaboratorPermission,
  type CreateCheckRunInput,
  type CreatePullRequestInput,
  ForkRefusedError,
  type ForbiddenOperation,
  GitHubApiError,
  type GitHubClient,
  type InstallationPermissions,
  type InstallationToken,
  type Issue,
  type IssueComment,
  type IssueState,
  type ListPullRequestsInput,
  type MintInstallationTokenInput,
  NotFoundError,
  PermissionDeniedError,
  type PullRequest,
  type PullRequestCommit,
  type PullRequestState,
  RateLimitedError,
  RefusedOperationError,
  type Repository,
  type RepositoryRef,
  type UpdateCheckRunInput,
  assertSameRepositoryHead,
  repositoryPath,
} from "./client.js";

export type FakeGitHubMethod =
  | "mintInstallationToken"
  | "getRepository"
  | "getCollaboratorPermission"
  | "getIssue"
  | "createIssueComment"
  | "updateIssueComment"
  | "listIssueComments"
  | "createPullRequest"
  | "getPullRequest"
  | "getBranchHead"
  | "listPullRequests"
  | "listPullRequestCommits"
  | "createCheckRun"
  | "updateCheckRun"
  | "listCheckRuns";

export type InjectedFailure =
  | { readonly kind: "notFound" }
  | { readonly kind: "permissionDenied"; readonly permission?: keyof InstallationPermissions }
  | { readonly kind: "rateLimited"; readonly retryAfterMs?: number }
  | { readonly kind: "apiError"; readonly status: number; readonly detail?: string };

export type GitHubCallRecord =
  | { type: "mintInstallationToken"; input: MintInstallationTokenInput }
  | { type: "getRepository"; repository: RepositoryRef }
  | { type: "getCollaboratorPermission"; repository: RepositoryRef; username: string }
  | { type: "getIssue"; repository: RepositoryRef; issueNumber: number }
  | { type: "createIssueComment"; repository: RepositoryRef; issueNumber: number; body: string }
  | { type: "updateIssueComment"; repository: RepositoryRef; commentId: number; body: string }
  | { type: "listIssueComments"; repository: RepositoryRef; issueNumber: number }
  | { type: "createPullRequest"; input: CreatePullRequestInput }
  | { type: "getPullRequest"; repository: RepositoryRef; pullNumber: number }
  | { type: "getBranchHead"; repository: RepositoryRef; branch: string }
  | { type: "listPullRequests"; input: ListPullRequestsInput }
  | { type: "listPullRequestCommits"; repository: RepositoryRef; pullNumber: number }
  | { type: "createCheckRun"; input: CreateCheckRunInput }
  | { type: "updateCheckRun"; input: UpdateCheckRunInput }
  | { type: "listCheckRuns"; repository: RepositoryRef; headSha: string }
  | { type: "refuse"; operation: ForbiddenOperation };

export interface FakeIssueCommentSeed {
  readonly body: string;
  readonly authorLogin?: string;
}

export interface FakeIssueSeed {
  readonly number: number;
  readonly title?: string;
  readonly body?: string;
  readonly state?: IssueState;
  readonly labels?: readonly string[];
  readonly authorLogin?: string;
  readonly comments?: readonly FakeIssueCommentSeed[];
}

export interface FakePullRequestCommitSeed {
  readonly sha: string;
  readonly authorEmail?: string;
  readonly authorLogin?: string | null;
  readonly authoredAt?: string;
  readonly parentCount?: number;
}

export interface FakePullRequestSeed {
  readonly number: number;
  readonly title?: string;
  readonly body?: string;
  readonly state?: PullRequestState;
  readonly headRef: string;
  readonly headSha?: string;
  readonly baseRef?: string;
  readonly merged?: boolean;
  readonly commits?: readonly FakePullRequestCommitSeed[];
}

export interface FakeRepositorySeed {
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch?: string;
  readonly fork?: boolean;
  readonly permissions?: InstallationPermissions;
  readonly issues?: readonly FakeIssueSeed[];
  readonly pullRequests?: readonly FakePullRequestSeed[];
  readonly branches?: Readonly<Record<string, string>>;
  readonly collaborators?: Readonly<Record<string, { permission: string; roleName?: string | null }>>;
}

export interface FakeGitHubSeed {
  readonly repositories?: readonly FakeRepositorySeed[];
}

export interface FakeGitHubClientOptions {
  readonly now?: () => number;
  readonly tokenLifetimeMs?: number;
  readonly resolveBranchHead?: (repository: RepositoryRef, branch: string) => string | null | undefined;
}

const FULL_PERMISSIONS: InstallationPermissions = {
  metadata: "read",
  contents: "write",
  issues: "write",
  pull_requests: "write",
  checks: "write",
};

const HOUR_MS = 60 * 60 * 1000;

interface StoredComment {
  id: number;
  body: string;
  authorLogin: string;
  issueNumber: number;
}

interface StoredIssue {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  authorLogin: string;
}

interface StoredPullRequest {
  number: number;
  title: string;
  body: string;
  state: PullRequestState;
  headRef: string;
  headSha: string;
  baseRef: string;
  merged: boolean;
  commits: PullRequestCommit[];
}

interface StoredCheckRun {
  id: number;
  name: string;
  headSha: string;
  status: CheckRunStatus;
  conclusion: CheckRunConclusion | null;
  detailsUrl: string | null;
  output: CheckRunOutput | null;
}

interface StoredRepository {
  owner: string;
  name: string;
  defaultBranch: string;
  fork: boolean;
  permissions: InstallationPermissions;
  issues: Map<number, StoredIssue>;
  comments: StoredComment[];
  pullRequests: Map<number, StoredPullRequest>;
  checkRuns: Map<number, StoredCheckRun>;
  branches: Map<string, string>;
  collaborators: Map<string, CollaboratorPermission>;
}

function derivedHeadSha(repository: RepositoryRef, ref: string): string {
  return createHash("sha1").update(`${repositoryPath(repository)}#${ref}`).digest("hex");
}

export class FakeGitHubClient implements GitHubClient {
  readonly name = "fake";
  readonly calls: GitHubCallRecord[] = [];

  private readonly repositories = new Map<string, StoredRepository>();
  private readonly failures = new Map<FakeGitHubMethod | "*", InjectedFailure[]>();
  private readonly now: () => number;
  private readonly tokenLifetimeMs: number;
  private readonly resolveBranchHead: FakeGitHubClientOptions["resolveBranchHead"];
  private nextCommentId = 1;
  private nextPullNumber = 1;
  private nextCheckRunId = 1;
  private nextTokenSerial = 1;

  constructor(seed: FakeGitHubSeed = {}, options: FakeGitHubClientOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.tokenLifetimeMs = options.tokenLifetimeMs ?? HOUR_MS;
    this.resolveBranchHead = options.resolveBranchHead;
    for (const repository of seed.repositories ?? []) this.seedRepository(repository);
  }

  seedRepository(seed: FakeRepositorySeed): void {
    const stored: StoredRepository = {
      owner: seed.owner,
      name: seed.name,
      defaultBranch: seed.defaultBranch ?? "main",
      fork: seed.fork ?? false,
      permissions: seed.permissions ?? FULL_PERMISSIONS,
      issues: new Map(),
      comments: [],
      pullRequests: new Map(),
      checkRuns: new Map(),
      branches: new Map(Object.entries(seed.branches ?? {})),
      collaborators: new Map(
        Object.entries(seed.collaborators ?? {}).map(([login, value]) => [
          login.toLowerCase(),
          { permission: value.permission, roleName: value.roleName ?? null },
        ]),
      ),
    };
    for (const issue of seed.issues ?? []) {
      stored.issues.set(issue.number, {
        number: issue.number,
        title: issue.title ?? `Issue ${issue.number}`,
        body: issue.body ?? "",
        state: issue.state ?? "open",
        labels: [...(issue.labels ?? [])],
        authorLogin: issue.authorLogin ?? "seed-user",
      });
      for (const comment of issue.comments ?? []) {
        stored.comments.push({
          id: this.nextCommentId++,
          body: comment.body,
          authorLogin: comment.authorLogin ?? "seed-user",
          issueNumber: issue.number,
        });
      }
    }
    for (const pull of seed.pullRequests ?? []) {
      stored.pullRequests.set(pull.number, {
        number: pull.number,
        title: pull.title ?? `PR ${pull.number}`,
        body: pull.body ?? "",
        state: pull.state ?? "open",
        headRef: pull.headRef,
        headSha: pull.headSha ?? derivedHeadSha(seed, pull.headRef),
        baseRef: pull.baseRef ?? stored.defaultBranch,
        merged: pull.merged ?? false,
        commits: (pull.commits ?? []).map(toStoredCommit),
      });
      this.nextPullNumber = Math.max(this.nextPullNumber, pull.number + 1);
    }
    this.repositories.set(repositoryPath(seed), stored);
  }

  injectFailure(
    method: FakeGitHubMethod | "*",
    failure: InjectedFailure,
    options: { count?: number } = {},
  ): void {
    const queue = this.failures.get(method) ?? [];
    for (let i = 0; i < (options.count ?? 1); i++) queue.push(failure);
    this.failures.set(method, queue);
  }

  revokePermission(repository: RepositoryRef, permission: keyof InstallationPermissions): void {
    const stored = this.requireRepository(repository);
    const { [permission]: _removed, ...rest } = stored.permissions;
    stored.permissions = rest;
  }

  setBranchHead(repository: RepositoryRef, branch: string, sha: string): void {
    this.requireRepository(repository).branches.set(branch, sha);
  }

  setCollaboratorPermission(
    repository: RepositoryRef,
    username: string,
    permission: string,
    roleName: string | null = permission,
  ): void {
    this.requireRepository(repository).collaborators.set(username.toLowerCase(), { permission, roleName });
  }

  commentsOn(repository: RepositoryRef, issueNumber: number): IssueComment[] {
    return this.requireRepository(repository)
      .comments.filter((c) => c.issueNumber === issueNumber)
      .map((c) => this.toComment(repository, c));
  }

  checkRunsFor(repository: RepositoryRef, headSha: string): CheckRun[] {
    return [...this.requireRepository(repository).checkRuns.values()]
      .filter((c) => c.headSha === headSha)
      .map(toCheckRun);
  }

  async mintInstallationToken(input: MintInstallationTokenInput): Promise<InstallationToken> {
    this.calls.push({ type: "mintInstallationToken", input });
    this.maybeFail("mintInstallationToken", repositoryPath(input.repository));
    const stored = this.requireRepository(input.repository);
    for (const [key, level] of Object.entries(input.permissions) as Array<
      [keyof InstallationPermissions, RepositoryPermissionValue]
    >) {
      const granted = stored.permissions[key];
      if (!granted || (level === "write" && granted === "read")) {
        throw new PermissionDeniedError(
          `token for ${repositoryPath(input.repository)}`,
          key,
        );
      }
    }
    const serial = this.nextTokenSerial++;
    return {
      token: `fake-installation-token-${serial}`,
      expiresAt: new Date(this.now() + this.tokenLifetimeMs).toISOString(),
      repository: { owner: input.repository.owner, name: input.repository.name },
      permissions: { ...input.permissions },
    };
  }

  async getRepository(repository: RepositoryRef): Promise<Repository> {
    this.calls.push({ type: "getRepository", repository });
    this.maybeFail("getRepository", repositoryPath(repository));
    const stored = this.requireRepository(repository);
    return {
      owner: stored.owner,
      name: stored.name,
      defaultBranch: stored.defaultBranch,
      cloneUrl: `https://github.com/${repositoryPath(repository)}.git`,
      htmlUrl: `https://github.com/${repositoryPath(repository)}`,
      fork: stored.fork,
      permissions: { ...stored.permissions },
    };
  }

  async getCollaboratorPermission(
    repository: RepositoryRef,
    username: string,
  ): Promise<CollaboratorPermission> {
    this.calls.push({ type: "getCollaboratorPermission", repository, username });
    this.maybeFail("getCollaboratorPermission", `${repositoryPath(repository)} permission of ${username}`);
    const stored = this.requireRepository(repository);
    this.requirePermission(repository, stored, "metadata", "read");
    const found = stored.collaborators.get(username.toLowerCase());
    return found ? { ...found } : { permission: "none", roleName: null };
  }

  async getIssue(repository: RepositoryRef, issueNumber: number): Promise<Issue> {
    this.calls.push({ type: "getIssue", repository, issueNumber });
    this.maybeFail("getIssue", `${repositoryPath(repository)}#${issueNumber}`);
    const stored = this.requireRepository(repository);
    this.requirePermission(repository, stored, "issues", "read");
    const issue = stored.issues.get(issueNumber);
    if (!issue) throw new NotFoundError(`${repositoryPath(repository)}#${issueNumber}`);
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: [...issue.labels],
      htmlUrl: `https://github.com/${repositoryPath(repository)}/issues/${issue.number}`,
      authorLogin: issue.authorLogin,
    };
  }

  async createIssueComment(
    repository: RepositoryRef,
    issueNumber: number,
    body: string,
  ): Promise<IssueComment> {
    this.calls.push({ type: "createIssueComment", repository, issueNumber, body });
    this.maybeFail("createIssueComment", `${repositoryPath(repository)}#${issueNumber}`);
    const stored = this.requireRepository(repository);
    this.refuseForkWrite(stored, `comment on ${repositoryPath(repository)}#${issueNumber}`);
    this.requirePermission(repository, stored, "issues", "write");
    if (!stored.issues.has(issueNumber) && !stored.pullRequests.has(issueNumber)) {
      throw new NotFoundError(`${repositoryPath(repository)}#${issueNumber}`);
    }
    const comment: StoredComment = {
      id: this.nextCommentId++,
      body,
      authorLogin: "windkeel[bot]",
      issueNumber,
    };
    stored.comments.push(comment);
    return this.toComment(repository, comment);
  }

  async updateIssueComment(
    repository: RepositoryRef,
    commentId: number,
    body: string,
  ): Promise<IssueComment> {
    this.calls.push({ type: "updateIssueComment", repository, commentId, body });
    this.maybeFail("updateIssueComment", `${repositoryPath(repository)} comment ${commentId}`);
    const stored = this.requireRepository(repository);
    this.refuseForkWrite(stored, `comment ${commentId} on ${repositoryPath(repository)}`);
    this.requirePermission(repository, stored, "issues", "write");
    const comment = stored.comments.find((c) => c.id === commentId);
    if (!comment) {
      throw new NotFoundError(`${repositoryPath(repository)} comment ${commentId}`);
    }
    comment.body = body;
    return this.toComment(repository, comment);
  }

  async listIssueComments(
    repository: RepositoryRef,
    issueNumber: number,
  ): Promise<IssueComment[]> {
    this.calls.push({ type: "listIssueComments", repository, issueNumber });
    this.maybeFail("listIssueComments", `${repositoryPath(repository)}#${issueNumber}`);
    const stored = this.requireRepository(repository);
    this.requirePermission(repository, stored, "issues", "read");
    return this.commentsOn(repository, issueNumber);
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    this.calls.push({ type: "createPullRequest", input });
    this.maybeFail("createPullRequest", repositoryPath(input.repository));
    assertSameRepositoryHead(input.headRef);
    const stored = this.requireRepository(input.repository);
    this.refuseForkWrite(stored, `pull request on ${repositoryPath(input.repository)}`);
    this.requirePermission(input.repository, stored, "pull_requests", "write");
    const pull: StoredPullRequest = {
      number: this.nextPullNumber++,
      title: input.title,
      body: input.body,
      state: "open",
      headRef: input.headRef,
      headSha: this.branchHead(input.repository, stored, input.headRef) ?? derivedHeadSha(input.repository, input.headRef),
      baseRef: input.baseRef,
      merged: false,
      commits: [],
    };
    stored.pullRequests.set(pull.number, pull);
    return toPullRequest(input.repository, pull);
  }

  async getPullRequest(repository: RepositoryRef, pullNumber: number): Promise<PullRequest> {
    this.calls.push({ type: "getPullRequest", repository, pullNumber });
    this.maybeFail("getPullRequest", `${repositoryPath(repository)}#${pullNumber}`);
    const stored = this.requireRepository(repository);
    this.requirePermission(repository, stored, "pull_requests", "read");
    const pull = stored.pullRequests.get(pullNumber);
    if (!pull) throw new NotFoundError(`${repositoryPath(repository)}#${pullNumber}`);
    return toPullRequest(repository, pull);
  }

  async getBranchHead(repository: RepositoryRef, branch: string): Promise<string | null> {
    this.calls.push({ type: "getBranchHead", repository, branch });
    this.maybeFail("getBranchHead", `${repositoryPath(repository)}@${branch}`);
    const stored = this.requireRepository(repository);
    this.requirePermission(repository, stored, "contents", "read");
    return this.branchHead(repository, stored, branch);
  }

  private branchHead(repository: RepositoryRef, stored: StoredRepository, branch: string): string | null {
    return stored.branches.get(branch) ?? this.resolveBranchHead?.(repository, branch) ?? null;
  }

  async listPullRequests(input: ListPullRequestsInput): Promise<PullRequest[]> {
    this.calls.push({ type: "listPullRequests", input });
    this.maybeFail("listPullRequests", repositoryPath(input.repository));
    const stored = this.requireRepository(input.repository);
    this.requirePermission(input.repository, stored, "pull_requests", "read");
    const wanted = input.state ?? "open";
    return [...stored.pullRequests.values()]
      .filter((p) => (wanted === "all" ? true : p.state === wanted))
      .filter((p) => (input.headRef === undefined ? true : p.headRef === input.headRef))
      .map((p) => toPullRequest(input.repository, p));
  }

  async listPullRequestCommits(
    repository: RepositoryRef,
    pullNumber: number,
  ): Promise<PullRequestCommit[]> {
    this.calls.push({ type: "listPullRequestCommits", repository, pullNumber });
    this.maybeFail("listPullRequestCommits", `${repositoryPath(repository)}#${pullNumber}`);
    const stored = this.requireRepository(repository);
    this.requirePermission(repository, stored, "pull_requests", "read");
    const pull = stored.pullRequests.get(pullNumber);
    if (!pull) throw new NotFoundError(`${repositoryPath(repository)}#${pullNumber}`);
    return pull.commits.map((c) => ({ ...c }));
  }

  seedPullRequestCommits(
    repository: RepositoryRef,
    pullNumber: number,
    commits: readonly FakePullRequestCommitSeed[],
  ): void {
    const stored = this.requireRepository(repository);
    const pull = stored.pullRequests.get(pullNumber);
    if (!pull) throw new NotFoundError(`${repositoryPath(repository)}#${pullNumber}`);
    pull.commits = commits.map(toStoredCommit);
  }

  async createCheckRun(input: CreateCheckRunInput): Promise<CheckRun> {
    this.calls.push({ type: "createCheckRun", input });
    this.maybeFail("createCheckRun", `${repositoryPath(input.repository)}@${input.headSha}`);
    const stored = this.requireRepository(input.repository);
    this.refuseForkWrite(stored, `check run on ${repositoryPath(input.repository)}`);
    this.requirePermission(input.repository, stored, "checks", "write");
    assertConclusionMatchesStatus(input.status, input.conclusion);
    const checkRun: StoredCheckRun = {
      id: this.nextCheckRunId++,
      name: input.name,
      headSha: input.headSha,
      status: input.status,
      conclusion: input.conclusion ?? null,
      detailsUrl: input.detailsUrl ?? null,
      output: input.output ?? null,
    };
    stored.checkRuns.set(checkRun.id, checkRun);
    return toCheckRun(checkRun);
  }

  async updateCheckRun(input: UpdateCheckRunInput): Promise<CheckRun> {
    this.calls.push({ type: "updateCheckRun", input });
    this.maybeFail("updateCheckRun", `${repositoryPath(input.repository)}/${input.checkRunId}`);
    const stored = this.requireRepository(input.repository);
    this.refuseForkWrite(stored, `check run ${input.checkRunId}`);
    this.requirePermission(input.repository, stored, "checks", "write");
    const checkRun = stored.checkRuns.get(input.checkRunId);
    if (!checkRun) {
      throw new NotFoundError(`${repositoryPath(input.repository)} check run ${input.checkRunId}`);
    }
    const status = input.status ?? checkRun.status;
    const conclusion = input.conclusion ?? checkRun.conclusion ?? undefined;
    assertConclusionMatchesStatus(status, conclusion);
    checkRun.status = status;
    if (input.conclusion !== undefined) checkRun.conclusion = input.conclusion;
    if (input.detailsUrl !== undefined) checkRun.detailsUrl = input.detailsUrl;
    if (input.output !== undefined) checkRun.output = input.output;
    return toCheckRun(checkRun);
  }

  async listCheckRuns(repository: RepositoryRef, headSha: string): Promise<CheckRun[]> {
    this.calls.push({ type: "listCheckRuns", repository, headSha });
    this.maybeFail("listCheckRuns", `${repositoryPath(repository)}@${headSha}`);
    const stored = this.requireRepository(repository);
    this.requirePermission(repository, stored, "checks", "read");
    return this.checkRunsFor(repository, headSha);
  }

  refuse(operation: ForbiddenOperation): never {
    this.calls.push({ type: "refuse", operation });
    throw new RefusedOperationError(operation);
  }

  private toComment(repository: RepositoryRef, comment: StoredComment): IssueComment {
    return {
      id: comment.id,
      body: comment.body,
      authorLogin: comment.authorLogin,
      htmlUrl:
        `https://github.com/${repositoryPath(repository)}/issues/` +
        `${comment.issueNumber}#issuecomment-${comment.id}`,
    };
  }

  private requireRepository(repository: RepositoryRef): StoredRepository {
    const stored = this.repositories.get(repositoryPath(repository));
    if (!stored) throw new NotFoundError(repositoryPath(repository));
    return stored;
  }

  private refuseForkWrite(stored: StoredRepository, detail: string): void {
    if (stored.fork) throw new ForkRefusedError(detail);
  }

  private requirePermission(
    repository: RepositoryRef,
    stored: StoredRepository,
    permission: keyof InstallationPermissions,
    level: RepositoryPermissionValue,
  ): void {
    const granted = stored.permissions[permission];
    if (!granted || (level === "write" && granted === "read")) {
      throw new PermissionDeniedError(repositoryPath(repository), permission);
    }
  }

  private maybeFail(method: FakeGitHubMethod, resource: string): void {
    const failure = this.takeFailure(method);
    if (!failure) return;
    switch (failure.kind) {
      case "notFound":
        throw new NotFoundError(resource);
      case "permissionDenied":
        throw failure.permission
          ? new PermissionDeniedError(resource, failure.permission)
          : new PermissionDeniedError(resource);
      case "rateLimited":
        throw new RateLimitedError(resource, failure.retryAfterMs ?? 60_000);
      case "apiError":
        throw new GitHubApiError(failure.status, resource, failure.detail ?? "injected failure");
    }
  }

  private takeFailure(method: FakeGitHubMethod): InjectedFailure | undefined {
    for (const key of [method, "*"] as const) {
      const queue = this.failures.get(key);
      const failure = queue?.shift();
      if (failure) return failure;
    }
    return undefined;
  }
}

type RepositoryPermissionValue = "read" | "write";

function toStoredCommit(seed: FakePullRequestCommitSeed): PullRequestCommit {
  return {
    sha: seed.sha,
    authorEmail: seed.authorEmail ?? "",
    authorLogin: seed.authorLogin ?? null,
    authoredAt: seed.authoredAt ?? "2026-01-01T00:00:00Z",
    parentCount: seed.parentCount ?? 1,
  };
}

function toPullRequest(repository: RepositoryRef, pull: StoredPullRequest): PullRequest {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    draft: true,
    headRef: pull.headRef,
    headSha: pull.headSha,
    baseRef: pull.baseRef,
    htmlUrl: `https://github.com/${repositoryPath(repository)}/pull/${pull.number}`,
    merged: pull.merged,
  };
}

function toCheckRun(checkRun: StoredCheckRun): CheckRun {
  return {
    id: checkRun.id,
    name: checkRun.name,
    headSha: checkRun.headSha,
    status: checkRun.status,
    conclusion: checkRun.conclusion,
    detailsUrl: checkRun.detailsUrl,
    output: checkRun.output,
  };
}

function assertConclusionMatchesStatus(
  status: CheckRunStatus,
  conclusion: CheckRunConclusion | undefined,
): void {
  if (status === "completed" && conclusion === undefined) {
    throw new GitHubApiError(422, "check run", "a completed check run needs a conclusion");
  }
  if (status !== "completed" && conclusion !== undefined) {
    throw new GitHubApiError(
      422,
      "check run",
      `a ${status} check run cannot carry a conclusion (${conclusion})`,
    );
  }
}
