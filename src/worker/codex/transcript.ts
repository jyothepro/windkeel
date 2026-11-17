import type { WorkerEvent, WorkerUsage } from "../adapter.js";
import { CodexEventNormalizer, normalizeCodexLine, type CodexDiagnostic } from "./events.js";

const CREDENTIAL_PATTERNS: Array<[string, RegExp]> = [
  ["model key (sk-…)", /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9][A-Za-z0-9_-]{15,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["Slack token", /\bxox[a-z]-[A-Za-z0-9-]{10,}/],
  ["Windkeel or Linear token", /\b(?:orq|lin)_[A-Za-z0-9_-]{16,}/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["bearer credential", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export interface CredentialFinding {
  line: number;
  kind: string;
}

export function findCredentials(text: string): CredentialFinding[] {
  const findings: CredentialFinding[] = [];
  text.split("\n").forEach((line, index) => {
    for (const [kind, pattern] of CREDENTIAL_PATTERNS) {
      if (pattern.test(line)) findings.push({ line: index + 1, kind });
    }
  });
  return findings;
}

export interface TranscriptAudit {
  events: WorkerEvent[];
  diagnostics: CodexDiagnostic[];
  unexpectedDiagnostics: CodexDiagnostic[];
  truncatedTail: boolean;
  rawFinalUsage: Record<string, unknown> | null;
  finalUsage: WorkerUsage | null;
  ending: "completed" | "failed" | "none";
  itemKinds: string[];
  eventTypes: string[];
  credentials: CredentialFinding[];
}

export function auditCodexTranscript(text: string): TranscriptAudit {
  const diagnostics: CodexDiagnostic[] = [];
  const onDiagnostic = (d: CodexDiagnostic) => diagnostics.push(d);
  const normalizer = new CodexEventNormalizer({ onDiagnostic });
  const lines = text.split("\n");
  const lastIndex = lines.map((l) => l.trim() !== "").lastIndexOf(true);

  const events: WorkerEvent[] = [];
  const itemKinds = new Set<string>();
  const eventTypes = new Set<string>();
  let rawFinalUsage: Record<string, unknown> | null = null;
  let truncatedTail = false;
  let tornLineDiagnostic: CodexDiagnostic | null = null;

  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (index === lastIndex) truncatedTail = true;
    }
    if (parsed && typeof parsed === "object") {
      const raw = parsed as Record<string, unknown>;
      if (typeof raw["type"] === "string") eventTypes.add(raw["type"]);
      const item = raw["item"] as Record<string, unknown> | undefined;
      const kind = item && (typeof item["item_type"] === "string" ? item["item_type"] : item["type"]);
      if (typeof kind === "string") itemKinds.add(kind);
      if (raw["type"] === "turn.completed" && raw["usage"] && typeof raw["usage"] === "object") {
        rawFinalUsage = raw["usage"] as Record<string, unknown>;
      }
    }
    const before = diagnostics.length;
    events.push(...normalizeCodexLine(normalizer, line, onDiagnostic));
    if (index === lastIndex && truncatedTail && diagnostics.length > before) tornLineDiagnostic = diagnostics.at(-1)!;
  });

  const last = [...events].reverse().find((e) => e.type === "completed" || e.type === "failed");
  const completed = [...events].reverse().find((e) => e.type === "completed");
  return {
    events,
    diagnostics,
    unexpectedDiagnostics: diagnostics.filter((d) => d !== tornLineDiagnostic),
    truncatedTail,
    rawFinalUsage,
    finalUsage: completed?.type === "completed" ? (completed.usage ?? null) : null,
    ending: last?.type === "completed" ? "completed" : last?.type === "failed" ? "failed" : "none",
    itemKinds: [...itemKinds].sort(),
    eventTypes: [...eventTypes].sort(),
    credentials: findCredentials(text),
  };
}
