

import { isModelProvider, PROVIDERS } from "@windkeel/verification/providers/catalog.js";
import { type WorkerModelRoute } from "../adapter.js";

export const DEFAULT_MODEL_API_DOMAIN = "api.openai.com";

export const CODEX_PROVIDER_ID = "windkeel";

export const CODEX_PROVIDER_ENV_KEY = "CODEX_API_KEY";

export type RouteIdentity = Pick<WorkerModelRoute, "model" | "provider" | "baseUrl">;

export function codexModelArgs(route: RouteIdentity): string[] {
  const args = ["--model", route.model];
  const known = isModelProvider(route.provider) ? PROVIDERS[route.provider] : undefined;
  const baseUrl = route.baseUrl ?? known?.defaultBaseUrl;
  const builtIn = route.provider === "openai" && (route.baseUrl === undefined || route.baseUrl === PROVIDERS.openai.defaultBaseUrl);
  if (builtIn || baseUrl === undefined) return args;
  const table = [
    `name = ${tomlString(`Windkeel ${route.provider}`)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `env_key = ${tomlString(CODEX_PROVIDER_ENV_KEY)}`,
    `wire_api = "responses"`,
  ].join(", ");
  return [
    ...args,
    "-c",
    `model_provider=${tomlString(CODEX_PROVIDER_ID)}`,
    "-c",
    `model_providers.${CODEX_PROVIDER_ID}={ ${table} }`,
  ];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function identityOf(route: RouteIdentity): RouteIdentity {
  return {
    model: route.model,
    provider: route.provider,
    ...(route.baseUrl !== undefined ? { baseUrl: route.baseUrl } : {}),
  };
}

export function routeIdentityOf(raw: unknown): RouteIdentity | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value["model"] !== "string" || typeof value["provider"] !== "string") return undefined;
  return identityOf({
    model: value["model"],
    provider: value["provider"],
    ...(typeof value["baseUrl"] === "string" ? { baseUrl: value["baseUrl"] } : {}),
  });
}

export function sameIdentity(a: RouteIdentity, b: RouteIdentity): boolean {
  return a.model === b.model && a.provider === b.provider && (a.baseUrl ?? null) === (b.baseUrl ?? null);
}

export function describeIdentity(identity: RouteIdentity): string {
  return `${identity.provider}/${identity.model}${identity.baseUrl ? ` at ${identity.baseUrl}` : ""}`;
}
