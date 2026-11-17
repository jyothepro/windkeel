import { z } from "zod";
import { CriterionSchema, RiskLevelSchema, RunStateSchema, VerdictSchema, jsonObject } from "./schemas.js";

const iso = z.string();
const CriteriaProvenanceSchema = z.enum(["extracted", "generated"]);

export const EvidenceStatusSchema = z.enum(["passed", "warning", "failed", "completed_with_findings", "skipped"]);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const StageResultSchema = z.object({
  stage: z.enum(["checks", "review", "intent", "security", "browser"]),
  status: EvidenceStatusSchema,
  items: z.array(
    z.object({ id: z.string(), stage: z.string(), type: z.string(), status: EvidenceStatusSchema, summary: z.string().nullable() }),
  ),
});
export type StageResult = z.infer<typeof StageResultSchema>;

export const ReportedVerificationSchema = z.object({
  id: z.string(),
  cycle: z.number(),
  candidateSha: z.string(),
  verdict: VerdictSchema.nullable(),
  startedAt: iso.nullable(),
  completedAt: iso.nullable(),
  evidence: z.object({ state: z.enum(["stored", "pruned", "none"]), ref: z.string().nullable(), manifestDigest: z.string().nullable() }),
  verdictOfRecord: z.boolean(),
  superseded: z.boolean(),
  stages: z.array(StageResultSchema).nullable().optional(),
});
export type ReportedVerification = z.infer<typeof ReportedVerificationSchema>;

export const ReportedRepairAttemptSchema = z.object({
  attemptNumber: z.number(),
  triggeringVerificationId: z.string(),
  taken: z.boolean(),
  failedCriteria: z.array(z.string()),
  failedChecks: z.array(z.string()),
  blockingFindings: z.array(z.string()),
});
export type ReportedRepairAttempt = z.infer<typeof ReportedRepairAttemptSchema>;

export const ReportedAgentRunSchema = z.object({
  id: z.string(),
  role: z.string(),
  workerType: z.string(),
  model: z.string(),
  startedAt: iso.nullable(),
  completedAt: iso.nullable(),
  modelCostUsd: z.number().nullable(),
  cachedInputShare: z.number().nullable(),
});
export type ReportedAgentRun = z.infer<typeof ReportedAgentRunSchema>;

export const RunReportSchema = z.object({
  engineeringRunId: z.string(),
  task: z.object({
    id: z.string(),
    title: z.string(),
    riskLevel: RiskLevelSchema,
    criteria: z.array(CriterionSchema),
    criteriaProvenance: CriteriaProvenanceSchema,
    criteriaGeneratedBy: z.string().nullable(),
    criteriaApprovedBy: z.string().nullable(),
    criteriaApprovedAt: iso.nullable(),
  }),
  state: RunStateSchema,
  terminal: z.boolean(),
  stopReason: z.string().nullable(),
  stopReasonText: z.string().nullable(),
  finalVerdict: VerdictSchema.nullable(),
  startedAt: iso.nullable(),
  completedAt: iso.nullable(),
  verifications: z.array(ReportedVerificationSchema),
  repairAttempts: z.array(ReportedRepairAttemptSchema),
  repairAttemptsTaken: z.number(),
  repairCap: z.number(),
  agentRuns: z.array(ReportedAgentRunSchema),
  cost: z.object({
    totalUsd: z.number(),
    modelUsd: z.number(),
    sandboxUsd: z.number(),
    unpricedModelCalls: z.number(),
    runCostUsd: z.number(),
    reconciles: z.boolean(),
    spendCapUsd: z.number().nullable(),
  }),
  criteria: z.object({ satisfied: z.number().nullable(), total: z.number() }),
  incompleteStages: z.array(z.object({ stage: z.string(), evidenceId: z.string(), tool: z.string(), detail: z.string() })),
  signed: z.boolean().nullable(),
  pendingSignals: z.array(z.object({ kind: z.string(), receivedAt: iso })),
});
export type RunReport = z.infer<typeof RunReportSchema>;

export const HumanSessionStateSchema = z.enum(["requested", "provisioning", "ready", "sleeping", "submitting", "handing_back", "ended", "failed"]);
export type HumanSessionState = z.infer<typeof HumanSessionStateSchema>;

export const HumanSessionSchema = z.object({
  id: z.string(),
  state: HumanSessionStateSchema,
  origin: z.enum(["takeover", "pair", "make_changes"]),
  editor: z.object({ principalId: z.string().nullable(), login: z.string().nullable(), displayName: z.string() }),
  yours: z.boolean(),
  awake: z.boolean(),
  requestedAt: iso,
  startedAt: iso.nullable(),
  lastActiveAt: iso.nullable(),
  expiresAt: iso.nullable(),
  seedSha: z.string().nullable(),
  intent: z.enum(["submit", "handback"]).nullable(),
  error: z.string().nullable(),
  outcome: z.enum(["submitted", "handed_back", "cancelled", "blocked", "expired", "failed"]).nullable().optional(),
  installNote: z.string().nullable().optional(),
  canHandBack: z.boolean(),
});
export type HumanSession = z.infer<typeof HumanSessionSchema>;

export const TakeoverInfoSchema = z.object({
  enabled: z.boolean(),
  session: HumanSessionSchema.nullable(),
  cycles: z.object({ used: z.number(), cap: z.number() }),
});
export type TakeoverInfo = z.infer<typeof TakeoverInfoSchema>;

export const CandidateProvenanceSchema = z.object({
  sha: z.string(),
  parentSha: z.string().nullable(),
  at: iso.nullable(),
  commitAuthor: z.enum(["maker", "person"]),
  provenance: z.enum(["maker", "person", "mixed"]),
  maker: z.object({ harness: z.string(), model: z.string() }).nullable(),
  person: z.object({ login: z.string().nullable(), principalId: z.string().nullable() }).nullable(),
});
export type CandidateProvenance = z.infer<typeof CandidateProvenanceSchema>;

export const MakerScreenshotSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  url: z.string().nullable(),
  pageTitle: z.string().nullable(),
  consoleErrors: z.array(z.string()),
  capturedAt: iso,
  bytes: z.number(),
  evidence: z.literal(false),
});
export type MakerScreenshot = z.infer<typeof MakerScreenshotSchema>;

export const WorkspaceEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "directory", "symlink", "other"]),
  bytes: z.number().nullable(),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

export const WorkspaceReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), path: z.string(), entries: z.array(WorkspaceEntrySchema), truncated: z.boolean() }),
  z.object({ kind: z.literal("file"), path: z.string(), bytes: z.number(), content: z.string() }),
]);
export type WorkspaceRead = z.infer<typeof WorkspaceReadSchema>;

export const RunDiffSchema = z.object({
  candidateSha: z.string(),
  workingBranch: z.string().nullable(),
  filesChanged: z.array(z.string()),
  truncated: z.boolean(),
  patch: z.string(),
  candidates: z.array(z.object({ sha: z.string(), agentRunId: z.string(), role: z.string(), filesChanged: z.number() })),
});
export type RunDiff = z.infer<typeof RunDiffSchema>;

export const EvidenceEntrySchema = z.object({
  verificationRunId: z.string(),
  candidateSha: z.string(),
  verdict: VerdictSchema.nullable(),
  state: z.enum(["stored", "pruned", "never_produced"]),
  prunedAt: iso.nullable(),
  manifestDigest: z.string().nullable(),
  files: z.array(z.string()).nullable(),
});
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;

export const KeySourceSchema = z.enum(["orqon", "customer"]);
export type KeySource = z.infer<typeof KeySourceSchema>;

export const CostBreakdownSchema = z.object({
  totalUsd: z.number(),
  unpricedEvents: z.number().optional(),
  byStage: z.array(
    z.object({
      stageType: z.string(),
      kind: z.string(),
      keySource: KeySourceSchema.nullable().optional(),
      usd: z.number(),
      tokensIn: z.number().nullable(),
      tokensOut: z.number().nullable(),
      events: z.number(),
      unpricedEvents: z.number().optional(),
    }),
  ),
  bySource: z
    .array(
      z.object({
        keySource: KeySourceSchema.nullable(),
        usd: z.number(),
        tokensIn: z.number().nullable(),
        tokensOut: z.number().nullable(),
        events: z.number(),
        unpricedEvents: z.number(),
      }),
    )
    .optional(),
  spendCapUsd: z.number().nullable(),
  runRowCost: z.number(),
});
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;

export const OrganizationViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  permissions: z.array(z.string()),
  role: z.string(),
});
export type OrganizationView = z.infer<typeof OrganizationViewSchema>;

export const SelfViewSchema = z.object({
  principal: z.object({ id: z.string(), kind: z.enum(["user", "token"]), displayName: z.string(), githubLogin: z.string().nullable() }),
  account: z.object({ id: z.string(), name: z.string() }),
  organizations: z.array(OrganizationViewSchema),
  via: z.enum(["bootstrap", "token", "session"]).optional(),
  token: z
    .object({ id: z.string(), name: z.string(), permissions: z.array(z.string()).nullable(), organizationId: z.string().nullable() })
    .nullable(),
  subject: z.string(),
  scopes: z.array(z.string()),
  features: z.object({ takeover: z.boolean().optional() }).optional(),
  accountRole: z.object({ key: z.string(), name: z.string(), permissions: z.array(z.string()) }).nullable().optional(),
});
export type SelfView = z.infer<typeof SelfViewSchema>;

export const ApiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  organizationId: z.string().nullable(),
  permissions: z.array(z.string()).nullable(),
  ownerPrincipalId: z.string(),
  createdBy: z.string(),
  createdAt: iso,
  lastUsedAt: iso.nullable(),
  expiresAt: iso.nullable(),
  revokedAt: iso.nullable(),
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;

export const CreatedTokenSchema = z.object({
  token: ApiTokenSchema,
  secret: z.string(),
  sample: z.boolean().optional(),
});
export type CreatedToken = z.infer<typeof CreatedTokenSchema>;

export const RoleSchema = z.enum(["admin", "member", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const MemberSchema = z.object({
  principalId: z.string(),
  displayName: z.string(),
  githubLogin: z.string().nullable(),
  role: z.string(),
  createdAt: iso,
});
export type Member = z.infer<typeof MemberSchema>;

export const InvitationSchema = z.object({
  id: z.string(),
  githubLogin: z.string(),
  role: z.string(),
  invitedBy: z.string().nullable(),
  invitedByName: z.string().nullable().optional(),
  createdAt: iso,
  expiresAt: iso.nullable(),
  acceptedAt: iso.nullable(),
});
export type Invitation = z.infer<typeof InvitationSchema>;

export const RepositoryGrantSchema = z.object({
  repositoryId: z.string(),
  fullName: z.string(),
  intake: z.boolean(),
  createdAt: iso,
});
export type RepositoryGrant = z.infer<typeof RepositoryGrantSchema>;

export const DeviceRequestSchema = z.object({
  userCode: z.string(),
  machineName: z.string(),
  requestedPermissions: z.array(z.string()),
  admin: z.boolean(),
  expiresAt: iso,
  state: z.enum(["pending", "approved", "denied", "expired"]),
});
export type DeviceRequest = z.infer<typeof DeviceRequestSchema>;

export const AccessRoleSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  permissions: z.array(z.string()),
  builtIn: z.boolean(),
  createdAt: iso,
  updatedAt: iso,
});
export type AccessRole = z.infer<typeof AccessRoleSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  seq: z.number(),
  organizationId: z.string().nullable(),
  actorPrincipalId: z.string().nullable(),
  actorText: z.string(),
  actorKind: z.enum(["user", "token", "github", "system", "scim"]),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  detail: jsonObject,
  hash: z.string(),
  occurredAt: iso,
});
export type AuditEvent = Omit<z.infer<typeof AuditEventSchema>, "detail"> & { detail: Record<string, unknown> };

export const ProviderSchema = z.enum(["slack", "linear", "jira", "sentry"]);
export type Provider = z.infer<typeof ProviderSchema>;
export const ScopeKindSchema = z.enum(["default", "slack_channel", "linear_team", "jira_project", "sentry_project"]);
export type ScopeKind = z.infer<typeof ScopeKindSchema>;

export const IntegrationRouteSchema = z.object({
  id: z.string(),
  scopeKind: ScopeKindSchema,
  scopeValue: z.string().nullable(),
  repositoryId: z.string(),
  triggerLabel: z.string(),
  enabled: z.boolean(),
  createdAt: iso,
});
export type IntegrationRoute = z.infer<typeof IntegrationRouteSchema>;

export const IntegrationConnectionSchema = z.object({
  id: z.string(),
  provider: ProviderSchema,
  installationId: z.string(),
  externalTenantId: z.string(),
  externalTenantName: z.string().nullable(),
  status: z.enum(["active", "disconnected"]),
  createdByPrincipalId: z.string().nullable().optional(),
  createdAt: iso,
  disconnectedAt: iso.nullable(),
});

export const IntegrationSchema = IntegrationConnectionSchema.extend({ routes: z.array(IntegrationRouteSchema) });
export type Integration = z.infer<typeof IntegrationSchema>;

export const ScheduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  repositoryId: z.string(),
  cron: z.string(),
  timezone: z.string(),
  title: z.string(),
  description: z.string(),
  riskLevel: RiskLevelSchema,
  spendCapUsd: z.number().nullable(),
  wallClockCapSeconds: z.number().nullable(),
  enabled: z.boolean(),
  nextFireAt: iso,
  nextFireTimes: z.array(iso),
  lastFiredAt: iso.nullable(),
  lastOutcome: z.string().nullable(),
  createdByPrincipalId: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export interface ScheduleInput {
  name?: string;
  repositoryId?: string;
  cron?: string;
  timezone?: string;
  title?: string;
  description?: string;
  riskLevel?: z.infer<typeof RiskLevelSchema>;
  enabled?: boolean;
}

export const WebhookEndpointSchema = z.object({
  id: z.string(),
  name: z.string(),
  repositoryId: z.string(),
  enabled: z.boolean(),
  defaultRiskLevel: RiskLevelSchema,
  secretVersion: z.number(),
  path: z.string(),
  createdAt: iso,
  rotatedAt: iso.nullable(),
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;

export const WebhookEndpointWithSecretSchema = z.object({
  endpoint: WebhookEndpointSchema,
  secret: z.string(),
  sample: z.boolean().optional(),
});
export type WebhookEndpointWithSecret = z.infer<typeof WebhookEndpointWithSecretSchema>;

export const ServicePrincipalSchema = z.object({
  id: z.string(),
  kind: z.literal("service"),
  organizationId: z.string(),
  displayName: z.string(),
  role: z.string(),
  permissions: z.array(z.string()),
  system: z.boolean(),
  systemPurpose: z.string().nullable(),
  createdAt: iso,
  deactivatedAt: iso.nullable(),
});
export type ServicePrincipal = z.infer<typeof ServicePrincipalSchema>;
