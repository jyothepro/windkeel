import { runInExecutionPhase } from "../sandbox/lifecycle.js";
import type { CredentialBrokerRule, SandboxHandle } from "../sandbox/provider.js";
import type { WorkerDiff } from "./adapter.js";

export interface DiffSource {
  readonly handle: SandboxHandle;
  readonly scratchDir: string;
  readonly workdir: string | undefined;
  readonly baseRevision: string | undefined;
}

export const DEFAULT_MAX_DIFF_BYTES = 2_000_000;

export interface DiffExtractionOptions {
  modelApiDomain: string;
  credentialRules: CredentialBrokerRule[];
  maxDiffBytes?: number;
}

const TRUNCATION_MARKER = (bytes: number, limit: number) =>
  `\n[windkeel] diff truncated: ${bytes} bytes exceeds the ${limit}-byte limit; the workspace, not this patch, is the record of what changed\n`;

export async function extractDiff(
  state: DiffSource,
  options: DiffExtractionOptions,
): Promise<WorkerDiff> {
  const limit = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const diffPath = `${state.scratchDir}/workspace.diff`;
  const namesPath = `${state.scratchDir}/workspace.files`;
  const base = state.baseRevision;

  const script = [
    "set -e",
    'cd "$WINDKEEL_WORKDIR"',
    "git add -A -N >/dev/null 2>&1 || true",
    'git diff "$WINDKEEL_BASE" > "$WINDKEEL_DIFF"',
    'git diff --name-only "$WINDKEEL_BASE" > "$WINDKEEL_NAMES"',
    'wc -c < "$WINDKEEL_DIFF"',
  ].join("\n");

  const result = await runInExecutionPhase(
    state.handle,
    options.modelApiDomain,
    options.credentialRules,
    "sh",
    {
      args: ["-c", script],
      env: {
        WINDKEEL_WORKDIR: state.workdir ?? ".",
        WINDKEEL_BASE: base ?? "HEAD",
        WINDKEEL_DIFF: diffPath,
        WINDKEEL_NAMES: namesPath,
      },
    },
  );

  if (result.error || result.status !== 0) {
    return {
      patch: "",
      filesChanged: [],
      truncated: false,
      error: `could not extract the workspace diff: ${result.error ?? `git exited ${result.status}`}${result.stderr ? ` — ${result.stderr.trim()}` : ""}`,
    };
  }

  const bytes = Number.parseInt(result.stdout.trim(), 10);
  const filesChanged = (await state.handle.readFile(namesPath))
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (Number.isFinite(bytes) && bytes > limit) {
    const head = await runInExecutionPhase(
      state.handle,
      options.modelApiDomain,
      options.credentialRules,
      "sh",
      { args: ["-c", `head -c ${limit} "$WINDKEEL_DIFF"`], env: { WINDKEEL_DIFF: diffPath } },
    );
    return {
      patch: `${head.stdout}${TRUNCATION_MARKER(bytes, limit)}`,
      filesChanged,
      truncated: true,
    };
  }

  return {
    patch: (await state.handle.readFile(diffPath)).toString("utf8"),
    filesChanged,
    truncated: false,
  };
}

export function crossCheckSelfReport(
  reportedByAgent: Iterable<string>,
  filesChanged: string[],
): { onlyReportedByAgent: string[]; onlyInWorkspace: string[] } | undefined {
  const reported = new Set<string>();
  for (const path of reportedByAgent) reported.add(normalizePath(path));
  const actual = new Set(filesChanged.map(normalizePath));

  const matches = (a: string, b: string) =>
    a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  const onlyReportedByAgent = [...reported]
    .filter((path) => ![...actual].some((other) => matches(path, other)))
    .sort();
  const onlyInWorkspace = [...actual]
    .filter((path) => ![...reported].some((other) => matches(path, other)))
    .sort();
  return onlyReportedByAgent.length === 0 && onlyInWorkspace.length === 0
    ? undefined
    : { onlyReportedByAgent, onlyInWorkspace };
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\/+/, "");
}
