import type { EngineeringTask } from "../repositories.js";

const PROTECTED_REFS = new Set(["main", "master", "HEAD", "trunk", "develop", "release"]);

const RUN_DISCRIMINATOR_LENGTH = 8;

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "task";
}

export function issueNumberOf(task: Pick<EngineeringTask, "sourceType" | "sourceReference">): number | null {
  if (task.sourceType !== "github_issue") return null;
  const match = /#(\d+)$/.exec(task.sourceReference);
  return match?.[1] ? Number(match[1]) : null;
}

export function runBranchFor(
  engineeringRunId: string,
  task?: Pick<EngineeringTask, "sourceType" | "sourceReference" | "title"> | null,
): string {
  const issueNumber = task ? issueNumberOf(task) : null;
  if (issueNumber === null) return `windkeel/run/${engineeringRunId}`;
  const discriminator = engineeringRunId.replace(/-/g, "").slice(0, RUN_DISCRIMINATOR_LENGTH);
  return `windkeel/issue-${issueNumber}-${slugify(task?.title ?? "")}-${discriminator}`;
}

export class UnsafePushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePushError";
  }
}

export function assertRunBranch(
  branch: string,
  engineeringRunId: string,
  task?: Pick<EngineeringTask, "sourceType" | "sourceReference" | "title"> | null,
): void {
  const expected = runBranchFor(engineeringRunId, task);
  if (branch !== expected) {
    throw new UnsafePushError(
      `refusing to push to "${branch}": run ${engineeringRunId} may only write to "${expected}"`,
    );
  }
  const leaf = branch.split("/").pop() ?? branch;
  if (PROTECTED_REFS.has(branch) || PROTECTED_REFS.has(leaf)) {
    throw new UnsafePushError(`refusing to push to the protected ref "${branch}"`);
  }
}
