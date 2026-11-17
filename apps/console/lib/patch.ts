export type LineKind = "add" | "remove" | "context";

export interface PatchLine {
  kind: LineKind;
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
}

export interface PatchHunk {
  header: string;
  lines: PatchLine[];
}

export interface PatchFile {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "renamed" | "modified";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: PatchHunk[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const stripPrefix = (p: string) => p.replace(/^[ab]\//, "");

export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunk: PatchHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      file = { path: match?.[2] ?? raw.slice(11), oldPath: null, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (raw.startsWith("new file mode")) file.status = "added";
      else if (raw.startsWith("deleted file mode")) file.status = "deleted";
      else if (raw.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = raw.slice("rename from ".length);
      } else if (raw.startsWith("rename to ")) file.path = raw.slice("rename to ".length);
      else if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) file.binary = true;
      else if (raw.startsWith("+++ ") && raw !== "+++ /dev/null") file.path = stripPrefix(raw.slice(4));
    }
    const header = HUNK.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", oldNumber: null, newNumber: newLine++, text: raw.slice(1) });
      file.additions++;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "remove", oldNumber: oldLine++, newNumber: null, text: raw.slice(1) });
      file.deletions++;
    } else if (raw.startsWith(" ") || raw === "") {
      if (raw === "") continue;
      hunk.lines.push({ kind: "context", oldNumber: oldLine++, newNumber: newLine++, text: raw.slice(1) });
    } else {
      hunk.lines.push({ kind: "context", oldNumber: null, newNumber: null, text: raw });
    }
  }
  return files;
}
