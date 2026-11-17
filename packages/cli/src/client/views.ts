

import type { Page } from "@windkeel/api-contract";

export interface RunEvent {

  kind: "transition" | "cost" | "agent";
  cursor: string;
  at: string;
  from?: string | null;
  to?: string;
  reason?: string | null;

  usd?: number | null;
  costKind?: string;
  stageType?: string;

  role?: string;
  event?: { type: string } & Record<string, unknown>;
}

export interface EventPage extends Page<RunEvent> {
  runStatus: string;
  terminal: boolean;
}

export interface BatchInput {
  kind: "fanout" | "multi_repo";
  title: string;
  description: string;

  repositoryId?: string;
  items?: Array<{ title: string; description: string; criteria?: string[] }>;

  repositories?: string[];
  criteria?: string[];
  riskLevel?: "low" | "medium" | "high";
  maxConcurrency?: number;
  batchSpendCapUsd?: number | null;
  uncappedConfirmed?: boolean;
  stopOnFailureRatio?: number | null;
  spendCapUsd?: number;
  wallClockCapSeconds?: number;
}

export interface BatchProgressView {
  items: number;
  pending: number;
  dispatched: number;
  skipped: number;
  active: number;
  settled: number;
  succeeded: number;
  failed: number;
  byStatus: Record<string, number>;
  verdicts: { pass: number; warn: number; fail: number; none: number };
  totalCostUsd: number;
  reservedUsd: number;
  remainingBudgetUsd: number | null;
}

export interface BatchView {
  id: string;
  kind: "fanout" | "multi_repo";
  title: string;
  description: string;
  maxConcurrency: number;
  batchSpendCapUsd: number | null;
  stopOnFailureRatio: number | null;
  status: string;
  stopReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  progress: BatchProgressView;
}

export interface BatchItemView {
  id: string;
  ordinal: number;
  repositoryId: string;
  repositoryFullName: string;
  state: "pending" | "dispatched" | "skipped";
  skipReason: string | null;
  title: string | null;
  taskId: string | null;
  runId: string | null;
  runStatus: string | null;
  finalVerdict: string | null;
  stopReason: string | null;
  spendCapUsd: number | null;
  costUsd: number;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
}

export interface BatchDetail {
  batch: BatchView;
  items: BatchItemView[];
}

export interface ScheduleInput {
  repositoryId: string;
  name: string;
  cron: string;
  timezone?: string;
  title: string;
  description: string;
  riskLevel?: "low" | "medium" | "high";
  spendCapUsd?: number | null;
  wallClockCapSeconds?: number | null;
  enabled?: boolean;
}

export interface ScheduleView {
  id: string;
  name: string;
  repositoryId: string;
  cron: string;
  timezone: string;
  title: string;
  description: string;
  riskLevel: string;
  spendCapUsd: number | null;
  wallClockCapSeconds: number | null;
  enabled: boolean;
  nextFireAt: string;
  nextFireTimes: string[];
  lastFiredAt: string | null;
  lastOutcome: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationView {
  id: string;
  provider: "slack" | "linear" | "jira";
  installationId: string;
  externalTenantId: string;
  externalTenantName: string | null;
  status: "active" | "disconnected";
  createdAt: string;
  disconnectedAt: string | null;
  routes?: IntegrationRouteView[];
}

export interface ModelChoiceInput {
  model: string;
  provider?: string;
  credentialId?: string | null;
  declaredVendor?: string;
}

export interface PlaybookView {
  id: string | null;
  slug: string;
  name: string;
  kind: string;
  version: number;
  builtin: boolean;
  makerInstructions: string;
  criteria: Array<{ text: string }>;
  verifier: Record<string, unknown>;
  defaultRiskLevel: string | null;
  modelPresetId: string | null;

  verifierAdds: string[];
  addedCriteria: Array<{ id: string; text: string }>;
}

export interface ModelPolicyView {
  id: string;
  repositoryId: string | null;
  role: "maker" | "checker";
  provider: string;
  model: string;
  credentialId: string | null;
  keySource: "orqon" | "customer";
  declaredVendor: string | null;
  updatedByPrincipalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelCredentialView {
  id: string;
  provider: string;
  baseUrl: string | null;
  declaredVendor: string | null;
  label: string;
  last4: string;
  keypairId: string;
  status: "unverified" | "valid" | "invalid" | "revoked";
  statusReason: string | null;
  validatedAt: string | null;
  createdByPrincipalId: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface WebhookEndpointView {
  id: string;
  name: string;
  repositoryId: string;
  enabled: boolean;
  defaultRiskLevel: "low" | "medium" | "high";
  secretVersion: number;

  path: string;
  createdAt: string;
  rotatedAt: string | null;
}

export interface IntegrationRouteView {
  id: string;
  scopeKind: "default" | "slack_channel" | "linear_team" | "jira_project";
  scopeValue: string | null;
  repositoryId: string;
  triggerLabel: string;
  enabled: boolean;
  createdAt: string;
}

export interface RunSummary {
  id: string;
  createdAt: string;
  taskId: string;
  taskTitle: string;
  status: string;
  terminal: boolean;
  finalVerdict: string | null;
  stopReason: string | null;
  cost: number;
  prNumber: number | null;
}

export interface GuidanceEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
  state: "queued" | "delivered" | "undeliverable" | "superseded";
  deliveredAt: string | null;
  undeliverableReason: string | null;
  deliveryAttempts: number;
}

export interface SecretEntry {
  key: string;
  note: string | null;
  setBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommandAck {
  accepted: boolean;
  engineeringRunId?: string;
  taskId?: string;
  outcome?: string;
  cursor?: string;
}

export interface RepositoryView {
  id: string;

  fullName: string;
  defaultBranch: string | null;
  openRuns: number;
}

export interface UsageReport {
  organizationId: string;
  period: { start: string; end: string; label: string };
  raw: { windkeelModelUsd: number; customerModelUsd: number; sandboxUsd: number };
  verification: { modelUsd: number; sandboxUsd: number; totalUsd: number; runs: number };
  unpriced: { calls: number; estimatedWindkeelUsd: number; estimatedCustomerUsd: number };
  billable: { aiUsd: number; computeFeeUsd: number; verificationFeeUsd: number; totalUsd: number; totalMicroUsd: number };
  budget: { monthlyLimitUsd: number | null; spentUsd: number; remainingUsd: number | null; exhausted: boolean; alertThresholdPct: number };
  plan: string | null;
  billingStatus: string | null;
}

export interface RunReceipt {
  runId: string;
  compute: Array<{ role: string; sandboxSeconds: number; sandboxMinutes: number; creditsPerMinute: number; credits: number }>;
  ai: Array<{ role: string; model: string | null; keySource: string; tokensIn: number; tokensOut: number; calls: number; unpricedCalls: number; credits: number }>;
  totals: { computeCredits: number; aiCredits: number; credits: number };
  settled: boolean;
}

export interface CreditBalanceReport {
  onCredits: boolean;
  plan?: string | null;
  pendingPlan?: string | null;
  period?: { start: string; end: string; daysToReset: number };
  planCredits?: { included: number; used: number; left: number };
  topups?: Array<{ source: string; product: string | null; credits: number; left: number; expiresAt: string }>;
  overage?: { enabled: boolean; capCredits: number | null; billedCredits: number; unbilledCredits: number };
  availableCredits?: number;
  admits?: boolean;
  alerts?: Array<{ kind: string; usedCredits: number; limitCredits: number; raisedAt: string }>;
}

export interface CreditStatement {
  period: { start: string; end: string; label: string };
  rows: Array<{ runId: string; repository: string | null; role: string; kind: string; model: string | null; sandboxSeconds: number; tokensIn: number; tokensOut: number; credits: number }>;
  byRun: Array<{ runId: string; repository: string | null; credits: number }>;
  byRepository: Array<{ repositoryId: string; repository: string | null; credits: number }>;
  byRole: Array<{ role: string; credits: number }>;
  totals: { credits: number };
}

export interface MetricsReport {
  summary: Record<string, Record<string, unknown>>;
  perRun: Record<string, Array<Record<string, unknown>>>;
}

export interface ReapableSandbox {
  id: string;
  engineeringRunId: string;
  role: string;
  sandboxProvider: string;
  providerHandle: string;
  status: string;
  because: "run_terminal" | "expired" | "orphaned";
}

export interface ReapResult {
  considered: number;
  outcomes: Array<
    | { workspaceId: string; kind: "destroyed" | "already_gone"; because: string }
    | { workspaceId: string; kind: "unreattachable"; provider: string }
    | { workspaceId: string; kind: "failed"; error: string; attempts: number }
  >;
}

export interface CaptureView {
  engineeringRunId: string;
  kind: "captured";
  providerHandle: string;
  scratchDir: string;
  maxBytes: number;
  files: Array<{ path: string; bytes: number; written: boolean; escaped?: boolean }>;

  stored: string[];
}

export interface CaptureListing extends Page<string> {
  state?: "stored" | "pruned" | "never_captured";
  capturedAt?: string | null;
  prunedAt?: string | null;
  expiresAt?: string | null;
  byteTotal?: number | null;
}

export interface SelfView {
  principal?: { id: string; kind: "user" | "token"; displayName: string | null; githubLogin: string | null };
  account?: { id: string; name: string };
  organizations?: Array<{ id: string; name: string; role: string; permissions: string[] }>;
  token?: { id: string; name: string; permissions: string[]; organizationId: string | null } | null;

  via?: "bootstrap" | "token" | "session";
  subject: string;
  scopes: string[];
}

export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  organizationId: string | null;
  permissions: string[];
  ownerPrincipalId: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreatedToken {
  token: ApiTokenView;
  secret: string;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;

  interval: number;

  expiresIn: number;
}

export interface ServicePrincipalView {
  id: string;
  organizationId: string;
  displayName: string;
  role: string | null;
  permissions: string[];
  system: boolean;
  systemPurpose: string | null;
  createdAt: string;
  deactivatedAt: string | null;
}

export interface MemberView {
  principalId: string;
  role: string;
  displayName?: string | null;
  githubLogin?: string | null;
  [field: string]: unknown;
}

export interface InvitationView {
  id?: string;
  githubLogin: string;
  role: string;
  [field: string]: unknown;
}
