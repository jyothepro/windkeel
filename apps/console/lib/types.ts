

import type * as Contract from "@windkeel/api-contract";
import type { PlaybookSnapshot } from "./playbooks.ts";
import type { RunModelConfig } from "./models.ts";
import type { Role } from "@windkeel/api-contract";

export type {
  Accepted,
  Page,
  RunSummary,
  RepositorySummary,
  Criterion,
  ReportedVerification,
  EvidenceStatus,
  StageResult,
  ReportedRepairAttempt,
  ReportedAgentRun,
  RunReport,
  HumanSessionState,
  HumanSession,
  TakeoverInfo,
  CandidateProvenance,
  AgentStep,
  RunEvent,
  MakerScreenshot,
  WorkspaceEntry,
  WorkspaceRead,
  RunDiff,
  EventPage,
  EventTail,
  RunChange,
  EvidenceEntry,
  KeySource,
  CostBreakdown,
  GuidanceMessage,
  RepositorySecret,
  Self,
  OrganizationView,
  SelfView,
  ApiToken,
  CreatedToken,
  Role,
  Member,
  Invitation,
  RepositoryGrant,
  DeviceRequest,
  AccessRole,
  AuditEvent,
  Provider,
  ScopeKind,
  RiskLevel,
  IntegrationRoute,
  Integration,
  Schedule,
  ScheduleInput,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  ServicePrincipal,
} from "@windkeel/api-contract";

export interface TaskRow extends Omit<Contract.TaskRow, "playbook"> {

  playbook?: PlaybookSnapshot | null;
}

export interface Task extends Omit<Contract.Task, "playbook"> {
  playbook?: PlaybookSnapshot | null;
}

export interface RunDetail {
  report: Contract.RunReport;
  rendered: string;
  terminal: boolean;
  cursor: string;

  modelConfig?: RunModelConfig | null;

  takeover?: Contract.TakeoverInfo;

  candidates?: Contract.CandidateProvenance[];

  batch?: { id: string; title: string } | null;

  receipt?: import("./credits.ts").RunReceiptView;
}

export const BUILT_IN_ROLES: readonly Role[] = ["admin", "member", "viewer"];

export const ROLE_LABEL: Record<Role, string> = { admin: "Admin", member: "Member", viewer: "Viewer" };
