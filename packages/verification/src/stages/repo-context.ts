import type { ExecutionEnvironment } from "../exec/environment.js";

const MAX_CONTEXT_BYTES = 200_000;

const MAX_FILE_BYTES = 40_000;

const MAX_TREE_ENTRIES = 2_000;

const MANIFESTS = [
  "package.json",
  "tsconfig.json",
  "Makefile",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
];

export interface RepositoryContext {
  tree: string;
  treeTruncated: boolean;
  files: Array<{ path: string; text: string; truncated: boolean }>;
  unreadable: string[];
}

async function read(
  execEnv: ExecutionEnvironment,
  repo: string,
  path: string,
): Promise<{ text: string; truncated: boolean } | null> {
  const result = await execEnv.exec("cat", { args: [path], cwd: repo }).catch(() => null);
  if (!result || result.status !== 0) return null;
  return result.stdout.length > MAX_FILE_BYTES
    ? { text: result.stdout.slice(0, MAX_FILE_BYTES), truncated: true }
    : { text: result.stdout, truncated: false };
}

async function changedPaths(
  execEnv: ExecutionEnvironment,
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<string[]> {
  const result = await execEnv
    .exec("git", { args: ["diff", "--name-only", `${baseSha}..${headSha}`], cwd: repo })
    .catch(() => null);
  if (!result || result.status !== 0) return [];
  return result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

export async function collectRepositoryContext(
  execEnv: ExecutionEnvironment,
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<RepositoryContext> {
  const listing = await execEnv.exec("git", { args: ["ls-files"], cwd: repo }).catch(() => null);
  const allPaths =
    listing && listing.status === 0
      ? listing.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
      : [];
  const treeTruncated = allPaths.length > MAX_TREE_ENTRIES;
  const tree = allPaths.slice(0, MAX_TREE_ENTRIES).join("\n");

  const changed = await changedPaths(execEnv, repo, baseSha, headSha);
  const tracked = new Set(allPaths);
  const wanted = [...changed, ...MANIFESTS.filter((m) => tracked.has(m))];

  const files: RepositoryContext["files"] = [];
  const unreadable: string[] = [];
  let budget = MAX_CONTEXT_BYTES - tree.length;

  for (const path of [...new Set(wanted)]) {
    if (budget <= 0) {
      unreadable.push(path);
      continue;
    }
    const got = await read(execEnv, repo, path);
    if (!got) {
      unreadable.push(path);
      continue;
    }
    const text = got.text.length > budget ? got.text.slice(0, budget) : got.text;
    files.push({ path, text, truncated: got.truncated || text.length < got.text.length });
    budget -= text.length;
  }

  return { tree, treeTruncated, files, unreadable };
}

export function renderRepositoryContext(context: RepositoryContext): string {
  const lines = [
    "REPOSITORY CONTEXT — the checkout under review. Check this before calling something",
    "missing or unverifiable; it is the answer to \"does this path exist\" and \"what surrounds",
    "this hunk\".",
    "",
    "Tracked files:",
    "```",
    context.tree || "(the file listing could not be read)",
    ...(context.treeTruncated ? ["… listing truncated; more files exist than are shown"] : []),
    "```",
  ];

  for (const file of context.files) {
    lines.push(
      "",
      `Full current text of ${file.path}:`,
      "```",
      file.text,
      ...(file.truncated ? [`… ${file.path} truncated; the file continues beyond this point`] : []),
      "```",
    );
  }

  if (context.unreadable.length) {
    lines.push(
      "",
      `Not included (unreadable or beyond the context budget): ${context.unreadable.join(", ")}.`,
      "Absence here means they were not gathered, NOT that they do not exist.",
    );
  }

  return lines.join("\n");
}
