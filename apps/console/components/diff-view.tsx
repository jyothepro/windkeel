import { parsePatch, type PatchFile } from "../lib/patch.ts";
import { shortSha } from "../lib/format.ts";
import type { RunDiff } from "../lib/types.ts";

const OPEN_UNDER_LINES = 400;
const RENDER_LINES = 3000;

export function DiffView({
  diff,
  pullRequestUrl,
  candidateLabel,
}: {
  diff: RunDiff;
  pullRequestUrl: string | null;
  candidateLabel?: string;
}) {
  const files = parsePatch(diff.patch);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const cycles = diff.candidates.length;

  return (
    <div className="oq-stack console-diff" style={{ ["--gap" as string]: "var(--space-3)" }}>
      <p className="console-facts">
        {files.length} {files.length === 1 ? "file" : "files"} changed · <span className="console-diff__add">+{additions}</span>{" "}
        <span className="console-diff__remove">−{deletions}</span> · candidate <span className="oq-mono">{shortSha(diff.candidateSha)}</span>
        {candidateLabel ? ` · ${candidateLabel}` : cycles > 1 ? ` · the newest of ${cycles} candidates` : ""}
        {pullRequestUrl ? (
          <>
            {" "}
            · <a href={`${pullRequestUrl}/files`}>on the pull request</a>
          </>
        ) : null}
      </p>
      {diff.truncated ? (
        <p className="console-guidance-rule">The stored patch hit its 2MB limit and is incomplete. The branch has the whole change.</p>
      ) : null}
      {files.length > 0 ? (
        files.map((f) => <FileDiff key={f.path} file={f} />)
      ) : diff.patch.trim() ? (
        <pre className="oq-terminal console-diff__raw">{diff.patch}</pre>
      ) : (
        <p className="oq-muted">The stored patch is empty.</p>
      )}
    </div>
  );
}

function FileDiff({ file }: { file: PatchFile }) {
  const lines = file.hunks.reduce((n, h) => n + h.lines.length + 1, 0);
  let budget = RENDER_LINES;
  return (
    <details className="oq-diff console-diff__file" open={lines <= OPEN_UNDER_LINES || undefined}>
      <summary className="oq-diff__header">
        <span className="oq-diff__path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        {file.status === "added" || file.status === "deleted" ? <span className="console-meta">{file.status}</span> : null}
        <span className="oq-diff__stat-add">+{file.additions}</span>
        <span className="oq-diff__stat-remove">−{file.deletions}</span>
      </summary>
      {file.binary ? (
        <p className="console-diff__note">Binary file, not shown.</p>
      ) : (
        <div className="oq-diff__body">
          <table className="oq-diff__table">
            <tbody>
              {file.hunks.map((hunk, h) => {
                if (budget <= 0) return null;
                const shown = hunk.lines.slice(0, budget);
                budget -= shown.length + 1;
                return [
                  <tr key={`h${h}`} className="oq-diff__row--hunk">
                    <td colSpan={3}>{hunk.header}</td>
                  </tr>,
                  ...shown.map((line, i) => (
                    <tr key={`h${h}l${i}`} className={line.kind === "add" ? "oq-diff__row--add" : line.kind === "remove" ? "oq-diff__row--remove" : undefined}>
                      <td className="oq-diff__num">{line.oldNumber ?? ""}</td>
                      <td className="oq-diff__num">{line.newNumber ?? ""}</td>
                      <td className="oq-diff__code">{line.text}</td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
          {budget <= 0 ? <p className="console-diff__note">Long file: the rest is on the branch.</p> : null}
        </div>
      )}
    </details>
  );
}
