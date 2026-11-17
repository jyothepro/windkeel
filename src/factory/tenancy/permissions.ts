import { PERMISSIONS, PRESETS as TOKEN_PRESETS, type Permission } from "@windkeel/api-contract";

export { PERMISSIONS, TOKEN_PRESETS };
export type { Permission };

export const ADMIN_PERMISSIONS: readonly Permission[] = [
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
];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export class InvalidScopeError extends Error {
  override readonly name = "InvalidScopeError";
}

export function resolveScope(input: { preset?: unknown; permissions?: unknown }): Permission[] {
  if (input.preset !== undefined && input.permissions !== undefined) {
    throw new InvalidScopeError("give either preset or permissions, not both");
  }
  if (input.preset !== undefined) {
    const preset = typeof input.preset === "string" ? TOKEN_PRESETS[input.preset] : undefined;
    if (!preset) {
      throw new InvalidScopeError(
        `unknown preset ${JSON.stringify(input.preset)}; use one of ${Object.keys(TOKEN_PRESETS).join(", ")}`,
      );
    }
    return [...preset];
  }
  if (input.permissions !== undefined) {
    if (!Array.isArray(input.permissions) || input.permissions.length === 0) {
      throw new InvalidScopeError("permissions must be a non-empty list");
    }
    const unknown = input.permissions.filter((p) => typeof p !== "string" || !isPermission(p));
    if (unknown.length > 0) {
      throw new InvalidScopeError(
        `unknown permission ${JSON.stringify(unknown[0])}; use any of ${PERMISSIONS.join(", ")}`,
      );
    }
    return [...new Set(input.permissions as Permission[])];
  }
  return [...(TOKEN_PRESETS["execute"] as Permission[])];
}
