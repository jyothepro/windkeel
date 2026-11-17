export const EVIDENCE_FORMAT = "dev.orqon.evidence/v0";
export const PREDICATE_TYPE = "https://orqon.dev/evidence/v0";
export const VERDICT_RULE =
  "fail iff any blocking finding OR any unsatisfied criterion; else warn iff any warning-status evidence, non-blocking finding, or criterion the evidence could not settle; else pass";

export type Verdict = "pass" | "warn" | "fail";

export type Stage = "checks" | "review" | "intent" | "security" | "browser";

export type EvidenceStatus =
  | "passed"
  | "warning"
  | "failed"
  | "completed_with_findings"
  | "skipped";

export type FindingSeverity = "blocking" | "non_blocking";

export interface Finding {
  id: string;
  severity: FindingSeverity;
  category: string;
  claim: string;
  location?: string;
  failure_scenario?: string;
}

export interface Reviewer {
  model: string;
  vendor: string;
  independence: {
    different_vendor_than_author: boolean;
    author_vendor: string | null;
    clean_context: boolean;
    inputs: string[];
    posture: string;
  };
}

export interface EvidenceItem {
  id: string;
  stage: Stage;
  type: string;
  status: EvidenceStatus;
  summary?: string;
  reason?: string;
  producer?: {
    command: string;
    exit_code: number;
    duration_ms: number;
  };
  environment?: {
    runner: string;
    node: string;
    clean_checkout: boolean;
  };
  transcript?: string;
  transcript_sha256?: string;
  reviewer?: Reviewer;
  scanners?: Array<{ tool: string; ran: boolean; note: string; killed?: boolean }>;
  tools?: Array<{
    tool: string;
    source: "repository" | "engine";
    status: "installed" | "failed" | "rejected";
    detail: string;
    duration_ms: number;
  }>;
  artifacts?: Array<{ path: string; sha256: string; bytes: number; included: boolean }>;
  findings?: Finding[];
}

export interface Author {
  login: string;
  kind: "agent" | "human" | "unknown";
  agent?: string;
  on_behalf_of?: string;
  provenance?: "maker" | "person" | "mixed";
  commits?: Array<{ sha: string; by: "maker" | "person"; agent?: string; login?: string }>;
}

export interface Manifest {
  format: string;
  package_id: string;
  created_at: string;
  tool: { name: string; version: string };
  subject: {
    repo: string;
    pr: number | null;
    title: string;
    head_sha: string;
    base_sha: string;
    author: Author;
  };
  pipeline: Stage[];
  intent_ref: string;
  mapping_ref: string;
  verdict_ref: string;
  hashes_ref: string;
  evidence_dir: string;
  playbook?: ManifestPlaybook;
}

export interface ManifestPlaybook {
  slug: string;
  version: number;
  builtin: boolean;
  added_checks: string[];
  added_flows: string[];
  added_tools: string[];
  checks_required: boolean;
  required_stages: Stage[];
  added_criteria: string[];
}

export interface Criterion {
  id: string;
  text: string;
  source: { kind: "pr_description" | "linked_issue" | "explicit"; ref: string };
}

export interface Intent {
  criteria: Criterion[];
  extraction: {
    method: string;
    confidence: "high" | "medium" | "low";
    note?: string;
  };
}

export interface Mapping {
  criterion: string;
  status: "satisfied" | "unsatisfied" | "unknown";
  evidence: string[];
  reason: string;
}

export interface MappingFile {
  status: "completed" | "skipped";
  reason?: string;
  mappings: Mapping[];
}

export interface VerdictFile {
  verdict: Verdict;
  rule: string;
  blocking_findings: string[];
  unsatisfied_criteria: string[];
  unknown_criteria: string[];
  criteria: { satisfied: number; unsatisfied: number; unknown: number; total: number };
  evidence_counts: Record<string, number>;
  summary: string;
}

export interface Hashes {
  algorithm: "sha256";
  files: Record<string, string>;
}
