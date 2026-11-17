
import { PERMISSIONS, PRESETS, type Permission } from "@windkeel/api-contract";
import type { SelfView } from "./views.js";

export { PERMISSIONS, PRESETS };
export type { Permission };

export function presetFor(permission: string): string {
  for (const name of ["read", "execute", "approve"]) {
    if (PRESETS[name]!.includes(permission as Permission)) return name;
  }
  return "admin";
}

export function effectivePermissions(self: SelfView, org?: string): string[] | null {
  const orgs = self.organizations;
  const tokenPermissions = self.token?.permissions;
  if (!orgs && !tokenPermissions) return null;

  let orgPermissions: string[] | null = null;
  if (orgs) {
    const chosen = org ?? self.token?.organizationId ?? (orgs.length === 1 ? orgs[0]!.id : undefined);
    const match = chosen === undefined ? undefined : orgs.find((o) => o.id === chosen || o.name === chosen);
    orgPermissions = match ? match.permissions : [...new Set(orgs.flatMap((o) => o.permissions))];
  }

  if (!tokenPermissions) return orgPermissions ?? [];
  if (orgPermissions === null) return [...tokenPermissions];
  const allowed = orgPermissions;
  return tokenPermissions.filter((p) => allowed.includes(p));
}
