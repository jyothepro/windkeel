import Link from "next/link";
import { Banner } from "../../../components/banner.tsx";
import { ConfirmAction } from "../../../components/confirm-action.tsx";
import { ActionButton } from "../../../components/model-controls.tsx";
import { SimpleForm } from "../../../components/simple-form.tsx";
import { Badge } from "../../../components/status.tsx";
import { knowledge } from "../../../lib/api.ts";
import { time } from "../../../lib/format.ts";
import { riskLine, sourceLabel, sourceRunId, type KnowledgeNote } from "../../../lib/knowledge.ts";
import { PERMISSION_LABEL } from "../../../lib/permissions.ts";
import type { OrganizationView } from "../../../lib/types.ts";
import { createKnowledgeNote, deleteKnowledgeNote, editKnowledgeNote, setKnowledgeNoteStatus } from "./actions.ts";

const muted = { margin: 0 } as const;

function NoteFields({ note }: { note?: KnowledgeNote }) {
  return (
    <>
      <label className="oq-field">
        <span className="oq-field__label">Title</span>
        <input className="oq-input" name="title" required maxLength={200} defaultValue={note?.title} placeholder="Use pnpm, not npm" />
      </label>
      <label className="oq-field">
        <span className="oq-field__label">Note</span>
        <textarea className="oq-input" name="body" required maxLength={8000} rows={4} defaultValue={note?.body} placeholder="This repository is a pnpm workspace; run the tests with pnpm -w test." />
      </label>
      <label className="oq-field">
        <span className="oq-field__label">Only when the task names a path matching (optional)</span>
        <input className="oq-input oq-mono" name="pathGlobs" defaultValue={note?.pathGlobs.join(", ")} placeholder="legacy/**, src/**/*.sql" />
      </label>
    </>
  );
}

function NoteRow({ note, manage, inherited }: { note: KnowledgeNote; manage: boolean; inherited?: boolean }) {
  const run = sourceRunId(note);
  const risk = riskLine(note);
  return (
    <li className="console-list__static" data-note={note.id} data-status={note.status}>
      <span className="console-list__main">
        <span className="console-list__title">
          {note.title} {inherited ? <Badge small intent="neutral">organization</Badge> : null}{" "}
          {note.status !== "active" ? <Badge small intent={note.status === "suggested" ? "warning" : "neutral"}>{note.status}</Badge> : null}
          {note.risk ? <Badge small intent={note.risk === "low" ? "neutral" : "warning"}>{note.risk} risk</Badge> : null}
        </span>
        <span className="console-list__next" style={{ whiteSpace: "pre-wrap" }}>
          {note.body}
        </span>
        <span className="console-meta">
          {run ? <Link href={`/runs/${run}`}>{sourceLabel(note)}</Link> : sourceLabel(note)} · v{note.version}
          {note.updatedBy !== note.createdBy ? ` · last changed by ${note.updatedBy}` : ""} · {time(note.updatedAt)}
          {note.pathGlobs.length ? (
            <>
              {" "}
              · applies to <span className="oq-mono">{note.pathGlobs.join(", ")}</span>
            </>
          ) : null}
        </span>
        {risk ? <span className="console-meta">{risk}</span> : null}
      </span>
      {manage && !inherited ? (
        <span className="console-list__meta console-actions">
          {note.status === "suggested" ? (
            <>
              <ActionButton label="Accept" run={setKnowledgeNoteStatus.bind(null, note.id, "accept")} />
              <ActionButton label="Reject" run={setKnowledgeNoteStatus.bind(null, note.id, "reject")} />
            </>
          ) : null}
          {note.status === "active" ? <ActionButton label="Archive" run={setKnowledgeNoteStatus.bind(null, note.id, "archive")} /> : null}
          {note.status === "archived" || note.status === "rejected" ? (
            <ActionButton label="Restore" run={setKnowledgeNoteStatus.bind(null, note.id, note.status === "archived" ? "restore" : "accept")} />
          ) : null}
          {note.sourceKind === "human" ? (
            <details>
              <summary className="oq-button oq-button--ghost oq-button--sm">Edit</summary>
              <SimpleForm action={editKnowledgeNote.bind(null, note.id, note.version)} submitLabel="Save">
                <NoteFields note={note} />
              </SimpleForm>
            </details>
          ) : null}
          <ConfirmAction
            label="Delete"
            question={`Delete “${note.title}”?`}
            consequence={note.sourceKind === "human" ? "Runs that already used it keep their record of it." : "It won't be learned again. Runs that already used it keep their record of it."}
            confirmLabel="Delete"
            run={deleteKnowledgeNote.bind(null, note.id)}
          />
        </span>
      ) : null}
    </li>
  );
}

function ReadOnly() {
  return (
    <p className="oq-muted" style={muted}>
      Read-only: changing knowledge needs <strong>{PERMISSION_LABEL["knowledge.manage"].label}</strong> (<code>knowledge.manage</code>), which admins and
      members have.
    </p>
  );
}

export async function RepositoryKnowledge({ org, repositoryId }: { org: OrganizationView; repositoryId: string }) {
  const manage = org.permissions.includes("knowledge.manage");
  const [{ items }, { digest }] = await Promise.all([knowledge.listNotes(org.id, { repositoryId }), knowledge.digest(org.id, repositoryId)]);
  const own = items.filter((n) => n.repositoryId === repositoryId);
  const active = own.filter((n) => n.status === "active");
  const suggested = own.filter((n) => n.status === "suggested");
  const rest = own.filter((n) => n.status === "archived" || n.status === "rejected");
  const inherited = items.filter((n) => n.repositoryId === null && n.status === "active");

  return (
    <section className="console-section" aria-labelledby="knowledge" data-section="knowledge">
      <h3 id="knowledge">Knowledge</h3>
      <p className="oq-muted" style={muted}>
        What the maker is told about this repository before it starts, with where each note came from. It shapes the maker only: the verifier checks the
        same things whatever is here.
      </p>
      {manage ? null : <ReadOnly />}

      {suggested.length ? (
        <>
          <h4>Suggested — waiting for a person</h4>
          <ul className="console-list" data-list="suggested">
            {suggested.map((n) => (
              <NoteRow key={n.id} note={n} manage={manage} />
            ))}
          </ul>
        </>
      ) : null}

      <h4>In use</h4>
      {active.length || inherited.length ? (
        <ul className="console-list" data-list="active">
          {active.map((n) => (
            <NoteRow key={n.id} note={n} manage={manage} />
          ))}
          {inherited.map((n) => (
            <NoteRow key={n.id} note={n} manage={manage} inherited />
          ))}
        </ul>
      ) : (
        <Banner title="No notes yet">
          <p>Write down what someone new to this repository gets wrong: the test command, a directory to leave alone, a review convention.</p>
        </Banner>
      )}

      {manage ? (
        <details className="console-disclosure">
          <summary>
            <span className="console-disclosure__title">Add a note</span>
          </summary>
          <SimpleForm action={createKnowledgeNote.bind(null, repositoryId)} submitLabel="Add note">
            <NoteFields />
          </SimpleForm>
        </details>
      ) : null}

      {rest.length ? (
        <details className="console-disclosure">
          <summary>
            <span className="console-disclosure__title">Archived and rejected</span>
            <span className="console-meta">{rest.length}</span>
          </summary>
          <ul className="console-list">
            {rest.map((n) => (
              <NoteRow key={n.id} note={n} manage={manage} />
            ))}
          </ul>
        </details>
      ) : null}

      <details className="console-disclosure" data-panel="digest">
        <summary>
          <span className="console-disclosure__title">Codebase digest</span>
          <span className="console-meta">{digest ? `at ${digest.commitSha.slice(0, 12)} · ${time(digest.generatedAt)}` : "not generated yet"}</span>
        </summary>
        {digest ? (
          <>
            <p className="console-meta">
              Generated from {digest.sources.map((s) => s.path).join(", ") || "the repository's layout"} — the files the repository already ships, with anything
              shaped like a credential removed. The lowest-priority knowledge: dropped first when the budget is tight.
            </p>
            <pre className="oq-mono" style={{ whiteSpace: "pre-wrap" }}>
              {digest.body}
            </pre>
          </>
        ) : (
          <p className="console-meta">Generated the first time a run provisions a workspace on this repository.</p>
        )}
      </details>
    </section>
  );
}

export async function OrganizationKnowledge({ org }: { org: OrganizationView }) {
  const manage = org.permissions.includes("knowledge.manage");
  const { items } = await knowledge.listNotes(org.id, { repositoryId: null });
  return (
    <section className="console-section" data-section="knowledge">
      <h3>Organization notes</h3>
      <p className="oq-muted" style={muted}>
        Given to the maker on every repository, after that repository&apos;s own notes. Repository notes, suggestions and the digest are on each repository&apos;s
        page.
      </p>
      {manage ? null : <ReadOnly />}
      {items.length ? (
        <ul className="console-list">
          {items.map((n) => (
            <NoteRow key={n.id} note={n} manage={manage} />
          ))}
        </ul>
      ) : (
        <Banner title="No organization notes">
          <p>House rules every repository shares — commit message style, a changelog convention.</p>
        </Banner>
      )}
      {manage ? (
        <SimpleForm action={createKnowledgeNote.bind(null, null)} submitLabel="Add note">
          <NoteFields />
        </SimpleForm>
      ) : null}
    </section>
  );
}
