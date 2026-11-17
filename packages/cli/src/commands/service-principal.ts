import type { WindkeelApi } from "../client/api.js";
import { parseScope, resolveOrgId } from "./auth.js";
import type { RemoteIo } from "./remote.js";

export type ServicePrincipalCommand =
  | { kind: "list"; json?: boolean }
  | { kind: "create"; name?: string; role?: string; json?: boolean }
  | { kind: "delete"; principalId: string }
  | { kind: "token-list"; principalId: string; json?: boolean }
  | {
      kind: "token-create";
      principalId: string;
      name?: string;
      scope?: string;
      permissions?: string;
      expiresAt?: string;
      json?: boolean;
    }
  | { kind: "token-revoke"; principalId: string; tokenId: string };

export const SERVICE_PRINCIPAL_USAGE =
  "usage: windkeel service-principal list [--json]\n" +
  "       windkeel service-principal create --name <name> [--role admin|member|viewer] [--json]\n" +
  "       windkeel service-principal delete <principal-id>\n" +
  "       windkeel service-principal token list <principal-id> [--json]\n" +
  "       windkeel service-principal token create <principal-id> --name <name>\n" +
  "                 [--scope <preset> | --permissions <a,b>] [--expires-at <iso-time>] [--json]\n" +
  "       windkeel service-principal token revoke <principal-id> <token-id>\n";

const ROLES = ["admin", "member", "viewer"] as const;

export async function servicePrincipalCommand(
  api: WindkeelApi,
  io: RemoteIo,
  command: ServicePrincipalCommand,
): Promise<number> {
  if (command.kind === "create") {
    if (!command.name) {
      io.err("windkeel service-principal create needs --name (say what will act as it: slack-intake, nightly, …)");
      return 2;
    }
    if (command.role !== undefined && !(ROLES as readonly string[]).includes(command.role)) {
      io.err(`a role is one of ${ROLES.join(", ")}, not ${command.role}`);
      return 2;
    }
  }
  let scope: { preset?: string; permissions?: string[] } = {};
  let expiresAt: string | undefined;
  if (command.kind === "token-create") {
    if (!command.name) {
      io.err("windkeel service-principal token create needs --name");
      return 2;
    }
    if (command.scope !== undefined || command.permissions !== undefined) {
      const parsed = parseScope({
        ...(command.scope !== undefined ? { scope: command.scope } : {}),
        ...(command.permissions !== undefined ? { permissions: command.permissions } : {}),
      });
      if (typeof parsed === "string") {
        io.err(parsed);
        return 2;
      }
      scope = parsed;
    }
    if (command.expiresAt !== undefined) {
      const when = new Date(command.expiresAt);
      if (Number.isNaN(when.getTime())) {
        io.err("--expires-at must be an ISO 8601 time, e.g. 2027-01-01T00:00:00Z");
        return 2;
      }
      expiresAt = when.toISOString();
    }
  }

  const org = await resolveOrgId(api);
  if ("error" in org) {
    io.err(org.error);
    return 2;
  }

  switch (command.kind) {
    case "list": {
      const { items } = await api.listServicePrincipals(org.id);
      if (command.json) {
        io.out(JSON.stringify({ items }, null, 2));
        return 0;
      }
      if (items.length === 0) {
        io.out("No service principals.");
        return 0;
      }
      io.out(`${pad("ID", 38)}${pad("ROLE", 8)}${pad("KIND", 8)}NAME`);
      for (const sp of items) {
        io.out(pad(sp.id, 38) + pad(sp.role ?? "—", 8) + pad(sp.system ? "system" : "service", 8) + sp.displayName);
      }
      return 0;
    }
    case "create": {
      const { servicePrincipal } = await api.createServicePrincipal(org.id, {
        name: command.name!,
        ...(command.role ? { role: command.role } : {}),
      });
      if (command.json) {
        io.out(JSON.stringify({ servicePrincipal }, null, 2));
        return 0;
      }
      io.out(`Created service principal "${servicePrincipal.displayName}"  (id ${servicePrincipal.id})`);
      io.out(`  role:  ${servicePrincipal.role ?? "—"}  (${servicePrincipal.permissions.join(", ")})`);
      io.out(`Mint its token with:  windkeel service-principal token create ${servicePrincipal.id} --name <name>`);
      return 0;
    }
    case "delete":
      await api.deleteServicePrincipal(org.id, command.principalId);
      io.out(`Deleted ${command.principalId}. Every token it held is revoked.`);
      return 0;
    case "token-list": {
      const { items } = await api.listServiceTokens(org.id, command.principalId);
      if (command.json) {
        io.out(JSON.stringify({ items }, null, 2));
        return 0;
      }
      if (items.length === 0) {
        io.out("No tokens.");
        return 0;
      }
      io.out(`${pad("ID", 38)}${pad("NAME", 20)}${pad("PREFIX", 14)}${pad("STATE", 9)}CAN`);
      for (const token of items) {
        const state = token.revokedAt
          ? "revoked"
          : token.expiresAt && Date.parse(token.expiresAt) <= Date.now()
            ? "expired"
            : "active";
        io.out(pad(token.id, 38) + pad(token.name, 20) + pad(token.prefix, 14) + pad(state, 9) + token.permissions.join(","));
      }
      return 0;
    }
    case "token-create": {
      const created = await api.createServiceToken(org.id, command.principalId, {
        name: command.name!,
        ...scope,
        ...(expiresAt ? { expiresAt } : {}),
      });
      if (command.json) {
        io.out(JSON.stringify(created, null, 2));
        return 0;
      }
      const t = created.token;
      io.out(`Created token "${t.name}" for service principal ${command.principalId}  (id ${t.id})`);
      io.out(`  can:      ${t.permissions.join(", ")}`);
      io.out(`  org:      ${t.organizationId ?? org.id}`);
      io.out(`  expires:  ${t.expiresAt ?? "never"}`);
      io.out("");
      io.out(created.secret);
      io.out("");
      io.out("This is the only time the secret is shown; it will not be shown again. Store it now.");
      return 0;
    }
    case "token-revoke": {
      const { token } = await api.revokeServiceToken(org.id, command.principalId, command.tokenId);
      io.out(`Revoked "${token.name}" (${token.prefix}…). Anything still using it is refused from now on.`);
      return 0;
    }
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value + " ".repeat(width - value.length);
}
