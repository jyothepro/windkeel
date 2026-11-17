import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceItem, VerdictFile } from "@windkeel/verification/evidence/format.js";
import { verify } from "./verify.js";

export interface ReplayCase {
  id: string;
  kind: "replay";
  upstream: {
    repo: string;
    clone_url: string;
    pr: number | null;
    base_sha: string;
    head_sha: string;
    subject: string;
  };
  surfaced: {
    how: "reverted" | "fixed";
    commit: string;
    subject: string;
    description: string;
  };
  expect: "pass" | "fail";
}

export interface ReplayResult extends ReplayCase {
  verdict: string;
  caught: boolean;
  evaluated: boolean;
  review_status: string;
  reviewer: string | null;
  findings: Array<{ id: string; severity: string; claim: string }>;
  package?: string;
  error?: string;
}

export interface ReplayReport {
  cases: ReplayResult[];
  evaluated: number;
  caught: number;
  errors: number;
}

const git = (args: string[], cwd?: string) =>
  spawnSync("git", args, {
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });

function run(args: string[], cwd?: string): string {
  const result = git(args, cwd);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout ?? "";
}

function fetchUpstream(cache: string, spec: ReplayCase): string {
  const dir = join(cache, spec.upstream.repo.replaceAll("/", "__"));
  mkdirSync(dir, { recursive: true });
  if (git(["rev-parse", "--git-dir"], dir).status !== 0) {
    run(["init", "-q", "--bare"], dir);
  }
  const remote = ["remote", git(["remote", "get-url", "origin"], dir).status === 0 ? "set-url" : "add"];
  run([...remote, "origin", spec.upstream.clone_url], dir);
  for (const sha of [spec.upstream.base_sha, spec.upstream.head_sha]) {
    if (git(["cat-file", "-e", `${sha}^{commit}`], dir).status !== 0) {
      run(["fetch", "-q", "--depth", "1", "origin", sha], dir);
    }
  }
  return dir;
}

const ARCHIVE_LIMIT = 512 * 1024 * 1024;

const extract = (bare: string, sha: string, into: string): void => {
  const archive = spawnSync("git", ["archive", sha], { cwd: bare, maxBuffer: ARCHIVE_LIMIT });
  if (archive.status !== 0) {
    throw new Error(`git archive ${sha}: ${archive.stderr?.toString().trim()}`);
  }
  const untar = spawnSync("tar", ["-x", "-C", into], {
    input: archive.stdout,
    maxBuffer: ARCHIVE_LIMIT,
  });
  if (untar.status !== 0) {
    throw new Error(`tar -x for ${sha} failed: ${untar.stderr?.toString().trim()}`);
  }
};

const clearWorktree = (dir: string): void => {
  for (const entry of readdirSync(dir)) {
    if (entry !== ".git") rmSync(join(dir, entry), { recursive: true, force: true });
  }
};

function materialize(bare: string, spec: ReplayCase, work: string): { repo: string; body: string } {
  const repo = join(work, "repo");
  mkdirSync(repo, { recursive: true });
  run(["init", "-q"], repo);
  run(["config", "user.email", "replay@windkeel.dev"], repo);
  run(["config", "user.name", "windkeel replay"], repo);

  extract(bare, spec.upstream.base_sha, repo);
  run(["add", "-A"], repo);
  run(["commit", "-q", "--allow-empty", "-m", `base ${spec.upstream.base_sha.slice(0, 12)}`], repo);

  clearWorktree(repo);
  extract(bare, spec.upstream.head_sha, repo);
  run(["add", "-A"], repo);
  const author = run(["show", "-s", "--format=%an <%ae>", spec.upstream.head_sha], bare).trim();
  run(
    ["commit", "-q", "--allow-empty", `--author=${author}`, "-m", spec.upstream.subject],
    repo,
  );

  const body = run(["show", "-s", "--format=%b", spec.upstream.head_sha], bare);
  const bodyPath = join(work, "pr-body.md");
  writeFileSync(bodyPath, body);

  writeFileSync(join(repo, "windkeel.config.json"), JSON.stringify({ checks: [] }, null, 2) + "\n");

  return { repo, body: bodyPath };
}

export async function runReplay(
  corpus: string,
  cache: string,
  out?: string,
): Promise<ReplayReport> {
  const caseDirs = readdirSync(corpus, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(corpus, d.name))
    .sort();

  const cases: ReplayResult[] = [];
  for (const caseDir of caseDirs) {
    const spec = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")) as ReplayCase;
    const base: ReplayResult = {
      ...spec,
      verdict: "unknown",
      caught: false,
      evaluated: false,
      review_status: "not_run",
      reviewer: null,
      findings: [],
    };

    try {
      const bare = fetchUpstream(cache, spec);
      const work = mkdtempSync(join(tmpdir(), "windkeel-replay-"));
      const { repo, body } = materialize(bare, spec, work);
      const packageDir = out ? join(out, spec.id) : join(work, "evidence");
      await verify({ repo, out: packageDir, prBodyFile: body });

      const verdict = JSON.parse(
        readFileSync(join(packageDir, "verdict.json"), "utf8"),
      ) as VerdictFile;
      const evidence = readdirSync(join(packageDir, "evidence"))
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(packageDir, "evidence", f), "utf8")) as EvidenceItem);
      const review = evidence.find((e) => e.stage === "review");

      cases.push({
        ...base,
        package: packageDir,
        verdict: verdict.verdict,
        evaluated: review !== undefined && review.status !== "skipped" && review.status !== "warning",
        caught: verdict.verdict === "fail",
        review_status: review?.status ?? "absent",
        reviewer: review?.reviewer ? `${review.reviewer.vendor}/${review.reviewer.model}` : null,
        findings: (review?.findings ?? []).map((f) => ({
          id: f.id,
          severity: f.severity,
          claim: f.claim,
        })),
      });
    } catch (error) {
      cases.push({ ...base, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    cases,
    evaluated: cases.filter((c) => c.evaluated).length,
    caught: cases.filter((c) => c.evaluated && c.caught).length,
    errors: cases.filter((c) => c.error).length,
  };
}

export function formatReplay(report: ReplayReport): string {
  const rows = report.cases.flatMap((c) => {
    const state = c.error
      ? `ERROR ${c.error}`
      : c.evaluated
        ? `${c.caught ? "CAUGHT" : "missed"} — verdict ${c.verdict}, reviewer ${c.reviewer}`
        : `not evaluated — review stage ${c.review_status}`;
    return [
      `  ${c.id}`,
      `    upstream:  ${c.upstream.repo}${c.upstream.pr ? `#${c.upstream.pr}` : ""} @ ${c.upstream.head_sha.slice(0, 12)}`,
      `    surfaced:  ${c.surfaced.how} in ${c.surfaced.commit.slice(0, 12)} — ${c.surfaced.subject}`,
      `    gate:      ${state}`,
      ...c.findings.map((f) => `      - [${f.severity}] ${f.claim}`),
    ];
  });

  return [...rows, "", summaryLine(report)].join("\n");
}

function summaryLine(report: ReplayReport): string {
  if (report.evaluated) {
    const notEvaluated = report.cases.length - report.evaluated;
    return (
      `caught ${report.caught}/${report.evaluated} replayed defects ` +
      `(${notEvaluated} not evaluated, ${report.errors} error(s))`
    );
  }
  return report.errors
    ? `0 of ${report.cases.length} cases evaluated — a reviewer was configured and asked, and ` +
        `${report.errors} case(s) errored before a verdict. The errors are above; they are a ` +
        `finding about the reviewer path, not about detection.`
    : `0 of ${report.cases.length} cases evaluated — no reviewer configured, so nothing was ` +
        `asked of a model. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.`;
}
