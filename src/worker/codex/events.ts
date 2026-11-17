import type { FileChangeKind, WorkerEvent, WorkerUsage } from "../adapter.js";
import { classifyCommand } from "../command-classification.js";

const CODEX_KNOWN_SCHEMA_VERSIONS = ["1"];

export interface CodexDiagnostic {
  kind:
    | "malformed_line"
    | "unknown_event_type"
    | "unknown_item_type"
    | "unknown_schema_version"
    | "output_regressed"
    | "recovered_error";
  detail: string;
}

export interface CodexNormalizerOptions {
  onDiagnostic?: (diagnostic: CodexDiagnostic) => void;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function itemType(item: Json): string | undefined {
  return asString(item.item_type) ?? asString(item.type);
}

function itemCommand(item: Json): string | undefined {
  return asString(item.command) ?? asString(item.cmd);
}

const asTokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function normalizeUsage(raw: unknown): WorkerUsage | undefined {
  if (!isObject(raw)) return undefined;
  const usage: WorkerUsage = {};
  const input = asTokenCount(raw.input_tokens);
  const cached = asTokenCount(raw.cached_input_tokens);
  const output = asTokenCount(raw.output_tokens);
  const reasoning = asTokenCount(raw.reasoning_output_tokens);
  if (input !== undefined) usage.inputTokens = input;
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (output !== undefined) usage.outputTokens = output;
  if (reasoning !== undefined) usage.reasoningOutputTokens = reasoning;
  const total =
    asTokenCount(raw.total_tokens) ??
    (usage.inputTokens !== undefined || usage.outputTokens !== undefined
      ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      : undefined);
  if (total !== undefined) usage.totalTokens = total;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export const COMMAND_OUTPUT_LIMIT = 4000;

const OUTPUT_CUT = "… (earlier output cut)\n";

export function commandOutput(raw: unknown): string | undefined {
  const text = asString(raw);
  if (text === undefined || text === "") return undefined;
  if (text.length <= COMMAND_OUTPUT_LIMIT) return text;
  return OUTPUT_CUT + text.slice(text.length - (COMMAND_OUTPUT_LIMIT - OUTPUT_CUT.length));
}

const FILE_CHANGE_KINDS = new Set<FileChangeKind>(["add", "update", "delete"]);

function fileChangeKind(raw: unknown): FileChangeKind | undefined {
  const value = asString(raw);
  if (value === "modify" || value === "modified") return "update";
  if (value === "created") return "add";
  if (value === "deleted") return "delete";
  return value !== undefined && FILE_CHANGE_KINDS.has(value as FileChangeKind)
    ? (value as FileChangeKind)
    : undefined;
}

export class CodexEventNormalizer {
  private readonly onDiagnostic: ((diagnostic: CodexDiagnostic) => void) | undefined;
  private startedEmitted = false;
  private readonly commandsByItemId = new Map<string, string>();
  private readonly testItemIds = new Set<string>();

  constructor(options: CodexNormalizerOptions = {}) {
    this.onDiagnostic = options.onDiagnostic;
  }

  normalize(raw: unknown): WorkerEvent[] {
    if (!isObject(raw)) {
      this.report("malformed_line", `expected a JSON object, got ${typeof raw}`);
      return [];
    }
    const type = asString(raw.type);
    switch (type) {
      case "thread.started": {
        this.checkSchemaVersion(raw);
        const sessionId = asString(raw.thread_id) ?? asString(raw.session_id) ?? asString(raw.id);
        this.startedEmitted = true;
        return [{ type: "started", ...(sessionId ? { sessionId } : {}) }];
      }
      case "turn.started": {
        if (this.startedEmitted) return [];
        this.startedEmitted = true;
        return [{ type: "started" }];
      }
      case "turn.completed": {
        const usage = normalizeUsage(raw.usage);
        return [{ type: "completed", ...(usage ? { usage } : {}) }];
      }
      case "turn.failed":
        return [{ type: "failed", error: this.errorText(raw) }];
      case "error":
        return [{ type: "failed", error: this.errorText(raw) }];
      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.normalizeItem(type, raw);
      default:
        this.report("unknown_event_type", `ignored event type ${JSON.stringify(type)}`);
        return [];
    }
  }

  private normalizeItem(eventType: string, raw: Json): WorkerEvent[] {
    const item = isObject(raw.item) ? raw.item : isObject(raw.data) ? raw.data : undefined;
    if (!item) {
      this.report("malformed_line", `${eventType} carried no item payload`);
      return [];
    }
    const kind = itemType(item);
    const id = asString(item.id) ?? "";

    switch (kind) {
      case "reasoning":
        return eventType === "item.completed" && asString(item.text)
          ? [{ type: "thinking", text: asString(item.text) as string }]
          : [];

      case "assistant_message":
        return eventType === "item.completed" && asString(item.text)
          ? [{ type: "message", text: asString(item.text) as string }]
          : [];

      case "command_execution":
        return this.normalizeCommand(eventType, item, id);

      case "file_change":
        return eventType === "item.completed" ? this.normalizeFileChange(item) : [];

      case "mcp_tool_call":
      case "web_search":
        return [];

      default:
        this.report("unknown_item_type", `ignored item type ${JSON.stringify(kind)}`);
        return [];
    }
  }

  private normalizeCommand(eventType: string, item: Json, id: string): WorkerEvent[] {
    const command = itemCommand(item) ?? this.commandsByItemId.get(id);
    if (command === undefined) {
      this.report("malformed_line", `command_execution item ${id || "(no id)"} carried no command`);
      return [];
    }

    if (eventType === "item.started") {
      if (id) this.commandsByItemId.set(id, command);
      if (classifyCommand(command).isTest) {
        if (id) this.testItemIds.add(id);
        return [{ type: "test_started", command }];
      }
      return [{ type: "command_started", command }];
    }

    if (eventType === "item.completed") {
      const exitCode = asNumber(item.exit_code) ?? null;
      const wasTest =
        id && this.commandsByItemId.has(id)
          ? this.testItemIds.has(id)
          : classifyCommand(command).isTest;
      if (id) {
        this.commandsByItemId.delete(id);
        this.testItemIds.delete(id);
      }
      const output = commandOutput(item.aggregated_output);
      const printed = output === undefined ? {} : { output };
      return wasTest
        ? [{ type: "test_finished", command, exitCode, passed: exitCode === 0, ...printed }]
        : [{ type: "command_finished", command, exitCode, ...printed }];
    }

    return [];
  }

  private normalizeFileChange(item: Json): WorkerEvent[] {
    const changes = Array.isArray(item.changes) ? item.changes : undefined;
    if (changes) {
      return changes.flatMap((change) => {
        if (!isObject(change)) return [];
        const path = asString(change.path);
        if (!path) return [];
        const kind = fileChangeKind(change.kind);
        return [{ type: "file_changed" as const, path, ...(kind ? { kind } : {}) }];
      });
    }
    const path = asString(item.path);
    if (!path) {
      this.report("malformed_line", "file_change item carried neither `changes` nor `path`");
      return [];
    }
    const kind = fileChangeKind(item.kind);
    return [{ type: "file_changed", path, ...(kind ? { kind } : {}) }];
  }

  private errorText(raw: Json): string {
    const error = raw.error;
    if (typeof error === "string") return error;
    if (isObject(error)) {
      return asString(error.message) ?? JSON.stringify(error);
    }
    return asString(raw.message) ?? "codex reported a failure with no message";
  }

  private checkSchemaVersion(raw: Json): void {
    const version = asString(raw.schema_version) ?? asString(raw.version);
    if (version !== undefined && !CODEX_KNOWN_SCHEMA_VERSIONS.includes(version)) {
      this.report(
        "unknown_schema_version",
        `stream reports schema version ${version}, known: ${CODEX_KNOWN_SCHEMA_VERSIONS.join(", ")}`,
      );
    }
  }

  private report(kind: CodexDiagnostic["kind"], detail: string): void {
    this.onDiagnostic?.({ kind, detail });
  }
}

export function normalizeCodexLine(
  normalizer: CodexEventNormalizer,
  line: string,
  onDiagnostic?: (diagnostic: CodexDiagnostic) => void,
): WorkerEvent[] {
  const trimmed = line.trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    onDiagnostic?.({
      kind: "malformed_line",
      detail: `unparseable JSONL line (${trimmed.length} chars): ${trimmed.slice(0, 200)}`,
    });
    return [];
  }
  return normalizer.normalize(parsed);
}

export async function* normalizeCodexStream(
  lines: AsyncIterable<string>,
  options: CodexNormalizerOptions = {},
): AsyncIterable<WorkerEvent> {
  const normalizer = new CodexEventNormalizer(options);
  for await (const line of lines) {
    for (const event of normalizeCodexLine(normalizer, line, options.onDiagnostic)) {
      yield event;
    }
  }
}
