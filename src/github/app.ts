import { createSign } from "node:crypto";
import {
  type InstallationPermissions,
  type InstallationToken,
  type RepositoryRef,
  repositoryPath,
} from "./client.js";

export class GitHubConfigError extends Error {
  constructor(message: string) {
    super(`github config: ${message}`);
    this.name = "GitHubConfigError";
  }
}

export interface GitHubAppCredentials {
  readonly appId: string;
  readonly privateKeyPem: string;
}

const PEM_HEADER = /-----BEGIN (RSA )?PRIVATE KEY-----/;

export function normalizePrivateKey(raw: string, variableName: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new GitHubConfigError(`${variableName} is empty`);

  const unescaped = trimmed.includes("\n") ? trimmed : trimmed.replace(/\\n/g, "\n");
  if (PEM_HEADER.test(unescaped)) return unescaped.trim();

  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (PEM_HEADER.test(decoded)) return decoded.trim();
  }

  throw new GitHubConfigError(
    `${variableName} is not a private key — expected a PEM ("-----BEGIN PRIVATE KEY-----"), ` +
      `a PEM with \\n escapes, or base64 of one`,
  );
}

export interface GitHubEnv {
  readonly GITHUB_APP_ID?: string | undefined;
  readonly GITHUB_APP_PRIVATE_KEY?: string | undefined;
  readonly GITHUB_WEBHOOK_SECRET?: string | undefined;
  readonly GITHUB_APP_INSTALLATION_ID?: string | undefined;
  readonly GITHUB_API_BASE_URL?: string | undefined;
}

export interface GitHubConfig {
  readonly credentials: GitHubAppCredentials;
  readonly webhookSecret: string | undefined;
  readonly installationId: number | undefined;
  readonly baseUrl: string;
}

export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

export function loadGitHubConfig(env: GitHubEnv, options: { requireWebhookSecret?: boolean } = {}): GitHubConfig {
  const appId = env.GITHUB_APP_ID?.trim();
  if (!appId) throw new GitHubConfigError("GITHUB_APP_ID is not set");
  if (!/^\d+$/.test(appId)) {
    throw new GitHubConfigError(`GITHUB_APP_ID must be numeric, got ${JSON.stringify(appId)}`);
  }

  const rawKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!rawKey || rawKey.trim() === "") {
    throw new GitHubConfigError("GITHUB_APP_PRIVATE_KEY is not set");
  }
  const privateKeyPem = normalizePrivateKey(rawKey, "GITHUB_APP_PRIVATE_KEY");

  const webhookSecret = env.GITHUB_WEBHOOK_SECRET?.trim() || undefined;
  if (options.requireWebhookSecret && !webhookSecret) {
    throw new GitHubConfigError("GITHUB_WEBHOOK_SECRET is not set");
  }

  const rawInstallationId = env.GITHUB_APP_INSTALLATION_ID?.trim();
  if (rawInstallationId !== undefined && !/^\d+$/.test(rawInstallationId)) {
    throw new GitHubConfigError(
      `GITHUB_APP_INSTALLATION_ID must be numeric, got ${JSON.stringify(rawInstallationId)}`,
    );
  }

  return {
    credentials: { appId, privateKeyPem },
    webhookSecret,
    installationId: rawInstallationId ? Number(rawInstallationId) : undefined,
    baseUrl: (env.GITHUB_API_BASE_URL?.trim() || DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, ""),
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export const APP_JWT_MAX_LIFETIME_SECONDS = 600;
const APP_JWT_CLOCK_SKEW_SECONDS = 60;

export function createAppJwt(
  credentials: GitHubAppCredentials,
  now: number = Date.now(),
  lifetimeSeconds: number = APP_JWT_MAX_LIFETIME_SECONDS - APP_JWT_CLOCK_SKEW_SECONDS,
): string {
  const issuedAt = Math.floor(now / 1000) - APP_JWT_CLOCK_SKEW_SECONDS;
  const payload = {
    iat: issuedAt,
    exp: issuedAt + lifetimeSeconds,
    iss: credentials.appId,
  };
  const signingInput = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(credentials.privateKeyPem)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function tokenCacheKey(
  installationId: number,
  repository: RepositoryRef,
  permissions: InstallationPermissions,
): string {
  const canonical = Object.keys(permissions)
    .sort()
    .map((key) => `${key}=${permissions[key as keyof InstallationPermissions]}`)
    .join(",");
  return `${installationId}|${repositoryPath(repository)}|${canonical}`;
}

export interface CachedToken {
  readonly token: InstallationToken;
  readonly expiresAtMs: number;
}

export class InstallationTokenCache {
  private readonly entries = new Map<string, CachedToken>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  get(key: string): InstallationToken | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs - TOKEN_REFRESH_MARGIN_MS <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.token;
  }

  set(key: string, token: InstallationToken): void {
    this.entries.set(key, { token, expiresAtMs: Date.parse(token.expiresAt) });
  }

  clear(): void {
    this.entries.clear();
  }
}
