import { IntegrationNotConnected, ProviderUnauthorized, type IntegrationProvider } from "./errors.js";

export interface ProviderTokenRequest {
  provider: IntegrationProvider;
  installationId: string;
  scopes?: string[];
}

export interface InstallationIdentity {
  tenantId: string | null;
  name: string | null;
}

export interface ProviderTokenSource {
  getToken(req: ProviderTokenRequest): Promise<string>;
  describeInstallation(req: ProviderTokenRequest): Promise<InstallationIdentity>;
  invalidate(req: ProviderTokenRequest): void;
}

export async function withProviderToken<T>(
  source: ProviderTokenSource,
  req: ProviderTokenRequest,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const first = await attempt(source, req, fn);
  if (!first.unauthorized) return first.value();
  source.invalidate(req);
  return (await attempt(source, req, fn)).value();
}

async function attempt<T>(
  source: ProviderTokenSource,
  req: ProviderTokenRequest,
  fn: (token: string) => Promise<T>,
): Promise<{ unauthorized: boolean; value: () => T }> {
  const token = await source.getToken(req);
  try {
    const result = await fn(token);
    return { unauthorized: statusOf(result) === 401, value: () => result };
  } catch (err) {
    if (err instanceof ProviderUnauthorized || statusOf(err) === 401) {
      return {
        unauthorized: true,
        value: () => {
          throw err;
        },
      };
    }
    throw err;
  }
}

function statusOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const status = (value as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export class FakeProviderTokenSource implements ProviderTokenSource {
  readonly calls: Array<{ method: "getToken" | "describeInstallation" | "invalidate"; req: ProviderTokenRequest }> = [];
  private readonly installations = new Map<string, InstallationIdentity>();
  private issued = 0;
  failWith: Error | undefined;

  install(provider: IntegrationProvider, installationId: string, identity: InstallationIdentity): this {
    this.installations.set(`${provider}:${installationId}`, identity);
    return this;
  }

  async getToken(req: ProviderTokenRequest): Promise<string> {
    this.calls.push({ method: "getToken", req });
    this.check(req);
    this.issued += 1;
    return `fake-${req.provider}-${req.installationId}-${this.issued}`;
  }

  async describeInstallation(req: ProviderTokenRequest): Promise<InstallationIdentity> {
    this.calls.push({ method: "describeInstallation", req });
    this.check(req);
    return this.installations.get(`${req.provider}:${req.installationId}`)!;
  }

  invalidate(req: ProviderTokenRequest): void {
    this.calls.push({ method: "invalidate", req });
  }

  private check(req: ProviderTokenRequest): void {
    if (this.failWith) throw this.failWith;
    if (!this.installations.has(`${req.provider}:${req.installationId}`)) {
      throw new IntegrationNotConnected(req.provider, req.installationId, "no such installation (fake)");
    }
  }
}
