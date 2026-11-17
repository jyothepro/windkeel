import { z } from "zod";
import {
  EventPageSchema,
  EventTailSchema,
  RunChangeSchema,
  RunStateSchema,
  VerdictSchema,
  jsonObject,
} from "./schemas.js";
import {
  CandidateProvenanceSchema,
  RunReportSchema,
  TakeoverInfoSchema,
  WorkspaceEntrySchema,
} from "./views.js";
import {
  iso,
  id,
  list,
  RunCommandAccepted,
} from "./route-common.js";

export const Health = z.object({ ok: z.literal(true), database: z.literal("reachable"), schema: z.literal("current").optional() });

export const Metrics = z.object({
  summary: z.record(z.string(), jsonObject),
  perRun: z.record(z.string(), z.array(jsonObject)),
});
export const ReapableWorkspace = z.object({
  id,
  engineeringRunId: id,
  role: z.string(),
  sandboxProvider: z.string(),
  providerHandle: z.string(),
  status: z.string(),
  because: z.enum(["run_terminal", "expired", "orphaned"]),
});
export const ReapResult = z.object({
  considered: z.number(),
  outcomes: z.array(
    z.object({
      workspaceId: id,
      kind: z.enum(["destroyed", "already_gone", "unreattachable", "failed"]),
      because: z.string().optional(),
      provider: z.string().optional(),
      error: z.string().optional(),
      attempts: z.number().optional(),
    }),
  ),
});

export const EnvironmentSnapshot = z.object({
  id,
  status: z.string(),
  sandboxProvider: z.string(),
  cacheKey: z.string(),
  baseSha: z.string(),
  sizeBytes: z.number().nullable(),
  detail: z.string().nullable(),
  setupLogRef: z.string().nullable(),
  builtBy: z.string(),
  createdAt: iso,
  readyAt: iso.nullable(),
  expiresAt: iso.nullable(),
  lastUsedAt: iso.nullable(),
});
export const RepositoryEnvironment = list(EnvironmentSnapshot).extend({
  current: EnvironmentSnapshot.nullable(),
  pendingRequest: z.object({ requestedBy: z.string(), reason: z.string(), requestedAt: iso }).nullable(),
  proposedSetup: jsonObject.nullable(),
});

export const RunReceipt = z.object({
  runId: id,
  unit: z.literal("credit"),
  creditUsd: z.number(),
  compute: z.array(
    z.object({ role: z.string(), sandboxSeconds: z.number(), sandboxMinutes: z.number(), creditsPerMinute: z.number(), credits: z.number() }),
  ),
  ai: z.array(
    z.object({
      role: z.string(),
      model: z.string().nullable(),
      keySource: z.string(),
      tokensIn: z.number(),
      tokensOut: z.number(),
      calls: z.number(),
      unpricedCalls: z.number(),
      credits: z.number(),
    }),
  ),
  totals: z.object({ computeCredits: z.number(), aiCredits: z.number(), credits: z.number(), totalMicro: z.number(), debitedMicro: z.number() }),
  settled: z.boolean(),
});

export const RunDetail = z.object({
  report: RunReportSchema,
  rendered: z.string(),
  terminal: z.boolean(),
  modelConfig: jsonObject.nullable(),
  cursor: z.string(),
  batch: z.object({ id, title: z.string() }).nullable(),
  receipt: RunReceipt,
  takeover: TakeoverInfoSchema,
  candidates: z.array(CandidateProvenanceSchema),
});

export const RunEvents = z.union([
  EventPageSchema,
  EventTailSchema.extend({ hasNextPage: z.boolean(), runStatus: RunStateSchema, terminal: z.boolean() }),
]);

export const RunChanges = list(RunChangeSchema).extend({ organizationId: id });

export const Attempt = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent_run"),
    at: iso.nullable(),
    id,
    role: z.string(),
    model: z.string(),
    workerType: z.string(),
    completedAt: iso.nullable(),
    modelCost: z.number().nullable(),
  }),
  z.object({
    kind: z.literal("verification"),
    at: iso.nullable(),
    id,
    candidateSha: z.string(),
    verdict: VerdictSchema.nullable(),
    evidence: z.object({ available: z.boolean() }).nullable(),
  }),
  z.object({
    kind: z.literal("repair_attempt"),
    at: z.null(),
    id,
    attemptNumber: z.number(),
    verificationRunId: id,
    agentRunId: id.nullable(),
  }),
]);

export const CaptureRun = z.object({
  engineeringRunId: id,
  kind: z.literal("captured"),
  providerHandle: z.string(),
  scratchDir: z.string(),
  maxBytes: z.number(),
  files: z.array(z.object({ path: z.string(), bytes: z.number() })),
  stored: z.array(z.string()),
});
export const RunCapture = list(z.string()).extend({
  state: z.enum(["stored", "pruned", "never_captured"]),
  capturedAt: iso.nullable(),
  prunedAt: iso.nullable(),
  expiresAt: iso.nullable(),
  byteTotal: z.number().nullable(),
});
export const RunWorkspace = z.discriminatedUnion("kind", [
  z.object({ engineeringRunId: id, kind: z.literal("directory"), path: z.string(), entries: z.array(WorkspaceEntrySchema), truncated: z.boolean() }),
  z.object({ engineeringRunId: id, kind: z.literal("file"), path: z.string(), bytes: z.number(), content: z.string() }),
]);

export const HumanSessionAccepted = RunCommandAccepted.extend({
  humanSessionId: id,
  note: z.string().optional(),
  url: z.string().optional(),
  expiresAt: iso.optional(),
});

export const GithubAuthorization = z.object({
  githubLogin: z.string(),
  githubUserId: z.number(),
  status: z.string(),
  statusReason: z.string().nullable(),
  accessExpiresAt: iso.nullable(),
  refreshExpiresAt: iso.nullable(),
  connectedAt: iso,
  updatedAt: iso,
});
export const NeedsALookItem = z.object({ id: z.string(), title: z.string().optional() });
export const RunMerge = z.object({
  id,
  principalId: id,
  prNumber: z.number(),
  verifiedSha: z.string(),
  mergedSha: z.string().nullable(),
  verdict: z.string(),
  verdictDigest: z.string().nullable(),
  acknowledgements: z.array(NeedsALookItem),
  markReady: z.boolean(),
  mergeMethod: z.string(),
  status: z.string(),
  reason: z.string().nullable(),
  githubLogin: z.string().nullable(),
  createdAt: iso,
  completedAt: iso.nullable(),
});
export const MergeRule = z.object({
  id: z.string(),
  ok: z.boolean(),
  blocking: z.boolean(),
  checked: z.boolean(),
  reason: z.string(),
  detail: z.string().optional(),
});
export const MergeEligibility = z.object({
  eligible: z.boolean(),
  rules: z.array(MergeRule),
  flags: z.array(z.string()),
  failing: MergeRule.nullable(),
  needsAcknowledgement: z.array(NeedsALookItem),
  verifiedSha: z.string().nullable(),
  verdict: z.string().nullable(),
  verdictDigest: z.string().nullable(),
  prNumber: z.number().nullable(),
  prUrl: z.string().nullable(),
  isDraft: z.boolean().nullable(),
  authorization: GithubAuthorization.nullable(),
  merge: RunMerge.nullable(),
  githubError: z.string().nullable(),
  seenBy: z.literal("app"),
});
export const Merging = z.object({
  allowMerge: z.boolean(),
  canManage: z.boolean(),
  canMerge: z.boolean(),
  githubConnect: z.object({ configured: z.boolean() }),
  authorization: GithubAuthorization.nullable(),
});
