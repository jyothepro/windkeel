import type { RunDiff } from "./types.ts";

export function sameFile(reported: string, patchPath: string, checkoutRoot?: string): boolean {
  if (reported.startsWith("/")) {
    if (checkoutRoot) {
      const root = checkoutRoot.replace(/\/+$/, "");
      return reported.startsWith(`${root}/`) && normalize(reported.slice(root.length + 1)) === patchPath;
    }
    return reported.endsWith(`/${patchPath}`);
  }
  return normalize(reported) === patchPath;
}

function normalize(path: string): string {
  return path
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/");
}

export function unquoteGitPath(text: string, from = 0): { path: string; end: number } | null {
  if (text[from] !== '"') return null;
  const bytes: number[] = [];
  const named: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  let i = from + 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const path = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
      return { path, end: i + 1 };
    }
    if (c !== "\\") {
      bytes.push(...new TextEncoder().encode(c));
      i += 1;
      continue;
    }
    const e = text[i + 1];
    if (e === undefined) return null;
    if (e in named) {
      bytes.push(named[e]!);
      i += 2;
    } else if (/^[0-3][0-7]{2}$/.test(text.slice(i + 1, i + 4))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 4), 8));
      i += 4;
    } else {
      return null;
    }
  }
  return null;
}

function pathField(raw: string): string | null {
  const field = raw.replace(/\t$/, "");
  if (field.startsWith('"')) {
    const q = unquoteGitPath(field);
    return q && q.end === field.length ? q.path : null;
  }
  return field === "" ? null : field;
}

function sidePath(raw: string, prefix: "a/" | "b/"): string | null {
  const path = pathField(raw);
  if (path === null || path === "/dev/null") return null;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function headerPaths(line: string): string[] {
  const rest = line.slice("diff --git ".length);
  const strip = (p: string, prefix: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
  if (rest.startsWith('"')) {
    const a = unquoteGitPath(rest);
    if (!a || rest[a.end] !== " ") return [];
    const b = pathField(rest.slice(a.end + 1));
    return b === null ? [strip(a.path, "a/")] : [strip(a.path, "a/"), strip(b, "b/")];
  }
  const quotedB = rest.lastIndexOf(' "b/');
  if (quotedB > 0 && rest.endsWith('"')) {
    const b = pathField(rest.slice(quotedB + 1));
    if (b !== null) return [strip(rest.slice(0, quotedB), "a/"), strip(b, "b/")];
  }
  if ((rest.length - 5) % 2 === 0) {
    const len = (rest.length - 5) / 2;
    const p = rest.slice(2, 2 + len);
    if (rest.startsWith("a/") && rest.slice(2 + len) === ` b/${p}`) return [p];
  }
  return [];
}

export function sections(patch: string): Array<{ paths: string[]; text: string }> {
  const out: Array<{ paths: string[]; text: string }> = [];
  for (const chunk of patch.split(/(?=^diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;
    const lines = chunk.split("\n");
    const paths = new Set<string>();
    for (const line of lines.slice(1)) {
      if (line.startsWith("@@")) break;
      let m: string | null = null;
      if (line.startsWith("--- ")) m = sidePath(line.slice(4), "a/");
      else if (line.startsWith("+++ ")) m = sidePath(line.slice(4), "b/");
      else {
        const named = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
        if (named) m = pathField(named[1]!);
      }
      if (m !== null) paths.add(m);
    }
    if (paths.size === 0) for (const p of headerPaths(lines[0]!)) paths.add(p);
    if (paths.size === 0) continue;
    out.push({ paths: [...paths], text: chunk });
  }
  return out;
}

export interface TurnScope {
  diff: RunDiff;
  notInPatch: string[];
  ownCandidate: boolean;
}

export function scopeToTurn(
  diff: RunDiff,
  touched: readonly string[],
  ownCandidate: boolean,
  checkoutRoot?: string,
): TurnScope {
  const same = (t: string, p: string) => sameFile(t, p, checkoutRoot);
  const kept = sections(diff.patch).filter((s) => touched.some((t) => s.paths.some((p) => same(t, p))));
  const keptPaths = kept.flatMap((s) => s.paths);
  return {
    diff: {
      ...diff,
      patch: kept.map((s) => s.text).join(""),
      filesChanged: diff.filesChanged.filter((f) => touched.some((t) => same(t, f))),
    },
    notInPatch: touched.filter((t) => !keptPaths.some((p) => same(t, p))),
    ownCandidate,
  };
}

export function candidateOfTurn(diff: RunDiff, agentRunId: string): string | null {
  return diff.candidates.find((c) => c.agentRunId === agentRunId)?.sha ?? null;
}
