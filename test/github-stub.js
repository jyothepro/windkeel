/**
 * A stub GitHub, as a `fetch`-shaped function.
 *
 * The conformance suite (test/github-conformance.js) has to run against the *real* client, which
 * means something has to answer its HTTP. The ticket forbids a new test dependency, so this is
 * that something: an in-memory GitHub that speaks the wire shapes the REST client parses —
 * snake_case keys, `labels: [{name}]`, `head: {ref, sha}`, `Link` pagination, and the header
 * combinations that distinguish a missing permission from a secondary rate limit.
 *
 * It is deliberately *not* `FakeGitHubClient` behind an HTTP veneer. The fake implements the
 * seam; this implements the API. Sharing one would make the conformance suite tautological —
 * both backings would be the same object — which is the exact failure the two-backings design
 * exists to avoid.
 *
 * Every request is recorded in `requests`, so a test can assert on the *bytes sent* (the
 * `permissions` body of a token mint, for instance) rather than on what came back.
 */

const API_VERSION = "2022-11-28";

function json(body, init = {}) {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function failureResponse(failure) {
  switch (failure.kind) {
    case "notFound":
      return json({ message: "Not Found" }, { status: 404 });
    case "permissionDenied":
      return json(
        { message: "Resource not accessible by integration" },
        { status: 403, "x-ratelimit-remaining": "4999" },
      );
    case "rateLimited":
      return json(
        { message: "You have exceeded a secondary rate limit" },
        {
          status: 403,
          headers: {
            "retry-after": String(Math.ceil((failure.retryAfterMs ?? 60_000) / 1000)),
            "x-ratelimit-remaining": "0",
          },
        },
      );
    case "apiError":
      return json({ message: failure.detail ?? "injected failure" }, { status: failure.status });
    default:
      throw new Error(`github stub: unknown failure kind ${failure.kind}`);
  }
}

/** Which client method a request belongs to, for `injectFailure`. */
function classify(method, path, search) {
  if (path.endsWith("/access_tokens")) return "mintInstallationToken";
  if (path.endsWith("/installation")) return "getInstallation";
  if (/\/check-runs$/.test(path)) return "createCheckRun";
  if (/\/check-runs\/\d+$/.test(path)) return "updateCheckRun";
  if (/\/issues\/comments\/\d+$/.test(path)) return "updateIssueComment";
  if (/\/issues\/\d+\/comments$/.test(path)) {
    return method === "POST" ? "createIssueComment" : "listIssueComments";
  }
  if (/\/issues\/\d+$/.test(path)) return "getIssue";
  if (/\/collaborators\/[^/]+\/permission$/.test(path)) return "getCollaboratorPermission";
  if (/\/pulls$/.test(path)) return method === "POST" ? "createPullRequest" : "listPullRequests";
  if (/\/pulls\/\d+\/commits$/.test(path)) return "listPullRequestCommits";
  if (/\/pulls\/\d+$/.test(path)) return "getPullRequest";
  if (/\/git\/ref\/heads\/.+$/.test(path)) return "getBranchHead";
  if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return "getRepository";
  return `unrouted:${method} ${path}${search}`;
}

export function createGitHubStub(seed = {}, { now = () => Date.now() } = {}) {
  const repositories = new Map();
  const failures = new Map();
  const requests = [];
  let nextCommentId = 1000;
  let nextPullNumber = 100;
  let nextCheckRunId = 500;
  let nextTokenSerial = 1;

  const seedRepository = (repo) => {
    const stored = {
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch ?? "main",
      fork: repo.fork ?? false,
      installationId: repo.installationId ?? 42,
      permissions: repo.permissions ?? {
        metadata: "read",
        contents: "write",
        issues: "write",
        pull_requests: "write",
        checks: "write",
      },
      issues: new Map(),
      comments: [],
      pulls: new Map(),
      checkRuns: new Map(),
      branches: new Map(Object.entries(repo.branches ?? {})),
      collaborators: new Map(
        Object.entries(repo.collaborators ?? {}).map(([login, value]) => [login.toLowerCase(), value]),
      ),
    };
    for (const issue of repo.issues ?? []) {
      stored.issues.set(issue.number, {
        number: issue.number,
        title: issue.title ?? `Issue ${issue.number}`,
        body: issue.body ?? "",
        state: issue.state ?? "open",
        labels: [...(issue.labels ?? [])],
        login: issue.authorLogin ?? "seed-user",
      });
      for (const comment of issue.comments ?? []) {
        stored.comments.push({
          id: nextCommentId++,
          issueNumber: issue.number,
          body: comment.body,
          login: comment.authorLogin ?? "seed-user",
        });
      }
    }
    for (const pull of repo.pullRequests ?? []) {
      stored.pulls.set(pull.number, {
        number: pull.number,
        title: pull.title ?? `PR ${pull.number}`,
        body: pull.body ?? "",
        state: pull.state ?? "open",
        headRef: pull.headRef,
        headSha: pull.headSha ?? "9".repeat(40),
        baseRef: pull.baseRef ?? stored.defaultBranch,
        merged: pull.merged ?? false,
        commits: [...(pull.commits ?? [])],
      });
      nextPullNumber = Math.max(nextPullNumber, pull.number + 1);
    }
    repositories.set(`${repo.owner}/${repo.name}`, stored);
  };

  for (const repo of seed.repositories ?? []) seedRepository(repo);

  const repoFor = (path) => {
    const match = /^\/repos\/([^/]+)\/([^/]+)/.exec(path);
    if (!match) return undefined;
    return repositories.get(`${match[1]}/${match[2]}`);
  };

  const issueUrl = (repo, number) =>
    `https://github.com/${repo.owner}/${repo.name}/issues/${number}`;

  const commentBody = (repo, comment) => ({
    id: comment.id,
    body: comment.body,
    html_url: `${issueUrl(repo, comment.issueNumber)}#issuecomment-${comment.id}`,
    user: { login: comment.login },
  });

  const pullBody = (repo, pull) => ({
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    draft: true,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef },
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    merged: pull.merged,
  });

  const checkRunBody = (run) => ({
    id: run.id,
    name: run.name,
    head_sha: run.headSha,
    status: run.status,
    conclusion: run.conclusion,
    details_url: run.detailsUrl,
    output: run.output,
  });

  async function handle(url, init) {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const headers = init?.headers ?? {};
    const operation = classify(method, path, parsed.search);
    requests.push({ method, path, search: parsed.search, body, headers, operation });

    if (headers["x-github-api-version"] !== API_VERSION) {
      return json({ message: "unpinned API version" }, { status: 400 });
    }
    if (!headers.authorization?.startsWith("Bearer ")) {
      return json({ message: "Bad credentials" }, { status: 401 });
    }

    const queued = failures.get(operation);
    const failure = queued?.shift();
    if (failure) return failureResponse(failure);

    // POST /app/installations/{id}/access_tokens
    if (operation === "mintInstallationToken") {
      // Expiry follows the *caller's* clock so a token-cache test can advance time without
      // sleeping and still get an expiry the client agrees is stale.
      const expiresAt = new Date(now() + 60 * 60 * 1000).toISOString();
      return json({
        token: `ghs_stub_${nextTokenSerial++}`,
        expires_at: expiresAt,
        permissions: body?.permissions ?? {},
      });
    }

    const repo = repoFor(path);
    if (!repo) return json({ message: "Not Found" }, { status: 404 });

    if (operation === "getInstallation") {
      return json({ id: repo.installationId, permissions: repo.permissions });
    }

    if (operation === "getRepository") {
      return json({
        name: repo.name,
        owner: { login: repo.owner },
        default_branch: repo.defaultBranch,
        clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
        html_url: `https://github.com/${repo.owner}/${repo.name}`,
        fork: repo.fork,
      });
    }

    if (operation === "getCollaboratorPermission") {
      const login = decodeURIComponent(path.split("/").at(-2));
      const found = repo.collaborators.get(login.toLowerCase());
      // GitHub's wire shape: the legacy `permission` and the precise `role_name`, snake_case.
      return json(
        found
          ? { permission: found.permission, role_name: found.roleName ?? found.permission, user: { login } }
          : { permission: "none", user: { login } },
      );
    }

    if (operation === "getIssue") {
      const number = Number(path.split("/").pop());
      const issue = repo.issues.get(number);
      if (!issue) return json({ message: "Not Found" }, { status: 404 });
      return json({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map((name) => ({ name })),
        html_url: issueUrl(repo, issue.number),
        user: { login: issue.login },
      });
    }

    if (operation === "listIssueComments") {
      const number = Number(path.split("/").at(-2));
      return json(
        repo.comments.filter((c) => c.issueNumber === number).map((c) => commentBody(repo, c)),
      );
    }

    if (operation === "createIssueComment") {
      const number = Number(path.split("/").at(-2));
      if (!repo.issues.has(number) && !repo.pulls.has(number)) {
        return json({ message: "Not Found" }, { status: 404 });
      }
      const comment = {
        id: nextCommentId++,
        issueNumber: number,
        body: body.body,
        login: "windkeel[bot]",
      };
      repo.comments.push(comment);
      return json(commentBody(repo, comment), { status: 201 });
    }

    if (operation === "updateIssueComment") {
      const id = Number(path.split("/").pop());
      const comment = repo.comments.find((c) => c.id === id);
      if (!comment) return json({ message: "Not Found" }, { status: 404 });
      comment.body = body.body;
      return json(commentBody(repo, comment));
    }

    if (operation === "createPullRequest") {
      const pull = {
        number: nextPullNumber++,
        title: body.title,
        body: body.body,
        state: "open",
        headRef: body.head,
        headSha: "a1".repeat(20),
        baseRef: body.base,
        merged: false,
        commits: [],
      };
      if (body.draft !== true) return json({ message: "draft required" }, { status: 422 });
      repo.pulls.set(pull.number, pull);
      return json(pullBody(repo, pull), { status: 201 });
    }

    if (operation === "getBranchHead") {
      const branch = decodeURIComponent(path.split("/git/ref/heads/")[1]);
      const sha = repo.branches.get(branch);
      if (!sha) return json({ message: "Not Found" }, { status: 404 });
      // GitHub's wire shape for a single ref.
      return json({ ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
    }

    if (operation === "getPullRequest") {
      const number = Number(path.split("/").pop());
      const pull = repo.pulls.get(number);
      if (!pull) return json({ message: "Not Found" }, { status: 404 });
      return json(pullBody(repo, pull));
    }

    if (operation === "listPullRequestCommits") {
      const number = Number(path.split("/").at(-2));
      const pull = repo.pulls.get(number);
      if (!pull) return json({ message: "Not Found" }, { status: 404 });
      // GitHub's wire shape, not the client's: `commit.author` is what git recorded and
      // `author` is the account GitHub matched it to. The client's job is telling them apart,
      // so the stub must present both.
      return json(
        (pull.commits ?? []).map((c) => ({
          sha: c.sha,
          commit: { author: { email: c.authorEmail ?? "", date: c.authoredAt ?? "2026-01-01T00:00:00Z" } },
          author: c.authorLogin ? { login: c.authorLogin } : null,
          parents: Array.from({ length: c.parentCount ?? 1 }, () => ({ sha: "0".repeat(40) })),
        })),
      );
    }

    if (operation === "listPullRequests") {
      const state = parsed.searchParams.get("state") ?? "open";
      const head = parsed.searchParams.get("head");
      const wantedRef = head ? head.slice(head.indexOf(":") + 1) : undefined;
      const matches = [...repo.pulls.values()]
        .filter((p) => (state === "all" ? true : p.state === state))
        .filter((p) => (wantedRef === undefined ? true : p.headRef === wantedRef));
      return json(matches.map((p) => pullBody(repo, p)));
    }

    if (operation === "createCheckRun") {
      if (body.status === "completed" && body.conclusion === undefined) {
        return json({ message: "conclusion required" }, { status: 422 });
      }
      if (body.status !== "completed" && body.conclusion !== undefined) {
        return json({ message: "conclusion not allowed" }, { status: 422 });
      }
      const run = {
        id: nextCheckRunId++,
        name: body.name,
        headSha: body.head_sha,
        status: body.status,
        conclusion: body.conclusion ?? null,
        detailsUrl: body.details_url ?? null,
        output: body.output ?? null,
      };
      repo.checkRuns.set(run.id, run);
      return json(checkRunBody(run), { status: 201 });
    }

    if (operation === "updateCheckRun") {
      const id = Number(path.split("/").pop());
      const run = repo.checkRuns.get(id);
      if (!run) return json({ message: "Not Found" }, { status: 404 });
      if (body.status !== undefined) run.status = body.status;
      if (body.conclusion !== undefined) run.conclusion = body.conclusion;
      if (body.details_url !== undefined) run.detailsUrl = body.details_url;
      if (body.output !== undefined) run.output = body.output;
      return json(checkRunBody(run));
    }

    return json({ message: `github stub: unrouted ${method} ${path}` }, { status: 501 });
  }

  return {
    fetch: (url, init) => handle(String(url), init),
    requests,
    repositories,
    seedRepository,
    /** Queues a failure for the *next* request belonging to `method`. */
    injectFailure(method, failure, { count = 1 } = {}) {
      const queue = failures.get(method) ?? [];
      for (let i = 0; i < count; i++) queue.push(failure);
      failures.set(method, queue);
    },
    requestsFor(method) {
      return requests.filter((r) => r.operation === method);
    },
  };
}
