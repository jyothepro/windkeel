export function crumbs(path: string): Array<{ label: string; path: string }> {
  const parts = path.split("/").filter(Boolean);
  return [{ label: "workspace", path: "" }, ...parts.map((label, i) => ({ label, path: parts.slice(0, i + 1).join("/") }))];
}

export function parentOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).join("/");
}

export const VIEW_LINES = 5000;

export function numberedLines(content: string, max = VIEW_LINES): { lines: string[]; total: number; cut: boolean } {
  const all = content.split(/\r?\n/);
  if (all.length > 1 && all.at(-1) === "") all.pop();
  return { lines: all.slice(0, max), total: all.length, cut: all.length > max };
}

export function sizeLabel(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function refusalText(code: string, message: string): string {
  switch (code) {
    case "turn_running":
      return "Windkeel is mid-turn, so the files are changing under it. They're readable between turns: when this turn ends, or while the change is being verified.";
    case "run_terminal":
      return "This run has ended and its maker sandbox is gone. The change itself is under Changes and on the branch.";
    case "no_workspace":
      return "There's no maker workspace yet: Windkeel hasn't started working on this run.";
    case "workspace_gone":
      return "The maker sandbox is gone, so there are no files to read. The change itself is under Changes and on the branch.";
    case "no_route":
      return "This control plane doesn't serve the workspace yet.";
    case "path_escapes":
      return "That path leads outside the workspace (a symlink), so it isn't followed.";
    case "binary_file":
      return `Not shown: ${message}.`;
    default:
      return message;
  }
}
