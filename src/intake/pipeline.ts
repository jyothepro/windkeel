

import { isBillingRefusal } from "../billing/admission.js";
import type { Pool, PoolClient } from "pg";
import { defaultLog, describeError, type IntakeLog } from "../factory/log.js";
import { claimIntakeDelivery, deleteIntakeDelivery, updateIntakeDelivery } from "./stores/intake-store.js";
import { withTransaction } from "../factory/db/transaction.js";

export interface RawRequest {

  headers: Record<string, string | undefined>;

  rawBody: Buffer | string;

  target?: string;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; status?: 400 | 401 | 403 | 404 | 503; error: string };

export interface ReadOnlyQueryable {
  query: Pool["query"];
}

export interface VerifyContext {
  db: ReadOnlyQueryable;
}

export class IntakeRejection extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 422 = 400,
  ) {
    super(message);
    this.name = "IntakeRejection";
  }
}

export type AfterCommit = () => Promise<unknown>;

export interface IntakeTransaction {

  db: PoolClient;
  source: string;
  deliveryKey: string;

  record(update: DeliveryRecordUpdate): Promise<void>;

  ignore(reason: string): Promise<void>;

  reply(status: number, body: unknown): void;
}

export interface DeliveryRecordUpdate {
  intent?: string;
  engineeringTaskId?: string | null;
  organizationId?: string | null;
  reason?: string | null;
}

interface IntentMeta {

  event?: string | null;
  action?: string | null;

  organizationId?: string | null;
}

export interface IgnoreIntent extends IntentMeta {
  kind: "ignore";

  reason: string;
}

export interface ActIntent extends IntentMeta {
  kind: "act";

  intent: string;

  act(tx: IntakeTransaction): Promise<AfterCommit | void>;
}

export interface AnswerIntent {
  kind: "answer";

  reason: string;

  reply: IntakeReply;
}

export type IntakeIntent = IgnoreIntent | ActIntent | AnswerIntent;

export function ignore(reason: string, meta: IntentMeta = {}): IgnoreIntent {
  return { kind: "ignore", reason, ...meta };
}

export interface InterpretContext {
  req: RawRequest;
  deliveryKey: string;

  db: Pool;
}

export interface IntakeSource<P = unknown> {

  name: string;

  verify(req: RawRequest, ctx: VerifyContext): Promise<VerifyResult>;

  parse(req: RawRequest): P;
  deliveryKey(req: RawRequest, payload: P): string;

  interpret(payload: P, ctx: InterpretContext): Promise<IntakeIntent>;

  respond?(response: IntakeResponse, payload: P): IntakeReply | undefined;
}

export interface IntakeReply {
  status: number;
  body: unknown;
}

export interface IntakeResponse {
  status: number;
  body: {
    ok: boolean;
    intent?: string;
    reason?: string;
    duplicate?: boolean;
    error?: string;
  };

  reply?: IntakeReply;
}

export function wireResponse(response: IntakeResponse): IntakeReply {
  return response.reply ?? { status: response.status, body: response.body };
}

export interface IntakeDeps {
  pool: Pool;

  transientStatus?: number;

  log?: IntakeLog;
}

const DEFAULT_PARSE_ERROR = "body is not valid JSON";

export const INTAKE_SOURCE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

export const INTAKE_TARGET_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const FAILURE_MESSAGES: Record<number, string> = {
  500: "internal error",
  503: "service unavailable",
};

export const RELEASE_FAILED_TAG = "intake_delivery_release_failed";

export { describeError, redactSecrets } from "../factory/log.js";

type Log = IntakeLog;

export async function runIntake<P>(
  source: IntakeSource<P>,
  req: RawRequest,
  deps: IntakeDeps,
): Promise<IntakeResponse> {
  const transientStatus = deps.transientStatus ?? 503;
  const log = deps.log ?? defaultLog;
  const failure = (error: unknown): IntakeResponse => {
    const status = isTransientDatabaseError(error) ? transientStatus : 500;

    return { status, body: { ok: false, error: FAILURE_MESSAGES[status] ?? "intake failure" } };
  };

  let verified: VerifyResult;
  try {
    verified = await source.verify(req, { db: deps.pool });
  } catch {

    return { status: 503, body: { ok: false, error: "verification unavailable" } };
  }
  if (!verified.ok) {

    return { status: verified.status ?? 401, body: { ok: false, error: verified.error } };
  }

  let payload: P;
  let deliveryKey: string;
  try {
    payload = source.parse(req);
    deliveryKey = source.deliveryKey(req, payload);
  } catch (error) {

    if (error instanceof IntakeRejection) {
      return { status: error.status, body: { ok: false, error: error.message } };
    }
    return { status: 400, body: { ok: false, error: DEFAULT_PARSE_ERROR } };
  }
  if (typeof deliveryKey !== "string" || deliveryKey.length === 0) {
    return { status: 400, body: { ok: false, error: "missing delivery key" } };
  }

  const shaped = (response: IntakeResponse): IntakeResponse => {
    if (!source.respond || response.reply) return response;
    try {
      const reply = source.respond(response, payload);
      return reply === undefined ? response : { ...response, reply };
    } catch (error) {

      log("intake respond failed", { source: source.name, deliveryKey, status: response.status, ...describeError(error) });
      return response;
    }
  };

  let intent: IntakeIntent;
  try {
    intent = await source.interpret(payload, { req, deliveryKey, db: deps.pool });
  } catch (error) {
    log("intake interpret failed", { source: source.name, deliveryKey, ...describeError(error) });
    return shaped(failure(error));
  }

  if (intent.kind === "answer") {

    return { status: 200, body: { ok: true, intent: "answer", reason: intent.reason }, reply: intent.reply };
  }

  try {
    return shaped(await persist(source.name, deliveryKey, intent, deps.pool, log));
  } catch (error) {
    log("intake failed", { source: source.name, deliveryKey, ...describeError(error) });
    return shaped(failure(error));
  }
}

async function persist(
  source: string,
  deliveryKey: string,
  intent: IgnoreIntent | ActIntent,
  pool: Pool,
  log: Log,
): Promise<IntakeResponse> {
  const label = intent.kind === "ignore" ? "ignore" : intent.intent;
  let ignoredReason: string | null = null;
  let reply: IntakeReply | null = null;

  const held = await pool.connect();
  try {
    const committed = await withTransaction(
      held,
      async (client): Promise<{ done: IntakeResponse } | { afterCommit: AfterCommit | void }> => {

        const claimed = await claimIntakeDelivery(client, {
          source,
          deliveryKey,
          organizationId: intent.organizationId ?? null,
          event: intent.event ?? null,
          action: intent.action ?? null,
          intent: label,
          reason: intent.kind === "ignore" ? intent.reason : null,
        });
        if (claimed.rowCount === 0) {

          return { done: { status: 200, body: { ok: true, intent: label, duplicate: true, reason: "already handled" } } };
        }

        if (intent.kind === "ignore") {

          return { done: { status: 200, body: { ok: true, intent: "ignore", reason: intent.reason } } };
        }

        const tx: IntakeTransaction = {
          db: client,
          source,
          deliveryKey,
          record: (update) => recordDelivery(client, source, deliveryKey, update),
          ignore: async (reason) => {
            ignoredReason = reason;
            await recordDelivery(client, source, deliveryKey, { intent: "ignore", reason });
          },
          reply: (status, body) => {
            reply = { status, body };
          },
        };

        try {
          return { afterCommit: await withTransaction(client, () => intent.act(tx)) };
        } catch (error) {
          if (!isBillingRefusal(error)) throw error;
          const reason = `${error.code}: ${error.message}`;
          await recordDelivery(client, source, deliveryKey, { intent: "ignore", reason });
          log("intake refused by billing", { source, deliveryKey, code: error.code });
          return { done: { status: 200, body: { ok: true, intent: "ignore", reason } } };
        }
      },
    );
    if ("done" in committed) return committed.done;

    const { afterCommit } = committed;
    if (afterCommit) {
      try {
        await afterCommit();
      } catch (error) {

        await deleteIntakeDelivery(pool, source, deliveryKey).catch((releaseError: unknown) => {

          log("intake delivery release failed", {
            tag: RELEASE_FAILED_TAG,
            source,
            deliveryKey,
            ...describeError(releaseError),
            afterCommitError: describeError(error),
          });
        });

        throw new AfterCommitError(error);
      }
    }

    if (ignoredReason !== null) {
      return { status: 200, body: { ok: true, intent: "ignore", reason: ignoredReason } };
    }
    const sourceReply = reply as IntakeReply | null;
    return { status: 200, body: { ok: true, intent: label }, ...(sourceReply ? { reply: sourceReply } : {}) };
  } finally {
    held.release();
  }
}

class AfterCommitError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "AfterCommitError";
  }
}

export async function recordDelivery(
  db: PoolClient | Pool,
  source: string,
  deliveryKey: string,
  update: DeliveryRecordUpdate,
): Promise<void> {
  await updateIntakeDelivery(db, source, deliveryKey, update);
}

const TRANSIENT_NODE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof AfterCommitError) return false;
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (TRANSIENT_NODE_CODES.has(code)) return true;

    if (/^(08|53)/.test(code) || /^57P0[1-4]$/.test(code) || code === "40001" || code === "40P01") {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : "";
  return /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(
    message,
  );
}

const sources = new Map<string, IntakeSource<unknown>>();

export function registerIntakeSource<P>(source: IntakeSource<P>): void {
  if (!INTAKE_SOURCE_NAME_PATTERN.test(source.name)) {
    throw new Error(`intake source name ${JSON.stringify(source.name)} must be lower-case [a-z0-9_-]`);
  }
  sources.set(source.name, source);
}

export function getIntakeSource(name: string): IntakeSource<unknown> | undefined {
  return sources.get(name);
}

export function unregisterIntakeSource(name: string): boolean {
  return sources.delete(name);
}

export function registeredIntakeSources(): string[] {
  return [...sources.keys()].sort();
}

export async function dispatchIntake(
  name: string,
  req: RawRequest,
  deps: IntakeDeps,
): Promise<IntakeResponse> {
  const source = sources.get(name);
  if (!source) return { status: 404, body: { ok: false, error: "unknown intake source" } };
  return runIntake(source, req, deps);
}
