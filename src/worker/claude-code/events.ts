import type { FileChangeKind, WorkerEvent, WorkerUsage } from "../adapter.js";
import { classifyCommand } from "../command-classification.js";
import { commandOutput } from "../codex/events.js";

export interface ClaudeCodeDiagnostic {
  kind:
    | "malformed_line"
    | "unknown_event_type"
    | "unknown_schema_version"
    | "output_regressed"
    | "api_retry"
    | "permission_denied"
    | "duplicate_result"
    | "auth_source_unreported";
  detail: string;
}

export interface ClaudeCodeNormalizerOptions {
  onDiagnostic?: (diagnostic: ClaudeCodeDiagnostic) => void;
}

const API_KEY_AUTH_SOURCE = "ANTHROPIC_API_KEY";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asTokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function normalizeClaudeUsage(raw: unknown): WorkerUsage | undefined {
  if (!isObject(raw)) return undefined;
  const input = asTokenCount(raw["input_tokens"]);
  const output = asTokenCount(raw["output_tokens"]);
  if (input === undefined || output === undefined) return undefined;
  const optionalCount = (key: string): number | null => {
    if (raw[key] === undefined || raw[key] === null) return 0;
    return asTokenCount(raw[key]) ?? null;
  };
  const cacheRead = optionalCount("cache_read_input_tokens");
  const cacheWrite = optionalCount("cache_creation_input_tokens");
  if (cacheRead === null || cacheWrite === null) return undefined;
  const inputTokens = input + cacheRead + cacheWrite;
  return {
    inputTokens,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    totalTokens: inputTokens + output,
  };
}

function mergeConservative(a: WorkerUsage, b: WorkerUsage): WorkerUsage {
  const merged: WorkerUsage = {};
  for (const key of ["inputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens", "cacheWriteInputTokens"] as const) {
    if (a[key] !== undefined || b[key] !== undefined) merged[key] = Math.max(a[key] ?? 0, b[key] ?? 0);
  }
  if (a.cachedInputTokens !== undefined && b.cachedInputTokens !== undefined) {
    merged.cachedInputTokens = Math.min(a.cachedInputTokens, b.cachedInputTokens);
  }
  return merged;
}

const FILE_TOOLS: Readonly<Record<string, FileChangeKind | undefined>> = {
  Edit: "update",
  MultiEdit: "update",
  NotebookEdit: "update",
  Write: undefined,
};

export class ClaudeCodeEventNormalizer {
  private readonly commands = new Map<string, { command: string; isTest: boolean }>();
  private terminated = false;
  verdict: { kind: "completed" } | { kind: "failed"; error: string } | undefined;
  usage: WorkerUsage | undefined;
  reportedCostUsd: number | undefined;
  sessionId: string | undefined;
  authRefused = false;

  constructor(private readonly options: ClaudeCodeNormalizerOptions = {}) {}

  normalize(raw: unknown): WorkerEvent[] {
    if (!isObject(raw)) {
      this.diagnose("malformed_line", "a stream line that is not a JSON object");
      return [];
    }
    const type = asString(raw["type"]);
    const subtype = asString(raw["subtype"]);
    switch (type) {
      case "system":
        return this.system(raw, subtype);
      case "assistant":
        return this.assistant(raw);
      case "user":
        return this.user(raw);
      case "result":
        return this.result(raw, subtype);
      case "permission_denied":
        this.diagnose("permission_denied", `a tool call was denied: ${JSON.stringify(raw).slice(0, 200)}`);
        return [];
      default:
        this.diagnose("unknown_event_type", `unknown stream-json type ${JSON.stringify(type ?? null)}`);
        return [];
    }
  }

  private system(raw: Json, subtype: string | undefined): WorkerEvent[] {
    if (subtype === "init") {
      const sessionId = asString(raw["session_id"]);
      if (sessionId) this.sessionId = sessionId;
      const started: WorkerEvent = { type: "started", ...(sessionId ? { sessionId } : {}) };
      const source = raw["apiKeySource"];
      if (source === undefined) {
        this.diagnose("auth_source_unreported", "system/init reported no apiKeySource; the turn proceeds on the brokered key");
        return [started];
      }
      if (source !== API_KEY_AUTH_SOURCE) {
        this.authRefused = true;
        const failed = this.fail(
          `Claude Code reported auth source ${JSON.stringify(source)}; Windkeel drives it with an API ` +
            `key only (${API_KEY_AUTH_SOURCE}), never a claude.ai login or OAuth token (ADR-0027 §5)`,
        );
        return failed ? [started, failed] : [started];
      }
      return [started];
    }
    if (subtype === "api_retry") {
      this.diagnose(
        "api_retry",
        `the model API call is being retried (attempt ${asNumber(raw["attempt"]) ?? "?"}` +
          `${raw["error_status"] !== undefined ? `, status ${String(raw["error_status"])}` : ""})`,
      );
      return [];
    }
    if (subtype === "permission_denied") {
      this.diagnose("permission_denied", `a tool call was denied: ${JSON.stringify(raw).slice(0, 200)}`);
      return [];
    }
    this.diagnose("unknown_event_type", `unknown system subtype ${JSON.stringify(subtype ?? null)}`);
    return [];
  }

  private assistant(raw: Json): WorkerEvent[] {
    const message = raw["message"];
    const content = isObject(message) && Array.isArray(message["content"]) ? message["content"] : [];
    const events: WorkerEvent[] = [];
    for (const block of content) {
      if (!isObject(block)) continue;
      const kind = asString(block["type"]);
      if (kind === "text") {
        const text = asString(block["text"]);
        if (text) events.push({ type: "message", text });
      } else if (kind === "thinking") {
        const text = asString(block["thinking"]);
        if (text) events.push({ type: "thinking", text });
      } else if (kind === "tool_use") {
        events.push(...this.toolUse(block));
      }
    }
    return events;
  }

  private toolUse(block: Json): WorkerEvent[] {
    const name = asString(block["name"]);
    const id = asString(block["id"]);
    const input = isObject(block["input"]) ? block["input"] : {};
    if (name === "Bash") {
      const command = asString(input["command"]);
      if (!command) return [];
      const isTest = classifyCommand(command).isTest;
      if (id) this.commands.set(id, { command, isTest });
      return [{ type: isTest ? "test_started" : "command_started", command }];
    }
    if (name !== undefined && Object.hasOwn(FILE_TOOLS, name)) {
      const path = asString(input["file_path"]) ?? asString(input["notebook_path"]);
      if (!path) return [];
      const kind = FILE_TOOLS[name];
      return [{ type: "file_changed", path, ...(kind ? { kind } : {}) }];
    }
    return [];
  }

  private user(raw: Json): WorkerEvent[] {
    const message = raw["message"];
    const content = isObject(message) && Array.isArray(message["content"]) ? message["content"] : [];
    const events: WorkerEvent[] = [];
    for (const block of content) {
      if (!isObject(block) || block["type"] !== "tool_result") continue;
      const id = asString(block["tool_use_id"]);
      const command = id ? this.commands.get(id) : undefined;
      if (!command || !id) continue;
      this.commands.delete(id);
      const text = toolResultText(block["content"]);
      const isError = block["is_error"] === true;
      const exitCode = isError ? Number(/Exit code (\d+)/.exec(text ?? "")?.[1] ?? 1) : 0;
      const output = commandOutput(text);
      if (command.isTest) {
        events.push({
          type: "test_finished",
          command: command.command,
          exitCode,
          ...(output !== undefined ? { output } : {}),
          passed: exitCode === 0,
        });
      } else {
        events.push({ type: "command_finished", command: command.command, exitCode, ...(output !== undefined ? { output } : {}) });
      }
    }
    return events;
  }

  private result(raw: Json, subtype: string | undefined): WorkerEvent[] {
    const sessionId = asString(raw["session_id"]);
    if (sessionId && !this.sessionId) this.sessionId = sessionId;
    const usage = normalizeClaudeUsage(raw["usage"]);
    if (usage) this.usage = this.usage ? mergeConservative(this.usage, usage) : usage;
    const cost = asNumber(raw["total_cost_usd"]);
    if (cost !== undefined && cost >= 0) this.reportedCostUsd = Math.max(this.reportedCostUsd ?? 0, cost);

    const ok = subtype === "success" && raw["is_error"] !== true;
    const error = ok
      ? undefined
      : `Claude Code ended the turn with ${subtype ?? "no subtype"}` +
        `${raw["is_error"] === true ? " (is_error)" : ""}` +
        `${asString(raw["result"]) ? `: ${asString(raw["result"])!.slice(0, 500)}` : ""}`;

    if (this.terminated) {
      this.diagnose("duplicate_result", "a second `result` line in one turn; it is not a second verdict");
      if (error !== undefined && this.verdict?.kind !== "failed") this.verdict = { kind: "failed", error };
      return [];
    }
    if (error !== undefined) {
      const failed = this.fail(error);
      return failed ? [failed] : [];
    }
    this.terminated = true;
    this.verdict = { kind: "completed" };
    return [{ type: "completed", ...(this.usage ? { usage: this.usage } : {}) }];
  }

  private fail(error: string): WorkerEvent | null {
    if (this.verdict?.kind !== "failed") this.verdict = { kind: "failed", error };
    if (this.terminated) return null;
    this.terminated = true;
    return { type: "failed", error };
  }

  private diagnose(kind: ClaudeCodeDiagnostic["kind"], detail: string): void {
    this.options.onDiagnostic?.({ kind, detail });
  }
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => (isObject(part) && typeof part["text"] === "string" ? [part["text"]] : []));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function normalizeClaudeCodeLine(
  normalizer: ClaudeCodeEventNormalizer,
  line: string,
  onDiagnostic?: (diagnostic: ClaudeCodeDiagnostic) => void,
): WorkerEvent[] {
  const trimmed = line.trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    onDiagnostic?.({ kind: "malformed_line", detail: `unparseable JSONL line (${trimmed.length} chars): ${trimmed.slice(0, 200)}` });
    return [];
  }
  return normalizer.normalize(parsed);
}
