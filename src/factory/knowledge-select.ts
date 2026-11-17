import type { LessonRisk } from "./knowledge-risk.js";
import {
  renderEntry,
  sectionHeader,
  TRUNCATION_MARKER,
  type KnowledgeEntry,
  type KnowledgeSourceKind,
} from "./knowledge-render.js";

export const DEFAULT_KNOWLEDGE_MAX_CHARS = 12_000;

export interface SelectableNote {
  id: string;
  repositoryId: string | null;
  title: string;
  body: string;
  pathGlobs: readonly string[];
  status: string;
  sourceKind: Exclude<KnowledgeSourceKind, "digest">;
  sourceRef: Record<string, unknown>;
  risk: LessonRisk | null;
  version: number;
  createdBy: string;
  updatedBy: string;
  updatedAt: Date;
}

export interface SelectableDigest {
  commitSha: string;
  body: string;
}

export interface KnowledgeSelection {
  injected: KnowledgeEntry[];
  dropped: Array<{ noteId: string | null; title: string; reason: string }>;
}

export function selectKnowledge(input: {
  notes: readonly SelectableNote[];
  digest?: SelectableDigest | null | undefined;
  taskText: string;
  budgetChars?: number | undefined;
}): KnowledgeSelection {
  const budget = input.budgetChars ?? DEFAULT_KNOWLEDGE_MAX_CHARS;
  const mentioned = mentionedPaths(input.taskText);

  const candidates: Array<{ rank: number; updatedAt: number; id: string; entry: KnowledgeEntry }> = [];
  for (const note of input.notes) {
    if (note.status !== "active") continue;
    if (note.pathGlobs.length > 0 && !note.pathGlobs.some((glob) => mentioned.some((path) => globMatches(glob, path)))) {
      continue;
    }
    candidates.push({
      rank: rankOf(note),
      updatedAt: note.updatedAt.getTime(),
      id: note.id,
      entry: {
        noteId: note.id,
        noteVersion: note.version,
        digestSha: null,
        sourceKind: note.sourceKind,
        risk: note.risk,
        title: note.title,
        body: note.body,
        provenance: provenanceOf(note),
      },
    });
  }
  candidates.sort((a, b) => a.rank - b.rank || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ordered = candidates.map((c) => c.entry);
  if (input.digest && input.digest.body.trim() !== "") {
    ordered.push({
      noteId: null,
      noteVersion: null,
      digestSha: input.digest.commitSha,
      sourceKind: "digest",
      risk: null,
      title: "Codebase digest",
      body: input.digest.body,
      provenance: `codebase digest generated from repository files at ${input.digest.commitSha.slice(0, 12)}`,
    });
  }

  const injected: KnowledgeEntry[] = [];
  const dropped: KnowledgeSelection["dropped"] = [];
  let used = sectionHeader().length;
  for (const entry of ordered) {
    if (dropped.length > 0) {
      dropped.push({ noteId: entry.noteId, title: entry.title, reason: "over the knowledge budget" });
      continue;
    }
    const cost = 2 + renderEntry(entry).length;
    if (used + cost <= budget) {
      injected.push(entry);
      used += cost;
      continue;
    }
    if (injected.length === 0) {
      const cut = truncateToFit(entry, budget - used - 2);
      if (cut) {
        injected.push(cut);
        used += 2 + renderEntry(cut).length;
        continue;
      }
    }
    dropped.push({ noteId: entry.noteId, title: entry.title, reason: "over the knowledge budget" });
  }
  return { injected, dropped };
}

function truncateToFit(entry: KnowledgeEntry, room: number): KnowledgeEntry | null {
  const overhead = renderEntry({ ...entry, body: "" }).length + TRUNCATION_MARKER.length;
  let keep = room - overhead;
  if (keep < 40) return null;
  for (;;) {
    const candidate = { ...entry, body: `${entry.body.slice(0, keep).trimEnd()}${TRUNCATION_MARKER}` };
    if (renderEntry(candidate).length <= room) return candidate;
    keep -= 16;
    if (keep < 40) return null;
  }
}

function rankOf(note: SelectableNote): number {
  if (note.sourceKind === "human") return note.repositoryId ? 0 : 1;
  if (note.sourceKind === "verifier_finding" || note.sourceKind === "pr_review") return 2;
  return 3;
}

function provenanceOf(note: SelectableNote): string {
  const version = `v${note.version}`;
  switch (note.sourceKind) {
    case "human":
      return `${note.repositoryId ? "repository" : "organization"} note, ${version}, by ${note.updatedBy}`;
    case "repo_file": {
      const path = typeof note.sourceRef["path"] === "string" ? note.sourceRef["path"] : "a repository file";
      return `from repository file ${path}, ${version}`;
    }
    case "verifier_finding":
    case "pr_review": {
      const runId = typeof note.sourceRef["runId"] === "string" ? note.sourceRef["runId"].slice(0, 8) : null;
      const from = note.sourceKind === "pr_review" ? "learned from a pull request review" : `learned from run ${runId ?? "?"}`;
      const how =
        note.risk === "low" && note.updatedBy === note.createdBy
          ? "low risk, applied automatically"
          : `accepted by ${note.updatedBy}`;
      return `${from}, ${how}, ${version}`;
    }
  }
}

export function mentionedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const [token] of text.matchAll(/[A-Za-z0-9_@~.\-/]+/g)) {
    const cleaned = token.replace(/^[./]+(?=[A-Za-z0-9_])/, "").replace(/[.,]+$/, "");
    if (cleaned === "" || !/[A-Za-z]/.test(cleaned)) continue;
    if (cleaned.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(cleaned)) out.add(cleaned);
  }
  return [...out];
}

export function globMatches(glob: string, path: string): boolean {
  const re = globToRegExp(glob);
  const bare = path.replace(/\/+$/, "");
  return re.test(path) || re.test(bare) || re.test(`${bare}/`) || literalPrefix(glob) === `${bare}/`;
}

function literalPrefix(glob: string): string {
  const index = glob.search(/[*?{[]/);
  return index === -1 ? glob : glob.slice(0, index);
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((part) => part.replace(/[.+^${}()|[\]\\*?]/g, "\\$&"))
          .join("|")})`;
        i = end;
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}
