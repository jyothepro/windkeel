import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EVIDENCE_STAGES = ["checks", "review", "intent", "security", "browser"] as const;
export type EvidenceStage = (typeof EVIDENCE_STAGES)[number];

export type EvidenceStatus = "passed" | "warning" | "failed" | "completed_with_findings" | "skipped";

const STATUSES: ReadonlySet<string> = new Set(["passed", "warning", "failed", "completed_with_findings", "skipped"]);

export interface EvidenceItemRecord {
  id: string;
  stage: EvidenceStage;
  type: string;
  status: EvidenceStatus;
  summary: string | null;
}

export interface StageResultRecord {
  stage: EvidenceStage;
  status: EvidenceStatus;
  items: EvidenceItemRecord[];
}

const SUMMARY_LIMIT = 300;

const SEVERITY: EvidenceStatus[] = ["failed", "warning", "completed_with_findings", "passed", "skipped"];

export function evidenceItemsFromPackage(packageDir: string): EvidenceItemRecord[] {
  const items = evidenceDirItems(packageDir);
  if (!items.some((i) => i.stage === "intent")) {
    const intent = intentItemFromMapping(packageDir);
    if (intent) items.push(intent);
  }
  return items;
}

function intentItemFromMapping(packageDir: string): EvidenceItemRecord | null {
  const path = join(packageDir, "mapping.json");
  if (!existsSync(path)) return null;
  let mapping: { status?: unknown; reason?: unknown; mappings?: unknown };
  try {
    mapping = JSON.parse(readFileSync(path, "utf8")) as typeof mapping;
  } catch {
    return null;
  }
  const base = { id: "mapping", stage: "intent" as const, type: "criteria_mapping" };
  if (mapping.status === "skipped") {
    return { ...base, status: "skipped", summary: typeof mapping.reason === "string" ? mapping.reason : null };
  }
  const entries = Array.isArray(mapping.mappings) ? (mapping.mappings as Array<{ status?: unknown }>) : [];
  const count = (status: string) => entries.filter((m) => m.status === status).length;
  const [satisfied, unsatisfied, unknown] = [count("satisfied"), count("unsatisfied"), count("unknown")];
  const summary = [
    `${satisfied} of ${entries.length} criteria met`,
    unsatisfied ? `${unsatisfied} not met` : "",
    unknown ? `${unknown} the evidence could not settle` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return { ...base, status: unsatisfied ? "failed" : unknown ? "warning" : "passed", summary };
}

function evidenceDirItems(packageDir: string): EvidenceItemRecord[] {
  const dir = join(packageDir, "evidence");
  if (!existsSync(dir)) return [];
  const items: EvidenceItemRecord[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const item = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
      const record = toRecord(item);
      if (record) items.push(record);
    } catch {
    }
  }
  return items;
}

function toRecord(item: Record<string, unknown>): EvidenceItemRecord | null {
  const stage = item["stage"];
  const status = item["status"];
  if (typeof stage !== "string" || !(EVIDENCE_STAGES as readonly string[]).includes(stage)) return null;
  if (typeof status !== "string" || !STATUSES.has(status)) return null;
  const text = typeof item["summary"] === "string" ? item["summary"] : typeof item["reason"] === "string" ? item["reason"] : null;
  return {
    id: typeof item["id"] === "string" ? item["id"] : "",
    stage: stage as EvidenceStage,
    type: typeof item["type"] === "string" ? item["type"] : "",
    status: status as EvidenceStatus,
    summary: text === null ? null : text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 1)}…` : text,
  };
}

export function stageResults(items: readonly EvidenceItemRecord[]): StageResultRecord[] {
  return EVIDENCE_STAGES.flatMap((stage) => {
    const mine = items.filter((i) => i.stage === stage);
    if (mine.length === 0) return [];
    const status = SEVERITY.find((s) => mine.some((i) => i.status === s)) ?? "skipped";
    return [{ stage, status, items: mine }];
  });
}

export function evidenceItemsOf(riskSummary: unknown): EvidenceItemRecord[] | null {
  if (!riskSummary || typeof riskSummary !== "object") return null;
  const raw = (riskSummary as Record<string, unknown>)["evidence"];
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((item) => {
    const record = item && typeof item === "object" ? toRecord(item as Record<string, unknown>) : null;
    return record ? [record] : [];
  });
}
