import type { Pool, PoolClient } from "pg";
import { recordAuditEvent, withTransaction, type AuditAction, type AuditContext } from "@windkeel/factory/tenancy";
import type { ErrorBody } from "@windkeel/api-contract";
import { enabledHarnesses, type HarnessInfo } from "@windkeel/factory/runs";
import type { SchemaGuard } from "@windkeel/factory/ops";
import type { TaskModelOverride } from "@windkeel/factory/models";
import { type Permission } from "@windkeel/factory/tenancy";
import { FEED_START } from "@windkeel/factory/runs";
import type { GuidanceRecord } from "@windkeel/factory/runs";
import type { RailsOptions } from "@windkeel/factory/runs";
import type { SandboxProvider } from "@windkeel/factory/sandbox";
import type { HumanWorkspaceProvider } from "@windkeel/factory/sandbox";
import { type IntegrationConnection } from "@windkeel/factory/integrations";
import type { ProviderTokenSource } from "@windkeel/factory/integrations";
import { defaultLog, describeError } from "@windkeel/factory/intake";
import { runFeedHead } from "../stores/run-store.js";

export interface ApiResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;

  raw?: string;
}

export type ApiError = ErrorBody;

export function ok(body: unknown, headers?: Record<string, string>): ApiResult {
  return headers ? { status: 200, body, headers } : { status: 200, body };
}

export function accepted(body: Record<string, unknown>): ApiResult {
  return { status: 202, body: { accepted: true, ...body } };
}

export function notFound(what: string): ApiResult {
  return { status: 404, body: { error: `no such ${what}`, code: "not_found" } satisfies ApiError };
}

export function repositoryNoLongerGranted(): ApiResult {
  return notFound("repository");
}

export function badRequest(error: string, code = "bad_request"): ApiResult {
  return { status: 400, body: { error, code } satisfies ApiError };
}

export function conflict(error: string, code = "conflict"): ApiResult {
  return { status: 409, body: { error, code } satisfies ApiError };
}

export interface ApiDeps {
  pool: Pool;

  schema?: SchemaGuard | undefined;

  control: RunCommandPort;

  evidence?: EvidencePort | undefined;

  githubUsers?: GitHubUserLookup | undefined;

  consoleUrl?: string | undefined;

  secretPublicKey?: string | undefined;

  credentialValidation?: { request(organizationId: string, credentialId: string): Promise<void> } | undefined;

  environmentBuilds?: { request(organizationId: string, repositoryId: string): Promise<void> } | undefined;

  modelEndpoint?:
    | { allowLocalhostHttp?: boolean; resolve?: (hostname: string) => Promise<string[]> }
    | undefined;

  sandboxes?: (() => Promise<Record<string, SandboxProvider>>) | undefined;

  captures?: CaptureStore | undefined;

  makerScreenshots?: import("./screenshots.js").MakerScreenshotStore | undefined;

  integrationTokens?: ProviderTokenSource | undefined;

  webhookSigningKey?: (() => string | undefined) | undefined;

  jiraWebhooks?:
    | {
        ensure(connection: IntegrationConnection): Promise<unknown>;
        remove?(connection: IntegrationConnection): Promise<unknown>;
      }
    | undefined;

  makerHarnesses?: readonly HarnessInfo[] | undefined;

  takeover?:
    | {
        enabled: boolean;
        workspaces?: (() => Promise<HumanWorkspaceProvider>) | undefined;
      }
    | undefined;

  merge?: import("./merge.js").MergePort | undefined;

  billing?: import("./billing.js").BillingPort | undefined;
}

export function harnessesOf(deps: ApiDeps): readonly HarnessInfo[] {
  return deps.makerHarnesses ?? enabledHarnesses(process.env);
}

export function refusedHarness(deps: ApiDeps, override: { maker?: { harness?: string } }): ApiResult | null {
  const harness = override.maker?.harness;
  if (!harness) return null;
  const enabled = harnessesOf(deps).map((h) => h.id);
  if (enabled.includes(harness)) return null;
  return {
    status: 422,
    body: {
      error: `${harness} is not a maker harness this deployment enables (it enables ${enabled.join(", ")})`,
      code: "harness_unavailable",
    } satisfies ApiError,
  };
}

export async function jiraWebhookEffect(effect: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await effect();
  } catch (error) {
    defaultLog("jira webhook sync failed", describeError(error));
  }
}

export interface CaptureStore {

  readonly bucket: string;
  put(localDir: string, key: string): Promise<void>;

  list(key: string): Promise<string[]>;
  presign(key: string, path: string, ttlSeconds: number): Promise<string>;
}

export interface RunCommandPort {
  approve(engineeringRunId: string, actor: string): Promise<{ outcome: string; reason?: string }>;
  cancel(engineeringRunId: string, reason: string, actor: string): Promise<{ outcome: string; reason?: string }>;

  message(
    engineeringRunId: string,
    message: string,
    actor: string,
    actorPrincipalId?: string | null,
  ): Promise<{ outcome: string; reason?: string }>;

  listMessages(engineeringRunId: string, runState: string): Promise<GuidanceRecord[]>;

  startRun(
    taskId: string,
    actor: string,
    rails?: RailsOptions,

    modelOverride?: TaskModelOverride | null,
  ): Promise<{ engineeringRunId: string }>;

  enqueue(engineeringRunId: string): Promise<{ enqueued: boolean }>;

  wake?(engineeringRunId: string, intent: "takeover" | "submit" | "handback", actor: string): Promise<void>;
}

export interface GitHubUserLookup {
  lookup(login: string): Promise<{ id: number; login: string } | null>;
}

export interface Scope {
  organizationId: string;
  actor: string;
  principalId: string;

  permissions?: readonly Permission[];

  audit?: AuditContext;
}

export interface AuditWrite {
  action: AuditAction;
  target?: { type: string; id: string } | null;
  detail?: Record<string, unknown>;
}

export function auditOf(scope: Scope): AuditContext {
  return scope.audit ?? { actor: { principalId: scope.principalId, text: scope.actor, kind: "user" } };
}

export async function audited<T>(
  deps: ApiDeps,
  scope: Scope,
  write: (tx: PoolClient) => Promise<T>,
  describe: (result: T) => AuditWrite | null,
): Promise<T> {
  return withTransaction(deps.pool, async (tx) => {
    const result = await write(tx);
    const event = describe(result);
    if (event) await recordAuditEvent(tx, { organizationId: scope.organizationId, ...auditOf(scope), ...event });
    return result;
  });
}

export async function auditAfter(deps: ApiDeps, scope: Scope, event: AuditWrite): Promise<void> {
  await recordAuditEvent(deps.pool, { organizationId: scope.organizationId, ...auditOf(scope), ...event });
}

export interface EvidencePort {
  list(bucket: string, key: string): Promise<string[]>;
  presign(bucket: string, key: string, path: string, ttlSeconds: number): Promise<string>;

  read?(bucket: string, key: string, path: string): Promise<Buffer>;
}

export interface Query {
  get(name: string): string | undefined;
}

export function acted(result: { outcome: string }): boolean {
  return result.outcome !== "refused" && result.outcome !== "ignored";
}

export async function commandResult(
  deps: ApiDeps,
  runId: string,
  result: { outcome: string; reason?: string },
): Promise<ApiResult> {
  if (result.outcome === "refused" || result.outcome === "ignored") {
    return conflict(result.reason ?? result.outcome, result.outcome);
  }
  const cursor = await currentCursor(deps.pool, runId, FEED_START);
  return accepted({ engineeringRunId: runId, outcome: result.outcome, cursor });
}

export async function currentCursor(pool: Pool, runId: string, fallback: string): Promise<string> {
  const head = await runFeedHead(pool, runId);
  return head === undefined || head === null ? fallback : String(head);
}

export function storageUnconfigured(): ApiResult {
  return {
    status: 503,
    body: {
      error: "this deployment has no object store configured, so evidence cannot be served",
      code: "storage_unconfigured",
    } satisfies ApiError,
  };
}

export function numeric(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function field(body: unknown, name: string): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  return (body as Record<string, unknown>)[name];
}

export function stringField(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

export function byTimeThenKind(
  a: { at: Date | null; kind: string },
  b: { at: Date | null; kind: string },
): number {

  if (a.at === null && b.at === null) return a.kind.localeCompare(b.kind);
  if (a.at === null) return 1;
  if (b.at === null) return -1;
  return a.at.getTime() - b.at.getTime();
}
