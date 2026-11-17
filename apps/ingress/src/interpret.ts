const TRIGGER_LABELS: ReadonlySet<string> = new Set(["windkeel", "orqon"]);

const COMMANDS = ["approve", "cancel"] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface RepositoryFacts {
  owner: string;
  name: string;
  defaultBranch: string;
  cloneUrl: string;
  installationId: number | null;
}

export interface IssueFacts {
  number: number;
  title: string;
  body: string;
  labels: string[];
  htmlUrl: string;
  authorLogin: string;
  state: "open" | "closed";
  locked: boolean;
}

export type Intent =
  | {
      kind: "create_task";
      repository: RepositoryFacts;
      issue: IssueFacts;
      actor: string;
    }
  | { kind: "cancel_run"; repository: RepositoryFacts; issueNumber: number; actor: string }
  | {
      kind: "command";
      repository: RepositoryFacts;
      issueNumber: number;
      command: CommandName;
      actor: string;
      authorAssociation: string;
    }
  | {
      kind: "pr_closed";
      repository: RepositoryFacts;
      pullNumber: number;
      merged: boolean;
      headRef: string;
      sender?: string;
    }
  | {
      kind: "pr_review";
      repository: RepositoryFacts;
      pullNumber: number;
      feedback: ReviewFeedbackFacts;
    }
  | { kind: "ignore"; reason: string };

export interface ReviewFeedbackFacts {
  kind: "review" | "review_comment";
  reviewId: number | null;
  commentId: number | null;
  author: string;
  body: string;
  state?: string;
  path?: string;
  line?: number;
  url?: string;
}

interface RawRepository {
  owner?: { login?: string };
  name?: string;
  full_name?: string;
  default_branch?: string;
  clone_url?: string;
  fork?: boolean;
}

interface RawPayload {
  action?: string;
  repository?: RawRepository;
  installation?: { id?: number };
  label?: { name?: string };
  sender?: { login?: string; type?: string };
  issue?: {
    number?: number;
    title?: string;
    state?: "open" | "closed";
    locked?: boolean;
    body?: string | null;
    labels?: Array<{ name?: string }>;
    html_url?: string;
    user?: { login?: string };
    pull_request?: unknown;
  };
  comment?: {
    id?: number;
    body?: string | null;
    user?: { login?: string; type?: string };
    author_association?: string;
    pull_request_review_id?: number | null;
    path?: string;
    line?: number | null;
    original_line?: number | null;
    html_url?: string;
  };
  review?: {
    id?: number;
    body?: string | null;
    state?: string;
    user?: { login?: string; type?: string };
    html_url?: string;
  };
  pull_request?: {
    number?: number;
    merged?: boolean;
    merged_at?: string | null;
    head?: { ref?: string; repo?: { full_name?: string; fork?: boolean } };
    base?: { repo?: { full_name?: string } };
  };
}

function repositoryFacts(payload: RawPayload): RepositoryFacts | undefined {
  const repository = payload.repository;
  const owner = repository?.owner?.login;
  const name = repository?.name;
  if (!owner || !name) return undefined;
  return {
    owner,
    name,
    defaultBranch: repository.default_branch ?? "",
    cloneUrl: repository.clone_url ?? `https://github.com/${owner}/${name}.git`,
    installationId: typeof payload.installation?.id === "number" ? payload.installation.id : null,
  };
}

export function parseCommand(body: string): { command: CommandName } | { unknown: string } | null {
  const firstLine = body.split("\n")[0]?.trim() ?? "";
  const match = /^\/(?:windkeel|orqon)\s+([a-z_-]+)\s*$/i.exec(firstLine);
  if (!match?.[1]) return null;
  const word = match[1].toLowerCase();
  const command = COMMANDS.find((c) => c === word);
  return command ? { command } : { unknown: word };
}

export function interpret(event: string, payload: unknown): Intent {
  const raw = (payload ?? {}) as RawPayload;
  const repository = repositoryFacts(raw);
  if (!repository) return { kind: "ignore", reason: "payload names no repository" };

  if (raw.repository?.fork === true) {
    return { kind: "ignore", reason: `${repository.owner}/${repository.name} is a fork` };
  }

  const actor = raw.sender?.login ?? raw.comment?.user?.login ?? "unknown";

  switch (event) {
    case "issues":
      return interpretIssues(raw, repository, actor);
    case "issue_comment":
      return interpretIssueComment(raw, repository, actor);
    case "pull_request":
      return interpretPullRequest(raw, repository);
    case "pull_request_review":
      return interpretReview(raw, repository);
    case "pull_request_review_comment":
      return interpretReviewComment(raw, repository);
    default:
      return { kind: "ignore", reason: `event ${event} is not subscribed (ADR-0009 §2)` };
  }
}

function interpretIssues(raw: RawPayload, repository: RepositoryFacts, actor: string): Intent {
  const issueNumber = raw.issue?.number;
  if (typeof issueNumber !== "number") {
    return { kind: "ignore", reason: "issues event carried no issue number" };
  }
  const label = raw.label?.name;

  if (raw.action === "labeled") {
    if (label === undefined || !TRIGGER_LABELS.has(label)) {
      return { kind: "ignore", reason: `label ${label ?? "(none)"} is not the trigger` };
    }
    return {
      kind: "create_task",
      repository,
      actor,
      issue: {
        number: issueNumber,
        title: raw.issue?.title ?? "",
        body: raw.issue?.body ?? "",
        labels: (raw.issue?.labels ?? []).map((l) => l.name ?? "").filter((n) => n !== ""),
        htmlUrl: raw.issue?.html_url ?? "",
        authorLogin: raw.issue?.user?.login ?? "",
        state: raw.issue?.state === "closed" ? "closed" : "open",
        locked: raw.issue?.locked === true,
      },
    };
  }

  if (raw.action === "unlabeled") {
    if (label === undefined || !TRIGGER_LABELS.has(label)) {
      return { kind: "ignore", reason: `label ${label ?? "(none)"} is not the trigger` };
    }
    return { kind: "cancel_run", repository, issueNumber, actor };
  }

  return { kind: "ignore", reason: `issues.${raw.action ?? "(none)"} is not acted on` };
}

function interpretIssueComment(
  raw: RawPayload,
  repository: RepositoryFacts,
  actor: string,
): Intent {
  if (raw.action !== "created") {
    return { kind: "ignore", reason: `issue_comment.${raw.action ?? "(none)"} is not acted on` };
  }
  const issueNumber = raw.issue?.number;
  if (typeof issueNumber !== "number") {
    return { kind: "ignore", reason: "issue_comment event carried no issue number" };
  }
  if (raw.issue?.pull_request !== undefined) {
    return {
      kind: "ignore",
      reason: "commands are read on the issue, not the pull request (ADR-0009 §3)",
    };
  }

  const parsed = parseCommand(raw.comment?.body ?? "");
  if (parsed === null) return { kind: "ignore", reason: "comment is not a /windkeel command" };
  if ("unknown" in parsed) {
    return { kind: "ignore", reason: `unknown command /windkeel ${parsed.unknown}` };
  }
  const commenter = raw.comment?.user?.login ?? (actor === "unknown" ? undefined : actor);
  if (!commenter) return { kind: "ignore", reason: "comment carried no author" };
  return {
    kind: "command",
    repository,
    issueNumber,
    command: parsed.command,
    actor: commenter,
    authorAssociation: raw.comment?.author_association ?? "NONE",
  };
}

function interpretPullRequest(raw: RawPayload, repository: RepositoryFacts): Intent {
  if (raw.action !== "closed") {
    return { kind: "ignore", reason: `pull_request.${raw.action ?? "(none)"} is not acted on` };
  }
  const pullNumber = raw.pull_request?.number;
  if (typeof pullNumber !== "number") {
    return { kind: "ignore", reason: "pull_request event carried no number" };
  }
  const head = raw.pull_request?.head;
  const fork = forkReason(raw, pullNumber);
  if (fork) return { kind: "ignore", reason: fork };
  return {
    kind: "pr_closed",
    repository,
    pullNumber,
    merged: raw.pull_request?.merged === true || raw.pull_request?.merged_at != null,
    headRef: head?.ref ?? "",
    ...(raw.sender?.login ? { sender: raw.sender.login } : {}),
  };
}

export function isBot(user: { login?: string; type?: string } | undefined): boolean {
  if (!user) return false;
  return user.type === "Bot" || (typeof user.login === "string" && /\[bot\]$/i.test(user.login));
}

function forkReason(raw: RawPayload, pullNumber: number): string | null {
  const head = raw.pull_request?.head;
  const baseFullName = raw.pull_request?.base?.repo?.full_name;
  if (head?.repo?.fork === true || (head?.repo?.full_name && head.repo.full_name !== baseFullName)) {
    return `pull request ${pullNumber} is from a fork (ADR-0009 §6)`;
  }
  return null;
}

function interpretReview(raw: RawPayload, repository: RepositoryFacts): Intent {
  if (raw.action !== "submitted") {
    return { kind: "ignore", reason: `pull_request_review.${raw.action ?? "(none)"} is not acted on` };
  }
  const pullNumber = raw.pull_request?.number;
  if (typeof pullNumber !== "number") {
    return { kind: "ignore", reason: "pull_request_review event carried no number" };
  }
  const fork = forkReason(raw, pullNumber);
  if (fork) return { kind: "ignore", reason: fork };
  const review = raw.review;
  if (typeof review?.id !== "number") return { kind: "ignore", reason: "review carried no id" };
  if (isBot(review.user) || isBot(raw.sender)) {
    return { kind: "ignore", reason: "reviews by bots are not learned from" };
  }
  const state = (review.state ?? "").toLowerCase();
  const body = review.body ?? "";
  if (state !== "changes_requested" && state !== "commented") {
    return { kind: "ignore", reason: `a ${state || "(no state)"} review is not learned from` };
  }
  if (body.trim() === "") {
    return { kind: "ignore", reason: `a ${state} review with no text is not learned from` };
  }
  const author = review.user?.login ?? raw.sender?.login;
  if (!author) return { kind: "ignore", reason: "review carried no author" };
  return {
    kind: "pr_review",
    repository,
    pullNumber,
    feedback: {
      kind: "review",
      reviewId: review.id,
      commentId: null,
      author,
      body,
      state,
      ...(review.html_url ? { url: review.html_url } : {}),
    },
  };
}

function interpretReviewComment(raw: RawPayload, repository: RepositoryFacts): Intent {
  if (raw.action !== "created") {
    return { kind: "ignore", reason: `pull_request_review_comment.${raw.action ?? "(none)"} is not acted on` };
  }
  const pullNumber = raw.pull_request?.number;
  if (typeof pullNumber !== "number") {
    return { kind: "ignore", reason: "pull_request_review_comment event carried no number" };
  }
  const fork = forkReason(raw, pullNumber);
  if (fork) return { kind: "ignore", reason: fork };
  const comment = raw.comment;
  if (typeof comment?.id !== "number") return { kind: "ignore", reason: "review comment carried no id" };
  if (isBot(comment.user) || isBot(raw.sender)) {
    return { kind: "ignore", reason: "review comments by bots are not learned from" };
  }
  const body = comment.body ?? "";
  if (body.trim() === "") return { kind: "ignore", reason: "a review comment with no text is not learned from" };
  const author = comment.user?.login ?? raw.sender?.login;
  if (!author) return { kind: "ignore", reason: "review comment carried no author" };
  const line = comment.line ?? comment.original_line;
  return {
    kind: "pr_review",
    repository,
    pullNumber,
    feedback: {
      kind: "review_comment",
      reviewId: typeof comment.pull_request_review_id === "number" ? comment.pull_request_review_id : null,
      commentId: comment.id,
      author,
      body,
      ...(comment.path ? { path: comment.path } : {}),
      ...(typeof line === "number" ? { line } : {}),
      ...(comment.html_url ? { url: comment.html_url } : {}),
    },
  };
}
