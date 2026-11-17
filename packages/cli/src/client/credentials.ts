import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StoredCredentials {
  apiUrl: string;
  token: string;
  org?: string;
}

export type CredentialSource = "env" | "file" | "explicit";

export interface ResolvedConfig {
  baseUrl: string;
  token: string;
  org?: string;
  tokenSource: CredentialSource;
  orgSource?: "flag" | "env" | "file";
  credentialsPath: string;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["WINDKEEL_CONFIG_DIR"]?.trim();
  if (explicit) return explicit;
  const xdg = env["XDG_CONFIG_HOME"]?.trim();
  const base = xdg || join(env["HOME"]?.trim() || homedir(), ".config");
  const current = join(base, "windkeel");
  const legacy = join(base, "orqon");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "credentials.json");
}

export class CredentialsFileError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`${path}: ${reason} — run \`windkeel login\` again, or delete the file`);
    this.name = "CredentialsFileError";
  }
}

export function readCredentials(env: NodeJS.ProcessEnv = process.env): StoredCredentials | null {
  const path = credentialsPath(env);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CredentialsFileError(path, "not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new CredentialsFileError(path, "not an object");
  const record = parsed as Record<string, unknown>;
  const apiUrl = record["apiUrl"];
  const token = record["token"];
  const org = record["org"];
  if (typeof apiUrl !== "string" || apiUrl === "" || typeof token !== "string" || token === "") {
    throw new CredentialsFileError(path, "missing apiUrl or token");
  }
  return { apiUrl, token, ...(typeof org === "string" && org !== "" ? { org } : {}) };
}

export function writeCredentials(credentials: StoredCredentials, env: NodeJS.ProcessEnv = process.env): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = credentialsPath(env);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const body: StoredCredentials = {
    apiUrl: credentials.apiUrl,
    token: credentials.token,
    ...(credentials.org ? { org: credentials.org } : {}),
  };
  writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return path;
}

export function deleteCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = credentialsPath(env);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export function sameApiUrl(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");
}

export class MissingApiConfigError extends Error {
  constructor(
    readonly variable: string,
    purpose: string,
  ) {
    super(
      `${variable} is not set — ${purpose}.\n` +
        `Run \`windkeel login --url <api-url>\` to sign in from this machine, or set ${variable} ` +
        `(CI, and agents configured through their MCP settings).`,
    );
    this.name = "MissingApiConfigError";
  }
}

export function resolveApiConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { baseUrl?: string; token?: string; org?: string } = {},
): ResolvedConfig {
  const path = credentialsPath(env);
  const envUrl = env["WINDKEEL_API_URL"]?.trim() || undefined;
  const envToken = env["WINDKEEL_API_TOKEN"]?.trim() || undefined;
  const envOrg = env["WINDKEEL_ORG"]?.trim() || undefined;

  const explicitToken = overrides.token ?? envToken;
  const needFile = explicitToken === undefined || (overrides.baseUrl ?? envUrl) === undefined;
  const file = needFile ? readCredentials(env) : null;

  const baseUrl = overrides.baseUrl ?? envUrl ?? file?.apiUrl;
  if (!baseUrl) throw new MissingApiConfigError("WINDKEEL_API_URL", "the control plane's base URL");

  let token: string | undefined;
  let tokenSource: CredentialSource;
  if (overrides.token !== undefined) {
    token = overrides.token;
    tokenSource = "explicit";
  } else if (envToken !== undefined) {
    token = envToken;
    tokenSource = "env";
  } else {
    tokenSource = "file";
    if (file && !sameApiUrl(file.apiUrl, baseUrl)) {
      throw new MissingApiConfigError(
        "WINDKEEL_API_TOKEN",
        `the credential in ${path} was issued by ${file.apiUrl}, and WINDKEEL_API_URL points at ${baseUrl}; ` +
          `it is not sent anywhere but the deployment that issued it`,
      );
    }
    token = file?.token;
  }
  if (!token) throw new MissingApiConfigError("WINDKEEL_API_TOKEN", "no API token, and no stored login");

  let org: string | undefined;
  let orgSource: ResolvedConfig["orgSource"];
  if (overrides.org) {
    org = overrides.org;
    orgSource = "flag";
  } else if (envOrg) {
    org = envOrg;
    orgSource = "env";
  } else if (tokenSource === "file" && file?.org) {
    org = file.org;
    orgSource = "file";
  }

  return {
    baseUrl,
    token,
    tokenSource,
    credentialsPath: path,
    ...(org ? { org } : {}),
    ...(orgSource ? { orgSource } : {}),
  };
}
