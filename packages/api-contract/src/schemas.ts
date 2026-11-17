import { z } from "zod";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);
export const jsonObject = z.record(z.string(), jsonValue);

export const RUN_STATES = [
  "CREATED",
  "CLASSIFYING",
  "PLANNING",
  "WAITING_FOR_APPROVAL",
  "PROVISIONING",
  "IMPLEMENTING",
  "VERIFYING",
  "REPAIRING",
  "PR_CREATING",
  "PR_READY",
  "WAITING_FOR_HUMAN",
  "HUMAN_EDITING",
  "COMPLETED",
  "CANCELLED",
  "BLOCKED",
  "FAILED",
  "MAX_REPAIR_ATTEMPTS_REACHED",
] as const;

export const RunStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunStateSchema>;

export const VerdictSchema = z.enum(["pass", "warn", "fail"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ErrorBodySchema = z.looseObject({
  error: z.string(),
  code: z.string(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.looseObject({
    items: z.array(item),
    endCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  });
export interface Page<T> {
  items: T[];
  endCursor: string | null;
  hasNextPage: boolean;
}

export const AcceptedSchema = z.looseObject({
  accepted: z.literal(true),
  engineeringRunId: z.string().optional(),
  cursor: z.string().optional(),
});
export type Accepted = z.infer<typeof AcceptedSchema>;

export const RunSummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  repositoryId: z.string(),
  status: RunStateSchema,
  terminal: z.boolean(),
  finalVerdict: VerdictSchema.nullable(),
  stopReason: z.string().nullable(),
  cost: z.number(),
  spendCapUsd: z.number().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  prNumber: z.number().nullable(),
  prMergedAt: z.string().nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RepositorySummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),

  fullName: z.string(),
  defaultBranch: z.string().nullable(),
  openRuns: z.number(),
});
export type RepositorySummary = z.infer<typeof RepositorySummarySchema>;

export const CriterionSchema = z.object({ id: z.string(), text: z.string() });
export type Criterion = z.infer<typeof CriterionSchema>;

const CriteriaProvenanceSchema = z.enum(["extracted", "generated"]);

export const TaskRowSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  sourceType: z.string(),
  sourceReference: z.string(),
  sourceContext: z.record(z.string(), z.unknown()).optional(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(CriterionSchema),
  criteriaProvenance: CriteriaProvenanceSchema,
  criteriaGeneratedBy: z.string().nullable(),
  criteriaApprovedBy: z.string().nullable(),
  criteriaApprovedAt: z.string().nullable(),
  riskLevel: RiskLevelSchema,
  sessionMode: z.enum(["autonomous", "pair"]).optional(),

  playbook: z.record(z.string(), z.unknown()).nullable().optional(),
  priority: z.number().nullable(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskRow = z.infer<typeof TaskRowSchema>;

export const TaskSchema = TaskRowSchema.extend({
  criteria: z.object({
    provenance: CriteriaProvenanceSchema,
    generatedBy: z.string().nullable(),
    approvedBy: z.string().nullable(),
    approvedAt: z.string().nullable(),
    items: z.array(CriterionSchema),
  }),
});
export type Task = z.infer<typeof TaskSchema>;

export const AgentStepSchema = z.object({
  type: z.enum([
    "started",
    "thinking",
    "command_started",
    "command_finished",
    "test_started",
    "test_finished",
    "file_changed",
    "message",
    "completed",
    "failed",
    "screenshot",
    "browser_unavailable",
  ]),
  text: z.string().optional(),
  screenshotId: z.string().optional(),
  name: z.string().optional(),
  url: z.string().nullable().optional(),
  reason: z.string().optional(),
  command: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  passed: z.boolean().optional(),
  output: z.string().optional(),
  path: z.string().optional(),
  kind: z.enum(["add", "update", "delete"]).optional(),
  error: z.string().optional(),
});
export type AgentStep = z.infer<typeof AgentStepSchema>;

export const RunEventSchema = z.object({
  kind: z.enum(["transition", "cost", "agent"]),
  cursor: z.string(),
  at: z.string(),
  from: RunStateSchema.nullable().optional(),
  to: RunStateSchema.optional(),
  reason: z.string().nullable().optional(),

  usd: z.number().nullable().optional(),
  costKind: z.string().optional(),
  stageType: z.string().optional(),
  agentRunId: z.string().optional(),
  role: z.string().optional(),
  event: AgentStepSchema.optional(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const EventPageSchema = pageSchema(RunEventSchema).extend({
  runStatus: RunStateSchema,
  terminal: z.boolean(),
});
export interface EventPage extends Page<RunEvent> {
  runStatus: RunState;
  terminal: boolean;
}

export const EventTailSchema = z.object({
  items: z.array(RunEventSchema),
  startCursor: z.string().nullable(),
  endCursor: z.string(),
  hasPreviousPage: z.boolean(),
});
export type EventTail = z.infer<typeof EventTailSchema>;

export const RunChangeSchema = z.object({
  kind: z.literal("run.changed"),
  changeId: z.string(),
  runId: z.string(),
  taskId: z.string(),
  from: RunStateSchema.nullable(),
  state: RunStateSchema,
  at: z.string(),
});
export type RunChange = z.infer<typeof RunChangeSchema>;

export const BatchStatusSchema = z.enum(["RUNNING", "PAUSED", "STOPPING", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);
export type BatchStatus = z.infer<typeof BatchStatusSchema>;

export const BatchProgressSchema = z.object({
  items: z.number(),
  pending: z.number(),
  dispatched: z.number(),
  skipped: z.number(),
  active: z.number(),
  settled: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  byStatus: z.record(z.string(), z.number()),
  verdicts: z.object({ pass: z.number(), warn: z.number(), fail: z.number(), none: z.number() }),
  totalCostUsd: z.number(),
  reservedUsd: z.number(),
  remainingBudgetUsd: z.number().nullable(),
});
export type BatchProgress = z.infer<typeof BatchProgressSchema>;

export const BatchViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["fanout", "multi_repo"]),
  title: z.string(),
  description: z.string(),
  maxConcurrency: z.number(),
  batchSpendCapUsd: z.number().nullable(),
  stopOnFailureRatio: z.number().nullable(),
  status: BatchStatusSchema,
  stopReason: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  progress: BatchProgressSchema,
});
export type BatchView = z.infer<typeof BatchViewSchema>;

export const BatchItemSchema = z.object({
  id: z.string(),
  ordinal: z.number(),
  repositoryId: z.string(),
  repositoryFullName: z.string(),
  state: z.enum(["pending", "dispatched", "skipped"]),
  skipReason: z.string().nullable(),
  title: z.string().nullable(),
  runId: z.string().nullable(),
  runStatus: z.string().nullable(),
  finalVerdict: z.string().nullable(),
  costUsd: z.number(),
  pullRequestNumber: z.number().nullable(),
  pullRequestUrl: z.string().nullable(),
});
export type BatchItem = z.infer<typeof BatchItemSchema>;

export const BatchDetailSchema = z.object({ batch: BatchViewSchema, items: z.array(BatchItemSchema) });
export type BatchDetail = z.infer<typeof BatchDetailSchema>;

export const GuidanceMessageSchema = z.object({
  id: z.string(),
  cursor: z.string(),
  at: z.string(),
  actor: z.string(),
  message: z.string(),
  state: z.enum(["queued", "delivered", "undeliverable", "superseded"]),
  deliveredAt: z.string().nullable(),
  undeliverableReason: z.string().nullable(),
  deliveryAttempts: z.number(),
});
export type GuidanceMessage = z.infer<typeof GuidanceMessageSchema>;

export const RepositorySecretSchema = z.object({
  key: z.string(),
  note: z.string().nullable(),
  setBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RepositorySecret = z.infer<typeof RepositorySecretSchema>;

export const SelfSchema = z.looseObject({ subject: z.string(), scopes: z.array(z.string()) });
export type Self = z.infer<typeof SelfSchema>;
