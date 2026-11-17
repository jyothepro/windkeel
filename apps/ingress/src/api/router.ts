import { looksLikeApiToken } from "@windkeel/factory/tenancy";
import * as accountHandlers from "./account.js";
import * as handlers from "./handlers.js";
import * as scheduleHandlers from "./schedules.js";
import * as batchHandlers from "./batches.js";
import * as modelHandlers from "./model-credentials.js";
import * as modelPolicyHandlers from "./model-policy.js";
import * as takeoverHandlers from "./takeover.js";
import * as mergeHandlers from "./merge.js";
import * as knowledgeHandlers from "./knowledge.js";
import * as playbookHandlers from "./playbooks.js";
import * as screenshotHandlers from "./screenshots.js";
import * as billingHandlers from "./billing.js";
import type { ApiDeps, ApiResult } from "./handlers.js";
import { matchRoute } from "./route.js";
import {
  type ApiAuth,
  type ApiRequest,
  accessibleOrganizations,
  accountScope,
  authenticate,
  bearerFrom,
  enforcePolicy,
  forbiddenInAccount,
  requestContext,
  resolveOrganization,
} from "./auth.js";
import { forbidden, translateError } from "./errors.js";
import { validateResponse, validatingResponses } from "./validate.js";

export type { ApiRequest, ApiAuth, Caller, OrganizationScope } from "./auth.js";

async function signupRequest(deps: ApiDeps, auth: ApiAuth, request: ApiRequest): Promise<ApiResult> {
  if (!auth.sessions) {
    return { status: 404, body: { error: "self-serve signup needs sign-in, which this deployment does not configure", code: "signup_disabled" } };
  }
  const presented = bearerFrom(request.headers["authorization"]);
  const claims = presented && !looksLikeApiToken(presented) ? await auth.sessions.verify(presented) : null;
  if (!claims) {
    return { status: 401, body: { error: "sign in first: signup needs a signed-in session", code: "unauthenticated" }, headers: { "www-authenticate": "Bearer" } };
  }
  return billingHandlers.signup(deps, claims, request.body);
}

export async function handleApiRequest(
  deps: ApiDeps,
  auth: ApiAuth,
  request: ApiRequest,
): Promise<ApiResult> {
  const match = matchRoute(request.method, request.path);
  const result = await dispatch(deps, auth, request, match);
  if (validatingResponses() && match !== null && !("methodMismatch" in match)) {
    return validateResponse(match.matched.route.name, result);
  }
  return result;
}

async function dispatch(
  deps: ApiDeps,
  auth: ApiAuth,
  request: ApiRequest,
  match: ReturnType<typeof matchRoute>,
): Promise<ApiResult> {
  if (match === null) {
    return { status: 404, body: { error: `no route for ${request.path}`, code: "no_route" } };
  }
  if ("methodMismatch" in match) {
    return {
      status: 405,
      body: { error: `${request.method} not allowed here`, code: "method_not_allowed" },
      headers: { allow: match.methodMismatch.join(", ") },
    };
  }

  const { route, params } = match.matched;

  try {

    if (deps.schema && route.name !== "health") {
      const refusal = await deps.schema.refusal(deps.pool);
      if (refusal) return { status: 503, body: refusal };
    }

    if (route.public) {
      switch (route.name) {
        case "health":
          return await handlers.health(deps);
        case "startDeviceLogin":
          return await handlers.startDeviceLogin(deps, request.body);
        case "pollDeviceLogin":
          return await handlers.pollDeviceLogin(deps, request.body);
        case "billingWebhook":
          return await billingHandlers.billingWebhook(deps, params["provider"]!, request.rawBody, request.headers);
        case "signup":
          return await signupRequest(deps, auth, request);
        default:
          break;
      }
      return { status: 500, body: { error: "public route with no handler", code: "internal" } };
    }

    const context = requestContext(auth, request);
    const authenticated = await authenticate(deps, auth, request.headers, context);
    if ("status" in authenticated) return authenticated;
    const caller = authenticated;

    const refusedByPolicy = await enforcePolicy(deps, caller);
    if (refusedByPolicy) return refusedByPolicy;

    if (route.session && caller.via !== "session") {
      return {
        status: 403,
        body: { error: "this needs a signed-in session, not a token", code: "session_required" },
      };
    }

    const organizations = await accessibleOrganizations(deps, caller);

    if (route.account) {
      const account = await accountScope(deps, caller);
      if ("status" in account) return account;
      if (route.permission && !account.permissions.includes(route.permission)) {
        return forbiddenInAccount(route.permission, caller);
      }
      switch (route.name) {
        case "accountAuditEvents":
          return await accountHandlers.accountAuditEvents(deps, account, request.query);
        case "accountAuditExport":
          return await accountHandlers.accountAuditExport(deps, account, request.query);
        case "accountAuditVerify":
          return await accountHandlers.accountAuditVerify(deps, account);
        case "deleteAccountAuditEvents":
          return await accountHandlers.deleteAccountAuditEvents(deps, account, request.query);
        case "accessReview":
          return await accountHandlers.accessReview(deps, account, request.query);
        case "accountRoles":
          return await accountHandlers.accountRoles(deps, account);
        case "createRole":
          return await accountHandlers.createRole(deps, account, request.body);
        case "updateRole":
          return await accountHandlers.updateRole(deps, account, params["roleId"]!, request.body);
        case "deleteRole":
          return await accountHandlers.deleteRole(deps, account, params["roleId"]!);
        case "securityPolicy":
          return await accountHandlers.securityPolicy(deps, account);
        case "setSecurityPolicy":
          return await accountHandlers.setSecurityPolicy(deps, account, request.body);
        default:
          break;
      }
      return { status: 500, body: { error: "account route with no handler", code: "internal" } };
    }

    if (!route.organization) {
      switch (route.name) {
        case "self":
          return await handlers.self(deps, caller, organizations);
        case "tokens":
          return await handlers.tokens(deps, caller);
        case "createToken":
          return await handlers.createToken(deps, caller, organizations, request.body);
        case "revokeToken":
          return await handlers.revokeToken(deps, caller, params["tokenId"]!);
        case "deviceLogin":
          return await handlers.deviceLogin(deps, params["userCode"]!);
        case "approveDeviceLogin":
          return await handlers.decideDeviceLogin(deps, caller, organizations, params["userCode"]!, "approved");
        case "denyDeviceLogin":
          return await handlers.decideDeviceLogin(deps, caller, organizations, params["userCode"]!, "denied");
        case "githubAuthorization":
          return await mergeHandlers.githubAuthorization(deps, caller);
        case "connectGithub":
          return await mergeHandlers.connectGithub(deps, caller, request.body);
        case "disconnectGithub":
          return await mergeHandlers.disconnectGithub(deps, caller);
        case "linkInstallation":
          return await billingHandlers.linkInstallation(deps, caller, request.body);
        default:
          break;
      }
      return { status: 500, body: { error: "route with no handler", code: "internal" } };
    }

    const resolved = resolveOrganization(organizations, params["orgId"]);
    if ("status" in resolved) return resolved;
    const org = resolved;
    if (route.permission && !org.permissions.includes(route.permission)) {
      return forbidden(route.permission, caller);
    }

    const scope: handlers.Scope = {
      organizationId: org.id,
      actor: caller.actor,
      principalId: caller.principal.id,
      permissions: org.permissions,
      audit: caller.audit,
    };
    switch (route.name) {
      case "auditEvents":
        return await accountHandlers.auditEvents(deps, scope, request.query);
      case "auditExport":
        return await accountHandlers.auditExport(deps, scope, request.query);
      case "roles":
        return await accountHandlers.roles(deps, scope);
      case "queue":
        return await handlers.queue(deps, scope, request.query);
      case "metrics":
        return await handlers.metrics(deps, caller);
      case "reapable":
        return await handlers.reapable(deps, caller);
      case "reap":
        return await handlers.reap(deps, caller);
      case "repositories":
        return await handlers.repositories(deps, scope, request.query);
      case "tasks":
        return await handlers.tasks(deps, scope, request.query);
      case "task":
        return await handlers.task(deps, scope, params["taskId"]!);
      case "taskRuns":
        return await handlers.taskRuns(deps, scope, params["taskId"]!, request.query);
      case "createTask":
        return await handlers.createTask(deps, scope, request.body, request.headers["idempotency-key"]);
      case "runs":
        return await handlers.runs(deps, scope, request.query);
      case "runChanges":
        return await handlers.runChanges(deps, scope, request.query);
      case "run":
        return await handlers.run(deps, scope, params["runId"]!);
      case "runEvents":
        return await handlers.runEvents(deps, scope, params["runId"]!, request.query);
      case "runAttempts":
        return await handlers.runAttempts(deps, scope, params["runId"]!);
      case "runCost":
        return await handlers.runCost(deps, scope, params["runId"]!);
      case "runDiff":
        return await handlers.runDiff(deps, scope, params["runId"]!, request.query);
      case "runEvidence":
        return await handlers.runEvidence(deps, scope, params["runId"]!);
      case "runEvidenceFile":
        return await handlers.runEvidenceFile(deps, scope, params["runId"]!, params["path"]!, request.query);
      case "runMessages":
        return await handlers.runMessages(deps, scope, params["runId"]!);
      case "sendRunMessage":
        return await handlers.sendRunMessage(deps, scope, params["runId"]!, request.body);
      case "approveRun":
        return await handlers.approveRun(deps, scope, params["runId"]!);
      case "cancelRun":
        return await handlers.cancelRun(deps, scope, params["runId"]!, request.body);
      case "captureRun":
        return await handlers.captureRun(deps, scope, params["runId"]!);
      case "runCapture":
        return await handlers.runCapture(deps, scope, params["runId"]!);
      case "runWorkspace":
        return await handlers.runWorkspace(deps, scope, params["runId"]!, request.query);
      case "runScreenshots":
        return await screenshotHandlers.runScreenshots(deps, scope, params["runId"]!);
      case "runScreenshotFile":
        return await screenshotHandlers.runScreenshotFile(deps, scope, params["runId"]!, params["screenshotId"]!);
      case "takeoverRun":
        return await takeoverHandlers.takeoverRun(deps, scope, params["runId"]!);
      case "submitRun":
        return await takeoverHandlers.submitRun(deps, scope, params["runId"]!);
      case "handbackRun":
        return await takeoverHandlers.handbackRun(deps, scope, params["runId"]!);
      case "openWorkspaceSession":
        return await takeoverHandlers.openWorkspaceSession(deps, scope, params["runId"]!);
      case "runCaptureFile":
        return await handlers.runCaptureFile(deps, scope, params["runId"]!, params["path"]!);
      case "createRun":
        return await handlers.createRun(deps, scope, request.body);
      case "repositorySecrets":
        return await handlers.repositorySecrets(deps, scope, params["repositoryId"]!);
      case "createRepositorySecret":
        return await handlers.createRepositorySecret(deps, scope, params["repositoryId"]!, request.body);
      case "deleteRepositorySecret":
        return await handlers.deleteRepositorySecret(deps, scope, params["repositoryId"]!, params["key"]!);
      case "repositoryEnvironment":
        return await handlers.repositoryEnvironment(deps, scope, params["repositoryId"]!);
      case "rebuildRepositoryEnvironment":
        return await handlers.rebuildRepositoryEnvironment(deps, scope, params["repositoryId"]!);
      case "invalidateRepositoryEnvironment":
        return await handlers.invalidateRepositoryEnvironment(deps, scope, params["repositoryId"]!);
      case "members":
        return await handlers.members(deps, scope);
      case "setMemberRole":
        return await handlers.setMemberRole(deps, scope, params["principalId"]!, request.body);
      case "removeMember":
        return await handlers.removeMember(deps, scope, params["principalId"]!);
      case "invitations":
        return await handlers.invitations(deps, scope);
      case "createInvitation":
        return await handlers.createInvitation(deps, scope, request.body);
      case "deleteInvitation":
        return await handlers.deleteInvitation(deps, scope, params["invitationId"]!);
      case "grants":
        return await handlers.grants(deps, scope);
      case "createGrant":
        return await handlers.createGrant(deps, scope, request.body);
      case "deleteGrant":
        return await handlers.deleteGrant(deps, scope, params["repositoryId"]!);
      case "servicePrincipals":
        return await handlers.servicePrincipals(deps, scope);
      case "createServicePrincipal":
        return await handlers.createServicePrincipal(deps, scope, request.body);
      case "deleteServicePrincipal":
      case "deleteServicePrincipalCommand":
        return await handlers.deleteServicePrincipal(deps, scope, params["principalId"]!);
      case "serviceTokens":
        return await handlers.serviceTokens(deps, scope, params["principalId"]!);
      case "createServiceToken":
        return await handlers.createServiceToken(deps, scope, params["principalId"]!, request.body);
      case "revokeServiceToken":
      case "revokeServiceTokenCommand":
        return await handlers.revokeServiceToken(deps, scope, params["principalId"]!, params["tokenId"]!);
      case "integrations":
        return await handlers.integrations(deps, scope);
      case "createIntegration":
        return await handlers.createIntegration(deps, scope, request.body);
      case "deleteIntegration":
        return await handlers.deleteIntegration(deps, scope, params["integrationId"]!);
      case "createIntegrationRoute":
        return await handlers.createIntegrationRoute(deps, scope, params["integrationId"]!, request.body);
      case "updateIntegrationRoute":
        return await handlers.updateIntegrationRoute(
          deps,
          scope,
          params["integrationId"]!,
          params["routeId"]!,
          request.body,
        );
      case "deleteIntegrationRoute":
        return await handlers.deleteIntegrationRoute(deps, scope, params["integrationId"]!, params["routeId"]!);
      case "schedules":
        return await scheduleHandlers.schedules(deps, scope, request.query);
      case "previewSchedule":
        return await scheduleHandlers.previewSchedule(request.query);
      case "schedule":
        return await scheduleHandlers.schedule(deps, scope, params["scheduleId"]!);
      case "createSchedule":
        return await scheduleHandlers.createSchedule(deps, scope, request.body);
      case "updateSchedule":
        return await scheduleHandlers.updateSchedule(deps, scope, params["scheduleId"]!, request.body);
      case "deleteSchedule":
        return await scheduleHandlers.deleteSchedule(deps, scope, params["scheduleId"]!);
      case "fireSchedule":
        return await scheduleHandlers.fireSchedule(deps, scope, params["scheduleId"]!);
      case "batches":
        return await batchHandlers.batches(deps, scope, request.query);
      case "batch":
        return await batchHandlers.batch(deps, scope, params["batchId"]!);
      case "createBatch":
        return await batchHandlers.createBatch(deps, scope, request.body, request.headers["idempotency-key"]);
      case "pauseBatch":
        return await batchHandlers.pauseBatch(deps, scope, params["batchId"]!);
      case "resumeBatch":
        return await batchHandlers.resumeBatch(deps, scope, params["batchId"]!);
      case "cancelBatch":
        return await batchHandlers.cancelBatch(deps, scope, params["batchId"]!);
      case "webhookEndpoints":
        return await handlers.webhookEndpoints(deps, scope);
      case "createWebhookEndpoint":
        return await handlers.createWebhookEndpoint(deps, scope, request.body);
      case "updateWebhookEndpoint":
        return await handlers.updateWebhookEndpoint(deps, scope, params["endpointId"]!, request.body);
      case "deleteWebhookEndpoint":
        return await handlers.deleteWebhookEndpoint(deps, scope, params["endpointId"]!);
      case "rotateWebhookEndpoint":
        return await handlers.rotateWebhookEndpoint(deps, scope, params["endpointId"]!);
      case "modelCredentials":
        return await modelHandlers.modelCredentials(deps, scope, request.query);
      case "createModelCredential":
        return await modelHandlers.createModelCredential(deps, scope, request.body);
      case "rotateModelCredential":
        return await modelHandlers.rotateModelCredential(deps, scope, params["credentialId"]!, request.body);
      case "revokeModelCredential":
        return await modelHandlers.revokeModelCredential(deps, scope, params["credentialId"]!);
      case "validateModelCredential":
        return await modelHandlers.validateModelCredential(deps, scope, params["credentialId"]!);
      case "modelPolicy":
        return await modelPolicyHandlers.modelPolicy(deps, scope, request.query);
      case "setModelPolicy":
        return await modelPolicyHandlers.setModelPolicy(deps, scope, request.query, request.body);
      case "deleteModelPolicy":
        return await modelPolicyHandlers.deleteModelPolicy(deps, scope, request.query);
      case "modelPresets":
        return await modelPolicyHandlers.modelPresets(deps, scope);
      case "createModelPreset":
        return await modelPolicyHandlers.createModelPreset(deps, scope, request.body);
      case "updateModelPreset":
        return await modelPolicyHandlers.updateModelPreset(deps, scope, params["presetId"]!, request.body);
      case "deleteModelPreset":
        return await modelPolicyHandlers.deleteModelPreset(deps, scope, params["presetId"]!);
      case "playbooks":
        return await playbookHandlers.playbooks(deps, scope);
      case "playbook":
        return await playbookHandlers.playbook(deps, scope, params["playbookId"]!);
      case "createPlaybook":
        return await playbookHandlers.createPlaybook(deps, scope, request.body);
      case "updatePlaybook":
        return await playbookHandlers.updatePlaybook(deps, scope, params["playbookId"]!, request.body);
      case "archivePlaybook":
        return await playbookHandlers.archivePlaybook(deps, scope, params["playbookId"]!);
      case "merging":
        return await mergeHandlers.merging(deps, scope);
      case "setMerging":
        return await mergeHandlers.setMerging(deps, scope, request.body);
      case "mergeEligibility":
        return await mergeHandlers.mergeEligibility(deps, scope, params["runId"]!);
      case "mergeRun":
        return await mergeHandlers.mergeRun(deps, scope, params["runId"]!, request.body);
      case "knowledgeNotes":
        return await knowledgeHandlers.knowledgeNotes(deps, scope, request.query);
      case "createKnowledgeNote":
        return await knowledgeHandlers.createKnowledgeNote(deps, scope, request.body);
      case "updateKnowledgeNote":
        return await knowledgeHandlers.updateKnowledgeNote(deps, scope, params["noteId"]!, request.body);
      case "setKnowledgeNoteStatus":
        return await knowledgeHandlers.setKnowledgeNoteStatus(deps, scope, params["noteId"]!, request.body);
      case "deleteKnowledgeNote":
      case "deleteKnowledgeNoteCommand":
        return await knowledgeHandlers.deleteKnowledgeNote(deps, scope, params["noteId"]!);
      case "knowledgeNoteRevisions":
        return await knowledgeHandlers.knowledgeNoteRevisions(deps, scope, params["noteId"]!);
      case "repositoryDigest":
        return await knowledgeHandlers.repositoryDigest(deps, scope, params["repositoryId"]!, request.query);
      case "runKnowledge":
        return await knowledgeHandlers.runKnowledge(deps, scope, params["runId"]!);
      case "usage":
        return await billingHandlers.usage(deps, scope, request.query);
      case "budget":
        return await billingHandlers.budget(deps, scope);
      case "setBudget":
        return await billingHandlers.setBudget(deps, scope, request.body);
      case "billing":
        return await billingHandlers.billing(deps, scope);
      case "billingCheckout":
        return await billingHandlers.billingLink(deps, scope, request.body, "checkout");
      case "billingPortal":
        return await billingHandlers.billingLink(deps, scope, request.body, "portal");
      case "billingBalance":
        return await billingHandlers.balance(deps, scope);
      case "billingStatement":
        return await billingHandlers.statement(deps, scope, request.query);
      case "setOverage":
        return await billingHandlers.setOverage(deps, scope, request.body);
      case "changePlan":
        return await billingHandlers.changePlan(deps, scope, request.body);
      case "runReceipt":
        return await billingHandlers.receipt(deps, scope, params["runId"]!);
      case "installLink":
        return await billingHandlers.installLink(deps, scope);
      default:
        break;
    }
    return { status: 500, body: { error: "route with no handler", code: "internal" } };
  } catch (err) {
    return translateError(err);
  }
}
