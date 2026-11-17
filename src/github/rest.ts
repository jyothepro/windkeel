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
import {
  type GitHubConfig,
  InstallationTokenCache,
  createAppJwt,
  loadGitHubConfig,
  tokenCacheKey,
} from "./app.js";

export type FetchLike = typeof fetch;

const CONTROL_PLANE_PERMISSIONS: InstallationPermissions = {
  metadata: "read",
  contents: "write",
  issues: "write",
  pull_requests: "write",
  checks: "write",
};

const GITHUB_API_VERSION = "2022-11-28";

export interface RetryEvent {
  readonly resource: string;
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: "network" | "server-error";
}

export interface RestGitHubClientOptions {
  readonly config: GitHubConfig;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: (event: RetryEvent) => void;
  readonly maxAttempts?: number;
  readonly userAgent?: string;
}

interface InstallationRecord {
  readonly id: number;
  readonly permissions: InstallationPermissions;
}

interface RequestSpec {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly resource: string;
  readonly auth: "app" | { repository: RepositoryRef };
  readonly body?: unknown;
  readonly permission?: keyof InstallationPermissions;
}

interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export class RestGitHubClient implements GitHubClient {
  readonly name = "rest";

  private readonly config: GitHubConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;
  private readonly maxAttempts: number;
  private readonly userAgent: string;
  private readonly tokens: InstallationTokenCache;
  private readonly installations = new Map<string, InstallationRecord>();
  private readonly repositoryFacts = new Map<string, Repository>();

  constructor(options: RestGitHubClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onRetry = options.onRetry;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.userAgent = options.userAgent ?? "windkeel-control-plane";
    this.tokens = new InstallationTokenCache(this.now);
  }

  async mintInstallationToken(input: MintInstallationTokenInput): Promise<InstallationToken> {
    const installation = await this.installation(input.repository);
    const key = tokenCacheKey(installation.id, input.repository, input.permissions);
    const cached = this.tokens.get(key);
    if (cached) return cached;

    const response = await this.request({
      method: "POST",
      path: `/app/installations/${installation.id}/access_tokens`,
      resource: `installation token for ${repositoryPath(input.repository)}`,
      auth: "app",
      body: {
        repositories: [input.repository.name],
        permissions: input.permissions,
      },
    });
    const payload = response.body as {
      token?: string;
      expires_at?: string;
      permissions?: InstallationPermissions;
    };
    if (!payload.token || !payload.expires_at) {
      throw new GitHubApiError(
        response.status,
        `installation token for ${repositoryPath(input.repository)}`,
        "response carried no token or expiry",
      );
    }
    const token: InstallationToken = {
      token: payload.token,
      expiresAt: payload.expires_at,
      repository: { owner: input.repository.owner, name: input.repository.name },
      permissions: payload.permissions ?? input.permissions,
    };
    this.tokens.set(key, token);
    return token;
  }

  async getRepository(repository: RepositoryRef): Promise<Repository> {
    const response = await this.request({
      method: "GET",
      path: `/repos/${repositoryPath(repository)}`,
      resource: repositoryPath(repository),
      auth: { repository },
      permission: "metadata",
    });
    const payload = response.body as {
      name?: string;
      default_branch?: string;
      clone_url?: string;
      html_url?: string;
      fork?: boolean;
      owner?: { login?: string };
    };
    if (typeof payload.default_branch !== "string" || payload.default_branch === "") {
      throw new GitHubApiError(
        response.status,
        repositoryPath(repository),
        "repository record carried no default_branch",
      );
    }
    const installation = await this.installation(repository);
    const facts: Repository = {
      owner: payload.owner?.login ?? repository.owner,
      name: payload.name ?? repository.name,
      defaultBranch: payload.default_branch,
      cloneUrl: payload.clone_url ?? `https://github.com/${repositoryPath(repository)}.git`,
      htmlUrl: payload.html_url ?? `https://github.com/${repositoryPath(repository)}`,
      fork: payload.fork === true,
      permissions: installation.permissions,
    };
    this.repositoryFacts.set(repositoryPath(repository), facts);
    return facts;
  }

  async getCollaboratorPermission(
    repository: RepositoryRef,
    username: string,
  ): Promise<CollaboratorPermission> {
    const response = await this.request({
      method: "GET",
      path: `/repos/${repositoryPath(repository)}/collaborators/${encodeURIComponent(username)}/permission`,
      resource: `${repositoryPath(repository)} permission of ${username}`,
      auth: { repository },
      permission: "metadata",
    });
    const payload = response.body as { permission?: unknown; role_name?: unknown };
    if (typeof payload.permission !== "string") {
      throw new GitHubApiError(
        response.status,
        `${repositoryPath(repository)} permission of ${username}`,
        "response carried no permission",
      );
    }
    return {
      permission: payload.permission,
      roleName: typeof payload.role_name === "string" ? payload.role_name : null,
    };
  }

  async getIssue(repository: RepositoryRef, issueNumber: number): Promise<Issue> {
    const response = await this.request({
      method: "GET",
      path: `/repos/${repositoryPath(repository)}/issues/${issueNumber}`,
      resource: `${repositoryPath(repository)}#${issueNumber}`,
      auth: { repository },
      permission: "issues",
    });
    return toIssue(response.body);
  }

  async createIssueComment(
    repository: RepositoryRef,
    issueNumber: number,
    body: string,
  ): Promise<IssueComment> {
    await this.assertNotFork(repository, `comment on ${repositoryPath(repository)}`);
    const response = await this.request({
      method: "POST",
      path: `/repos/${repositoryPath(repository)}/issues/${issueNumber}/comments`,
      resource: `${repositoryPath(repository)}#${issueNumber} comments`,
      auth: { repository },
      permission: "issues",
      body: { body },
    });
    return toComment(response.body);
  }

  async updateIssueComment(
    repository: RepositoryRef,
    commentId: number,
    body: string,
  ): Promise<IssueComment> {
    await this.assertNotFork(repository, `comment ${commentId} on ${repositoryPath(repository)}`);
    const response = await this.request({
      method: "PATCH",
      path: `/repos/${repositoryPath(repository)}/issues/comments/${commentId}`,
      resource: `${repositoryPath(repository)} comment ${commentId}`,
      auth: { repository },
      permission: "issues",
      body: { body },
    });
    return toComment(response.body);
  }

  async listIssueComments(
    repository: RepositoryRef,
    issueNumber: number,
  ): Promise<IssueComment[]> {
    const pages = await this.paginate({
      method: "GET",
      path: `/repos/${repositoryPath(repository)}/issues/${issueNumber}/comments?per_page=100`,
      resource: `${repositoryPath(repository)}#${issueNumber} comments`,
      auth: { repository },
      permission: "issues",
    });
    return pages.map(toComment);
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    assertSameRepositoryHead(input.headRef);
    await this.assertNotFork(
      input.repository,
      `pull request on ${repositoryPath(input.repository)}`,
    );
    const response = await this.request({
      method: "POST",
      path: `/repos/${repositoryPath(input.repository)}/pulls`,
      resource: `${repositoryPath(input.repository)} pulls`,
      auth: { repository: input.repository },
      permission: "pull_requests",
      body: {
        title: input.title,
        body: input.body,
        head: input.headRef,
        base: input.baseRef,
        draft: true,
      },
    });
    return toPullRequest(response.body);
  }

  async getPullRequest(repository: RepositoryRef, pullNumber: number): Promise<PullRequest> {
    const response = await this.request({
      method: "GET",
      path: `/repos/${repositoryPath(repository)}/pulls/${pullNumber}`,
      resource: `${repositoryPath(repository)}#${pullNumber}`,
      auth: { repository },
      permission: "pull_requests",
    });
    return toPullRequest(response.body);
  }

  async getBranchHead(repository: RepositoryRef, branch: string): Promise<string | null> {
    try {
      const response = await this.request({
        method: "GET",
        path: `/repos/${repositoryPath(repository)}/git/ref/heads/${branch
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        resource: `${repositoryPath(repository)}@${branch}`,
        auth: { repository },
        permission: "contents",
      });
      const sha = (response.body as { object?: { sha?: unknown } } | null)?.object?.sha;
      return typeof sha === "string" ? sha : null;
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async listPullRequests(input: ListPullRequestsInput): Promise<PullRequest[]> {
    const query = new URLSearchParams({ state: input.state ?? "open", per_page: "100" });
    if (input.headRef !== undefined) {
      query.set("head", `${input.repository.owner}:${input.headRef}`);
    }
    const pages = await this.paginate({
      method: "GET",
      path: `/repos/${repositoryPath(input.repository)}/pulls?${query.toString()}`,
      resource: `${repositoryPath(input.repository)} pulls`,
      auth: { repository: input.repository },
      permission: "pull_requests",
    });
    return pages.map(toPullRequest);
  }

  async listPullRequestCommits(
    repository: RepositoryRef,
    pullNumber: number,
  ): Promise<PullRequestCommit[]> {
    const pages = await this.paginate({
      method: "GET",
      path: `/repos/${repositoryPath(repository)}/pulls/${pullNumber}/commits?per_page=100`,
      resource: `${repositoryPath(repository)}#${pullNumber} commits`,
      auth: { repository },
      permission: "pull_requests",
    });
    return pages.map(toPullRequestCommit);
  }

  async createCheckRun(input: CreateCheckRunInput): Promise<CheckRun> {
    await this.assertNotFork(
      input.repository,
      `check run on ${repositoryPath(input.repository)}`,
    );
    const response = await this.request({
      method: "POST",
      path: `/repos/${repositoryPath(input.repository)}/check-runs`,
      resource: `${repositoryPath(input.repository)}@${input.headSha}`,
      auth: { repository: input.repository },
      permission: "checks",
      body: {
        name: input.name,
        head_sha: input.headSha,
        status: input.status,
        ...(input.conclusion !== undefined ? { conclusion: input.conclusion } : {}),
        ...(input.detailsUrl !== undefined ? { details_url: input.detailsUrl } : {}),
        ...(input.output !== undefined ? { output: input.output } : {}),
      },
    });
    return toCheckRun(response.body);
  }

  async updateCheckRun(input: UpdateCheckRunInput): Promise<CheckRun> {
    await this.assertNotFork(input.repository, `check run ${input.checkRunId}`);
    const response = await this.request({
      method: "PATCH",
      path: `/repos/${repositoryPath(input.repository)}/check-runs/${input.checkRunId}`,
      resource: `${repositoryPath(input.repository)} check run ${input.checkRunId}`,
      auth: { repository: input.repository },
      permission: "checks",
      body: {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.conclusion !== undefined ? { conclusion: input.conclusion } : {}),
        ...(input.detailsUrl !== undefined ? { details_url: input.detailsUrl } : {}),
        ...(input.output !== undefined ? { output: input.output } : {}),
      },
    });
    return toCheckRun(response.body);
  }

  async listCheckRuns(repository: RepositoryRef, headSha: string): Promise<CheckRun[]> {
    const response = await this.request({
      method: "GET",
      path: `/repos/${repositoryPath(repository)}/commits/${headSha}/check-runs?per_page=100`,
      resource: `${repositoryPath(repository)}@${headSha} check runs`,
      auth: { repository },
      permission: "checks",
    });
    const payload = response.body as { check_runs?: unknown[] };
    return (payload.check_runs ?? []).map(toCheckRun);
  }

  refuse(operation: ForbiddenOperation): never {
    throw new RefusedOperationError(operation);
  }

  private async installation(repository: RepositoryRef): Promise<InstallationRecord> {
    const key = repositoryPath(repository);
    const cached = this.installations.get(key);
    if (cached) return cached;
    const response = await this.request({
      method: "GET",
      path: `/repos/${key}/installation`,
      resource: `installation for ${key}`,
      auth: "app",
    });
    const payload = response.body as { id?: number; permissions?: InstallationPermissions };
    const id = this.config.installationId ?? payload.id;
    if (typeof id !== "number") {
      throw new GitHubApiError(response.status, `installation for ${key}`, "no installation id");
    }
    const record: InstallationRecord = { id, permissions: payload.permissions ?? {} };
    this.installations.set(key, record);
    return record;
  }

  private async assertNotFork(repository: RepositoryRef, detail: string): Promise<void> {
    const cached = this.repositoryFacts.get(repositoryPath(repository));
    const facts = cached ?? (await this.getRepository(repository));
    if (facts.fork) throw new ForkRefusedError(detail);
  }

  private async authorization(auth: RequestSpec["auth"]): Promise<string> {
    if (auth === "app") return `Bearer ${createAppJwt(this.config.credentials, this.now())}`;
    const token = await this.mintInstallationToken({
      repository: auth.repository,
      permissions: CONTROL_PLANE_PERMISSIONS,
    });
    return `Bearer ${token.token}`;
  }

  private async paginate(spec: RequestSpec): Promise<unknown[]> {
    const items: unknown[] = [];
    let path: string | undefined = spec.path;
    while (path) {
      const response: RawResponse = await this.request({ ...spec, path });
      if (Array.isArray(response.body)) items.push(...response.body);
      path = nextPageUrl(response.headers.get("link"));
    }
    return items;
  }

  private async request(spec: RequestSpec): Promise<RawResponse> {
    const url = spec.path.startsWith("http") ? spec.path : `${this.config.baseUrl}${spec.path}`;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": this.userAgent,
      authorization: await this.authorization(spec.auth),
    };
    if (spec.body !== undefined) headers["content-type"] = "application/json";

    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: spec.method,
          headers,
          ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        });
      } catch (cause) {
        if (attempt >= this.maxAttempts) {
          throw new GitHubApiError(0, spec.resource, `request failed: ${errorMessage(cause)}`);
        }
        await this.backoff(spec.resource, attempt, "network");
        continue;
      }

      const body = await readBody(response);
      if (response.ok) return { status: response.status, headers: response.headers, body };

      if (response.status >= 500 && attempt < this.maxAttempts) {
        await this.backoff(spec.resource, attempt, "server-error");
        continue;
      }
      throw this.toTypedError(response, body, spec);
    }
  }

  private async backoff(
    resource: string,
    attempt: number,
    reason: RetryEvent["reason"],
  ): Promise<void> {
    const delayMs = 250 * 2 ** (attempt - 1);
    this.onRetry?.({ resource, attempt, delayMs, reason });
    await this.sleep(delayMs);
  }

  private toTypedError(response: Response, body: unknown, spec: RequestSpec): Error {
    const message = extractMessage(body);
    if (response.status === 404) return new NotFoundError(spec.resource);
    if (response.status === 429 || (response.status === 403 && isRateLimit(response, message))) {
      return new RateLimitedError(spec.resource, this.retryAfterMs(response));
    }
    if (response.status === 401 || response.status === 403) {
      return spec.permission
        ? new PermissionDeniedError(spec.resource, spec.permission)
        : new PermissionDeniedError(spec.resource);
    }
    return new GitHubApiError(response.status, spec.resource, message ?? "no message");
  }

  private retryAfterMs(response: Response): number {
    const retryAfter = Number(response.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) {
      return Math.max(1000, reset * 1000 - this.now());
    }
    return 60_000;
  }
}

export function githubClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<RestGitHubClientOptions, "config"> = {},
): RestGitHubClient {
  return new RestGitHubClient({ ...options, config: loadGitHubConfig(env) });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractMessage(body: unknown): string | undefined {
  if (typeof body === "string") return body;
  if (body && typeof body === "object" && "message" in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

function isRateLimit(response: Response, message: string | undefined): boolean {
  if (response.headers.get("x-ratelimit-remaining") === "0") return true;
  if (response.headers.get("retry-after") !== null) return true;
  return /rate limit|secondary rate|abuse detection/i.test(message ?? "");
}

function nextPageUrl(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function toIssue(body: unknown): Issue {
  const payload = body as {
    number?: number;
    title?: string;
    body?: string | null;
    state?: IssueState;
    labels?: Array<string | { name?: string }>;
    html_url?: string;
    user?: { login?: string };
  };
  return {
    number: payload.number ?? 0,
    title: payload.title ?? "",
    body: payload.body ?? "",
    state: payload.state ?? "open",
    labels: (payload.labels ?? [])
      .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
      .filter((name) => name !== ""),
    htmlUrl: payload.html_url ?? "",
    authorLogin: payload.user?.login ?? "",
  };
}

function toComment(body: unknown): IssueComment {
  const payload = body as {
    id?: number;
    body?: string | null;
    html_url?: string;
    user?: { login?: string };
  };
  return {
    id: payload.id ?? 0,
    body: payload.body ?? "",
    htmlUrl: payload.html_url ?? "",
    authorLogin: payload.user?.login ?? "",
  };
}

function toPullRequestCommit(body: unknown): PullRequestCommit {
  const payload = body as {
    sha?: string;
    commit?: { author?: { email?: string; date?: string } };
    author?: { login?: string } | null;
    parents?: unknown[];
  };
  return {
    sha: payload.sha ?? "",
    authorEmail: payload.commit?.author?.email ?? "",
    authorLogin: payload.author?.login ?? null,
    authoredAt: payload.commit?.author?.date ?? "",
    parentCount: payload.parents?.length ?? 1,
  };
}

function toPullRequest(body: unknown): PullRequest {
  const payload = body as {
    number?: number;
    title?: string;
    body?: string | null;
    state?: PullRequestState;
    draft?: boolean;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
    html_url?: string;
    merged?: boolean;
    merged_at?: string | null;
  };
  return {
    number: payload.number ?? 0,
    title: payload.title ?? "",
    body: payload.body ?? "",
    state: payload.state ?? "open",
    draft: payload.draft ?? false,
    headRef: payload.head?.ref ?? "",
    headSha: payload.head?.sha ?? "",
    baseRef: payload.base?.ref ?? "",
    htmlUrl: payload.html_url ?? "",
    merged: payload.merged ?? payload.merged_at != null,
  };
}

function toCheckRun(body: unknown): CheckRun {
  const payload = body as {
    id?: number;
    name?: string;
    head_sha?: string;
    status?: CheckRunStatus;
    conclusion?: CheckRunConclusion | null;
    details_url?: string | null;
    output?: CheckRunOutput | null;
  };
  return {
    id: payload.id ?? 0,
    name: payload.name ?? "",
    headSha: payload.head_sha ?? "",
    status: payload.status ?? "queued",
    conclusion: payload.conclusion ?? null,
    detailsUrl: payload.details_url ?? null,
    output: payload.output ?? null,
  };
}
