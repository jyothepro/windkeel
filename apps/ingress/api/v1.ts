import "../src/env-compat.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { githubClientFromEnv } from "@windkeel/factory/github";
import { S3EvidenceStorage } from "@windkeel/factory/execution";
import { VercelConnectTokenSource } from "@windkeel/factory/integrations";
import { ensureJiraWebhook, removeJiraWebhook } from "@windkeel/factory/integrations";
import type { IntegrationConnection } from "@windkeel/factory/integrations";
import { webhookSigningKeyFromEnv } from "@windkeel/factory/intake";
import type { SandboxProvider } from "@windkeel/factory/sandbox";
import type { HumanWorkspaceProvider } from "@windkeel/factory/sandbox";
import { loadIngressConfig } from "../src/config.js";
import { functionPool } from "../src/db-pool.js";
import { deploymentSchema, primeSchemaCheck } from "../src/schema-gate.js";
import { apiControl } from "../src/api/control.js";
import { handleApiRequest } from "../src/api/router.js";
import { poolGithubIdentities, supabaseSessionVerifier } from "../src/api/session.js";
import { keepAlive, SSE_HEADERS } from "../src/api/sse.js";
import { DEFAULT_CHANGE_STREAM_OPTIONS, DEFAULT_STREAM_OPTIONS, streamRunChanges, streamRunEvents } from "../src/api/stream.js";
import { matchRoute } from "../src/api/route.js";
import { runEnqueuer } from "../src/windkeel-actions.js";
import {
  startEnvironmentSnapshotBuild,
  startModelCredentialValidation,
  startPullRequestMerge,
} from "@windkeel/factory/workflow";
import { appPullRequestFacts } from "@windkeel/factory/github";
import { mergeEnabledFromEnv } from "@windkeel/factory/runs";
import { allowLocalhostHttpFromEnv } from "@windkeel/factory/models";
import {
  BillingConfigError,
  DEFAULT_PRICING,
  loadBillingConfig,
  loadCreditPrices,
  selfServeMode,
} from "@windkeel/factory/billing";
import { billingProviderFromConfig } from "@windkeel/factory/billing";
import { githubInstallationVerifier } from "@windkeel/factory/github";
import { githubWebBase } from "@windkeel/factory/github";
import { defaultLog } from "@windkeel/factory/intake";
import type { BillingPort } from "../src/api/billing.js";

export const config = { runtime: "nodejs", maxDuration: 800 };

const STREAM_BUDGET_MS = 780_000;

const JIRA_API_BUDGET_MS = 20_000;

const ingressConfig = loadIngressConfig();

const pool = functionPool(ingressConfig.databaseUrl, 2);

primeSchemaCheck(pool);

const { evidence, captures, makerScreenshots } = storagePorts();

const integrationTokens = new VercelConnectTokenSource();

const supabaseUrl = process.env["SUPABASE_URL"]?.trim();
const sessions = supabaseUrl
  ? supabaseSessionVerifier({
      url: supabaseUrl,
      jwtSecret: process.env["SUPABASE_JWT_SECRET"]?.trim() || undefined,
      githubIdentities: poolGithubIdentities(pool),
    })
  : undefined;

const githubUsers = {
  async lookup(login: string): Promise<{ id: number; login: string } | null> {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return null;
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "windkeel-ingress" },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub user lookup failed with ${response.status}`);
    const body = (await response.json()) as { id?: unknown; login?: unknown };
    return typeof body.id === "number" && typeof body.login === "string" ? { id: body.id, login: body.login } : null;
  },
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query = { get: (name: string) => url.searchParams.get(name) ?? undefined };
  const headers = lowerCased(req.headers);

  const github = githubClientFromEnv();
  const deps = {
    pool,
    schema: deploymentSchema,
    control: apiControl({
      pool,
      control: runEnqueuer({ connectionString: ingressConfig.databaseUrl }),
      github,
    }),
    evidence,
    githubUsers,
    consoleUrl: process.env["WINDKEEL_CONSOLE_URL"]?.trim() || undefined,

    secretPublicKey: process.env["WINDKEEL_SECRET_PUBLIC_KEY"]?.trim() || undefined,

    credentialValidation: {
      request: async (organizationId: string, credentialId: string) => {
        await startModelCredentialValidation(organizationId, credentialId);
      },
    },

    environmentBuilds: {
      request: async (organizationId: string, repositoryId: string) => {
        await startEnvironmentSnapshotBuild(organizationId, repositoryId);
      },
    },
    modelEndpoint: { allowLocalhostHttp: allowLocalhostHttpFromEnv() },
    captures,
    makerScreenshots,

    sandboxes: () => sandboxProviders(),

    takeover: {
      enabled: ["1", "true"].includes((process.env["WINDKEEL_TAKEOVER"] ?? "").trim().toLowerCase()),
      workspaces: () => humanWorkspaces(),
    },
    integrationTokens,

    jiraWebhooks: {
      ensure: (connection: IntegrationConnection) =>
        ensureJiraWebhook(pool, connection, { tokens: integrationTokens, signal: AbortSignal.timeout(JIRA_API_BUDGET_MS) }),
      remove: (connection: IntegrationConnection) =>
        removeJiraWebhook(pool, connection, { tokens: integrationTokens, signal: AbortSignal.timeout(JIRA_API_BUDGET_MS) }),
    },

    webhookSigningKey: () => webhookSigningKeyFromEnv(),

    merge: {
      enabled: mergeEnabledFromEnv(),
      start: async (runMergeId: string) => {
        await startPullRequestMerge(runMergeId);
      },
      pullRequestFacts: appPullRequestFacts(github, { apiBase: githubApiBase }),
      githubApp: githubAppOAuth(),
      apiBase: githubApiBase,
    },

    billing: billingPort(),
  };
  const auth = {
    token: process.env["WINDKEEL_API_TOKEN"],
    subject: process.env["WINDKEEL_API_SUBJECT"] ?? "operator",
    sessions,

    clientIpHeader: process.env["WINDKEEL_CLIENT_IP_HEADER"]?.trim() || undefined,
  };

  const matched = req.method === "GET" && query.get("stream") === "sse" ? matchRoute("GET", url.pathname) : null;
  const streamRoute = matched && "matched" in matched ? matched.matched : null;
  if (streamRoute && (streamRoute.route.name === "runEvents" || streamRoute.route.name === "runChanges")) {
    const probe = await handleApiRequest(deps, auth, {
      method: "GET",
      path: url.pathname,
      query,
      headers,
    });

    if (probe.status !== 200) return sendJson(res, probe);

    res.writeHead(200, { ...SSE_HEADERS });

    res.write(keepAlive());
    let alive = true;
    res.on("close", () => {
      alive = false;
    });
    const sink = { write: (chunk: string) => void res.write(chunk), writable: () => alive && !res.writableEnded };
    if (streamRoute.route.name === "runEvents") {
      await streamRunEvents(pool, streamRoute.params["runId"]!, sink, query.get("after") ?? "0", {
        ...DEFAULT_STREAM_OPTIONS,
        budgetMs: STREAM_BUDGET_MS,
      });
    } else {

      const organizationId = (probe.body as { organizationId: string }).organizationId;
      await streamRunChanges(pool, organizationId, sink, query.get("after"), {
        ...DEFAULT_CHANGE_STREAM_OPTIONS,
        budgetMs: STREAM_BUDGET_MS,
      });
    }
    res.end();
    return;
  }

  const read =
    req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE"
      ? await readBody(req)
      : undefined;
  const result = await handleApiRequest(deps, auth, {
    method: req.method ?? "GET",
    path: url.pathname,
    query,
    headers,
    body: read?.json,

    rawBody: read?.raw,
    remoteAddress: req.socket?.remoteAddress,
  });
  sendJson(res, result);
}

function sendJson(
  res: ServerResponse,
  result: { status: number; body: unknown; headers?: Record<string, string>; raw?: string },
): void {

  if (result.raw !== undefined) {
    res.writeHead(result.status, { "content-type": "application/octet-stream", ...result.headers });
    res.end(result.raw);
    return;
  }

  if (Buffer.isBuffer(result.body)) {
    res.writeHead(result.status, { ...result.headers });
    res.end(result.body);
    return;
  }
  res.writeHead(result.status, { "content-type": "application/json; charset=utf-8", ...result.headers });
  res.end(JSON.stringify(result.body));
}

function lowerCased(headers: IncomingMessage["headers"]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<{ raw: Buffer; json: unknown }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  if (chunks.length === 0) return { raw, json: undefined };
  try {
    return { raw, json: JSON.parse(raw.toString("utf8")) };
  } catch {

    return { raw, json: undefined };
  }
}

let loadedBilling: BillingPort | undefined;
function billingPort(): BillingPort {
  if (loadedBilling) return loadedBilling;
  let provider: BillingPort["provider"] = null;
  let providerName: BillingPort["providerName"] = "none";
  let pricing = DEFAULT_PRICING;
  let prices: BillingPort["prices"];
  try {
    const config = loadBillingConfig();
    provider = billingProviderFromConfig(config);
    providerName = config.provider;
    pricing = config.pricing;
    prices = config.prices;
  } catch (error) {
    if (!(error instanceof BillingConfigError)) throw error;
    defaultLog("billing configuration refused", { variables: error.variables.join(",") });
  }
  const oauth = githubAppOAuth();
  loadedBilling = {
    provider,
    providerName,
    pricing,
    selfServe: selfServeMode(),

    prices: prices ?? loadCreditPrices(process.env, "none"),
    githubAppSlug: process.env["WINDKEEL_GITHUB_APP_SLUG"]?.trim() || undefined,
    installationVerifier: oauth
      ? githubInstallationVerifier({ ...oauth, apiBase: githubApiBase, webBase: githubWebBase(githubApiBase) })
      : undefined,
  };
  return loadedBilling;
}

const githubApiBase = (process.env["GITHUB_API_BASE_URL"]?.trim() || "https://api.github.com").replace(/\/+$/, "");

function githubAppOAuth(): { clientId: string; clientSecret: string } | undefined {
  const clientId = process.env["GITHUB_APP_CLIENT_ID"]?.trim();
  const clientSecret = process.env["GITHUB_APP_CLIENT_SECRET"]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

let loadedProviders: Record<string, SandboxProvider> | undefined;
async function humanWorkspaces(): Promise<HumanWorkspaceProvider> {
  const [{ sandboxCredentialsFromEnv }, { VercelHumanWorkspaceProvider }] = await Promise.all([
    import("@windkeel/factory/execution"),
    import("@windkeel/factory/execution"),
  ]);
  const credentials = sandboxCredentialsFromEnv();
  if (!credentials) throw new Error("WINDKEEL_SANDBOX_TOKEN, WINDKEEL_SANDBOX_TEAM_ID and WINDKEEL_SANDBOX_PROJECT_ID are required for a human workspace");
  return new VercelHumanWorkspaceProvider(credentials);
}

async function sandboxProviders(): Promise<Record<string, SandboxProvider>> {

  const { providersFromEnv } = await import("@windkeel/factory/execution");
  loadedProviders ??= providersFromEnv();
  return loadedProviders;
}

function storagePorts() {
  const endpoint = process.env["S3_ENDPOINT"];
  const accessKeyId = process.env["S3_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["S3_SECRET_ACCESS_KEY"];
  if (!endpoint || !accessKeyId || !secretAccessKey) return { evidence: undefined, captures: undefined, makerScreenshots: undefined };
  const storage = new S3EvidenceStorage({
    endpoint,
    region: process.env["S3_REGION"] ?? "us-east-1",
    accessKeyId,
    secretAccessKey,
  });
  const evidence = {
    list: (bucket: string, key: string) => storage.listPackage(bucket, key),
    presign: (bucket: string, key: string, path: string, ttlSeconds: number) =>
      storage.presignPackageFile(bucket, key, path, ttlSeconds),
    read: (bucket: string, key: string, path: string) => storage.getPackageFile(bucket, key, path),
  };

  const bucket = process.env["S3_BUCKET"]?.trim();
  const captures = bucket
    ? {
        bucket,
        put: (localDir: string, key: string) => storage.putPackage(localDir, bucket, key),
        list: async (key: string) =>
          (await storage.listPackage(bucket, key)).map((full) => full.slice(`${key}/`.length)),
        presign: (key: string, path: string, ttlSeconds: number) =>
          storage.presignPackageFile(bucket, key, path, ttlSeconds),
      }
    : undefined;

  const makerScreenshots = bucket
    ? {
        read: async (engineeringRunId: string, sha256: string) => {
          const { makerScreenshotPrefix } = await import("@windkeel/factory/runs");
          return storage.getPackageFile(bucket, makerScreenshotPrefix(engineeringRunId), `${sha256}.png`);
        },
      }
    : undefined;
  return { evidence, captures, makerScreenshots };
}
