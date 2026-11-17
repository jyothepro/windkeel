import type { ActionResult, PreviewResult } from "./action-result.ts";
import type { AutomationsApi, RouteInput } from "./automations.ts";
import { ApiError } from "./http.ts";
import { TOKEN_EXPIRY_DAYS, TOKEN_PRESETS, scopeProblem } from "./permissions.ts";
import { refusalText } from "./refusals.ts";
import { BUILT_IN_ROLES, type Provider, type RiskLevel, type ScheduleInput, type ScopeKind } from "./types.ts";

export const PROVIDERS: readonly Provider[] = ["slack", "linear", "jira", "sentry"];
export const PROVIDER_LABEL: Record<Provider, string> = { slack: "Slack", linear: "Linear", jira: "Jira", sentry: "Sentry" };

export const PROVIDER_SCOPE: Record<Provider, { kind: Exclude<ScopeKind, "default">; label: string; example: string }> = {
  slack: { kind: "slack_channel", label: "Channel id", example: "C0123ABCD" },
  linear: { kind: "linear_team", label: "Team key or id", example: "ENG" },
  jira: { kind: "jira_project", label: "Project key", example: "ENG" },
  sentry: { kind: "sentry_project", label: "Project slug", example: "checkout-web" },
};

const RISKS: readonly RiskLevel[] = ["low", "medium", "high"];

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const fail = (message: string): ActionResult => ({ ok: false, message });

async function guard(fn: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return fail(refusalText(err.code, err.message));
    throw err;
  }
}

export function connectIntegration(api: AutomationsApi, orgId: string, form: FormData): Promise<ActionResult> {
  const provider = text(form, "provider") as Provider;
  const installationId = text(form, "installationId");
  if (!PROVIDERS.includes(provider)) return Promise.resolve(fail("Choose Slack, Linear, Jira or Sentry."));
  if (!installationId) return Promise.resolve(fail("Paste the installation id Vercel Connect shows for this workspace."));
  return guard(async () => {
    const connection = await api.connectIntegration(orgId, { provider, installationId });
    return { ok: true, message: `Connected ${connection.externalTenantName ?? connection.externalTenantId}.` };
  });
}

export function disconnectIntegration(api: AutomationsApi, orgId: string, integrationId: string): Promise<ActionResult> {
  return guard(async () => {
    await api.disconnectIntegration(orgId, integrationId);
    return { ok: true };
  });
}

const NEEDS_LABEL = "A route needs a trigger label — the label that marks an item as work for Windkeel.";

export function addRoute(api: AutomationsApi, orgId: string, integrationId: string, provider: Provider, form: FormData): Promise<ActionResult> {
  const scopeKind = text(form, "scopeKind") as ScopeKind;
  const scopeValue = text(form, "scopeValue");
  const repositoryId = text(form, "repositoryId");
  const triggerLabel = text(form, "triggerLabel");
  if (scopeKind !== "default" && scopeKind !== PROVIDER_SCOPE[provider].kind) return Promise.resolve(fail("Choose where the route applies."));
  if (scopeKind !== "default" && !scopeValue) return Promise.resolve(fail(`Give the ${PROVIDER_SCOPE[provider].label.toLowerCase()} this route is for.`));
  if (!repositoryId) return Promise.resolve(fail("Choose the repository its work goes to."));
  if (!triggerLabel) return Promise.resolve(fail(NEEDS_LABEL));
  const input: RouteInput = {
    scopeKind,
    scopeValue: scopeKind === "default" ? null : scopeValue,
    repositoryId,
    triggerLabel,
    enabled: form.get("enabled") === "on",
  };
  return guard(async () => {
    await api.addIntegrationRoute(orgId, integrationId, input);
    return { ok: true };
  });
}

export function updateRoute(api: AutomationsApi, orgId: string, integrationId: string, routeId: string, form: FormData): Promise<ActionResult> {
  const repositoryId = text(form, "repositoryId");
  const triggerLabel = text(form, "triggerLabel");
  if (!repositoryId) return Promise.resolve(fail("Choose the repository its work goes to."));
  if (!triggerLabel) return Promise.resolve(fail(NEEDS_LABEL));
  return guard(async () => {
    await api.updateIntegrationRoute(orgId, integrationId, routeId, { repositoryId, triggerLabel, enabled: form.get("enabled") === "on" });
    return { ok: true };
  });
}

export function removeRoute(api: AutomationsApi, orgId: string, integrationId: string, routeId: string): Promise<ActionResult> {
  return guard(async () => {
    await api.deleteIntegrationRoute(orgId, integrationId, routeId);
    return { ok: true };
  });
}

export function scheduleInput(form: FormData, mode: "create" | "edit" = "create"): { input: ScheduleInput } | { problem: string } {
  const input = {
    name: text(form, "name"),
    repositoryId: text(form, "repositoryId"),
    cron: text(form, "cron").replace(/\s+/g, " "),
    timezone: text(form, "timezone") || "UTC",
    title: text(form, "title"),
    description: String(form.get("description") ?? ""),
    riskLevel: (text(form, "riskLevel") || "low") as RiskLevel,
    ...(mode === "create" ? { enabled: form.get("enabled") === "on" } : {}),
  };
  if (!input.name) return { problem: "Name the schedule after what it does." };
  if (!input.repositoryId) return { problem: "Choose the repository it works on." };
  if (!input.cron) return { problem: "Give it a cron expression, like 0 3 * * * for 03:00 every day." };
  if (!input.title) return { problem: "Give the task it files a title." };
  if (!input.description.trim()) return { problem: "Describe the task — its acceptance criteria are read from this." };
  if (!RISKS.includes(input.riskLevel)) return { problem: "Risk is low, medium or high." };
  return { input };
}

export function createSchedule(api: AutomationsApi, orgId: string, form: FormData): Promise<ActionResult> {
  const read = scheduleInput(form);
  if ("problem" in read) return Promise.resolve(fail(read.problem));
  return guard(async () => {
    await api.createSchedule(orgId, read.input);
    return { ok: true };
  });
}

export function updateSchedule(api: AutomationsApi, orgId: string, scheduleId: string, form: FormData): Promise<ActionResult> {
  const read = scheduleInput(form, "edit");
  if ("problem" in read) return Promise.resolve(fail(read.problem));
  return guard(async () => {
    await api.updateSchedule(orgId, scheduleId, read.input);
    return { ok: true };
  });
}

export function setScheduleEnabled(api: AutomationsApi, orgId: string, scheduleId: string, enabled: boolean): Promise<ActionResult> {
  return guard(async () => {
    await api.updateSchedule(orgId, scheduleId, { enabled });
    return { ok: true };
  });
}

export function deleteSchedule(api: AutomationsApi, orgId: string, scheduleId: string): Promise<ActionResult> {
  return guard(async () => {
    await api.deleteSchedule(orgId, scheduleId);
    return { ok: true };
  });
}

export function fireSchedule(api: AutomationsApi, orgId: string, scheduleId: string): Promise<ActionResult> {
  return guard(async () => {
    const accepted = await api.fireSchedule(orgId, scheduleId);
    return { ok: true, message: "Fired. Its run has started.", hrefLabel: "Open run", href: `/runs/${encodeURIComponent(accepted.engineeringRunId)}` };
  });
}

export async function previewCron(api: AutomationsApi, orgId: string, cron: string, timezone: string): Promise<PreviewResult> {
  const expr = cron.trim().replace(/\s+/g, " ");
  if (!expr) return { ok: false, message: "Type a cron expression to see when it fires." };
  try {
    const preview = await api.previewSchedule(orgId, expr, timezone.trim() || "UTC", 3);
    return { ok: true, times: preview.nextFireTimes };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, message: refusalText(err.code, err.message) };
    throw err;
  }
}

export function createWebhook(api: AutomationsApi, orgId: string, form: FormData): Promise<ActionResult> {
  const name = text(form, "name");
  const repositoryId = text(form, "repositoryId");
  const defaultRiskLevel = (text(form, "defaultRiskLevel") || "low") as RiskLevel;
  if (!name) return Promise.resolve(fail("Name it after what will call it — pagerduty, nightly CI."));
  if (!repositoryId) return Promise.resolve(fail("Choose the repository its tasks go to."));
  if (!RISKS.includes(defaultRiskLevel)) return Promise.resolve(fail("Risk is low, medium or high."));
  return guard(async () => {
    const { secret, sample } = await api.createWebhookEndpoint(orgId, { name, repositoryId, defaultRiskLevel });
    return { ok: true, secret, ...(sample ? { sample } : {}) };
  });
}

export function rotateWebhook(api: AutomationsApi, orgId: string, endpointId: string): Promise<ActionResult> {
  return guard(async () => {
    const { secret, sample } = await api.rotateWebhookEndpoint(orgId, endpointId);
    return { ok: true, secret, ...(sample ? { sample } : {}) };
  });
}

export function setWebhookEnabled(api: AutomationsApi, orgId: string, endpointId: string, enabled: boolean): Promise<ActionResult> {
  return guard(async () => {
    await api.updateWebhookEndpoint(orgId, endpointId, { enabled });
    return { ok: true };
  });
}

export function deleteWebhook(api: AutomationsApi, orgId: string, endpointId: string): Promise<ActionResult> {
  return guard(async () => {
    await api.deleteWebhookEndpoint(orgId, endpointId);
    return { ok: true };
  });
}

export function createServicePrincipal(api: AutomationsApi, orgId: string, form: FormData): Promise<ActionResult> {
  const name = text(form, "name");
  const role = text(form, "role") || "member";
  if (!name) return Promise.resolve(fail("Name it after the automation that will use it — release-ci, nightly-report."));
  if (!(BUILT_IN_ROLES as readonly string[]).includes(role)) return Promise.resolve(fail(`Unknown role: ${role}.`));
  return guard(async () => {
    await api.createServicePrincipal(orgId, { name, role });
    return { ok: true };
  });
}

export function deleteServicePrincipal(api: AutomationsApi, orgId: string, principalId: string): Promise<ActionResult> {
  return guard(async () => {
    await api.deleteServicePrincipal(orgId, principalId);
    return { ok: true };
  });
}

export function createServiceToken(
  api: AutomationsApi,
  orgId: string,
  principalId: string,
  held: readonly string[],
  form: FormData,
  now = Date.now(),
): Promise<ActionResult> {
  const name = text(form, "name");
  if (!name) return Promise.resolve(fail("Name the token after where it will live — a CI job, a cron host."));
  const choice = text(form, "preset") || "execute";
  const preset = TOKEN_PRESETS.find((p) => p.preset === choice);
  if (!preset && choice !== "custom") return Promise.resolve(fail(`Unknown scope: ${choice}.`));
  const permissions = preset ? [...preset.permissions] : form.getAll("permissions").map(String);
  const problem = scopeProblem(permissions, held);
  if (problem) return Promise.resolve(fail(preset ? `Your role doesn't cover “${preset.label}”. Choose a narrower scope.` : problem));
  const rawDays = text(form, "expiresInDays");
  const days = rawDays && rawDays !== "never" ? Number(rawDays) : null;
  if (days !== null && !TOKEN_EXPIRY_DAYS.some((e) => e.days === days)) return Promise.resolve(fail("Choose when it expires."));
  const expiresAt = days === null ? null : new Date(now + days * 86_400_000).toISOString();
  return guard(async () => {
    const { secret, sample } = await api.createServiceToken(orgId, principalId, { name, ...(preset ? { preset: preset.preset } : { permissions }), expiresAt });
    return { ok: true, secret, ...(sample ? { sample } : {}) };
  });
}

export function revokeServiceToken(api: AutomationsApi, orgId: string, principalId: string, tokenId: string): Promise<ActionResult> {
  return guard(async () => {
    await api.revokeServiceToken(orgId, principalId, tokenId);
    return { ok: true };
  });
}
