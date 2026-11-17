import { currentOrganization, getIdentity, knowledge } from "../lib/api.ts";
import type { RunKnowledgeEntry } from "../lib/knowledge.ts";

export async function KnowledgePanel({ runId }: { runId: string }) {
  const org = await currentOrganization(await getIdentity());
  let items: RunKnowledgeEntry[] = [];
  try {
    items = (await knowledge.runKnowledge(org?.id ?? "", runId)).items;
  } catch {
  }
  return (
    <details className="console-disclosure" data-panel="knowledge">
      <summary>
        <span className="console-disclosure__title">Knowledge used</span>
        <span className="console-meta">{items.length ? `${items.length} entr${items.length === 1 ? "y" : "ies"} given to the maker` : "none"}</span>
      </summary>
      {items.length ? (
        <ul className="console-list">
          {items.map((entry) => (
            <li key={`${entry.noteId ?? "digest"}`} className="console-list__static" data-knowledge={entry.noteId ?? "digest"}>
              <span className="console-list__main">
                <span className="console-list__title">{entry.title}</span>
                <span className="console-meta">source: {entry.provenance}</span>
                <span className="console-list__next" style={{ whiteSpace: "pre-wrap" }}>
                  {entry.body}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="console-meta">This run&apos;s maker was given no repository knowledge.</p>
      )}
    </details>
  );
}
