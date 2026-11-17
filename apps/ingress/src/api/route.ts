export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Permission =
  | "runs.read"
  | "runs.write"
  | "runs.approve"
  | "secrets.manage"
  | "repositories.manage"
  | "members.manage"
  | "tokens.manage"
  | "integrations.manage"
  | "schedules.manage"
  | "models.read"
  | "models.manage"
  | "runs.takeover"
  | "runs.merge"
  | "audit.read"
  | "roles.manage"
  | "account.manage"
  | "knowledge.manage"
  | "playbooks.read"
  | "playbooks.manage"
  | "batches.manage"
  | "billing.manage";

export interface RouteDefinition {
  method: Method;
  pattern: string;
  name: RouteName;
  command?: boolean;
  public?: boolean;
  organization?: boolean;
  permission?: Permission;
  account?: boolean;
  session?: boolean;
}

export type RouteName =
  | "self"
  | "health"
  | "queue"
  | "metrics"
  | "repositories"
  | "repositorySecrets"
  | "createRepositorySecret"
  | "deleteRepositorySecret"
  | "repositoryEnvironment"
  | "rebuildRepositoryEnvironment"
  | "invalidateRepositoryEnvironment"
  | "tasks"
  | "task"
  | "taskRuns"
  | "createTask"
  | "runs"
  | "run"
  | "runEvents"
  | "runChanges"
  | "runAttempts"
  | "runCost"
  | "runDiff"
  | "runEvidence"
  | "runEvidenceFile"
  | "runMessages"
  | "createRun"
  | "sendRunMessage"
  | "approveRun"
  | "cancelRun"
  | "captureRun"
  | "runCapture"
  | "runCaptureFile"
  | "runWorkspace"
  | "runScreenshots"
  | "runScreenshotFile"
  | "reapable"
  | "reap"
  | "tokens"
  | "createToken"
  | "revokeToken"
  | "startDeviceLogin"
  | "pollDeviceLogin"
  | "deviceLogin"
  | "approveDeviceLogin"
  | "denyDeviceLogin"
  | "members"
  | "setMemberRole"
  | "removeMember"
  | "invitations"
  | "createInvitation"
  | "deleteInvitation"
  | "grants"
  | "createGrant"
  | "deleteGrant"
  | "servicePrincipals"
  | "createServicePrincipal"
  | "deleteServicePrincipal"
  | "deleteServicePrincipalCommand"
  | "serviceTokens"
  | "createServiceToken"
  | "revokeServiceToken"
  | "revokeServiceTokenCommand"
  | "integrations"
  | "createIntegration"
  | "deleteIntegration"
  | "createIntegrationRoute"
  | "updateIntegrationRoute"
  | "deleteIntegrationRoute"
  | "schedules"
  | "previewSchedule"
  | "schedule"
  | "createSchedule"
  | "updateSchedule"
  | "deleteSchedule"
  | "fireSchedule"
  | "webhookEndpoints"
  | "createWebhookEndpoint"
  | "updateWebhookEndpoint"
  | "deleteWebhookEndpoint"
  | "rotateWebhookEndpoint"
  | "modelCredentials"
  | "createModelCredential"
  | "rotateModelCredential"
  | "revokeModelCredential"
  | "validateModelCredential"
  | "modelPolicy"
  | "setModelPolicy"
  | "deleteModelPolicy"
  | "modelPresets"
  | "createModelPreset"
  | "updateModelPreset"
  | "deleteModelPreset"
  | "takeoverRun"
  | "submitRun"
  | "handbackRun"
  | "openWorkspaceSession"
  | "merging"
  | "setMerging"
  | "githubAuthorization"
  | "connectGithub"
  | "disconnectGithub"
  | "mergeEligibility"
  | "mergeRun"
  | "auditEvents"
  | "auditExport"
  | "roles"
  | "accountAuditEvents"
  | "accountAuditExport"
  | "accountAuditVerify"
  | "deleteAccountAuditEvents"
  | "accountRoles"
  | "createRole"
  | "updateRole"
  | "deleteRole"
  | "securityPolicy"
  | "setSecurityPolicy"
  | "accessReview"
  | "knowledgeNotes"
  | "createKnowledgeNote"
  | "updateKnowledgeNote"
  | "setKnowledgeNoteStatus"
  | "deleteKnowledgeNote"
  | "deleteKnowledgeNoteCommand"
  | "knowledgeNoteRevisions"
  | "repositoryDigest"
  | "runKnowledge"
  | "playbooks"
  | "playbook"
  | "createPlaybook"
  | "updatePlaybook"
  | "archivePlaybook"
  | "batches"
  | "batch"
  | "createBatch"
  | "pauseBatch"
  | "resumeBatch"
  | "cancelBatch"
  | "usage"
  | "budget"
  | "setBudget"
  | "billing"
  | "billingCheckout"
  | "billingPortal"
  | "billingWebhook"
  | "billingBalance"
  | "billingStatement"
  | "setOverage"
  | "changePlan"
  | "runReceipt"
  | "signup"
  | "installLink"
  | "linkInstallation";

const READ = { organization: true, permission: "runs.read" } as const;
const WRITE = { organization: true, permission: "runs.write", command: true } as const;
const SECRETS = { organization: true, permission: "secrets.manage" } as const;
const MEMBERS = { organization: true, permission: "members.manage" } as const;
const GRANTS = { organization: true, permission: "repositories.manage", command: true } as const;
const SERVICE = { organization: true, permission: "tokens.manage" } as const;
const INTEGRATIONS = { organization: true, permission: "integrations.manage", command: true } as const;
const SCHEDULES = { organization: true, permission: "schedules.manage", command: true } as const;
const MODELS = { organization: true, permission: "models.manage", command: true } as const;
const BATCHES = { organization: true, permission: "batches.manage", command: true } as const;
const TAKEOVER = { organization: true, permission: "runs.takeover", command: true } as const;
const AUDIT = { account: true, permission: "audit.read" } as const;
const ROLES = { account: true, permission: "roles.manage" } as const;
const ACCOUNT = { account: true, permission: "account.manage" } as const;
const KNOWLEDGE = { organization: true, permission: "knowledge.manage", command: true } as const;
const PLAYBOOKS = { organization: true, permission: "playbooks.manage", command: true } as const;

export const ROUTES: readonly RouteDefinition[] = [
  { method: "GET", pattern: "/v1/health", name: "health", public: true },
  { method: "GET", pattern: "/v1/self", name: "self" },
  { method: "GET", pattern: "/v1/queue", name: "queue", ...READ },
  { method: "GET", pattern: "/v1/metrics", name: "metrics", ...READ },

  { method: "GET", pattern: "/v1/repositories", name: "repositories", ...READ },
  { method: "GET", pattern: "/v1/repositories/grants", name: "grants", ...READ },
  { method: "POST", pattern: "/v1/repositories/grants", name: "createGrant", ...GRANTS },
  { method: "POST", pattern: "/v1/repositories/grants/:repositoryId/delete", name: "deleteGrant", ...GRANTS },
  { method: "GET", pattern: "/v1/repositories/:repositoryId/secrets", name: "repositorySecrets", ...SECRETS },
  { method: "POST", pattern: "/v1/repositories/:repositoryId/secrets", name: "createRepositorySecret", ...SECRETS, command: true },
  { method: "POST", pattern: "/v1/repositories/:repositoryId/secrets/:key/delete", name: "deleteRepositorySecret", ...SECRETS, command: true },
  { method: "GET", pattern: "/v1/repositories/:repositoryId/environment", name: "repositoryEnvironment", ...SECRETS },
  { method: "POST", pattern: "/v1/repositories/:repositoryId/environment/rebuild", name: "rebuildRepositoryEnvironment", ...SECRETS, command: true },
  { method: "POST", pattern: "/v1/repositories/:repositoryId/environment/invalidate", name: "invalidateRepositoryEnvironment", ...SECRETS, command: true },

  { method: "GET", pattern: "/v1/tasks", name: "tasks", ...READ },
  { method: "POST", pattern: "/v1/tasks", name: "createTask", ...WRITE },
  { method: "GET", pattern: "/v1/tasks/:taskId", name: "task", ...READ },
  { method: "GET", pattern: "/v1/tasks/:taskId/runs", name: "taskRuns", ...READ },

  { method: "GET", pattern: "/v1/runs", name: "runs", ...READ },
  { method: "GET", pattern: "/v1/events", name: "runChanges", ...READ },
  { method: "POST", pattern: "/v1/runs", name: "createRun", ...WRITE },
  { method: "GET", pattern: "/v1/runs/:runId", name: "run", ...READ },
  { method: "GET", pattern: "/v1/runs/:runId/events", name: "runEvents", ...READ },
  { method: "GET", pattern: "/v1/runs/:runId/attempts", name: "runAttempts", ...READ },
  { method: "GET", pattern: "/v1/runs/:runId/cost", name: "runCost", ...READ },
  { method: "GET", pattern: "/v1/runs/:runId/diff", name: "runDiff", ...READ },
  { method: "GET", pattern: "/v1/runs/:runId/evidence", name: "runEvidence", ...READ },
  { method: "GET", pattern: "/v1/runs/:runId/evidence/*path", name: "runEvidenceFile", ...READ },
  { method: "GET", pattern: "/v1/runs/:runId/messages", name: "runMessages", ...READ },
  { method: "POST", pattern: "/v1/runs/:runId/messages", name: "sendRunMessage", ...WRITE },
  { method: "POST", pattern: "/v1/runs/:runId/approve", name: "approveRun", ...WRITE, permission: "runs.approve" },
  { method: "POST", pattern: "/v1/runs/:runId/cancel", name: "cancelRun", ...WRITE },
  { method: "POST", pattern: "/v1/runs/:runId/capture", name: "captureRun", ...WRITE },
  { method: "GET", pattern: "/v1/runs/:runId/capture", name: "runCapture", ...READ },
  { method: "GET", pattern: "/v1/runs/:runId/capture/*path", name: "runCaptureFile", ...READ },
  { method: "GET", pattern: "/v1/runs/:runId/workspace", name: "runWorkspace", ...READ },
  { method: "GET", pattern: "/v1/runs/:runId/screenshots", name: "runScreenshots", ...READ },
  { method: "GET", pattern: "/v1/runs/:runId/screenshots/:screenshotId", name: "runScreenshotFile", ...READ },
  { method: "POST", pattern: "/v1/runs/:runId/takeover", name: "takeoverRun", ...TAKEOVER },
  { method: "POST", pattern: "/v1/runs/:runId/submit", name: "submitRun", ...TAKEOVER },
  { method: "POST", pattern: "/v1/runs/:runId/handback", name: "handbackRun", ...TAKEOVER },
  { method: "POST", pattern: "/v1/runs/:runId/workspace/session", name: "openWorkspaceSession", ...TAKEOVER },
  { method: "GET", pattern: "/v1/runs/:runId/merge-eligibility", name: "mergeEligibility", ...READ },
  { method: "POST", pattern: "/v1/runs/:runId/merge", name: "mergeRun", ...WRITE, permission: "runs.merge", session: true },
  { method: "GET", pattern: "/v1/merging", name: "merging", ...READ },
  { method: "PUT", pattern: "/v1/merging", name: "setMerging", ...MEMBERS, command: true },

  { method: "GET", pattern: "/v1/sandboxes/reapable", name: "reapable", ...READ },
  { method: "POST", pattern: "/v1/sandboxes/reap", name: "reap", ...WRITE },

  { method: "GET", pattern: "/v1/usage", name: "usage", ...READ },
  { method: "GET", pattern: "/v1/budget", name: "budget", ...READ },
  { method: "PUT", pattern: "/v1/budget", name: "setBudget", organization: true, permission: "billing.manage", command: true },
  { method: "GET", pattern: "/v1/billing", name: "billing", ...READ },
  { method: "POST", pattern: "/v1/billing/checkout", name: "billingCheckout", organization: true, permission: "billing.manage", command: true },
  { method: "POST", pattern: "/v1/billing/portal", name: "billingPortal", organization: true, permission: "billing.manage", command: true },
  { method: "POST", pattern: "/v1/billing/webhooks/:provider", name: "billingWebhook", command: true, public: true },
  { method: "GET", pattern: "/v1/billing/balance", name: "billingBalance", ...READ },
  { method: "GET", pattern: "/v1/billing/statement", name: "billingStatement", ...READ },
  { method: "PUT", pattern: "/v1/billing/overage", name: "setOverage", organization: true, permission: "billing.manage", command: true },
  { method: "POST", pattern: "/v1/billing/plan", name: "changePlan", organization: true, permission: "billing.manage", command: true },
  { method: "GET", pattern: "/v1/runs/:runId/receipt", name: "runReceipt", ...READ },
  { method: "POST", pattern: "/v1/signup", name: "signup", command: true, public: true },
  { method: "POST", pattern: "/v1/github-installations/state", name: "installLink", ...GRANTS },
  { method: "POST", pattern: "/v1/github-installations", name: "linkInstallation", command: true },

  { method: "GET", pattern: "/v1/members", name: "members", ...READ },
  { method: "POST", pattern: "/v1/members/:principalId/role", name: "setMemberRole", ...MEMBERS, command: true },
  { method: "POST", pattern: "/v1/members/:principalId/delete", name: "removeMember", ...MEMBERS, command: true },
  { method: "GET", pattern: "/v1/invitations", name: "invitations", ...MEMBERS },
  { method: "POST", pattern: "/v1/invitations", name: "createInvitation", ...MEMBERS, command: true },
  { method: "POST", pattern: "/v1/invitations/:invitationId/delete", name: "deleteInvitation", ...MEMBERS, command: true },

  { method: "GET", pattern: "/v1/integrations", name: "integrations", ...READ },
  { method: "POST", pattern: "/v1/integrations", name: "createIntegration", ...INTEGRATIONS },
  { method: "DELETE", pattern: "/v1/integrations/:integrationId", name: "deleteIntegration", ...INTEGRATIONS },
  { method: "POST", pattern: "/v1/integrations/:integrationId/routes", name: "createIntegrationRoute", ...INTEGRATIONS },
  { method: "PATCH", pattern: "/v1/integrations/:integrationId/routes/:routeId", name: "updateIntegrationRoute", ...INTEGRATIONS },
  { method: "DELETE", pattern: "/v1/integrations/:integrationId/routes/:routeId", name: "deleteIntegrationRoute", ...INTEGRATIONS },

  { method: "GET", pattern: "/v1/schedules", name: "schedules", ...READ },
  { method: "POST", pattern: "/v1/schedules", name: "createSchedule", ...SCHEDULES },
  { method: "GET", pattern: "/v1/schedules/preview", name: "previewSchedule", ...READ },
  { method: "GET", pattern: "/v1/schedules/:scheduleId", name: "schedule", ...READ },
  { method: "PATCH", pattern: "/v1/schedules/:scheduleId", name: "updateSchedule", ...SCHEDULES },
  { method: "DELETE", pattern: "/v1/schedules/:scheduleId", name: "deleteSchedule", ...SCHEDULES },
  { method: "POST", pattern: "/v1/schedules/:scheduleId/fire", name: "fireSchedule", ...SCHEDULES },

  { method: "GET", pattern: "/v1/batches", name: "batches", ...READ },
  { method: "POST", pattern: "/v1/batches", name: "createBatch", ...BATCHES },
  { method: "GET", pattern: "/v1/batches/:batchId", name: "batch", ...READ },
  { method: "POST", pattern: "/v1/batches/:batchId/pause", name: "pauseBatch", ...BATCHES },
  { method: "POST", pattern: "/v1/batches/:batchId/resume", name: "resumeBatch", ...BATCHES },
  { method: "POST", pattern: "/v1/batches/:batchId/cancel", name: "cancelBatch", ...BATCHES },

  { method: "GET", pattern: "/v1/webhook-endpoints", name: "webhookEndpoints", organization: true, permission: "integrations.manage" },
  { method: "POST", pattern: "/v1/webhook-endpoints", name: "createWebhookEndpoint", ...INTEGRATIONS },
  { method: "PATCH", pattern: "/v1/webhook-endpoints/:endpointId", name: "updateWebhookEndpoint", ...INTEGRATIONS },
  { method: "DELETE", pattern: "/v1/webhook-endpoints/:endpointId", name: "deleteWebhookEndpoint", ...INTEGRATIONS },
  { method: "POST", pattern: "/v1/webhook-endpoints/:endpointId/rotate", name: "rotateWebhookEndpoint", ...INTEGRATIONS },

  { method: "GET", pattern: "/v1/model-credentials", name: "modelCredentials", organization: true, permission: "models.read" },
  { method: "POST", pattern: "/v1/model-credentials", name: "createModelCredential", ...MODELS },
  { method: "PUT", pattern: "/v1/model-credentials/:credentialId", name: "rotateModelCredential", ...MODELS },
  { method: "DELETE", pattern: "/v1/model-credentials/:credentialId", name: "revokeModelCredential", ...MODELS },
  { method: "POST", pattern: "/v1/model-credentials/:credentialId/validate", name: "validateModelCredential", ...MODELS },
  { method: "GET", pattern: "/v1/model-policy", name: "modelPolicy", organization: true, permission: "models.read" },
  { method: "PUT", pattern: "/v1/model-policy", name: "setModelPolicy", ...MODELS },
  { method: "DELETE", pattern: "/v1/model-policy", name: "deleteModelPolicy", ...MODELS },
  { method: "GET", pattern: "/v1/model-policy/presets", name: "modelPresets", organization: true, permission: "models.read" },
  { method: "POST", pattern: "/v1/model-policy/presets", name: "createModelPreset", ...MODELS },
  { method: "PUT", pattern: "/v1/model-policy/presets/:presetId", name: "updateModelPreset", ...MODELS },
  { method: "DELETE", pattern: "/v1/model-policy/presets/:presetId", name: "deleteModelPreset", ...MODELS },

  { method: "GET", pattern: "/v1/knowledge", name: "knowledgeNotes", ...READ },
  { method: "POST", pattern: "/v1/knowledge", name: "createKnowledgeNote", ...KNOWLEDGE },
  { method: "POST", pattern: "/v1/knowledge/:noteId", name: "updateKnowledgeNote", ...KNOWLEDGE },
  { method: "DELETE", pattern: "/v1/knowledge/:noteId", name: "deleteKnowledgeNote", ...KNOWLEDGE },
  { method: "POST", pattern: "/v1/knowledge/:noteId/status", name: "setKnowledgeNoteStatus", ...KNOWLEDGE },
  { method: "POST", pattern: "/v1/knowledge/:noteId/delete", name: "deleteKnowledgeNoteCommand", ...KNOWLEDGE },
  { method: "GET", pattern: "/v1/knowledge/:noteId/revisions", name: "knowledgeNoteRevisions", ...READ },
  { method: "GET", pattern: "/v1/repositories/:repositoryId/digest", name: "repositoryDigest", ...READ },
  { method: "GET", pattern: "/v1/runs/:runId/knowledge", name: "runKnowledge", ...READ },

  { method: "GET", pattern: "/v1/playbooks", name: "playbooks", organization: true, permission: "playbooks.read" },
  { method: "POST", pattern: "/v1/playbooks", name: "createPlaybook", ...PLAYBOOKS },
  { method: "GET", pattern: "/v1/playbooks/:playbookId", name: "playbook", organization: true, permission: "playbooks.read" },
  { method: "PATCH", pattern: "/v1/playbooks/:playbookId", name: "updatePlaybook", ...PLAYBOOKS },
  { method: "DELETE", pattern: "/v1/playbooks/:playbookId", name: "archivePlaybook", ...PLAYBOOKS },

  { method: "GET", pattern: "/v1/tokens", name: "tokens" },
  { method: "POST", pattern: "/v1/tokens", name: "createToken", command: true },
  { method: "POST", pattern: "/v1/tokens/:tokenId/revoke", name: "revokeToken", command: true },

  { method: "GET", pattern: "/v1/github-authorization", name: "githubAuthorization" },
  { method: "POST", pattern: "/v1/github-authorization", name: "connectGithub", command: true, session: true },
  { method: "DELETE", pattern: "/v1/github-authorization", name: "disconnectGithub", command: true, session: true },

  { method: "GET", pattern: "/v1/service-principals", name: "servicePrincipals", ...SERVICE },
  { method: "POST", pattern: "/v1/service-principals", name: "createServicePrincipal", ...SERVICE, command: true },
  { method: "DELETE", pattern: "/v1/service-principals/:principalId", name: "deleteServicePrincipal", ...SERVICE, command: true },
  { method: "POST", pattern: "/v1/service-principals/:principalId/delete", name: "deleteServicePrincipalCommand", ...SERVICE, command: true },
  { method: "GET", pattern: "/v1/service-principals/:principalId/tokens", name: "serviceTokens", ...SERVICE },
  { method: "POST", pattern: "/v1/service-principals/:principalId/tokens", name: "createServiceToken", ...SERVICE, command: true },
  { method: "DELETE", pattern: "/v1/service-principals/:principalId/tokens/:tokenId", name: "revokeServiceToken", ...SERVICE, command: true },
  { method: "POST", pattern: "/v1/service-principals/:principalId/tokens/:tokenId/revoke", name: "revokeServiceTokenCommand", ...SERVICE, command: true },

  { method: "GET", pattern: "/v1/audit-events", name: "auditEvents", organization: true, permission: "audit.read" },
  { method: "GET", pattern: "/v1/audit-events/export", name: "auditExport", organization: true, permission: "audit.read" },
  { method: "GET", pattern: "/v1/roles", name: "roles", organization: true, permission: "members.manage" },

  { method: "GET", pattern: "/v1/account/audit-events", name: "accountAuditEvents", ...AUDIT },
  { method: "DELETE", pattern: "/v1/account/audit-events", name: "deleteAccountAuditEvents", ...ACCOUNT, command: true },
  { method: "GET", pattern: "/v1/account/audit-events/export", name: "accountAuditExport", ...AUDIT },
  { method: "GET", pattern: "/v1/account/audit-events/verify", name: "accountAuditVerify", ...AUDIT },
  { method: "GET", pattern: "/v1/account/access-review", name: "accessReview", ...AUDIT },
  { method: "GET", pattern: "/v1/account/roles", name: "accountRoles", ...ROLES },
  { method: "POST", pattern: "/v1/account/roles", name: "createRole", ...ROLES, command: true },
  { method: "PATCH", pattern: "/v1/account/roles/:roleId", name: "updateRole", ...ROLES, command: true },
  { method: "DELETE", pattern: "/v1/account/roles/:roleId", name: "deleteRole", ...ROLES, command: true },
  { method: "GET", pattern: "/v1/account/security-policy", name: "securityPolicy", ...ACCOUNT },
  { method: "PUT", pattern: "/v1/account/security-policy", name: "setSecurityPolicy", ...ACCOUNT, command: true },

  { method: "POST", pattern: "/v1/auth/device", name: "startDeviceLogin", command: true, public: true },
  { method: "POST", pattern: "/v1/auth/device/token", name: "pollDeviceLogin", command: true, public: true },
  { method: "GET", pattern: "/v1/auth/device/:userCode", name: "deviceLogin", session: true },
  { method: "POST", pattern: "/v1/auth/device/:userCode/approve", name: "approveDeviceLogin", command: true, session: true },
  { method: "POST", pattern: "/v1/auth/device/:userCode/deny", name: "denyDeviceLogin", command: true, session: true },
];

export interface Matched {
  route: RouteDefinition;
  params: Record<string, string>;
}

export function matchRoute(
  method: string,
  path: string,
): { matched: Matched } | { methodMismatch: Method[] } | null {
  const scoped = organizationPrefix(path);
  const segments = splitPath(scoped ? scoped.rest : path);
  const pathMatches: RouteDefinition[] = [];

  for (const route of ROUTES) {
    if (scoped && !route.organization) continue;
    const params = matchSegments(splitPath(route.pattern), segments);
    if (params === null) continue;
    pathMatches.push(route);
    if (route.method === method) {
      return { matched: { route, params: scoped ? { ...params, orgId: scoped.orgId } : params } };
    }
  }

  if (pathMatches.length > 0) {
    return { methodMismatch: [...new Set(pathMatches.map((r) => r.method))] };
  }
  return null;
}

function organizationPrefix(path: string): { orgId: string; rest: string } | null {
  const segments = splitPath(path);
  if (segments[0] !== "v1" || segments[1] !== "orgs" || !segments[2] || segments.length < 4) return null;
  return { orgId: decodeURIComponent(segments[2]), rest: `/v1/${segments.slice(3).join("/")}` };
}

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i]!;
    if (expected.startsWith("*")) {
      const rest = actual.slice(i);
      if (rest.length === 0) return null;
      params[expected.slice(1)] = rest.join("/");
      return params;
    }
    const segment = actual[i];
    if (segment === undefined) return null;
    if (expected.startsWith(":")) {
      if (segment === "") return null;
      params[expected.slice(1)] = decodeURIComponent(segment);
      continue;
    }
    if (segment !== expected) return null;
  }
  return actual.length === pattern.length ? params : null;
}
