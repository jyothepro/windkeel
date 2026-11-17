import type { Pool } from "pg";
import { listWorkspaces } from "./repositories.js";
import { selectRunSnapshot } from "./stores/run-store.js";
import { TERMINAL_STATES } from "./run-state-machine.js";
import type { SandboxHandle, SandboxProvider } from "../sandbox/provider.js";

export const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;

const MAX_WORKSPACE_ENTRIES = 1000;

const MAX_PATH_LENGTH = 1024;

const TURN_RUNNING_STATES: ReadonlySet<string> = new Set(["IMPLEMENTING", "REPAIRING"]);

const BEFORE_WORKSPACE: ReadonlySet<string> = new Set([
  "CREATED",
  "CLASSIFYING",
  "PLANNING",
  "WAITING_FOR_APPROVAL",
  "PROVISIONING",
]);

export type WorkspaceEntryType = "file" | "directory" | "symlink" | "other";

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: WorkspaceEntryType;
  bytes: number | null;
}

export type WorkspaceRead =
  | { kind: "directory"; path: string; entries: WorkspaceEntry[]; truncated: boolean }
  | { kind: "file"; path: string; bytes: number; content: string }
  | { kind: "unavailable"; code: WorkspaceUnavailableCode; reason: string }
  | { kind: "refused"; status: 400 | 404 | 413 | 415; code: WorkspaceRefusalCode; reason: string; bytes?: number; cap?: number };

export type WorkspaceUnavailableCode =
  | "run_terminal"
  | "turn_running"
  | "no_workspace"
  | "workspace_gone"
  | "workspace_unreachable";

export type WorkspaceRefusalCode =
  | "invalid_path"
  | "path_escapes"
  | "not_found"
  | "not_a_file"
  | "file_too_large"
  | "binary_file";

export function workspacePath(raw: string | undefined): { path: string } | { refused: string } {
  const value = raw ?? "";
  if (value.length > MAX_PATH_LENGTH) return { refused: `path is longer than ${MAX_PATH_LENGTH} characters` };
  if (/[\u0000-\u001f\u007f]/.test(value)) return { refused: "path may not contain control characters" };
  if (value.includes("\\")) return { refused: "path may not contain a backslash; use '/'" };
  if (value.startsWith("/") || value.startsWith("~")) {
    return { refused: "path must be relative to the workspace root, not absolute" };
  }
  const segments = value.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return { refused: "path may not contain '..'" };
  if (segments[0] === ".git") return { refused: "the repository's .git directory is not part of the workspace view" };
  return { path: segments.join("/") };
}

const READ_SCRIPT = [
  'root=$(realpath -- "$WINDKEEL_ROOT" 2>/dev/null) || exit 10',
  'if [ -z "$WINDKEEL_REL" ]; then target=$root; else',
  '  p="$root/$WINDKEEL_REL"',
  '  if [ ! -e "$p" ]; then if [ -L "$p" ]; then exit 12; fi; exit 11; fi',
  '  target=$(realpath -- "$p" 2>/dev/null) || exit 11',
  "fi",
  'case "$target" in "$root"|"$root"/*) ;; *) exit 12 ;; esac',
  'case "$target/" in "$root/.git/"*) exit 13 ;; esac',
  'if [ -d "$target" ]; then',
  "  printf 'dir\\0'",
  "  n=0",
  '  for f in "$target"/* "$target"/.[!.]* "$target"/..?*; do',
  '    if [ ! -e "$f" ] && [ ! -L "$f" ]; then continue; fi',
  '    n=$((n + 1)); if [ "$n" -gt "$WINDKEEL_MAX_ENTRIES" ]; then printf "more\\0"; exit 0; fi',
  "    s=0",
  '    if [ -L "$f" ]; then t=l; elif [ -d "$f" ]; then t=d; elif [ -f "$f" ]; then t=f; s=$(wc -c < "$f"); else t=o; fi',
  "    printf '%s\\t%s\\t%s\\0' \"$t\" \"$s\" \"${f##*/}\"",
  "  done",
  "  exit 0",
  "fi",
  '[ -f "$target" ] || exit 14',
  's=$(wc -c < "$target")',
  "printf 'file\\0%s\\0' \"$s\"",
  'if [ "$s" -gt "$WINDKEEL_MAX_BYTES" ]; then exit 0; fi',
  'head -c "$((WINDKEEL_MAX_BYTES + 1))" < "$target" | base64 | tr -d "\\n"',
].join("\n");

export interface ReadWorkspaceOptions {
  pool: Pool;
  runId: string;
  runStatus: string;
  path: string | undefined;
  providers: Record<string, SandboxProvider>;
  maxBytes?: number;
  maxEntries?: number;
}

export async function readWorkspace(options: ReadWorkspaceOptions): Promise<WorkspaceRead> {
  const { pool, runId, runStatus } = options;
  const parsed = workspacePath(options.path);
  if ("refused" in parsed) return { kind: "refused", status: 400, code: "invalid_path", reason: parsed.refused };

  const refusedByState = stateRefusal(runStatus);
  if (refusedByState) return refusedByState;

  const maker = (await listWorkspaces(pool, runId)).find((w) => w.role === "maker");
  if (!maker) return unavailable("no_workspace", "this run has no maker workspace recorded");
  if (maker.status !== "ready" || !maker.providerHandle) {
    return unavailable("workspace_gone", `the maker workspace is ${maker.status}; there is no sandbox to read`);
  }
  const provider = options.providers[maker.sandboxProvider];
  if (!provider) {
    return unavailable(
      "workspace_unreachable",
      `the maker workspace was made by the "${maker.sandboxProvider}" provider, which this deployment doesn't reach`,
    );
  }
  if (!provider.capabilities.reattachable) {
    return unavailable("workspace_unreachable", `the "${maker.sandboxProvider}" provider can't reattach to a sandbox from another process`);
  }

  let handle: SandboxHandle;
  try {
    handle = await provider.attach({ role: "maker", handleId: maker.providerHandle });
  } catch (error) {
    return unavailable(
      "workspace_gone",
      `couldn't attach to the maker sandbox: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const before = await runSnapshot(pool, runId);
  if (!before) return unavailable("no_workspace", "the run is gone");
  const refusedBefore = stateRefusal(before.status);
  if (refusedBefore) return refusedBefore;

  let read: WorkspaceRead;
  try {
    read = await readThrough(handle, parsed.path, options.maxBytes ?? MAX_WORKSPACE_FILE_BYTES, options.maxEntries ?? MAX_WORKSPACE_ENTRIES);
  } catch (error) {
    const moved = await movedDuringRead(pool, runId, before);
    if (moved) return moved;
    throw error;
  }
  return (await movedDuringRead(pool, runId, before)) ?? read;
}

function unavailable(code: WorkspaceUnavailableCode, reason: string): WorkspaceRead {
  return { kind: "unavailable", code, reason };
}

function stateRefusal(runStatus: string): WorkspaceRead | null {
  if (TERMINAL_STATES.has(runStatus as never)) {
    return unavailable("run_terminal", `run is ${runStatus}; its maker sandbox is torn down when a run ends (ADR-0017)`);
  }
  if (TURN_RUNNING_STATES.has(runStatus)) {
    return unavailable(
      "turn_running",
      `run is ${runStatus}: the agent is mid-turn and the tree is changing under it. The workspace is readable between turns`,
    );
  }
  if (BEFORE_WORKSPACE.has(runStatus)) {
    return unavailable("no_workspace", `run is ${runStatus}; no maker sandbox has been made yet`);
  }
  return null;
}

interface RunSnapshot {
  status: string;
  marker: string | null;
}

async function runSnapshot(pool: Pool, runId: string): Promise<RunSnapshot | null> {
  const row = await selectRunSnapshot(pool, runId);
  return row ? { status: row.status, marker: row.marker } : null;
}

async function movedDuringRead(pool: Pool, runId: string, before: RunSnapshot): Promise<WorkspaceRead | null> {
  const after = await runSnapshot(pool, runId);
  if (!after) return unavailable("no_workspace", "the run is gone");
  const refused = stateRefusal(after.status);
  if (refused) return refused;
  if (after.status !== before.status || after.marker !== before.marker) {
    return unavailable(
      "turn_running",
      `the run moved (${before.status} → ${after.status}) while the workspace was being read, so the tree may have changed under the read; its result was discarded. Try again`,
    );
  }
  return null;
}

export async function readThrough(handle: SandboxHandle, path: string, maxBytes: number, maxEntries: number): Promise<WorkspaceRead> {
  const result = await handle.exec("sh", {
    args: ["-c", READ_SCRIPT],
    cwd: "/",
    env: {
      WINDKEEL_ROOT: handle.checkoutPath,
      WINDKEEL_REL: path,
      WINDKEEL_MAX_BYTES: String(maxBytes),
      WINDKEEL_MAX_ENTRIES: String(maxEntries),
    },
    maxBuffer: Math.ceil((maxBytes + 1) * 1.4) + 4 * 1024 * 1024,
  });
  const shown = path === "" ? "the workspace root" : path;
  switch (result.status) {
    case 0:
      break;
    case 10:
      return { kind: "unavailable", code: "workspace_gone", reason: "the checkout is gone from the maker sandbox" };
    case 11:
      return { kind: "refused", status: 404, code: "not_found", reason: `${shown}: no such file or directory in the workspace` };
    case 12:
      return { kind: "refused", status: 400, code: "path_escapes", reason: `${shown} resolves outside the workspace (a symlink); it is not followed` };
    case 13:
      return { kind: "refused", status: 400, code: "invalid_path", reason: `${shown} resolves into .git, which is not part of the workspace view` };
    case 14:
      return { kind: "refused", status: 400, code: "not_a_file", reason: `${shown} is not a regular file or directory` };
    default:
      throw new Error(
        `workspace read failed in the maker sandbox (exit ${result.status ?? "none"}${result.error ? `: ${result.error}` : ""})`,
      );
  }

  const fields = result.stdout.split("\0");
  if (fields[0] === "dir") return { kind: "directory", path, ...parseEntries(path, fields.slice(1)) };
  if (fields[0] !== "file") throw new Error("workspace read answered in a shape it never produces");

  const bytes = Number.parseInt((fields[1] ?? "").trim(), 10);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("workspace read answered with no file size");
  const tooLarge = (size: number): WorkspaceRead => ({
    kind: "refused",
    status: 413,
    code: "file_too_large",
    reason: `${shown} is ${size.toLocaleString("en-US")} bytes; the workspace view reads files up to ${maxBytes.toLocaleString("en-US")} bytes`,
    bytes: size,
    cap: maxBytes,
  });
  if (bytes > maxBytes) return tooLarge(bytes);

  const data = Buffer.from(fields.slice(2).join(""), "base64");
  if (data.length > maxBytes) return tooLarge(data.length);
  const content = utf8Text(data);
  if (content === null) {
    return {
      kind: "refused",
      status: 415,
      code: "binary_file",
      reason: `binary, ${data.length.toLocaleString("en-US")} bytes`,
      bytes: data.length,
    };
  }
  return { kind: "file", path, bytes: data.length, content };
}

export function utf8Text(data: Buffer): string | null {
  if (data.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
  } catch {
    return null;
  }
}

const TYPES: Record<string, WorkspaceEntryType> = { f: "file", d: "directory", l: "symlink", o: "other" };

export function parseEntries(dir: string, records: string[]): { entries: WorkspaceEntry[]; truncated: boolean } {
  let truncated = false;
  const entries: WorkspaceEntry[] = [];
  for (const record of records) {
    if (record === "") continue;
    if (record === "more") {
      truncated = true;
      continue;
    }
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const type = TYPES[record.slice(0, first)];
    const size = Number.parseInt(record.slice(first + 1, second).trim(), 10);
    const name = record.slice(second + 1);
    if (!type || !Number.isSafeInteger(size) || size < 0) continue;
    if (name === "" || name === "." || name === ".." || name.includes("/")) continue;
    if (dir === "" && name === ".git") continue;
    entries.push({ name, path: dir === "" ? name : `${dir}/${name}`, type, bytes: type === "file" ? size : null });
  }
  entries.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries, truncated };
}
