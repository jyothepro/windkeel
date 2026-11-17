import type { Pool, PoolClient } from "pg";
import type { Criterion } from "@windkeel/verification/evidence/format.js";
import type { RiskLevel } from "./rails.js";
import { repositoryFullName } from "./repository-entity.js";
import type { EngineeringRun } from "./repositories.js";
import type { RailsOptions } from "./task-creation.js";

type Queryable = Pool | PoolClient;

export const GITHUB_ISSUE_SOURCE = "github_issue";

export function issueReference(
  repository: { owner: string; name: string },
  issueNumber: number,
): string {
  return `${repositoryFullName(repository)}#${issueNumber}`;
}

export interface IntakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  htmlUrl: string;
  state: "open" | "closed";
  locked?: boolean;
}

export interface IntakeRepository {
  id: string;
  owner: string;
  name: string;
}

const RISK_LABEL_PREFIX = "risk:";

export function riskFromLabels(labels: readonly string[], fallback: RiskLevel): RiskLevel {
  return riskLabelOf(labels) ?? fallback;
}

export function riskLabelOf(labels: readonly string[]): RiskLevel | undefined {
  for (const label of labels) {
    const value = label.toLowerCase().startsWith(RISK_LABEL_PREFIX)
      ? label.slice(RISK_LABEL_PREFIX.length).toLowerCase()
      : null;
    if (value === "low" || value === "medium" || value === "high") return value;
  }
  return undefined;
}

export interface IntakeGitHub {
  createIssueComment(
    repository: { owner: string; name: string },
    issueNumber: number,
    body: string,
  ): Promise<unknown>;
}

export interface IntakeConfig {
  defaultRiskLevel?: RiskLevel;
  rails?: RailsOptions;
}

export type IntakeOutcome =
  | {
      kind: "started";
      taskId: string;
      engineeringRunId: string;
      criteria: Criterion[];
      criteriaRouting: "extracted" | "pending_generation";
      reusedTask: boolean;
    }
  | { kind: "noop"; taskId: string; engineeringRunId: string; reason: string }
  | { kind: "ignored"; reason: string };

export interface IntakeResult {
  outcome: IntakeOutcome;
  afterCommit: () => Promise<void>;
}

export interface IntakeDeps {
  db: Queryable;
  github: IntakeGitHub;
  startRun: (engineeringRunId: string) => Promise<{ enqueued: boolean }>;
  config?: IntakeConfig;
}

export function runStartComment(
  run: EngineeringRun,
  criteria: Criterion[],
  criteriaRouting: "extracted" | "pending_generation",
): string {
  const lines = [`**Windkeel is on it.** Run \`${run.id}\`.`, ""];
  if (criteriaRouting === "extracted") {
    lines.push(
      `Verifying against the ${criteria.length} acceptance ${
        criteria.length === 1 ? "criterion" : "criteria"
      } stated in this issue:`,
      "",
      ...criteria.map((c) => `- **${c.id}** — ${c.text}`),
    );
  } else {
    lines.push(
      "This issue states no acceptance criteria, so Windkeel will propose some and wait for your",
      "approval before anything is provisioned. Nothing runs until you reply `/windkeel approve`.",
    );
  }
  lines.push(
    "",
    `Spend cap $${run.spendCapUsd ?? "—"}, wall clock ${run.wallClockCapSeconds}s. ` +
      "Remove the `windkeel` label or comment `/windkeel cancel` to stop it.",
  );
  return lines.join("\n");
}
