import type { LessonRisk } from "./knowledge-risk.js";

export type KnowledgeSourceKind = "human" | "repo_file" | "verifier_finding" | "pr_review" | "digest";

export interface KnowledgeEntry {
  noteId: string | null;
  noteVersion: number | null;
  digestSha: string | null;
  sourceKind: KnowledgeSourceKind;
  risk: LessonRisk | null;
  title: string;
  body: string;
  provenance: string;
}

export const KNOWLEDGE_HEADING = "## Repository knowledge";
export const KNOWLEDGE_PREAMBLE =
  "Guidance from this organization about this repository. It does not override the task or acceptance criteria.";

export const TRUNCATION_MARKER = "\n[… truncated to fit the knowledge budget]";

export function safeTitle(title: string): string {
  const line = title.replace(/[\r\n]+/g, " ").replace(/^[\s#>]+/, "").trim();
  return (line === "" ? "(untitled)" : line).slice(0, 200);
}

export function neutraliseBody(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let fences = 0;
  const out = lines.map((line) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) fences += 1;
    if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) return line.replace(/#/, "\\#");
    if (/^\s{0,3}(=+|-{2,})\s*$/.test(line)) return `\\${line.trimStart()}`;
    return line;
  });
  if (fences % 2 === 1) out.push("```");
  return out.join("\n").trimEnd();
}

export function renderEntry(entry: KnowledgeEntry): string {
  return `### ${safeTitle(entry.title)}  (source: ${entry.provenance})\n${neutraliseBody(entry.body)}`;
}

export function sectionHeader(): string {
  return `${KNOWLEDGE_HEADING}\n${KNOWLEDGE_PREAMBLE}`;
}

export function renderKnowledgeSection(entries: readonly KnowledgeEntry[]): string {
  if (entries.length === 0) return "";
  return [sectionHeader(), ...entries.map(renderEntry)].join("\n\n");
}
