

import type { Queryable } from "../db/transaction.js";

type Row = Record<string, unknown>;

const NOTE_COLUMNS = `id, organization_id, repository_id, title, body, path_globs, status, source_kind, source_ref,
  risk, risk_reasons, version, created_by, updated_by, created_at, updated_at`;

export async function selectNoteRows(
  db: Queryable,
  filter: { organizationId: string; repositoryId?: string | null | undefined; status?: string | undefined; includeOrganization?: boolean },
): Promise<Row[]> {
  const params: unknown[] = [filter.organizationId];
  const where = ["organization_id = $1"];
  if (filter.repositoryId === null) {
    where.push("repository_id is null");
  } else if (filter.repositoryId !== undefined) {
    params.push(filter.repositoryId);
    where.push(
      filter.includeOrganization === false
        ? `repository_id = $${params.length}`
        : `(repository_id = $${params.length} or repository_id is null)`,
    );
  }
  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  const { rows } = await db.query(
    `select ${NOTE_COLUMNS} from knowledge_note where ${where.join(" and ")} order by updated_at desc, id`,
    params,
  );
  return rows;
}

export async function selectNoteRow(db: Queryable, organizationId: string, noteId: string): Promise<Row | undefined> {
  const { rows } = await db.query(`select ${NOTE_COLUMNS} from knowledge_note where id = $1 and organization_id = $2`, [
    noteId,
    organizationId,
  ]);
  return rows[0];
}

export async function insertHumanNoteRow(
  db: Queryable,
  v: { organizationId: string; repositoryId: string | null; title: string; body: string; pathGlobs: string[]; actor: string },
): Promise<Row> {
  const { rows } = await db.query(
    `insert into knowledge_note (organization_id, repository_id, title, body, path_globs, status, source_kind,
                                 created_by, updated_by)
     values ($1, $2, $3, $4, $5, 'active', 'human', $6, $6)
     returning ${NOTE_COLUMNS}`,
    [v.organizationId, v.repositoryId, v.title, v.body, v.pathGlobs, v.actor],
  );
  return rows[0]!;
}

export async function updateNoteContentRow(
  db: Queryable,
  v: { noteId: string; organizationId: string; title: string; body: string; pathGlobs: string[]; actor: string; expectedVersion: number },
): Promise<Row | undefined> {
  const { rows } = await db.query(
    `update knowledge_note
        set title = $3, body = $4, path_globs = $5, version = version + 1, updated_by = $6, updated_at = now()
      where id = $1 and organization_id = $2 and version = $7
      returning ${NOTE_COLUMNS}`,
    [v.noteId, v.organizationId, v.title, v.body, v.pathGlobs, v.actor, v.expectedVersion],
  );
  return rows[0];
}

export async function updateNoteStatusRow(
  db: Queryable,
  v: { noteId: string; organizationId: string; status: string; actor: string; expectedVersion: number },
): Promise<Row | undefined> {
  const { rows } = await db.query(
    `update knowledge_note set status = $3, version = version + 1, updated_by = $4, updated_at = now()
      where id = $1 and organization_id = $2 and version = $5
      returning ${NOTE_COLUMNS}`,
    [v.noteId, v.organizationId, v.status, v.actor, v.expectedVersion],
  );
  return rows[0];
}

export async function insertLessonTombstone(
  db: Queryable,
  v: { organizationId: string; repositoryId: string; contentHash: string; deletedBy: string },
): Promise<void> {
  await db.query(
    `insert into knowledge_lesson_tombstone (organization_id, repository_id, content_hash, deleted_by)
     values ($1, $2, $3, $4) on conflict do nothing`,
    [v.organizationId, v.repositoryId, v.contentHash, v.deletedBy],
  );
}

export async function deleteNoteRow(db: Queryable, organizationId: string, noteId: string): Promise<number> {
  const { rowCount } = await db.query("delete from knowledge_note where id = $1 and organization_id = $2", [
    noteId,
    organizationId,
  ]);
  return rowCount ?? 0;
}

export async function selectNoteRevisionRows(db: Queryable, noteId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select note_id, version, title, body, path_globs, status, actor, at
       from knowledge_note_revision where note_id = $1 order by version`,
    [noteId],
  );
  return rows;
}

export async function hasLessonTombstone(db: Queryable, organizationId: string, repositoryId: string, contentHash: string): Promise<boolean> {
  const tomb = await db.query(
    "select 1 from knowledge_lesson_tombstone where organization_id = $1 and repository_id = $2 and content_hash = $3",
    [organizationId, repositoryId, contentHash],
  );
  return tomb.rows.length > 0;
}

export interface LearnedNoteInsert {
  organizationId: string;
  repositoryId: string;
  title: string;
  body: string;
  status: string;
  sourceKind: string;

  sourceRef: string;
  risk: string;
  riskReasons: string[];
  contentHash: string;
}

export async function insertLearnedNoteRow(db: Queryable, v: LearnedNoteInsert): Promise<Row | undefined> {
  const { rows } = await db.query(
    `insert into knowledge_note (organization_id, repository_id, title, body, status, source_kind, source_ref,
                                 risk, risk_reasons, content_hash, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'orqon', 'orqon')
     on conflict (organization_id, repository_id, content_hash) where content_hash is not null do nothing
     returning ${NOTE_COLUMNS}`,
    [v.organizationId, v.repositoryId, v.title, v.body, v.status, v.sourceKind, v.sourceRef, v.risk, v.riskReasons, v.contentHash],
  );
  return rows[0];
}

export interface RunKnowledgeInsert {
  noteId: string | null;
  noteVersion: number | null;
  digestSha: string | null;
  sourceKind: string;
  risk: string | null;
  title: string;
  body: string;
  provenance: string;
  chars: number;
  position: number;
}

export async function insertRunKnowledgeRow(db: Queryable, engineeringRunId: string, v: RunKnowledgeInsert): Promise<void> {
  await db.query(
    `insert into run_knowledge (engineering_run_id, note_id, note_version, digest_sha, source_kind, risk, title, body,
                                provenance, chars, position)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (engineering_run_id, coalesce(note_id::text, 'digest')) do nothing`,
    [engineeringRunId, v.noteId, v.noteVersion, v.digestSha, v.sourceKind, v.risk, v.title, v.body, v.provenance, v.chars, v.position],
  );
}

export async function selectRunKnowledgeRows(db: Queryable, engineeringRunId: string): Promise<Row[]> {
  const { rows } = await db.query(
    `select id, note_id, note_version, digest_sha, source_kind, risk, title, body, provenance, chars, position, recorded_at
       from run_knowledge where engineering_run_id = $1 order by position, id`,
    [engineeringRunId],
  );
  return rows;
}

export async function insertRepositoryDigestRow(
  db: Queryable,
  v: { repositoryId: string; commitSha: string; body: string; sources: string },
): Promise<void> {
  await db.query(
    `insert into repository_digest (repository_id, commit_sha, body, sources) values ($1, $2, $3, $4)
     on conflict (repository_id, commit_sha) do nothing`,
    [v.repositoryId, v.commitSha, v.body, v.sources],
  );
}

export async function selectRepositoryDigestRow(db: Queryable, repositoryId: string, commitSha: string): Promise<Row | undefined> {
  const { rows } = await db.query(
    `select repository_id, commit_sha, body, sources, generated_at from repository_digest
      where repository_id = $1
      order by (commit_sha = $2) desc, generated_at desc
      limit 1`,
    [repositoryId, commitSha],
  );
  return rows[0];
}

export async function hasRepositoryDigestRow(db: Queryable, repositoryId: string, commitSha: string): Promise<boolean> {
  const { rows } = await db.query("select 1 from repository_digest where repository_id = $1 and commit_sha = $2", [
    repositoryId,
    commitSha,
  ]);
  return rows.length > 0;
}

export async function insertNoteRevisionRow(
  db: Queryable,
  v: { noteId: string; version: number; title: string; body: string; pathGlobs: string[]; status: string; actor: string },
): Promise<void> {
  await db.query(
    `insert into knowledge_note_revision (note_id, version, title, body, path_globs, status, actor)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing`,
    [v.noteId, v.version, v.title, v.body, v.pathGlobs, v.status, v.actor],
  );
}

export async function selectNoteContentHash(db: Queryable, noteId: string): Promise<string | null> {
  const { rows } = await db.query("select content_hash from knowledge_note where id = $1", [noteId]);
  return (rows[0]?.["content_hash"] as string | null) ?? null;
}

export async function repositoryExists(db: Queryable, repositoryId: string): Promise<boolean> {
  const exists = await db.query("select 1 from repository where id = $1", [repositoryId]);
  return exists.rows.length > 0;
}

export async function countVerifierLessonsForRun(db: Queryable, engineeringRunId: string, organizationId: string): Promise<number> {
  const already = await db.query(
    "select count(*)::int as n from knowledge_note where source_ref->>'runId' = $1 and organization_id = $2 and source_kind = 'verifier_finding'",
    [engineeringRunId, organizationId],
  );
  return Number(already.rows[0]?.["n"] ?? 0);
}

export async function reviewLessonSeen(db: Queryable, organizationId: string, repositoryId: string, reviewKey: unknown): Promise<boolean> {
  const seen = await db.query(
    `select 1 from knowledge_note
      where organization_id = $1 and repository_id = $2 and source_kind = 'pr_review'
        and source_ref->>'reviewKey' = $3
      limit 1`,
    [organizationId, repositoryId, reviewKey],
  );
  return seen.rows.length > 0;
}

export async function countReviewLessonsForRun(db: Queryable, organizationId: string, engineeringRunId: string): Promise<number> {
  const count = await db.query(
    `select count(*)::int as n from knowledge_note
      where organization_id = $1 and source_kind = 'pr_review' and source_ref->>'runId' = $2`,
    [organizationId, engineeringRunId],
  );
  return Number(count.rows[0]?.["n"] ?? 0);
}
