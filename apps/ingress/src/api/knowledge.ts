import {
  createNote,
  deleteNote,
  getDigest,
  getNote,
  listNotes,
  listRevisions,
  listRunKnowledge,
  setNoteStatus,
  updateNote,
  type KnowledgeNote,
  type NoteStatus,
} from "@windkeel/factory/repositories";
import { grantedRepository, runInOrganization } from "@windkeel/factory/tenancy";
import { badRequest, notFound, ok, type ApiDeps, type ApiResult, type Query, type Scope } from "./handlers.js";

const STATUSES: readonly NoteStatus[] = ["active", "suggested", "rejected", "archived"];

function knowledgeNoteView(note: KnowledgeNote) {
  return {
    id: note.id,
    repositoryId: note.repositoryId,
    scope: note.repositoryId ? "repository" : "organization",
    title: note.title,
    body: note.body,
    pathGlobs: note.pathGlobs,
    status: note.status,
    sourceKind: note.sourceKind,
    sourceRef: note.sourceRef,
    risk: note.risk,
    riskReasons: note.riskReasons,
    version: note.version,
    createdBy: note.createdBy,
    updatedBy: note.updatedBy,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

const fieldsOf = (body: unknown): Record<string, unknown> =>
  typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

export async function knowledgeNotes(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  const status = query.get("status") ?? undefined;
  if (status !== undefined && !STATUSES.includes(status as NoteStatus)) {
    return badRequest(`status must be one of ${STATUSES.join(", ")}`, "invalid_status");
  }
  const repositoryId = query.get("repositoryId");
  let filter: string | null | undefined;
  if (repositoryId) {
    if (!(await grantedRepository(deps.pool, scope.organizationId, repositoryId))) return notFound("repository");
    filter = repositoryId;
  } else if (query.get("scope") === "organization") {
    filter = null;
  }
  const notes = await listNotes(deps.pool, {
    organizationId: scope.organizationId,
    repositoryId: filter,
    status: status as NoteStatus | undefined,
  });
  const visible = filter === undefined ? await onlyGranted(deps, scope, notes) : notes;
  return ok({ items: visible.map(knowledgeNoteView), endCursor: null, hasNextPage: false });
}

export async function createKnowledgeNote(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  const fields = fieldsOf(body);
  const repositoryId = fields["repositoryId"];
  if (repositoryId !== undefined && repositoryId !== null) {
    if (typeof repositoryId !== "string" || !(await grantedRepository(deps.pool, scope.organizationId, repositoryId))) {
      return notFound("repository");
    }
  }
  const note = await createNote(deps.pool, {
    organizationId: scope.organizationId,
    repositoryId: (repositoryId) ?? null,
    title: fields["title"],
    body: fields["body"],
    pathGlobs: fields["pathGlobs"],
    actor: scope.actor,
  });
  return { status: 201, body: { note: knowledgeNoteView(note) } };
}

export async function updateKnowledgeNote(deps: ApiDeps, scope: Scope, noteId: string, body: unknown): Promise<ApiResult> {
  if (!(await visibleNote(deps, scope, noteId))) return notFound("note");
  const fields = fieldsOf(body);
  const note = await updateNote(deps.pool, {
    organizationId: scope.organizationId,
    noteId,
    expectedVersion: fields["version"],
    title: fields["title"],
    body: fields["body"],
    pathGlobs: fields["pathGlobs"],
    actor: scope.actor,
  });
  return note ? ok({ note: knowledgeNoteView(note) }) : notFound("note");
}

export async function setKnowledgeNoteStatus(deps: ApiDeps, scope: Scope, noteId: string, body: unknown): Promise<ApiResult> {
  if (!(await visibleNote(deps, scope, noteId))) return notFound("note");
  const fields = fieldsOf(body);
  const note = await setNoteStatus(deps.pool, {
    organizationId: scope.organizationId,
    noteId,
    action: fields["action"],
    expectedVersion: fields["version"],
    actor: scope.actor,
  });
  return note ? ok({ note: knowledgeNoteView(note) }) : notFound("note");
}

export async function deleteKnowledgeNote(deps: ApiDeps, scope: Scope, noteId: string): Promise<ApiResult> {
  if (!(await visibleNote(deps, scope, noteId))) return notFound("note");
  const deleted = await deleteNote(deps.pool, { organizationId: scope.organizationId, noteId, actor: scope.actor });
  return deleted ? ok({ deleted: noteId }) : notFound("note");
}

export async function knowledgeNoteRevisions(deps: ApiDeps, scope: Scope, noteId: string): Promise<ApiResult> {
  if (!(await visibleNote(deps, scope, noteId))) return notFound("note");
  const revisions = await listRevisions(deps.pool, scope.organizationId, noteId);
  if (!revisions) return notFound("note");
  return ok({
    items: revisions.map((r) => ({ ...r, at: r.at.toISOString() })),
    endCursor: null,
    hasNextPage: false,
  });
}

export async function repositoryDigest(deps: ApiDeps, scope: Scope, repositoryId: string, query: Query): Promise<ApiResult> {
  if (!(await grantedRepository(deps.pool, scope.organizationId, repositoryId))) return notFound("repository");
  const digest = await getDigest(deps.pool, repositoryId, query.get("commitSha"));
  return ok({
    repositoryId,
    digest: digest
      ? { commitSha: digest.commitSha, body: digest.body, sources: digest.sources, generatedAt: digest.generatedAt.toISOString() }
      : null,
  });
}

export async function runKnowledge(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  if (!(await runInOrganization(deps.pool, scope.organizationId, runId))) return notFound("run");
  const items = await listRunKnowledge(deps.pool, runId);
  return ok({
    items: items.map((entry) => ({
      noteId: entry.noteId,
      noteVersion: entry.noteVersion,
      digestSha: entry.digestSha,
      sourceKind: entry.sourceKind,
      risk: entry.risk,
      title: entry.title,
      body: entry.body,
      provenance: entry.provenance,
      chars: entry.chars,
      position: entry.position,
      recordedAt: entry.recordedAt.toISOString(),
    })),
    endCursor: null,
    hasNextPage: false,
  });
}

async function visibleNote(deps: ApiDeps, scope: Scope, noteId: string): Promise<KnowledgeNote | null> {
  const note = await getNote(deps.pool, scope.organizationId, noteId);
  if (!note) return null;
  if (note.repositoryId && !(await grantedRepository(deps.pool, scope.organizationId, note.repositoryId))) return null;
  return note;
}

async function onlyGranted(deps: ApiDeps, scope: Scope, notes: KnowledgeNote[]): Promise<KnowledgeNote[]> {
  const granted = new Map<string, boolean>();
  const out: KnowledgeNote[] = [];
  for (const note of notes) {
    if (!note.repositoryId) {
      out.push(note);
      continue;
    }
    if (!granted.has(note.repositoryId)) {
      granted.set(note.repositoryId, Boolean(await grantedRepository(deps.pool, scope.organizationId, note.repositoryId)));
    }
    if (granted.get(note.repositoryId)) out.push(note);
  }
  return out;
}
