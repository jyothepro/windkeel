export type IntegrationProvider = "slack" | "linear" | "jira" | "sentry";

export const PROVIDERS: readonly IntegrationProvider[] = ["slack", "linear", "jira", "sentry"];

export function isProvider(value: unknown): value is IntegrationProvider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export class IntegrationNotConnected extends Error {
  override readonly name = "IntegrationNotConnected";
  constructor(
    readonly provider: IntegrationProvider,
    readonly installationId: string,
    readonly reason: string,
  ) {
    super(`${provider} installation ${installationId} is not connected: ${reason}`);
  }
}

export class IntegrationMisconfigured extends Error {
  override readonly name = "IntegrationMisconfigured";
  constructor(
    readonly provider: IntegrationProvider,
    readonly reason: string,
  ) {
    super(`the ${provider} integration is misconfigured on this deployment: ${reason}`);
  }
}

export class IntegrationUnavailable extends Error {
  override readonly name = "IntegrationUnavailable";
  constructor(
    readonly provider: IntegrationProvider,
    readonly reason: string,
  ) {
    super(`Vercel Connect could not issue a ${provider} token: ${reason}`);
  }
}

export class TenantClaimedError extends Error {
  override readonly name = "TenantClaimedError";
  constructor(
    readonly provider: IntegrationProvider,
    readonly externalTenantId: string,
    message = `that ${provider} workspace is already connected to another organization`,
  ) {
    super(message);
  }
}

export class RouteError extends Error {
  override readonly name = "RouteError";
  constructor(
    message: string,
    readonly code: "invalid_route" | "repository_not_granted" | "route_exists" | "connection_disconnected",
    readonly status: 400 | 409 | 422,
  ) {
    super(message);
  }
}

export class ProviderUnauthorized extends Error {
  override readonly name = "ProviderUnauthorized";
  readonly status = 401;
  constructor(message = "the provider rejected the token") {
    super(message);
  }
}
