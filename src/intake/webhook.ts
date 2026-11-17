import type { RiskLevel } from "../factory/rails.js";
import { getSystemActor, grantedRepository } from "../factory/tenancy.js";
import { createTaskFromIntake } from "./create-task.js";
import { signHmacSha256, verifyHmacSha256, withinTolerance, DEFAULT_TOLERANCE_SECONDS } from "./hmac.js";
import { IntakeRejection, type IntakeSource, type RawRequest } from "./pipeline.js";
import {
  deriveWebhookSecret,
  findWebhookEndpoint,
  RISK_LEVELS,
  usableWebhookSigningKey,
  webhookSigningKeyFromEnv,
  type WebhookEndpoint,
} from "./webhook-endpoints.js";

const WEBHOOK_SOURCE = "webhook";

const TIMESTAMP_HEADER = "x-windkeel-timestamp";
export const SIGNATURE_HEADER = "x-windkeel-signature";
const DELIVERY_HEADER = "x-windkeel-delivery";
const SIGNATURE_SCHEME = "v1=";

const MAX_DELIVERY_ID_LENGTH = 200;
const MAX_EXTERNAL_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 64 * 1024;

const SIGNING_UNCONFIGURED = "webhook_signing_unconfigured";

export interface WebhookPayload {
  title: string;
  description: string;
  riskLevel?: RiskLevel;
  externalId?: string;
}

export function signWebhookPayload(secret: string, timestamp: number | string, rawBody: Buffer | string): string {
  return signHmacSha256({ secret, body: signedBytes(timestamp, rawBody), encoding: "hex", prefix: SIGNATURE_SCHEME });
}

function signedBytes(timestamp: number | string, rawBody: Buffer | string): Buffer {
  return Buffer.concat([
    Buffer.from(`${timestamp}.`, "utf8"),
    Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8"),
  ]);
}

export interface WebhookSourceDeps {
  signingKey?: () => string | undefined;
  startRun(engineeringRunId: string): Promise<{ enqueued: boolean }>;
  now?: () => number;
  toleranceSeconds?: number;
}

export function createWebhookIntakeSource(deps: WebhookSourceDeps): IntakeSource<WebhookPayload> {
  const signingKey = deps.signingKey ?? (() => webhookSigningKeyFromEnv());
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const tolerance = deps.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const verified = new WeakMap<RawRequest, WebhookEndpoint>();
  const verifiedEndpoint = (req: RawRequest): WebhookEndpoint => {
    const endpoint = verified.get(req);
    if (!endpoint) throw new Error("webhook request reached the pipeline without a verified endpoint");
    return endpoint;
  };

  return {
    name: WEBHOOK_SOURCE,

    async verify(req, { db }) {
      const key = usableWebhookSigningKey(signingKey());
      if (!key) return { ok: false, status: 503, error: SIGNING_UNCONFIGURED };
      const target = req.target;
      if (!target) return { ok: false, status: 404, error: "unknown webhook endpoint" };

      const delivery = req.headers[DELIVERY_HEADER];
      if (!delivery || delivery.trim() === "") {
        return { ok: false, status: 400, error: "X-Windkeel-Delivery header is required" };
      }
      if (delivery.length > MAX_DELIVERY_ID_LENGTH) {
        return { ok: false, status: 400, error: `X-Windkeel-Delivery is longer than ${MAX_DELIVERY_ID_LENGTH} characters` };
      }

      const endpoint = await findWebhookEndpoint(db, target);
      const live = endpoint !== null && endpoint.enabled;
      const secret = deriveWebhookSecret(key, live ? endpoint.id : target, live ? endpoint.secretVersion : 0);
      const timestampHeader = req.headers[TIMESTAMP_HEADER] ?? "";
      const signed = verifyHmacSha256({
        secret,
        body: signedBytes(timestampHeader, req.rawBody),
        signature: req.headers[SIGNATURE_HEADER],
        prefix: SIGNATURE_SCHEME,
        encoding: "hex",
      });

      if (!live) return { ok: false, status: 404, error: "unknown webhook endpoint" };
      const timestamp = /^\d{1,12}$/.test(timestampHeader) ? Number(timestampHeader) : Number.NaN;
      if (!withinTolerance(timestamp, now(), tolerance)) {
        return { ok: false, status: 401, error: `timestamp missing or outside the ${tolerance} s window` };
      }
      if (!signed) return { ok: false, status: 401, error: "signature verification failed" };
      verified.set(req, endpoint);
      return { ok: true };
    },

    parse(req) {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.isBuffer(req.rawBody) ? req.rawBody.toString("utf8") : req.rawBody);
      } catch {
        throw new IntakeRejection("body is not valid JSON");
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new IntakeRejection("body must be a JSON object");
      }
      const b = body as Record<string, unknown>;
      const title = b["title"];
      const description = b["description"];
      if (typeof title !== "string" || title.trim() === "") throw new IntakeRejection("title is required");
      if (title.length > MAX_TITLE_LENGTH) throw new IntakeRejection(`title is longer than ${MAX_TITLE_LENGTH} characters`);
      if (typeof description !== "string" || description.trim() === "") {
        throw new IntakeRejection("description is required");
      }
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        throw new IntakeRejection(`description is longer than ${MAX_DESCRIPTION_LENGTH} characters`);
      }
      const payload: WebhookPayload = { title: title.trim(), description };
      if (b["riskLevel"] !== undefined) {
        if (typeof b["riskLevel"] !== "string" || !RISK_LEVELS.includes(b["riskLevel"] as RiskLevel)) {
          throw new IntakeRejection("riskLevel must be low, medium or high");
        }
        payload.riskLevel = b["riskLevel"] as RiskLevel;
      }
      if (b["externalId"] !== undefined) {
        const externalId = b["externalId"];
        if (typeof externalId !== "string" || externalId === "" || externalId.length > MAX_EXTERNAL_ID_LENGTH) {
          throw new IntakeRejection(`externalId must be a non-empty string of at most ${MAX_EXTERNAL_ID_LENGTH} characters`);
        }
        payload.externalId = externalId;
      }
      return payload;
    },

    deliveryKey(req) {
      return `${verifiedEndpoint(req).id}:${req.headers[DELIVERY_HEADER]}`;
    },

    async interpret(payload, { req }) {
      const endpoint = verifiedEndpoint(req);
      const delivery = req.headers[DELIVERY_HEADER]!;
      const sourceReference = `webhook:${endpoint.id}:${payload.externalId ?? delivery}`;
      return {
        kind: "act",
        intent: "create_task",
        event: "webhook",
        organizationId: endpoint.organizationId,
        async act(tx) {
          const repository = await grantedRepository(tx.db, endpoint.organizationId, endpoint.repositoryId);
          if (!repository) {
            await tx.ignore("the endpoint's repository is no longer granted to its organization");
            return;
          }
          const actor = await getSystemActor(tx.db, endpoint.organizationId, "webhook");
          const created = await createTaskFromIntake(
            tx.db,
            {
              organizationId: endpoint.organizationId,
              repositoryId: endpoint.repositoryId,
              sourceType: WEBHOOK_SOURCE,
              sourceReference,
              sourceContext: { endpointId: endpoint.id },
              title: payload.title,
              description: payload.description,
              riskLevel: payload.riskLevel ?? endpoint.defaultRiskLevel,
              createdByPrincipalId: actor.id,
            },
            { startRun: deps.startRun },
          );
          await tx.record({
            intent: `create_task:${created.created ? "started" : "existing"}`,
            engineeringTaskId: created.taskId,
          });
          tx.reply(202, { taskId: created.taskId, engineeringRunId: created.runId });
          return created.afterCommit;
        },
      };
    },
  };
}
