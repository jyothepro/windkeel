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

export const PRESETS: Readonly<Record<string, readonly Permission[]>> = {
  read: ["runs.read"],
  execute: ["runs.read", "runs.write"],
  approve: ["runs.read", "runs.write", "runs.approve"],
  admin: PERMISSIONS,
};
