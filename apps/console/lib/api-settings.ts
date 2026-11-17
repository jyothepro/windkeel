import "./env-compat.ts";
import * as fixtures from "./fixtures.ts";
import { automationsClient, type AutomationsApi } from "./automations.ts";
import { modelsClient, type ModelsApi } from "./models.ts";
import { knowledgeClient, type KnowledgeApi } from "./knowledge.ts";
import { buildPicker, type ModelPicker } from "./model-picker.ts";
import { canReadPlaybooks, playbooksClient, type Playbook, type PlaybooksApi } from "./playbooks.ts";
import { ApiError, callApi, refusal } from "./http.ts";
import type { BillingView, BudgetView, UsageView } from "./billing.ts";
import type { CreditBalanceView } from "./credits.ts";
import { visibleTabs } from "./permissions.ts";
import type { SelfView } from "./types.ts";
import {
  apiAuth,
  currentOrganization,
  getIdentity,
  live,
  liveOr,
  query,
  request,
  sampleOnly,
} from "./api-transport.ts";

export async function loadModelPicker(): Promise<ModelPicker | null> {
  try {
    const org = await currentOrganization(await getIdentity());
    if (!org || !(org.permissions.includes("models.read") || org.permissions.includes("models.manage"))) return null;
    const [policy, credentials] = await Promise.all([models.getPolicy(org.id), models.listCredentials(org.id)]);
    return buildPicker(policy, credentials);
  } catch {
    return null;
  }
}

const automationsLive = automationsClient((method, path, body) => request(method, path, body));

const L = automationsLive;

export const automations: AutomationsApi = {
  listIntegrations: (org) => liveOr(() => L.listIntegrations(org), fixtures.integrations),
  connectIntegration: (org, input) => liveOr(() => L.connectIntegration(org, input)),
  disconnectIntegration: (org, id) => liveOr(() => L.disconnectIntegration(org, id)),
  addIntegrationRoute: (org, id, input) => liveOr(() => L.addIntegrationRoute(org, id, input)),
  updateIntegrationRoute: (org, id, routeId, input) => liveOr(() => L.updateIntegrationRoute(org, id, routeId, input)),
  deleteIntegrationRoute: (org, id, routeId) => liveOr(() => L.deleteIntegrationRoute(org, id, routeId)),

  listSchedules: (org, cursor) => liveOr(() => L.listSchedules(org, cursor), fixtures.schedules),
  previewSchedule: (org, cron, timezone, count = 3) =>
    liveOr(
      () => L.previewSchedule(org, cron, timezone, count),
      () => ({ cron, timezone, nextFireTimes: fixtures.previewTimes(cron, timezone, count) }),
    ),
  createSchedule: (org, input) => liveOr(() => L.createSchedule(org, input)),
  updateSchedule: (org, id, input) => liveOr(() => L.updateSchedule(org, id, input)),
  deleteSchedule: (org, id) => liveOr(() => L.deleteSchedule(org, id)),
  fireSchedule: (org, id) => liveOr(() => L.fireSchedule(org, id)),

  listWebhookEndpoints: (org) => liveOr(() => L.listWebhookEndpoints(org), fixtures.webhookEndpoints),
  createWebhookEndpoint: (org, input) =>
    liveOr(
      () => L.createWebhookEndpoint(org, input),
      () => {
        const endpoint = { ...fixtures.webhookEndpoints()[0]!, id: "whe-sample", name: input.name, repositoryId: input.repositoryId, secretVersion: 1, rotatedAt: null };
        return { endpoint: { ...endpoint, path: `/api/intake/webhook/${endpoint.id}` }, secret: fixtures.sampleSecret("whsec_"), sample: true };
      },
    ),
  updateWebhookEndpoint: (org, id, input) => liveOr(() => L.updateWebhookEndpoint(org, id, input)),
  deleteWebhookEndpoint: (org, id) => liveOr(() => L.deleteWebhookEndpoint(org, id)),
  rotateWebhookEndpoint: (org, id) =>
    liveOr(
      () => L.rotateWebhookEndpoint(org, id),
      () => {
        const endpoint = fixtures.webhookEndpoints().find((e) => e.id === id);
        if (!endpoint) throw new ApiError(404, "not_found", "No such webhook endpoint.");
        return { endpoint: { ...endpoint, secretVersion: endpoint.secretVersion + 1 }, secret: fixtures.sampleSecret("whsec_"), sample: true };
      },
    ),

  listServicePrincipals: (org) => liveOr(() => L.listServicePrincipals(org), fixtures.servicePrincipals),
  createServicePrincipal: (org, input) => liveOr(() => L.createServicePrincipal(org, input)),
  deleteServicePrincipal: (org, id) => liveOr(() => L.deleteServicePrincipal(org, id)),
  listServiceTokens: (org, id) => liveOr(() => L.listServiceTokens(org, id), () => fixtures.serviceTokens(id)),
  createServiceToken: (org, id, input) =>
    liveOr(
      () => L.createServiceToken(org, id, input),
      () => {
        const token = { ...fixtures.serviceTokens("sp-ci")[0]!, id: "stok-sample", name: input.name, ownerPrincipalId: id, prefix: "orq_SAMP", lastUsedAt: null };
        return { token, secret: fixtures.sampleSecret("orq_"), sample: true };
      },
    ),
  revokeServiceToken: (org, id, tokenId) => liveOr(() => L.revokeServiceToken(org, id, tokenId)),
};

const M = modelsClient((method, path, body) => request(method, path, body));

export const models: ModelsApi = {
  listCredentials: (org) => liveOr(() => M.listCredentials(org), fixtures.modelCredentials),
  createCredential: (org, input) => liveOr(() => M.createCredential(org, input)),
  rotateCredential: (org, id, value) => liveOr(() => M.rotateCredential(org, id, value)),
  revokeCredential: (org, id) => liveOr(() => M.revokeCredential(org, id)),
  validateCredential: (org, id) => liveOr(() => M.validateCredential(org, id)),
  getPolicy: (org, repositoryId = null) => liveOr(() => M.getPolicy(org, repositoryId), () => fixtures.modelPolicy(repositoryId)),
  setPolicy: (org, repositoryId, body) => liveOr(() => M.setPolicy(org, repositoryId, body)),
  clearPolicy: (org, repositoryId, role) => liveOr(() => M.clearPolicy(org, repositoryId, role)),
  createPreset: (org, input) => liveOr(() => M.createPreset(org, input)),
  updatePreset: (org, id, input) => liveOr(() => M.updatePreset(org, id, input)),
  deletePreset: (org, id) => liveOr(() => M.deletePreset(org, id)),
};

const K = knowledgeClient((method, path, body) => request(method, path, body));

export const knowledge: KnowledgeApi = {
  listNotes: (org, filter) => liveOr(() => K.listNotes(org, filter), () => ({ items: [] })),
  createNote: (org, input) => liveOr(() => K.createNote(org, input)),
  updateNote: (org, id, input) => liveOr(() => K.updateNote(org, id, input)),
  setStatus: (org, id, action) => liveOr(() => K.setStatus(org, id, action)),
  deleteNote: (org, id) => liveOr(() => K.deleteNote(org, id)),
  digest: (org, repositoryId) => liveOr(() => K.digest(org, repositoryId), () => ({ digest: null })),
  runKnowledge: (org, runId) => liveOr(() => K.runKnowledge(org, runId), () => ({ items: [] })),
};

const P = playbooksClient((method, path, body) => request(method, path, body));

export const playbooks: PlaybooksApi = {
  list: (org) => liveOr(() => P.list(org), fixtures.playbooks),
  create: (org, input) => liveOr(() => P.create(org, input)),
  update: (org, playbookId, input) => liveOr(() => P.update(org, playbookId, input)),
  archive: (org, playbookId) => liveOr(() => P.archive(org, playbookId)),
};

export async function loadPlaybooks(): Promise<Playbook[] | null> {
  try {
    const org = await currentOrganization(await getIdentity());
    if (!org || !canReadPlaybooks(org.permissions)) return null;
    return await playbooks.list(org.id);
  } catch {
    return null;
  }
}

export async function openableTabs(): Promise<string[]> {
  const identity = await getIdentity();
  const org = await currentOrganization(identity);
  return visibleTabs(org?.permissions ?? [], identity.accountRole?.permissions ?? []).map((t) => t.tab);
}

export function ingressUrl(): string | null {
  const url = process.env.WINDKEEL_API_URL;
  return url && live() ? url.replace(/\/+$/, "") : null;
}

export async function getUsage(orgId: string, period?: string): Promise<UsageView | null> {
  if (!live()) return null;
  return request<UsageView>("GET", `/orgs/${encodeURIComponent(orgId)}/usage${query({ period })}`);
}

export async function getBudget(orgId: string): Promise<BudgetView | null> {
  if (!live()) return null;
  return request<BudgetView>("GET", `/orgs/${encodeURIComponent(orgId)}/budget`);
}

export async function putBudget(orgId: string, budget: Partial<BudgetView>): Promise<BudgetView> {
  if (!live()) sampleOnly();
  return request<BudgetView>("PUT", `/orgs/${encodeURIComponent(orgId)}/budget`, budget);
}

export async function getCreditBalance(orgId: string): Promise<CreditBalanceView | null> {
  if (!live()) return null;
  return request<CreditBalanceView>("GET", `/orgs/${encodeURIComponent(orgId)}/billing/balance`);
}

export async function getBilling(orgId: string): Promise<BillingView | null> {
  if (!live()) return null;
  return request<BillingView>("GET", `/orgs/${encodeURIComponent(orgId)}/billing`);
}

export async function billingLink(orgId: string, kind: "checkout" | "portal", returnUrl: string): Promise<string> {
  if (!live()) sampleOnly();
  const answer = await request<{ url: string }>("POST", `/orgs/${encodeURIComponent(orgId)}/billing/${kind}`, { returnUrl });
  return answer.url;
}

export async function welcomeState(): Promise<{ kind: "member"; identity: SelfView } | { kind: "new" }> {
  if (!live()) return { kind: "member", identity: fixtures.self() };
  const { url, token } = await apiAuth();
  const answer = await callApi(url, token, "GET", "/self");
  if (answer.ok) return { kind: "member", identity: await getIdentity() };
  if (answer.json["code"] === "not_a_member") return { kind: "new" };
  throw refusal(answer);
}

export async function signUp(input: { inviteCode: string; organizationName: string; plan: "byok" | "managed" }): Promise<void> {
  if (!live()) sampleOnly();
  const { url, token } = await apiAuth();
  const answer = await callApi(url, token, "POST", "/signup", input);
  if (!answer.ok) throw refusal(answer);
}

export async function installLink(orgId: string): Promise<string> {
  if (!live()) sampleOnly();
  const answer = await request<{ url: string }>("POST", `/orgs/${encodeURIComponent(orgId)}/github-installations/state`);
  return answer.url;
}

export async function linkInstallation(body: { installationId: string; state: string; code: string | undefined }): Promise<void> {
  if (!live()) sampleOnly();
  await request("POST", "/github-installations", body);
}
