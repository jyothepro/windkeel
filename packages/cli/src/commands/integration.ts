import type { IntegrationRouteView, IntegrationView, WindkeelApi } from "../client/api.js";
import type { RemoteIo } from "./remote.js";

export const INTEGRATION_USAGE =
  "usage: windkeel integration list [--json]\n" +
  "       windkeel integration connect <slack|linear|jira> <installation-id> [--json]\n" +
  "       windkeel integration disconnect <integration-id>\n" +
  "       windkeel integration route add <integration-id> --repo <repository-id>\n" +
  "                                   [--scope default|slack_channel|linear_team|jira_project]\n" +
  "                                   [--value <channel|team|project>] [--label <trigger-label>] [--json]\n" +
  "       windkeel integration route rm <integration-id> <route-id>\n";

export type IntegrationAction =
  | { kind: "list"; json?: boolean }
  | { kind: "connect"; provider: string; installationId: string; json?: boolean }
  | { kind: "disconnect"; integrationId: string }
  | {
      kind: "route-add";
      integrationId: string;
      repositoryId: string;
      scopeKind?: string;
      scopeValue?: string;
      triggerLabel?: string;
      json?: boolean;
    }
  | { kind: "route-rm"; integrationId: string; routeId: string };

export async function integrationCommand(api: WindkeelApi, io: RemoteIo, action: IntegrationAction): Promise<number> {
  switch (action.kind) {
    case "list": {
      const page = await api.listIntegrations();
      if (action.json) {
        io.out(JSON.stringify(page.items, null, 2));
        return 0;
      }
      if (page.items.length === 0) {
        io.out("no integrations; connect one with `windkeel integration connect <provider> <installation-id>`");
        return 0;
      }
      for (const connection of page.items) io.out(formatIntegration(connection));
      return 0;
    }
    case "connect": {
      const { connection } = await api.connectIntegration(action.provider, action.installationId);
      if (action.json) io.out(JSON.stringify(connection, null, 2));
      else {
        io.out(`connected ${describe(connection)}  (${connection.id})`);
        io.out("add a route so its work has somewhere to go: `windkeel integration route add " + connection.id + " --repo <repository-id>`");
      }
      return 0;
    }
    case "disconnect": {
      const { connection } = await api.disconnectIntegration(action.integrationId);
      io.out(`disconnected ${describe(connection)}`);
      return 0;
    }
    case "route-add": {
      const { route } = await api.addIntegrationRoute(action.integrationId, {
        repositoryId: action.repositoryId,
        ...(action.scopeKind ? { scopeKind: action.scopeKind } : {}),
        ...(action.scopeValue ? { scopeValue: action.scopeValue } : {}),
        ...(action.triggerLabel ? { triggerLabel: action.triggerLabel } : {}),
      });
      io.out(action.json ? JSON.stringify(route, null, 2) : `added route ${formatRoute(route)}`);
      return 0;
    }
    case "route-rm": {
      await api.removeIntegrationRoute(action.integrationId, action.routeId);
      io.out(`removed route ${action.routeId}`);
      return 0;
    }
  }
}

function describe(c: IntegrationView): string {
  return `${c.provider} ${c.externalTenantName ?? c.externalTenantId}`;
}

export function formatIntegration(c: IntegrationView): string {
  const lines = [`${c.id}  ${describe(c)}  [${c.status}]  installation ${c.installationId}`];
  const routes = c.routes ?? [];
  if (routes.length === 0) lines.push("  (no routes: its work has nowhere to go)");
  for (const route of routes) lines.push(`  ${formatRoute(route)}`);
  return lines.join("\n");
}

function formatRoute(r: IntegrationRouteView): string {
  const scope = r.scopeKind === "default" ? "default" : `${r.scopeKind}=${r.scopeValue ?? ""}`;
  return `${r.id}  ${scope} -> ${r.repositoryId}  label "${r.triggerLabel}"${r.enabled ? "" : "  (disabled)"}`;
}
