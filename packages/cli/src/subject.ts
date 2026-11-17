import { existsSync, readFileSync } from "node:fs";
import type { ExecutionEnvironment } from "@windkeel/verification/exec/environment.js";
import type { Author, Manifest } from "@windkeel/verification/evidence/format.js";

export interface SubjectInputs {
  repo: string;
  prBodyFile?: string | undefined;
  issueBodyFile?: string | undefined;
  event?: GithubEvent | null | undefined;
  runner?: string | undefined;
}

export interface ResolvedSubject {
  subject: Manifest["subject"];
  prBody: string;
  issueBody: string;
  runner: string;
}

export interface GithubEvent {
  repository?: { full_name?: string };
  pull_request?: {
    number?: number;
    title?: string;
    body?: string;
    head?: { sha?: string };
    base?: { sha?: string };
    user?: { login?: string; type?: string };
  };
}

const AGENT_LOGINS: Record<string, string> = {
  "codex-cloud[bot]": "openai-codex",
  "devin-ai-integration[bot]": "devin",
  "copilot-swe-agent[bot]": "github-copilot",
  "claude[bot]": "claude-code",
};

async function git(execEnv: ExecutionEnvironment, repo: string, args: string[]): Promise<string> {
  const result = await execEnv.exec("git", { args, cwd: repo });
  return result.status === 0 ? result.stdout.trim() : "";
}

function classifyAuthor(login: string, type?: string): Author {
  const agent = AGENT_LOGINS[login];
  if (agent) return { login, kind: "agent", agent };
  if (type === "Bot") return { login, kind: "agent", agent: login };
  return { login, kind: login ? "human" : "unknown" };
}

function readEvent(): GithubEvent | null {
  const path = process.env["GITHUB_EVENT_PATH"];
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as GithubEvent;
  } catch {
    return null;
  }
}

const readFile = (path: string | undefined): string =>
  path && existsSync(path) ? readFileSync(path, "utf8") : "";

export async function resolveSubject(
  execEnv: ExecutionEnvironment,
  inputs: SubjectInputs,
): Promise<ResolvedSubject> {
  const event = inputs.event === undefined ? readEvent() : inputs.event;
  const pr = event?.pull_request;
  const runner =
    inputs.runner ?? (process.env["GITHUB_ACTIONS"] === "true" ? "github-actions" : "local");
  const headSha = pr?.head?.sha ?? (await git(execEnv, inputs.repo, ["rev-parse", "HEAD"]));
  const baseSha =
    pr?.base?.sha ?? ((await git(execEnv, inputs.repo, ["rev-parse", "HEAD~1"])) || headSha);
  const login =
    pr?.user?.login ?? (await git(execEnv, inputs.repo, ["log", "-1", "--format=%an"]));

  return {
    subject: {
      repo:
        event?.repository?.full_name != null
          ? `github.com/${event.repository.full_name}`
          : (await git(execEnv, inputs.repo, ["remote", "get-url", "origin"])) || "local",
      pr: pr?.number ?? null,
      title: pr?.title ?? (await git(execEnv, inputs.repo, ["log", "-1", "--format=%s"])),
      head_sha: headSha,
      base_sha: baseSha,
      author: classifyAuthor(login, pr?.user?.type),
    },
    prBody: readFile(inputs.prBodyFile) || pr?.body || "",
    issueBody: readFile(inputs.issueBodyFile),
    runner,
  };
}
