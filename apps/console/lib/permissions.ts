export const PERMISSIONS = [
  "runs.read",
  "runs.write",
  "runs.approve",
  "secrets.manage",
  "repositories.manage",
  "members.manage",
  "tokens.manage",
  "integrations.manage",
  "schedules.manage",
  "models.read",
  "models.manage",
  "runs.takeover",
  "runs.merge",
  "audit.read",
  "roles.manage",
  "account.manage",
  "knowledge.manage",
  "playbooks.read",
  "playbooks.manage",
  "batches.manage",
  "billing.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABEL: Record<Permission, { label: string; detail: string }> = {
  "runs.read": { label: "Read runs", detail: "See runs, tasks, evidence and cost." },
  "runs.write": { label: "Start and steer runs", detail: "File tasks, start and cancel runs, send guidance." },
  "runs.approve": { label: "Approve criteria", detail: "Let a run start on criteria a model wrote." },
  "secrets.manage": { label: "Manage secrets", detail: "Set and remove repository secrets." },
  "repositories.manage": { label: "Grant repositories", detail: "Decide which repositories this organization can work on." },
  "members.manage": { label: "Manage members", detail: "Invite people, change roles, remove members." },
  "tokens.manage": { label: "Manage tokens", detail: "Create tokens from another token (a session can always create its own)." },
  "integrations.manage": { label: "Manage integrations", detail: "Connect Slack, Linear and Jira to this organization." },
  "schedules.manage": { label: "Manage schedules", detail: "Create, change and remove schedules that start work unattended." },
  "models.read": { label: "See model keys", detail: "List the organization's model credentials: label, provider, last four characters, status." },
  "models.manage": { label: "Manage model keys", detail: "Add, rotate and revoke the organization's own model credentials." },
  "runs.takeover": { label: "Take over runs", detail: "Take over a run in a workspace of your own, then submit it for verification or hand it back." },
  "runs.merge": { label: "Merge pull requests", detail: "Merge a verified pull request from Windkeel, as yourself, when the organization allows it." },
  "audit.read": { label: "Read the audit log", detail: "See and export who did what, and verify the log hasn't been altered." },
  "roles.manage": { label: "Manage roles", detail: "Create, change and delete the account's custom roles." },
  "account.manage": { label: "Manage account security", detail: "Set the account's token, sign-in and network policy, and delete audit data." },
  "knowledge.manage": { label: "Manage knowledge", detail: "Write repository and organization notes the maker is given, and accept, reject or delete learned lessons." },
  "playbooks.read": { label: "See playbooks", detail: "List the organization's playbooks and file work under one." },
  "playbooks.manage": { label: "Manage playbooks", detail: "Create, edit and archive playbooks, including the extra checks the verifier runs for them." },
  "batches.manage": { label: "Manage batches", detail: "Start, pause, resume and cancel batches that fan one change out into many verified runs." },
  "billing.manage": { label: "Manage billing", detail: "Set the organization's monthly budget, and open checkout and the billing portal." },
};

export const ADMIN_PERMISSIONS: ReadonlySet<Permission> = new Set([
  "members.manage",
  "tokens.manage",
  "repositories.manage",
  "integrations.manage",
  "schedules.manage",
  "models.manage",
  "runs.merge",
  "audit.read",
  "roles.manage",
  "account.manage",
  "knowledge.manage",
  "playbooks.manage",
  "batches.manage",
  "billing.manage",
]);

export function isPermission(p: string): p is Permission {
  return (PERMISSIONS as readonly string[]).includes(p);
}

export function grantable(held: readonly string[]): Permission[] {
  return PERMISSIONS.filter((p) => held.includes(p));
}

export function defaultTokenScopes(held: readonly string[]): Permission[] {
  return grantable(held).filter((p) => !ADMIN_PERMISSIONS.has(p));
}

export function scopeProblem(requested: readonly string[], held: readonly string[]): string | null {
  if (requested.length === 0) return "Tick at least one thing the token can do.";
  const unknown = requested.filter((p) => !isPermission(p));
  if (unknown.length) return `Unknown permission: ${unknown.join(", ")}.`;
  const excess = requested.filter((p) => !held.includes(p));
  if (excess.length) return `You can't give a token what you don't hold: ${excess.map((p) => PERMISSION_LABEL[p as Permission].label).join(", ")}.`;
  return null;
}

export const TOKEN_PRESETS = [
  { preset: "read", label: "Read", detail: "See runs, tasks, evidence and cost.", permissions: ["runs.read"] },
  { preset: "execute", label: "Execute", detail: "Read, and file tasks, start, cancel and steer runs.", permissions: ["runs.read", "runs.write"] },
  { preset: "approve", label: "Approve", detail: "Execute, and approve criteria a model wrote.", permissions: ["runs.read", "runs.write", "runs.approve"] },
  { preset: "admin", label: "Admin", detail: "Everything, including members, repository grants and other tokens.", permissions: [...PERMISSIONS] },
] as const;

export type TokenPreset = (typeof TOKEN_PRESETS)[number]["preset"];

export const DEFAULT_PRESET: TokenPreset = "execute";

export function offeredPresets(held: readonly string[]): (typeof TOKEN_PRESETS)[number][] {
  return TOKEN_PRESETS.filter((p) => p.permissions.every((perm) => held.includes(perm)));
}

export type SettingsTab =
  | "general"
  | "members"
  | "tokens"
  | "access"
  | "models"
  | "integrations"
  | "schedules"
  | "webhooks"
  | "service-principals"
  | "merging"
  | "audit"
  | "roles"
  | "knowledge"
  | "playbooks"
  | "billing";

export const SETTINGS_TABS: Array<{
  tab: SettingsTab;
  label: string;
  needs: readonly Permission[] | null;
  manage?: Permission;
  scope?: "account";
}> = [
  { tab: "general", label: "General", needs: null },
  { tab: "tokens", label: "Your tokens", needs: null },
  { tab: "members", label: "Members and invitations", needs: ["members.manage"] },
  { tab: "access", label: "Repository access", needs: ["repositories.manage"] },
  { tab: "models", label: "Models", needs: ["models.manage", "models.read"], manage: "models.manage" },
  { tab: "integrations", label: "Integrations", needs: ["integrations.manage", "runs.read"], manage: "integrations.manage" },
  { tab: "schedules", label: "Schedules", needs: ["schedules.manage", "runs.read"], manage: "schedules.manage" },
  { tab: "webhooks", label: "Webhook endpoints", needs: ["integrations.manage"], manage: "integrations.manage" },
  { tab: "service-principals", label: "Service principals", needs: ["tokens.manage"], manage: "tokens.manage" },
  { tab: "merging", label: "Merging", needs: ["runs.merge", "members.manage"], manage: "members.manage" },
  { tab: "audit", label: "Audit log", needs: ["audit.read"] },
  { tab: "roles", label: "Roles", needs: ["roles.manage"], scope: "account" },
  { tab: "knowledge", label: "Knowledge", needs: ["knowledge.manage", "runs.read"], manage: "knowledge.manage" },
  { tab: "playbooks", label: "Playbooks", needs: ["playbooks.manage", "playbooks.read"], manage: "playbooks.manage" },
  { tab: "billing", label: "Billing", needs: ["billing.manage"], manage: "billing.manage" },
];

export function visibleTabs(held: readonly string[], accountHeld: readonly string[] = []): typeof SETTINGS_TABS {
  return SETTINGS_TABS.filter((t) => {
    const from = t.scope === "account" ? accountHeld : held;
    return t.needs === null || t.needs.some((p) => from.includes(p));
  });
}

export function canManage(tab: SettingsTab, held: readonly string[]): boolean {
  const t = SETTINGS_TABS.find((x) => x.tab === tab);
  if (!t) return false;
  const needed = t.manage ?? t.needs?.[0] ?? null;
  return needed === null || held.includes(needed);
}

export const TOKEN_EXPIRY_DAYS: Array<{ days: number | null; label: string }> = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
  { days: null, label: "Never" },
];
