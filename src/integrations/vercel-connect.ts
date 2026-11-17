import {
  IntegrationMisconfigured,
  IntegrationNotConnected,
  IntegrationUnavailable,
  type IntegrationProvider,
} from "./errors.js";
import type { InstallationIdentity, ProviderTokenRequest, ProviderTokenSource } from "./token-source.js";

export interface ConnectSdk {
  getToken(connector: string, params: ConnectParams): Promise<string>;
  getTokenResponse(
    connector: string,
    params: ConnectParams,
  ): Promise<{ token: string; tenantId?: string; name?: string; installationId?: string }>;
  deleteTokenCacheEntry(connector: string, params: ConnectParams): void;
}

interface ConnectParams {
  subject: { type: "app" };
  installationId: string;
  scopes?: string[];
}

const CONNECTOR_ENV: Readonly<Record<IntegrationProvider, string>> = {
  slack: "WINDKEEL_CONNECT_SLACK",
  linear: "WINDKEEL_CONNECT_LINEAR",
  jira: "WINDKEEL_CONNECT_JIRA",
  sentry: "WINDKEEL_CONNECT_SENTRY",
};

const NOT_CONNECTED_NAMES = new Set([
  "ConnectorInstallationRequiredError",
  "NoValidTokenError",
  "UserAuthorizationRequiredError",
]);
const NOT_CONNECTED_CODES = new Set([
  "no_token",
  "client_installation_required",
  "connector_installation_required",
  "user_authorization_required",
]);

const MISCONFIGURED_NAMES = new Set([
  "ConnectorNotFoundError",
  "ClientNotLinkedToProjectError",
  "ClientNotEnabledForEnvironmentError",
  "VercelOidcTokenError",
]);
const MISCONFIGURED_CODES = new Set([
  "connector_not_found",
  "client_not_found",
  "client_not_linked_to_project",
  "client_not_enabled_for_environment",
  "project_not_linked",
  "environment_not_enabled",
]);

export interface VercelConnectTokenSourceOptions {
  env?: Record<string, string | undefined>;
  sdk?: ConnectSdk | (() => Promise<ConnectSdk>);
}

export class VercelConnectTokenSource implements ProviderTokenSource {
  private readonly env: Record<string, string | undefined>;
  private readonly loadSdk: () => Promise<ConnectSdk>;
  private sdk: ConnectSdk | undefined;

  constructor(options: VercelConnectTokenSourceOptions = {}) {
    this.env = options.env ?? process.env;
    const sdk = options.sdk;
    this.loadSdk =
      sdk === undefined
        ? async () => await import("@vercel/connect")
        : typeof sdk === "function"
          ? sdk
          : async () => sdk;
  }

  async getToken(req: ProviderTokenRequest): Promise<string> {
    const connector = this.connectorFor(req.provider);
    const sdk = await this.connect();
    try {
      return await sdk.getToken(connector, params(req));
    } catch (err) {
      throw mapConnectError(err, req);
    }
  }

  async describeInstallation(req: ProviderTokenRequest): Promise<InstallationIdentity> {
    const connector = this.connectorFor(req.provider);
    const sdk = await this.connect();
    try {
      const response = await sdk.getTokenResponse(connector, params(req));
      return { tenantId: response.tenantId ?? null, name: response.name ?? null };
    } catch (err) {
      throw mapConnectError(err, req);
    }
  }

  invalidate(req: ProviderTokenRequest): void {
    const connector = this.connectorFor(req.provider);
    this.sdk?.deleteTokenCacheEntry(connector, params(req));
  }

  private connectorFor(provider: IntegrationProvider): string {
    const name = CONNECTOR_ENV[provider];
    const uid = this.env[name]?.trim();
    if (!uid) throw new IntegrationMisconfigured(provider, `${name} is not set`);
    return uid;
  }

  private async connect(): Promise<ConnectSdk> {
    this.sdk ??= await this.loadSdk();
    return this.sdk;
  }
}

function params(req: ProviderTokenRequest): ConnectParams {
  return {
    subject: { type: "app" },
    installationId: req.installationId,
    ...(req.scopes && req.scopes.length > 0 ? { scopes: [...req.scopes] } : {}),
  };
}

function mapConnectError(err: unknown, req: ProviderTokenRequest): Error {
  if (err instanceof IntegrationMisconfigured || err instanceof IntegrationNotConnected) return err;
  const name = err instanceof Error ? err.name : "";
  const code = codeOf(err);
  if (NOT_CONNECTED_NAMES.has(name) || (code !== undefined && NOT_CONNECTED_CODES.has(code))) {
    return new IntegrationNotConnected(req.provider, req.installationId, code ?? name);
  }
  if (MISCONFIGURED_NAMES.has(name) || (code !== undefined && MISCONFIGURED_CODES.has(code))) {
    return new IntegrationMisconfigured(req.provider, code ?? name);
  }
  const status = statusOf(err);
  return new IntegrationUnavailable(
    req.provider,
    [name || "error", code, status === undefined ? undefined : `status ${status}`].filter(Boolean).join(", "),
  );
}

function codeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export interface ForwardedRequest {
  headers: Record<string, string | undefined>;
}

export type ConnectForwardVerifier = (req: ForwardedRequest) => Promise<boolean>;

function forwardEnvironment(env: Record<string, string | undefined>): string | null {
  const value = (env["VERCEL_TARGET_ENV"] ?? env["VERCEL_ENV"])?.trim();
  return value ? value : null;
}

function forwardOwnerId(env: Record<string, string | undefined>): string | undefined {
  const explicit = env["WINDKEEL_CONNECT_OWNER_ID"]?.trim();
  if (explicit) return explicit;
  const team = env["VERCEL_TEAM_ID"]?.trim();
  return team && team.startsWith("team_") ? team : undefined;
}

export interface ConnectForwardVerifierOptions {
  env?: Record<string, string | undefined>;
  environment?: string;
  createVerifier?: (options: {
    projectId: string;
    environment: string[];
    ownerId?: string;
  }) => (request: Request, body: string) => Promise<unknown> | unknown;
}

export function createConnectForwardVerifier(options: ConnectForwardVerifierOptions = {}): ConnectForwardVerifier {
  const env = options.env ?? process.env;
  return async (req) => {
    try {
      const authorization = req.headers["authorization"];
      if (!authorization) return false;
      const projectId = env["VERCEL_PROJECT_ID"]?.trim();
      if (!projectId) return false;
      const environment = options.environment?.trim() || forwardEnvironment(env);
      if (!environment) return false;
      const ownerId = forwardOwnerId(env);
      const create =
        options.createVerifier ??
        ((await import("@vercel/connect/chat")).createConnectWebhookVerifier);
      const verify = create({
        projectId,
        environment: [environment],
        ...(ownerId === undefined ? {} : { ownerId }),
      });
      const request = { headers: new Headers({ authorization }) } as unknown as Request;
      const verdict = await verify(request, "");
      return Boolean(verdict);
    } catch {
      return false;
    }
  };
}

let defaultVerifier: ConnectForwardVerifier | undefined;

export function verifyConnectForward(req: ForwardedRequest): Promise<boolean> {
  defaultVerifier ??= createConnectForwardVerifier();
  return defaultVerifier(req);
}

export function fakeConnectForwardVerifier(token = "test-connect-oidc"): ConnectForwardVerifier {
  return async (req) => req.headers["authorization"] === `Bearer ${token}`;
}
