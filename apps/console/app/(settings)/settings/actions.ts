"use server";

import "../../../lib/env-compat.ts";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ORG_COOKIE } from "../../../lib/auth.ts";
import type { ActionResult, PreviewResult } from "../../../lib/action-result.ts";
import * as core from "../../../lib/automation-actions.ts";
import * as modelCore from "../../../lib/model-actions.ts";
import * as playbookCore from "../../../lib/playbooks.ts";
import {
  ApiError,
  automations,
  knowledge,
  models,
  playbooks,
  createGrant,
  createInvitation,
  createRole,
  deleteRole,
  disconnectGithub,
  setMerging,
  deleteGrant,
  createToken,
  currentOrganization,
  deleteInvitation,
  getIdentity,
  removeMember,
  revokeToken,
  setMemberRole,
  putBudget,
  billingLink,
} from "../../../lib/api.ts";
import { budgetFromForm } from "../../../lib/billing.ts";
import { refusalText } from "../../../lib/refusals.ts";
import { TOKEN_PRESETS, scopeProblem } from "../../../lib/permissions.ts";
import { parseGlobs, type NoteAction } from "../../../lib/knowledge.ts";
import { BUILT_IN_ROLES } from "../../../lib/types.ts";

async function attempt(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const secret = await fn();
    revalidatePath("/settings", "layout");
    return secret ? { ok: true, secret } : { ok: true };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, message: err.message };
    throw err;
  }
}

const expiry = (raw: FormDataEntryValue | null) => (raw && raw !== "never" ? Number(raw) : null);

export async function createPersonalToken(form: FormData): Promise<ActionResult> {
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { ok: false, message: "Name the token after where it will live — a machine, a CI job." };
  const organizationId = String(form.get("organizationId") ?? "") || null;
  const choice = String(form.get("preset") ?? "execute");
  const identity = await getIdentity();
  const orgs = organizationId ? identity.organizations.filter((o) => o.id === organizationId) : identity.organizations;
  const held = [...new Set(orgs.flatMap((o) => o.permissions))];

  const preset = TOKEN_PRESETS.find((p) => p.preset === choice);
  const permissions = preset ? [...preset.permissions] : form.getAll("permissions").map(String);
  if (!preset && choice !== "custom") return { ok: false, message: `Unknown scope: ${choice}.` };
  const problem = scopeProblem(permissions, held);
  if (problem) return { ok: false, message: preset ? `Your role doesn't cover “${preset.label}”. Choose a narrower scope.` : problem };

  return attempt(async () => {
    const created = await createToken({
      name,
      organizationId,
      ...(preset ? { preset: preset.preset } : { permissions }),
      expiresInDays: expiry(form.get("expiresInDays")),
    });
    return created.secret;
  });
}

export async function revokePersonalToken(id: string): Promise<ActionResult> {
  return attempt(() => revokeToken(id));
}

const ROLE_KEY = /^[a-z][a-z0-9-]{1,39}$/;

export async function changeRole(principalId: string, role: string): Promise<ActionResult> {
  if (!(BUILT_IN_ROLES as readonly string[]).includes(role) && !ROLE_KEY.test(role)) return { ok: false, message: `Unknown role: ${role}.` };
  const org = await currentOrganization(await getIdentity());
  if (!org) return { ok: false, message: "You're not in an organization." };
  return attempt(() => setMemberRole(org.id, principalId, role));
}

export async function removeFromOrganization(principalId: string): Promise<ActionResult> {
  const org = await currentOrganization(await getIdentity());
  if (!org) return { ok: false, message: "You're not in an organization." };
  return attempt(() => removeMember(org.id, principalId));
}

export async function invite(form: FormData): Promise<ActionResult> {
  const login = String(form.get("githubLogin") ?? "").trim().replace(/^@/, "");
  const role = String(form.get("role") ?? "member");
  if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login)) return { ok: false, message: "That isn't a GitHub username." };
  if (!(BUILT_IN_ROLES as readonly string[]).includes(role) && !ROLE_KEY.test(role)) return { ok: false, message: `Unknown role: ${role}.` };
  const org = await currentOrganization(await getIdentity());
  if (!org) return { ok: false, message: "You're not in an organization." };
  return attempt(() => createInvitation(org.id, login, role));
}

export async function cancelInvitation(id: string): Promise<ActionResult> {
  const org = await currentOrganization(await getIdentity());
  if (!org) return { ok: false, message: "You're not in an organization." };
  return attempt(() => deleteInvitation(org.id, id));
}

export async function revokeGrant(repositoryId: string): Promise<ActionResult> {
  const org = await currentOrganization(await getIdentity());
  if (!org) return { ok: false, message: "You're not in an organization." };
  return attempt(() => deleteGrant(org.id, repositoryId));
}

export async function grantRepository(form: FormData): Promise<ActionResult> {
  const repositoryId = String(form.get("repositoryId") ?? "");
  if (!repositoryId) return { ok: false, message: "Choose a repository." };
  const org = await currentOrganization(await getIdentity());
  if (!org) return { ok: false, message: "You're not in an organization." };
  return attempt(() => createGrant(org.id, repositoryId, form.get("intake") === "on"));
}

type Org = { id: string; permissions: string[] };

async function inOrg(fn: (org: Org) => Promise<ActionResult>): Promise<ActionResult> {
  const org = await currentOrganization(await getIdentity());
  if (!org) return { ok: false, message: "You're not in an organization." };
  const result = await fn(org);
  if (result.ok) revalidatePath("/settings", "layout");
  return result;
}

export async function connectIntegration(form: FormData): Promise<ActionResult> {
  return inOrg((org) => core.connectIntegration(automations, org.id, form));
}

export async function disconnectIntegration(integrationId: string): Promise<ActionResult> {
  return inOrg((org) => core.disconnectIntegration(automations, org.id, integrationId));
}

export async function addIntegrationRoute(integrationId: string, provider: string, form: FormData): Promise<ActionResult> {
  if (!core.PROVIDERS.includes(provider as never)) return { ok: false, message: `Unknown provider: ${provider}.` };
  return inOrg((org) => core.addRoute(automations, org.id, integrationId, provider as (typeof core.PROVIDERS)[number], form));
}

export async function updateIntegrationRoute(integrationId: string, routeId: string, form: FormData): Promise<ActionResult> {
  return inOrg((org) => core.updateRoute(automations, org.id, integrationId, routeId, form));
}

export async function removeIntegrationRoute(integrationId: string, routeId: string): Promise<ActionResult> {
  return inOrg((org) => core.removeRoute(automations, org.id, integrationId, routeId));
}

export async function createSchedule(form: FormData): Promise<ActionResult> {
  return inOrg((org) => core.createSchedule(automations, org.id, form));
}

export async function updateSchedule(scheduleId: string, form: FormData): Promise<ActionResult> {
  return inOrg((org) => core.updateSchedule(automations, org.id, scheduleId, form));
}

export async function setScheduleEnabled(scheduleId: string, enabled: boolean): Promise<ActionResult> {
  return inOrg((org) => core.setScheduleEnabled(automations, org.id, scheduleId, enabled));
}

export async function deleteSchedule(scheduleId: string): Promise<ActionResult> {
  return inOrg((org) => core.deleteSchedule(automations, org.id, scheduleId));
}

export async function fireSchedule(scheduleId: string): Promise<ActionResult> {
  return inOrg((org) => core.fireSchedule(automations, org.id, scheduleId));
}

export async function previewCron(cron: string, timezone: string): Promise<PreviewResult> {
  const org = await currentOrganization(await getIdentity());
  if (!org) return { ok: false, message: "You're not in an organization." };
  return core.previewCron(automations, org.id, cron, timezone);
}

export async function createWebhookEndpoint(form: FormData): Promise<ActionResult> {
  return inOrg((org) => core.createWebhook(automations, org.id, form));
}

export async function rotateWebhookEndpoint(endpointId: string): Promise<ActionResult> {
  return inOrg((org) => core.rotateWebhook(automations, org.id, endpointId));
}

export async function setWebhookEndpointEnabled(endpointId: string, enabled: boolean): Promise<ActionResult> {
  return inOrg((org) => core.setWebhookEnabled(automations, org.id, endpointId, enabled));
}

export async function deleteWebhookEndpoint(endpointId: string): Promise<ActionResult> {
  return inOrg((org) => core.deleteWebhook(automations, org.id, endpointId));
}

export async function createServicePrincipal(form: FormData): Promise<ActionResult> {
  return inOrg((org) => core.createServicePrincipal(automations, org.id, form));
}

export async function deleteServicePrincipal(principalId: string): Promise<ActionResult> {
  return inOrg((org) => core.deleteServicePrincipal(automations, org.id, principalId));
}

export async function createServiceToken(principalId: string, form: FormData): Promise<ActionResult> {
  return inOrg((org) => core.createServiceToken(automations, org.id, principalId, org.permissions, form));
}

export async function revokeServiceToken(principalId: string, tokenId: string): Promise<ActionResult> {
  return inOrg((org) => core.revokeServiceToken(automations, org.id, principalId, tokenId));
}

async function inOrgModels(fn: (org: Org) => Promise<ActionResult>): Promise<ActionResult> {
  const result = await inOrg(fn);
  if (result.ok) revalidatePath("/repositories/[id]", "page");
  return result;
}

export async function addModelCredential(form: FormData): Promise<ActionResult> {
  return inOrgModels((org) => modelCore.addCredential(models, org.id, form));
}

export async function rotateModelCredential(credentialId: string, form: FormData): Promise<ActionResult> {
  return inOrgModels((org) => modelCore.rotateCredential(models, org.id, credentialId, form));
}

export async function revokeModelCredential(credentialId: string): Promise<ActionResult> {
  return inOrgModels((org) => modelCore.revokeCredential(models, org.id, credentialId));
}

export async function checkModelCredential(credentialId: string): Promise<ActionResult> {
  return inOrgModels((org) => modelCore.checkCredential(models, org.id, credentialId));
}

export async function saveModelPolicy(repositoryId: string | null, form: FormData): Promise<ActionResult> {
  return inOrgModels(async (org) => {
    const [credentials, defaults] = await Promise.all([models.listCredentials(org.id), repositoryId ? models.getPolicy(org.id) : null]);
    const below: Parameters<typeof modelCore.savePolicy>[5] = {};
    for (const row of defaults?.items ?? []) {
      const credential = credentials.find((c) => c.id === row.credentialId);
      below[row.role] = { provider: row.provider, model: row.model, declaredVendor: row.declaredVendor ?? credential?.declaredVendor ?? null };
    }
    return modelCore.savePolicy(models, org.id, repositoryId, form, credentials, below);
  });
}

export async function saveModelPreset(presetId: string | null, form: FormData): Promise<ActionResult> {
  return inOrgModels(async (org) => {
    const [credentials, policy] = await Promise.all([models.listCredentials(org.id), models.getPolicy(org.id)]);
    const existing = presetId ? (policy.presets ?? []).find((p) => p.id === presetId) ?? null : null;
    return modelCore.savePreset(models, org.id, presetId, form, credentials, policy.harnesses ?? [{ id: "codex", label: "OpenAI's Codex CLI", default: true }], existing);
  });
}

export async function deleteModelPreset(presetId: string): Promise<ActionResult> {
  return inOrgModels((org) => modelCore.deletePreset(models, org.id, presetId));
}

export async function clearModelPolicy(repositoryId: string | null, role: string): Promise<ActionResult> {
  return inOrgModels((org) => modelCore.clearPolicy(models, org.id, repositoryId, role));
}

async function inOrgKnowledge(fn: (orgId: string) => Promise<unknown>): Promise<ActionResult> {
  const result = await inOrg(async (org) => {
    try {
      await fn(org.id);
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError) return { ok: false, message: err.message };
      throw err;
    }
  });
  if (result.ok) revalidatePath("/repositories/[id]", "page");
  return result;
}

export async function createKnowledgeNote(repositoryId: string | null, form: FormData): Promise<ActionResult> {
  const title = String(form.get("title") ?? "").trim();
  const body = String(form.get("body") ?? "").trim();
  if (!title || !body) return { ok: false, message: "A note needs a title and a body." };
  const pathGlobs = parseGlobs(String(form.get("pathGlobs") ?? ""));
  return inOrgKnowledge((org) => knowledge.createNote(org, { repositoryId, title, body, pathGlobs }));
}

export async function editKnowledgeNote(noteId: string, version: number, form: FormData): Promise<ActionResult> {
  const title = String(form.get("title") ?? "").trim();
  const body = String(form.get("body") ?? "").trim();
  const pathGlobs = parseGlobs(String(form.get("pathGlobs") ?? ""));
  return inOrgKnowledge((org) => knowledge.updateNote(org, noteId, { version, title, body, pathGlobs }));
}

export async function setKnowledgeNoteStatus(noteId: string, action: NoteAction): Promise<ActionResult> {
  return inOrgKnowledge((org) => knowledge.setStatus(org, noteId, action));
}

export async function deleteKnowledgeNote(noteId: string): Promise<ActionResult> {
  return inOrgKnowledge((org) => knowledge.deleteNote(org, noteId));
}

export async function switchOrganization(form: FormData): Promise<void> {
  const orgId = String(form.get("orgId") ?? "");
  const identity = await getIdentity();
  if (identity.organizations.some((o) => o.id === orgId)) {
    (await cookies()).set(ORG_COOKIE, orgId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  }
  redirect("/runs");
}

export async function setAllowMerging(orgId: string, allow: boolean): Promise<ActionResult> {
  return attempt(() => setMerging(orgId, allow));
}

export async function disconnectGithubAuthorization(): Promise<ActionResult> {
  return attempt(() => disconnectGithub());
}

export async function createCustomRole(form: FormData): Promise<ActionResult> {
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { ok: false, message: "Name the role after what its holders do." };
  const permissions = form.getAll("permissions").map(String);
  if (permissions.length === 0) return { ok: false, message: "Tick at least one thing the role can do." };
  const description = String(form.get("description") ?? "").trim();
  return attempt(async () => {
    await createRole({ name, permissions, ...(description ? { description } : {}) });
  });
}

export async function deleteCustomRole(roleId: string): Promise<ActionResult> {
  return attempt(() => deleteRole(roleId));
}

export async function savePlaybook(playbookId: string | null, form: FormData): Promise<ActionResult> {
  return inOrg(async (org) => {
    const existing = playbookId ? ((await playbooks.list(org.id)).find((p) => p.id === playbookId) ?? null) : null;
    return playbookCore.savePlaybook(playbooks, org.id, playbookId, form, existing);
  });
}

export async function duplicatePlaybook(from: string, form: FormData): Promise<ActionResult> {
  const slug = String(form.get("slug") ?? "").trim();
  return inOrg((org) => playbookCore.duplicatePlaybook(playbooks, org.id, from, slug || undefined));
}

export async function archivePlaybook(playbookId: string): Promise<ActionResult> {
  return inOrg((org) => playbookCore.archivePlaybook(playbooks, org.id, playbookId));
}

export async function saveBudget(orgId: string, form: FormData): Promise<ActionResult> {
  const parsed = budgetFromForm(form);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return attempt(async () => {
    await putBudget(orgId, parsed.budget);
  });
}

export async function openBilling(orgId: string, kind: "checkout" | "portal"): Promise<ActionResult> {
  const consoleUrl = process.env.WINDKEEL_CONSOLE_URL?.replace(/\/+$/, "") ?? "";
  let url: string;
  try {
    url = await billingLink(orgId, kind, `${consoleUrl}/settings/billing`);
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, message: refusalText(err.code, err.message) };
    throw err;
  }
  redirect(url);
}
