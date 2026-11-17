import { z } from "zod";
import {
  AcceptedSchema,
  BatchDetailSchema,
  BatchProgressSchema,
  BatchViewSchema,
  CriterionSchema,
  RiskLevelSchema,
  jsonObject,
} from "./schemas.js";
import {
  AccessRoleSchema,
  ApiTokenSchema,
  AuditEventSchema,
  IntegrationConnectionSchema,
  ServicePrincipalSchema,
  WebhookEndpointSchema,
} from "./views.js";
import {
  iso,
  id,
  list,
} from "./route-common.js";

export const Connection = z.object({ connection: IntegrationConnectionSchema });
export const SentryConnection = Connection.extend({
  credential: z.object({ last4: z.string(), updatedAt: iso }).nullable().optional(),
});
export const BatchItem = z.object({
  id,
  ordinal: z.number(),
  repositoryId: id,
  repositoryFullName: z.string(),
  state: z.enum(["pending", "dispatched", "skipped"]),
  skipReason: z.string().nullable(),
  title: z.string().nullable(),
  taskId: id.nullable(),
  runId: id.nullable(),
  runStatus: z.string().nullable(),
  finalVerdict: z.string().nullable(),
  stopReason: z.string().nullable(),
  spendCapUsd: z.number().nullable(),
  costUsd: z.number(),
  pullRequestNumber: z.number().nullable(),
  pullRequestUrl: z.string().nullable(),
  dispatchedAt: iso.nullable(),
});
export const Batch = BatchViewSchema.extend({
  template: jsonObject,
  createdByPrincipalId: id.nullable(),
  updatedAt: iso,
  progress: BatchProgressSchema,
});
export const BatchDetail = BatchDetailSchema.extend({ batch: Batch, items: z.array(BatchItem) });
export const BatchAccepted = AcceptedSchema.extend({
  batchId: id,
  started: z.number(),
  cancelled: z.array(z.object({ runId: id, outcome: z.string() })).optional(),
  batch: Batch.optional(),
  items: z.array(BatchItem).optional(),
});
export const WebhookEndpointWithSecret = z.object({ endpoint: WebhookEndpointSchema, secret: z.string() });

export const ModelCredential = z.object({
  id,
  provider: z.string(),
  baseUrl: z.string().nullable(),
  declaredVendor: z.string().nullable(),
  label: z.string(),
  last4: z.string(),
  keypairId: z.string(),
  status: z.string(),
  statusReason: z.string().nullable(),
  validatedAt: iso.nullable(),
  createdByPrincipalId: id.nullable(),
  createdAt: iso,
  updatedAt: iso,
  revokedAt: iso.nullable(),
});
export const Validation = z.enum(["started", "unavailable", "failed"]);
export const CredentialWithValidation = z.object({ credential: ModelCredential, validation: Validation });
export const ModelPolicyEntry = z.object({
  id,
  repositoryId: id.nullable(),
  role: z.enum(["maker", "checker"]),
  provider: z.string(),
  model: z.string(),
  credentialId: id.nullable(),
  keySource: z.enum(["orqon", "customer"]),
  declaredVendor: z.string().nullable(),
  harness: z.string().nullable(),
  updatedByPrincipalId: id.nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export const ModelPreset = z.object({
  id,
  name: z.string(),
  harness: z.string().nullable(),
  maker: jsonObject,
  checker: z.union([jsonObject, z.array(jsonObject)]),
  createdByPrincipalId: id.nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export const ModelPolicy = z.object({
  repositoryId: id.nullable(),
  items: z.array(ModelPolicyEntry),
  presets: z.array(ModelPreset),
  harnesses: z.array(z.object({ id: z.string(), label: z.string(), default: z.boolean() })),
});

export const KnowledgeNote = z.object({
  id,
  repositoryId: id.nullable(),
  scope: z.enum(["repository", "organization"]),
  title: z.string(),
  body: z.string(),
  pathGlobs: z.array(z.string()),
  status: z.string(),
  sourceKind: z.string(),
  sourceRef: jsonObject,
  risk: z.string().nullable(),
  riskReasons: z.array(z.string()),
  version: z.number(),
  createdBy: z.string(),
  updatedBy: z.string(),
  createdAt: iso,
  updatedAt: iso,
});
export const Note = z.object({ note: KnowledgeNote });
export const KnowledgeRevision = z.object({
  noteId: id,
  version: z.number(),
  title: z.string(),
  body: z.string(),
  pathGlobs: z.array(z.string()),
  status: z.string(),
  actor: z.string(),
  at: iso,
});
export const RepositoryDigest = z.object({
  repositoryId: id,
  digest: z
    .object({ commitSha: z.string(), body: z.string(), sources: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string() })), generatedAt: iso })
    .nullable(),
});
export const RunKnowledgeEntry = z.object({
  noteId: id.nullable(),
  noteVersion: z.number().nullable(),
  digestSha: z.string().nullable(),
  sourceKind: z.string(),
  risk: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  provenance: z.string(),
  chars: z.number(),
  position: z.number(),
  recordedAt: iso,
});
export const Playbook = z.object({
  id: id.nullable(),
  slug: z.string(),
  name: z.string(),
  kind: z.string(),
  version: z.number(),
  builtin: z.boolean(),
  makerInstructions: z.string(),
  criteria: z.array(z.object({ text: z.string() })),
  verifier: jsonObject,
  defaultRiskLevel: RiskLevelSchema.nullable(),
  modelPresetId: id.nullable(),
  verifierAdds: z.array(z.string()),
  addedCriteria: z.array(CriterionSchema),
});

export const DeletedServicePrincipal = z.object({ deleted: id, servicePrincipal: ServicePrincipalSchema.extend({ role: z.string().nullable() }) });
export const ServiceToken = z.object({ token: ApiTokenSchema, secret: z.string() });
export const CreatedToken = ServiceToken.extend({ expiryClamped: z.literal(true).optional() });
export const RoleWithCreator = AccessRoleSchema.extend({ createdBy: id.nullable() });
export const Roles = list(RoleWithCreator);
export const AuditRow = AuditEventSchema.extend({ accountId: id, requestId: z.string().nullable(), prevHash: z.string().nullable() });
export const AuditPage = list(AuditRow);
export const ChainVerdict = z.object({
  ok: z.boolean(),
  checked: z.number(),
  brokenAt: z.object({ seq: z.number(), id, reason: z.string() }).optional(),
});
export const SecurityPolicy = z.object({
  policy: z.object({
    maxTokenTtlDays: z.number().nullable(),
    requireTokenExpiry: z.boolean(),
    idleSessionMinutes: z.number().nullable(),
    requireMfa: z.boolean(),
    ipAllowlist: z.array(z.string()).nullable(),
    auditRetentionDays: z.number().nullable(),
    defaultAuditRetentionDays: z.number().nullable(),
    updatedAt: iso.nullable(),
  }),
});
export const AccessReview = z.object({
  generatedAt: iso,
  accountId: id,
  principals: z.array(
    z.object({
      principalId: id,
      kind: z.enum(["user", "service"]),
      displayName: z.string(),
      githubLogin: z.string().nullable(),
      bootstrap: z.boolean(),
      deactivatedAt: iso.nullable(),
      lastSignInAt: iso.nullable(),
      accountRole: z.string().nullable(),
      organizations: z.array(z.object({ id, name: z.string(), role: z.string() })),
      tokens: z.array(
        z.object({
          id,
          name: z.string(),
          prefix: z.string(),
          organizationId: id.nullable(),
          permissions: z.array(z.string()),
          createdAt: iso,
          lastUsedAt: iso.nullable(),
          expiresAt: iso.nullable(),
        }),
      ),
    }),
  ),
});
export const DeviceStart = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  verificationUriComplete: z.string(),
  interval: z.number(),
  expiresIn: z.number(),
});
