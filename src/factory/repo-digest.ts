import { createHash } from "node:crypto";
import type { ExecResult } from "@windkeel/verification/exec/environment.js";
import { hardenedGit, type GitExec } from "../sandbox/git-hardening.js";
import { redactSecrets } from "./log.js";

export const MAX_FILE_CHARS = 4 * 1024;
export const MAX_DIGEST_CHARS = 8 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const MAX_TREE_ENTRIES = 60;

const DIGEST_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"] as const;
const README_NAMES = ["README.md", "README.markdown", "README", "readme.md", "Readme.md"];
const README_SECTION = /^(development|developing|testing|tests?|running tests|run tests|building|build|local development|getting started|contributing|setup)\b/i;

export interface TreeEntry {
  name: string;
  type: "blob" | "tree" | "commit" | string;
  bytes: number | null;
}

export interface DigestReader {
  topLevel(): Promise<TreeEntry[]>;
  read(path: string): Promise<Buffer | null>;
}

export interface DigestSource {
  path: string;
  bytes: number;
  sha256: string;
}

export interface RepositoryDigest {
  body: string;
  sources: DigestSource[];
}

export async function buildDigest(reader: DigestReader): Promise<RepositoryDigest> {
  const tree = (await reader.topLevel()).slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const names = new Map(tree.map((entry) => [entry.name, entry]));
  const sources: DigestSource[] = [];
  const parts: string[] = [];

  const readText = async (path: string): Promise<string | null> => {
    const entry = names.get(path);
    if (!entry || entry.type !== "blob" || isEnvFile(path)) return null;
    if (entry.bytes !== null && entry.bytes > MAX_READ_BYTES) return null;
    const bytes = await reader.read(path);
    if (!bytes || bytes.length > MAX_READ_BYTES) return null;
    const text = textOf(bytes);
    if (text === null) return null;
    sources.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    return text;
  };

  const shown = tree.filter((entry) => !isEnvFile(entry.name)).slice(0, MAX_TREE_ENTRIES);
  if (shown.length > 0) {
    const more = tree.length > shown.length ? `\n- … and ${tree.length - shown.length} more` : "";
    parts.push(
      `Top-level layout:\n${shown.map((e) => `- ${e.name}${e.type === "tree" ? "/" : ""}`).join("\n")}${more}`,
    );
  }

  const pkg = await readText("package.json");
  if (pkg !== null) {
    const scripts = packageScripts(pkg);
    if (scripts) {
      const runner = packageRunner(names);
      const lines = Object.keys(scripts)
        .sort()
        .slice(0, 40)
        .map((name) => `- ${name}: ${oneLine(scripts[name]!).slice(0, 160)}`);
      const testCommand = scripts["test"] ? `${runner} test` : null;
      parts.push(
        [
          `package.json scripts (from repository file package.json):`,
          ...lines,
          ...(testCommand ? [`Detected test command: ${testCommand}`] : []),
        ].join("\n"),
      );
    }
  }

  for (const path of DIGEST_FILES) {
    const text = await readText(path);
    if (text !== null && text.trim() !== "") parts.push(fileBlock(path, text));
  }

  const readme = README_NAMES.find((name) => names.has(name));
  if (readme) {
    const text = await readText(readme);
    const sections = text === null ? "" : readmeSections(text);
    if (sections.trim() !== "") parts.push(fileBlock(readme, sections));
  }

  let body = scrubSecrets(parts.join("\n\n"));
  if (body.length > MAX_DIGEST_CHARS) body = `${body.slice(0, MAX_DIGEST_CHARS - 40).trimEnd()}\n[… digest truncated]`;
  return { body, sources };
}

function fileBlock(path: string, text: string): string {
  const capped = text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS).trimEnd()}\n[… truncated]` : text.trimEnd();
  return `From repository file ${path}:\n${capped}`;
}

export function readmeSections(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let level = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1]!.length;
      if (level && depth <= level) level = 0;
      if (!level && README_SECTION.test(heading[2]!.trim())) level = depth;
    }
    if (level) out.push(line);
  }
  return out.join("\n");
}

function packageScripts(text: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(text) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== "object" || Array.isArray(parsed.scripts)) return null;
    const scripts: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.scripts as Record<string, unknown>)) {
      if (typeof value === "string") scripts[name] = value;
    }
    return Object.keys(scripts).length > 0 ? scripts : null;
  } catch {
    return null;
  }
}

function packageRunner(names: Map<string, TreeEntry>): string {
  if (names.has("pnpm-lock.yaml") || names.has("pnpm-workspace.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("bun.lockb") || names.has("bun.lock")) return "bun";
  return "npm";
}

function isEnvFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return /^\.env/i.test(base) || /\.env$/i.test(base);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function textOf(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  const text = bytes.toString("utf8");
  if (text.includes("�")) return null;
  return text;
}

export function scrubSecrets(text: string): string {
  return redactSecrets(
    text
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted]")
      .replace(/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g, "[redacted]")
      .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[redacted]")
      .replace(/\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{10,}\b/g, "[redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted]")
      .replace(
        /\b([A-Za-z0-9_.-]*(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)[^\s"'`,;]{6,}\3/gi,
        "$1$2[redacted]",
      ),
  );
}

export function gitTreeReader(exec: GitExec, cwd: string, sha: string): DigestReader {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`gitTreeReader: ${JSON.stringify(sha)} is not a commit sha`);
  const git = (args: string[]): Promise<ExecResult> => hardenedGit(exec, args, { cwd });
  let entries: TreeEntry[] | null = null;
  return {
    async topLevel() {
      const result = await git(["ls-tree", "-l", "-z", "--end-of-options", sha]);
      if (result.status !== 0) throw new Error(`git ls-tree failed: ${result.stderr.trim() || `exit ${result.status}`}`);
      entries = result.stdout
        .split("\0")
        .filter((line) => line !== "")
        .flatMap((line) => {
          const tab = line.indexOf("\t");
          if (tab === -1) return [];
          const [, type, , size] = line.slice(0, tab).split(/\s+/);
          const bytes = size && /^\d+$/.test(size) ? Number(size) : null;
          return [{ name: line.slice(tab + 1), type: type ?? "", bytes }];
        });
      return entries;
    },
    async read(path) {
      const entry = (entries ?? []).find((e) => e.name === path);
      if (!entry || entry.type !== "blob" || entry.bytes === null || entry.bytes > MAX_READ_BYTES) return null;
      const result = await git(["cat-file", "blob", `${sha}:${path}`]);
      if (result.status !== 0) return null;
      return Buffer.from(result.stdout, "utf8");
    },
  };
}
