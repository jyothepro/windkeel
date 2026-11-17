

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { KnowledgeEntry, KnowledgeSourceKind } from "./knowledge-render.js";
import { classifyLesson, type LessonRisk } from "./knowledge-risk.js";
import { DEFAULT_KNOWLEDGE_MAX_CHARS } from "./knowledge-select.js";
import {
  deleteNoteRow,
  hasLessonTombstone,
  hasRepositoryDigestRow,
  insertHumanNoteRow,
  insertLearnedNoteRow,
  insertLessonTombstone,
  insertNoteRevisionRow,
  insertRepositoryDigestRow,
  insertRunKnowledgeRow,
  selectNoteContentHash,
  selectNoteRevisionRows,
  selectNoteRow,
  selectNoteRows,
  selectRepositoryDigestRow,
  selectRunKnowledgeRows,
  updateNoteContentRow,
  updateNoteStatusRow,
} from "./stores/knowledge-store.js";

type Db = Pool | PoolClient;

export type NoteStatus = "active" | "suggested" | "rejected" | "archived";
export type NoteSourceKind = Exclude<KnowledgeSourceKind, "digest">;
export type NoteStatusAction = "accept" | "reject" | "archive" | "restore";

export interface KnowledgeNote {
  id: string;
  organizationId: string;
  repositoryId: string | null;
  title: string;
  body: string;
  pathGlobs: string[];
  status: NoteStatus;
  sourceKind: NoteSourceKind;
  sourceRef: Record<string, unknown>;
  risk: LessonRisk | null;
  riskReasons: string[];
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeRevision {
  noteId: string;
  version: number;
  title: string;
  body: string;
  pathGlobs: string[];
  status: string;
  actor: string;
  at: Date;
}

export interface RunKnowledgeRecord extends KnowledgeEntry {
  id: string;
  chars: number;
  position: number;
  recordedAt: Date;
}

export interface RepositoryDigestRecord {
  repositoryId: string;
  commitSha: string;
  body: string;
  sources: Array<{ path: string; bytes: number; sha256: string }>;
  generatedAt: Date;
}

class KnowledgeNoteError extends Error {
  override readonly name = "KnowledgeNoteError";
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 8000;
const MAX_PATH_GLOBS = 20;

export interface KnowledgeSettings {
  enabled: boolean;
  maxChars: number;
}

export function knowledgeSettings(env: Readonly<Record<string, string | undefined>> = process.env): KnowledgeSettings {
  const flag = (env["WINDKEEL_KNOWLEDGE"] ?? "").trim().toLowerCase();
  const max = Number.parseInt((env["WINDKEEL_KNOWLEDGE_MAX_CHARS"] ?? "").trim(), 10);
  return {
    enabled: !["off", "0", "false", "no"].includes(flag),
    maxChars: Number.isFinite(max) && max > 0 ? max : DEFAULT_KNOWLEDGE_MAX_CHARS,
  };
}

export async function listNotes(
  db: Db,
  filter: { organizationId: string; repositoryId?: string | null | undefined; status?: NoteStatus | undefined; includeOrganization?: boolean },
): Promise<KnowledgeNote[]> {
  return (await selectNoteRows(db, filter)).map(mapNote);
}

export async function getNote(db: Db, organizationId: string, noteId: string): Promise<KnowledgeNote | null> {
  if (!isUuid(noteId)) return null;
  const row = await selectNoteRow(db, organizationId, noteId);
  return row ? mapNote(row) : null;
}

export interface NoteInput {
  title?: unknown;
  body?: unknown;
  pathGlobs?: unknown;
}

export async function createNote(
  db: Db,
  input: NoteInput & { organizationId: string; repositoryId: string | null; actor: string },
): Promise<KnowledgeNote> {
  const fields = validateNote(input, true);
  const note = mapNote(
    await insertHumanNoteRow(db, {
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      title: fields.title,
      body: fields.body,
      pathGlobs: fields.pathGlobs,
      actor: input.actor,
    }),
  );
  await writeRevision(db, note, input.actor);
  return note;
}

export async function updateNote(
  db: Db,
  input: NoteInput & { organizationId: string; noteId: string; expectedVersion: unknown; actor: string },
): Promise<KnowledgeNote | null> {
  const expected = input.expectedVersion;
  if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
    throw new KnowledgeNoteError("give the version you are editing: { version, title?, body?, pathGlobs? }", 400, "missing_version");
  }
  const current = await getNote(db, input.organizationId, input.noteId);
  if (!current) return null;
  const fields = validateNote(
    {
      title: input.title ?? current.title,
      body: input.body ?? current.body,
      pathGlobs: input.pathGlobs ?? current.pathGlobs,
    },
    true,
  );
  const row = await updateNoteContentRow(db, {
    noteId: input.noteId,
    organizationId: input.organizationId,
    title: fields.title,
    body: fields.body,
    pathGlobs: fields.pathGlobs,
    actor: input.actor,
    expectedVersion: expected,
  });
  if (!row) throw versionConflict(current.version);
  const note = mapNote(row);
  await writeRevision(db, note, input.actor);
  return note;
}

const TRANSITIONS: Record<NoteStatusAction, { from: NoteStatus[]; to: NoteStatus }> = {
  accept: { from: ["suggested", "rejected"], to: "active" },
  reject: { from: ["suggested", "active"], to: "rejected" },
  archive: { from: ["active"], to: "archived" },
  restore: { from: ["archived"], to: "active" },
};

export async function setNoteStatus(
  db: Db,
  input: { organizationId: string; noteId: string; action: unknown; actor: string; expectedVersion?: unknown },
): Promise<KnowledgeNote | null> {
  const action = input.action;
  if (typeof action !== "string" || !(action in TRANSITIONS)) {
    throw new KnowledgeNoteError("action must be one of accept, reject, archive, restore", 400, "invalid_action");
  }
  const rule = TRANSITIONS[action as NoteStatusAction];
  const current = await getNote(db, input.organizationId, input.noteId);
  if (!current) return null;
  if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) throw versionConflict(current.version);
  if (!rule.from.includes(current.status)) {
    throw new KnowledgeNoteError(`a ${current.status} note cannot be ${action}ed`, 409, "invalid_transition");
  }
  const row = await updateNoteStatusRow(db, {
    noteId: input.noteId,
    organizationId: input.organizationId,
    status: rule.to,
    actor: input.actor,
    expectedVersion: current.version,
  });
  if (!row) throw versionConflict(current.version);
  const note = mapNote(row);
  await writeRevision(db, note, input.actor);
  return note;
}

export async function deleteNote(db: Db, input: { organizationId: string; noteId: string; actor: string }): Promise<boolean> {
  const current = await getNote(db, input.organizationId, input.noteId);
  if (!current) return false;
  const hash = await contentHashOf(db, current.id);
  if (hash && current.repositoryId) {
    await insertLessonTombstone(db, {
      organizationId: current.organizationId,
      repositoryId: current.repositoryId,
      contentHash: hash,
      deletedBy: input.actor,
    });
  }
  return (await deleteNoteRow(db, input.organizationId, input.noteId)) > 0;
}

export async function listRevisions(db: Db, organizationId: string, noteId: string): Promise<KnowledgeRevision[] | null> {
  if (!(await getNote(db, organizationId, noteId))) return null;
  const rows = await selectNoteRevisionRows(db, noteId);
  return rows.map((row) => ({
    noteId: row["note_id"] as string,
    version: Number(row["version"]),
    title: row["title"] as string,
    body: row["body"] as string,
    pathGlobs: (row["path_globs"] as string[]) ?? [],
    status: row["status"] as string,
    actor: row["actor"] as string,
    at: row["at"] as Date,
  }));
}

export function lessonHash(title: string, body: string): string {
  const normal = `${title}\n${body}`.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return createHash("sha256").update(normal).digest("hex");
}

export interface LearnedLessonInput {
  organizationId: string;
  repositoryId: string;
  title: string;
  body: string;
  sourceKind: "verifier_finding" | "pr_review";
  sourceRef: Record<string, unknown>;

  forceSuggested?: boolean;
}

export async function insertLearnedLesson(db: Db, input: LearnedLessonInput): Promise<KnowledgeNote | null> {
  const title = input.title.slice(0, MAX_TITLE_CHARS);
  const body = input.body.slice(0, MAX_BODY_CHARS);
  const hash = lessonHash(title, body);
  if (await hasLessonTombstone(db, input.organizationId, input.repositoryId, hash)) return null;
  const verdict = classifyLesson({ title, body });
  const row = await insertLearnedNoteRow(db, {
    organizationId: input.organizationId,
    repositoryId: input.repositoryId,
    title,
    body,
    status: verdict.risk === "low" && !input.forceSuggested ? "active" : "suggested",
    sourceKind: input.sourceKind,
    sourceRef: JSON.stringify(input.sourceRef),
    risk: verdict.risk,
    riskReasons: verdict.reasons,
    contentHash: hash,
  });
  if (!row) return null;
  const note = mapNote(row);
  await writeRevision(db, note, "orqon");
  return note;
}

export async function recordRunKnowledge(
  db: Db,
  engineeringRunId: string,
  entries: readonly KnowledgeEntry[],
  renderedChars: (entry: KnowledgeEntry) => number,
): Promise<RunKnowledgeRecord[]> {
  let position = 0;
  for (const entry of entries) {
    await insertRunKnowledgeRow(db, engineeringRunId, {
      noteId: entry.noteId,
      noteVersion: entry.noteVersion,
      digestSha: entry.digestSha,
      sourceKind: entry.sourceKind,
      risk: entry.risk,
      title: entry.title,
      body: entry.body,
      provenance: entry.provenance,
      chars: renderedChars(entry),
      position: position++,
    });
  }
  return listRunKnowledge(db, engineeringRunId);
}

export async function listRunKnowledge(db: Db, engineeringRunId: string): Promise<RunKnowledgeRecord[]> {
  const rows = await selectRunKnowledgeRows(db, engineeringRunId);
  return rows.map((row) => ({
    id: row["id"] as string,
    noteId: (row["note_id"] as string | null) ?? null,
    noteVersion: row["note_version"] === null ? null : Number(row["note_version"]),
    digestSha: (row["digest_sha"] as string | null) ?? null,
    sourceKind: row["source_kind"] as KnowledgeSourceKind,
    risk: (row["risk"] as LessonRisk | null) ?? null,
    title: row["title"] as string,
    body: row["body"] as string,
    provenance: row["provenance"] as string,
    chars: Number(row["chars"]),
    position: Number(row["position"]),
    recordedAt: row["recorded_at"] as Date,
  }));
}

export async function putDigest(
  db: Db,
  digest: { repositoryId: string; commitSha: string; body: string; sources: RepositoryDigestRecord["sources"] },
): Promise<void> {
  await insertRepositoryDigestRow(db, {
    repositoryId: digest.repositoryId,
    commitSha: digest.commitSha,
    body: digest.body,
    sources: JSON.stringify(digest.sources),
  });
}

export async function getDigest(
  db: Db,
  repositoryId: string,
  commitSha?: string | null,
): Promise<RepositoryDigestRecord | null> {
  const row = await selectRepositoryDigestRow(db, repositoryId, commitSha ?? "");
  if (!row) return null;
  return {
    repositoryId: row["repository_id"] as string,
    commitSha: row["commit_sha"] as string,
    body: row["body"] as string,
    sources: (row["sources"] as RepositoryDigestRecord["sources"]) ?? [],
    generatedAt: row["generated_at"] as Date,
  };
}

export async function hasDigest(db: Db, repositoryId: string, commitSha: string): Promise<boolean> {
  return hasRepositoryDigestRow(db, repositoryId, commitSha);
}

function validateNote(input: NoteInput, requireAll: boolean): { title: string; body: string; pathGlobs: string[] } {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (requireAll && title === "") throw new KnowledgeNoteError("title is required", 400, "invalid_note");
  if (title.length > MAX_TITLE_CHARS || /[\r\n]/.test(title)) {
    throw new KnowledgeNoteError(`title must be one line of at most ${MAX_TITLE_CHARS} characters`, 400, "invalid_note");
  }
  if (requireAll && body === "") throw new KnowledgeNoteError("body is required", 400, "invalid_note");
  if (body.length > MAX_BODY_CHARS) {
    throw new KnowledgeNoteError(`body must be at most ${MAX_BODY_CHARS} characters`, 400, "invalid_note");
  }
  const globs = input.pathGlobs ?? [];
  if (!Array.isArray(globs) || globs.length > MAX_PATH_GLOBS || !globs.every((g) => typeof g === "string")) {
    throw new KnowledgeNoteError(`pathGlobs must be a list of at most ${MAX_PATH_GLOBS} strings`, 400, "invalid_note");
  }
  const pathGlobs = (globs).map((g) => g.trim()).filter((g) => g !== "");
  for (const glob of pathGlobs) {
    if (glob.length > 200 || glob.startsWith("/") || glob.split("/").includes("..") || /[\s\0]/.test(glob)) {
      throw new KnowledgeNoteError(`path glob ${JSON.stringify(glob.slice(0, 60))} must be a repository-relative path`, 400, "invalid_note");
    }
  }
  return { title, body, pathGlobs };
}

function versionConflict(current: number): KnowledgeNoteError {
  return new KnowledgeNoteError(
    `this note changed since you read it; it is now at version ${current}. Reload it and apply your edit again.`,
    409,
    "version_conflict",
  );
}

async function writeRevision(db: Db, note: KnowledgeNote, actor: string): Promise<void> {
  await insertNoteRevisionRow(db, {
    noteId: note.id,
    version: note.version,
    title: note.title,
    body: note.body,
    pathGlobs: note.pathGlobs,
    status: note.status,
    actor,
  });
}

async function contentHashOf(db: Db, noteId: string): Promise<string | null> {
  return selectNoteContentHash(db, noteId);
}

function mapNote(row: Record<string, unknown>): KnowledgeNote {
  return {
    id: row["id"] as string,
    organizationId: row["organization_id"] as string,
    repositoryId: (row["repository_id"] as string | null) ?? null,
    title: row["title"] as string,
    body: row["body"] as string,
    pathGlobs: (row["path_globs"] as string[]) ?? [],
    status: row["status"] as NoteStatus,
    sourceKind: row["source_kind"] as NoteSourceKind,
    sourceRef: (row["source_ref"] as Record<string, unknown>) ?? {},
    risk: (row["risk"] as LessonRisk | null) ?? null,
    riskReasons: (row["risk_reasons"] as string[]) ?? [],
    version: Number(row["version"]),
    createdBy: row["created_by"] as string,
    updatedBy: row["updated_by"] as string,
    createdAt: row["created_at"] as Date,
    updatedAt: row["updated_at"] as Date,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
