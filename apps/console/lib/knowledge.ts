import { orgPath, type Send } from "./automations.ts";

export type NoteStatus = "active" | "suggested" | "rejected" | "archived";
export type NoteSourceKind = "human" | "repo_file" | "verifier_finding" | "pr_review";
export type NoteAction = "accept" | "reject" | "archive" | "restore";

export interface KnowledgeNote {
  id: string;
  repositoryId: string | null;
  scope: "repository" | "organization";
  title: string;
  body: string;
  pathGlobs: string[];
  status: NoteStatus;
  sourceKind: NoteSourceKind;
  sourceRef: Record<string, unknown>;
  risk: "low" | "high" | null;
  riskReasons: string[];
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunKnowledgeEntry {
  noteId: string | null;
  noteVersion: number | null;
  digestSha: string | null;
  sourceKind: NoteSourceKind | "digest";
  risk: "low" | "high" | null;
  title: string;
  body: string;
  provenance: string;
  chars: number;
  position: number;
  recordedAt: string;
}

export interface RepositoryDigest {
  commitSha: string;
  body: string;
  sources: Array<{ path: string; bytes: number; sha256: string }>;
  generatedAt: string;
}

export interface NoteInput {
  repositoryId?: string | null;
  title: string;
  body: string;
  pathGlobs?: string[];
}

export interface KnowledgeApi {
  listNotes(org: string, filter: { repositoryId?: string | null; status?: NoteStatus }): Promise<{ items: KnowledgeNote[] }>;
  createNote(org: string, input: NoteInput): Promise<{ note: KnowledgeNote }>;
  updateNote(org: string, id: string, input: Partial<NoteInput> & { version: number }): Promise<{ note: KnowledgeNote }>;
  setStatus(org: string, id: string, action: NoteAction): Promise<{ note: KnowledgeNote }>;
  deleteNote(org: string, id: string): Promise<{ deleted: string }>;
  digest(org: string, repositoryId: string): Promise<{ digest: RepositoryDigest | null }>;
  runKnowledge(org: string, runId: string): Promise<{ items: RunKnowledgeEntry[] }>;
}

const id = encodeURIComponent;

export function knowledgeClient(send: Send): KnowledgeApi {
  return {
    listNotes: (org, filter) => {
      const params = new URLSearchParams();
      if (filter.repositoryId) params.set("repositoryId", filter.repositoryId);
      else if (filter.repositoryId === null) params.set("scope", "organization");
      if (filter.status) params.set("status", filter.status);
      const query = params.toString();
      return send("GET", orgPath(org, `/knowledge${query ? `?${query}` : ""}`));
    },
    createNote: (org, input) => send("POST", orgPath(org, "/knowledge"), input),
    updateNote: (org, noteId, input) => send("POST", orgPath(org, `/knowledge/${id(noteId)}`), input),
    setStatus: (org, noteId, action) => send("POST", orgPath(org, `/knowledge/${id(noteId)}/status`), { action }),
    deleteNote: (org, noteId) => send("POST", orgPath(org, `/knowledge/${id(noteId)}/delete`)),
    digest: (org, repositoryId) => send("GET", orgPath(org, `/repositories/${id(repositoryId)}/digest`)),
    runKnowledge: (org, runId) => send("GET", orgPath(org, `/runs/${id(runId)}/knowledge`)),
  };
}

export function sourceLabel(note: Pick<KnowledgeNote, "sourceKind" | "sourceRef" | "risk" | "createdBy" | "updatedBy" | "scope">): string {
  switch (note.sourceKind) {
    case "human":
      return `${note.scope === "organization" ? "Organization note" : "Repository note"} by ${note.createdBy}`;
    case "repo_file":
      return `From repository file ${typeof note.sourceRef["path"] === "string" ? note.sourceRef["path"] : ""}`.trim();
    case "verifier_finding": {
      const run = typeof note.sourceRef["runId"] === "string" ? note.sourceRef["runId"] : null;
      return `Learned from run ${run ? run.slice(0, 8) : "?"}`;
    }
    case "pr_review":
      return "Learned from a pull request review";
  }
}

export function sourceRunId(note: Pick<KnowledgeNote, "sourceRef">): string | null {
  const run = note.sourceRef["runId"];
  return typeof run === "string" && /^[0-9a-f-]{36}$/i.test(run) ? run : null;
}

export function riskLine(note: Pick<KnowledgeNote, "risk" | "riskReasons" | "status">): string | null {
  if (note.risk === "low") return "Low risk: applied automatically. Delete it if it's wrong.";
  if (note.risk === "high") {
    const why = note.riskReasons.length ? note.riskReasons.join("; ") : "it could change what the maker does";
    return note.status === "suggested" ? `Held for a person: ${why}.` : `High risk (${why}).`;
  }
  return null;
}

export function parseGlobs(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((g) => g.trim())
    .filter((g) => g !== "");
}
