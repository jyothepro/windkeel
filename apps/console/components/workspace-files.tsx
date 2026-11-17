import Link from "next/link";
import { workspaceHref } from "../lib/session.ts";
import type { WorkspaceRead } from "../lib/types.ts";
import { crumbs, numberedLines, refusalText, sizeLabel } from "../lib/workspace-files.ts";

type Refused = { refused: { code: string; message: string } };
type Read = WorkspaceRead | Refused;

export function WorkspaceFiles({ runId, path, listing, file }: { runId: string; path: string; listing: Read; file: Read | null }) {
  const href = (p: string) => workspaceHref(runId, "files", undefined, { path: p });
  if ("refused" in listing && !["not_found", "invalid_path", "path_escapes", "not_a_file", "file_too_large", "binary_file"].includes(listing.refused.code)) {
    return (
      <p className="oq-muted" style={{ margin: 0 }}>
        {refusalText(listing.refused.code, listing.refused.message)}
      </p>
    );
  }
  return (
    <div className="oq-stack console-files" style={{ ["--gap" as string]: "var(--space-3)" }}>
      <nav aria-label="Path" className="console-files__crumbs oq-mono">
        {crumbs(path).map((c, i, all) => (
          <span key={c.path}>
            {i > 0 ? <span className="console-meta"> / </span> : null}
            {i === all.length - 1 ? <span aria-current="page">{c.label}</span> : <Link href={href(c.path)} scroll={false}>{c.label}</Link>}
          </span>
        ))}
      </nav>
      <p className="console-guidance-rule">Read-only, between turns: the maker&rsquo;s checkout as it stands now, not a candidate.</p>
      <div className="console-files__panes">
        {"refused" in listing ? (
          <p className="oq-muted" style={{ margin: 0 }}>
            {refusalText(listing.refused.code, listing.refused.message)}
          </p>
        ) : listing.kind === "directory" ? (
          <ul className="console-list console-files__tree" aria-label="Files">
            {listing.entries.length === 0 ? <li className="console-list__static console-meta">Empty directory</li> : null}
            {listing.entries.map((e) => (
              <li key={e.path}>
                {e.type === "directory" || e.type === "file" ? (
                  <Link className="console-list__row console-files__entry" href={href(e.path)} scroll={false} aria-current={e.path === path ? "page" : undefined}>
                    <span className="console-files__name">
                      {e.name}
                      {e.type === "directory" ? "/" : ""}
                    </span>
                    <span className="console-meta">{sizeLabel(e.bytes)}</span>
                  </Link>
                ) : (
                  <Link className="console-list__row console-files__entry" href={href(e.path)} scroll={false} title={e.type === "symlink" ? "A symlink: opened only if it stays inside the workspace" : "Not a regular file"}>
                    <span className="console-files__name">{e.name}</span>
                    <span className="console-meta">{e.type}</span>
                  </Link>
                )}
              </li>
            ))}
            {listing.truncated ? <li className="console-list__static console-meta">The first 1,000 entries are shown.</li> : null}
          </ul>
        ) : null}
        <div className="console-files__view">
          {file === null ? (
            <p className="oq-muted" style={{ margin: 0 }}>
              Choose a file to read it.
            </p>
          ) : "refused" in file ? (
            <p className="oq-muted" style={{ margin: 0 }}>
              {refusalText(file.refused.code, file.refused.message)}
            </p>
          ) : file.kind === "file" ? (
            <FileView path={file.path} bytes={file.bytes} content={file.content} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FileView({ path, bytes, content }: { path: string; bytes: number; content: string }) {
  const { lines, total, cut } = numberedLines(content);
  return (
    <div className="oq-diff">
      <div className="oq-diff__header">
        <span className="oq-diff__path" title={path}>
          {path}
        </span>
        <span className="console-meta">
          {total.toLocaleString()} {total === 1 ? "line" : "lines"} · {sizeLabel(bytes)}
        </span>
      </div>
      <div className="oq-diff__body">
        <table className="oq-diff__table console-files__code">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i}>
                <td className="oq-diff__num">{i + 1}</td>
                <td className="oq-diff__code">{line}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {cut ? <p className="console-diff__note">The first {lines.length.toLocaleString()} lines are shown.</p> : null}
      </div>
    </div>
  );
}
