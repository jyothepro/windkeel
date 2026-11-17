

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Pool, type PoolClient } from "pg";
import { redactSecrets } from "./log.js";
import { credentialProvider } from "./model-credential-providers.js";
import {
  ModelCredentialError,
  getModelCredential,
  openModelCredential,
  type ModelCredential,
} from "./model-credentials.js";
import { allowLocalhostHttpFromEnv, guardedLookup, parseBaseUrl } from "./model-endpoint-guard.js";
import { secretPrivateKeysFromEnv } from "./worker-config.js";
import { recordModelCredentialValidation, selectModelCredentialVersion } from "./stores/model-credential-store.js";

type Db = Pool | PoolClient;

export type CredentialProbe = (request: {
  url: string;
  headers: Record<string, string>;
  allowLocalhostHttp: boolean;
  timeoutMs: number;
}) => Promise<{ status: number }>;

export interface ValidationDeps {
  pool: Db;

  privateKeys: readonly string[];

  probe?: CredentialProbe;
  allowLocalhostHttp?: boolean;
  timeoutMs?: number;
}

export type ValidationOutcome = { status: "valid" | "invalid" | "unverified" | "skipped" };

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REASON_LENGTH = 300;

export async function validateModelCredential(
  deps: ValidationDeps,
  organizationId: string,
  credentialId: string,
): Promise<ValidationOutcome> {

  const version = await credentialVersion(deps.pool, organizationId, credentialId);
  if (version === null) return { status: "skipped" };

  if (deps.privateKeys.length === 0) {
    await record(deps.pool, organizationId, credentialId, version, "unverified",
      "the stage deployment has no WINDKEEL_SECRET_PRIVATE_KEY, so the credential cannot be opened to check it");
    return { status: "unverified" };
  }

  let credential: ModelCredential;
  let value: string;
  try {
    ({ credential, value } = await openModelCredential(deps.pool, deps.privateKeys, organizationId, credentialId));
  } catch (err) {
    if (err instanceof ModelCredentialError) return { status: "skipped" };
    if (err instanceof Error && err.name === "SealedSecretError") {

      await record(deps.pool, organizationId, credentialId, version, "invalid", `could not be opened: ${err.message}`);
      return { status: "invalid" };
    }
    throw err;
  }

  const outcome = await probeOutcome(deps, credential, value);
  await record(deps.pool, organizationId, credentialId, version, outcome.status, scrub(outcome.reason, value));
  return { status: outcome.status };
}

async function probeOutcome(
  deps: ValidationDeps,
  credential: ModelCredential,
  value: string,
): Promise<{ status: "valid" | "invalid" | "unverified"; reason: string | null }> {
  const provider = credentialProvider(credential.provider);
  const base = credential.baseUrl ?? provider?.defaultBaseUrl ?? null;
  if (!provider || !base) {
    return { status: "invalid", reason: `provider ${credential.provider} is not one this deployment knows` };
  }
  const allowLocalhostHttp = deps.allowLocalhostHttp ?? false;
  let url: string;
  try {

    url = `${parseBaseUrl(base, { allowLocalhostHttp }).toString().replace(/\/$/, "")}${provider.probePath}`;
  } catch (err) {
    return { status: "invalid", reason: err instanceof Error ? err.message : "the base URL is not allowed" };
  }

  let status: number;
  try {
    ({ status } = await (deps.probe ?? httpProbe)({
      url,
      headers: provider.authHeaders(value),
      allowLocalhostHttp,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }));
  } catch (err) {
    if (err instanceof Error && err.name === "UnsafeEndpointError") {
      return { status: "invalid", reason: err.message };
    }

    const code = (err as { code?: unknown })?.code;
    return {
      status: "unverified",
      reason: `could not reach ${hostOf(url)} (${typeof code === "string" ? code : "network error"}); not yet verified`,
    };
  }

  const path = provider.probePath;
  if (status >= 200 && status < 300) return { status: "valid", reason: null };
  if (status === 401 || status === 403) {
    return { status: "invalid", reason: `the provider refused the key (HTTP ${status} from GET ${path})` };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return {
      status: "unverified",
      reason: `HTTP ${status} from GET ${path}: rate-limited, out of quota or unavailable; not yet verified`,
    };
  }
  if (status >= 300 && status < 400) {
    return {
      status: "invalid",
      reason: `HTTP ${status} from GET ${path}: the endpoint redirects, and a key is never sent after a redirect; use the final URL as the base URL`,
    };
  }
  return { status: "invalid", reason: `HTTP ${status} from GET ${path}; check the provider and base URL` };
}

function scrub(reason: string | null, value: string): string | null {
  if (reason === null) return null;
  return redactSecrets(reason.split(value).join("[redacted]")).slice(0, MAX_REASON_LENGTH);
}

async function credentialVersion(db: Db, organizationId: string, credentialId: string): Promise<string | null> {

  const credential = await getModelCredential(db, organizationId, credentialId);
  if (!credential || credential.revokedAt !== null) return null;

  return selectModelCredentialVersion(db, organizationId, credentialId);
}

async function record(
  db: Db,
  organizationId: string,
  credentialId: string,
  version: string,
  status: "valid" | "invalid" | "unverified",
  reason: string | null,
): Promise<void> {
  await recordModelCredentialValidation(db, { organizationId, credentialId, version, status, reason });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the endpoint";
  }
}

export const httpProbe: CredentialProbe = ({ url, headers, allowLocalhostHttp, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "http:" ? httpRequest : httpsRequest;
    const req = send(
      target,
      {
        method: "GET",
        headers: { ...headers, accept: "application/json", "user-agent": "windkeel-credential-check" },
        lookup: guardedLookup({ allowLocalhostHttp }),
        timeout: timeoutMs,
      },
      (res) => {
        resolve({ status: res.statusCode ?? 0 });
        res.destroy();
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });

let pool: Pool | null = null;

export async function validateModelCredentialFromEnvironment(
  organizationId: string,
  credentialId: string,
): Promise<ValidationOutcome> {
  if (!pool) {
    const connectionString = process.env["DATABASE_POOL_URL"]?.trim() || process.env["DATABASE_URL"]?.trim();
    if (!connectionString) throw new Error("validateModelCredential: DATABASE_URL is not set");
    pool = new Pool({ connectionString, max: 1, idleTimeoutMillis: 5_000 });
    const { attachDatabasePool } = await import("@vercel/functions");
    attachDatabasePool(pool);
  }
  return await validateModelCredential(
    {
      pool,
      privateKeys: secretPrivateKeysFromEnv(),
      allowLocalhostHttp: allowLocalhostHttpFromEnv(),
    },
    organizationId,
    credentialId,
  );
}
