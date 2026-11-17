import { createHmac, timingSafeEqual } from "node:crypto";
import type { PlanKey, TopupKey } from "../factory/config/credits.js";

export interface BillingCustomerInput {
  accountId: string;
  name: string;
  existingCustomerId?: string | null;
}

export interface UsageReportInput {
  customerId: string;
  organizationId: string;
  periodStart: Date;
  periodEnd: Date;
  amountMicroUsd: number;
  idempotencyKey: string;
  timestamp: Date;
}

export type BillingStatus = "active" | "past_due" | "suspended";

export interface BillingEvent {
  id: string;
  type: string;
  customerId: string | null;
  created: Date | null;
  status: BillingStatus | null;
  source: "invoice" | "subscription" | null;
  ended: boolean;
  object: Record<string, unknown>;
}

export type CheckoutPurchase =
  | { kind: "plan"; plan: PlanKey; priceId: string }
  | { kind: "topup"; pack: TopupKey; priceId: string };

export interface CheckoutInput {
  customerId: string;
  returnUrl: string;
  accountId?: string;
  purchase?: CheckoutPurchase;
}

export interface PlanChangeInput {
  subscriptionId: string;
  priceId: string;
  planPriceIds: string[];
  when: "now" | "period_end";
}

export interface BillingProvider {
  readonly name: "fake" | "stripe";
  readonly acceptsWebhooks: boolean;
  ensureCustomer(input: BillingCustomerInput): Promise<{ customerId: string }>;
  reportUsage(input: UsageReportInput): Promise<{ ref: string }>;
  checkoutUrl(input: CheckoutInput): Promise<string>;
  changePlan(input: PlanChangeInput): Promise<void>;
  portalUrl(input: { customerId: string; returnUrl: string }): Promise<string>;
  parseWebhook(rawBody: Buffer | string, signatureHeader: string | undefined, now?: Date): BillingEvent;
}

export class WebhookSignatureError extends Error {
  override readonly name = "WebhookSignatureError";
}

export class BillingProviderError extends Error {
  override readonly name = "BillingProviderError";
  constructor(
    message: string,
    readonly retryable: boolean = true,
  ) {
    super(message);
  }
}

const WEBHOOK_TOLERANCE_SECONDS = 300;

export function verifySignedPayload(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
  now: Date = new Date(),
  toleranceSeconds: number = WEBHOOK_TOLERANCE_SECONDS,
): void {
  if (!header) throw new WebhookSignatureError("no signature header");
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s.trim());
    if (key === "t" && value && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) throw new WebhookSignatureError("malformed signature header");
  const expected = signedDigest(timestamp, rawBody, secret);
  const matched = signatures.some((candidate) => {
    if (!/^[0-9a-f]+$/i.test(candidate)) return false;
    const given = Buffer.from(candidate, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matched) throw new WebhookSignatureError("signature does not match");
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) {
    throw new WebhookSignatureError("signature timestamp outside the tolerance window");
  }
}

export function signPayload(rawBody: Buffer | string, secret: string, at: Date = new Date()): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${signedDigest(t, rawBody, secret).toString("hex")}`;
}

function signedDigest(timestamp: number, rawBody: Buffer | string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(`${timestamp}.`, "utf8")
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
    .digest();
}

function transitionForEvent(
  type: string,
  object: Record<string, unknown>,
): { status: BillingStatus; source: "invoice" | "subscription"; ended: boolean } | null {
  switch (type) {
    case "invoice.payment_failed":
      return { status: "past_due", source: "invoice", ended: false };
    case "invoice.paid":
    case "invoice.payment_succeeded":
      return { status: "active", source: "invoice", ended: false };
    case "customer.subscription.deleted":
      return { status: "suspended", source: "subscription", ended: true };
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const status = object["status"];
      if (status === "active" || status === "trialing") return { status: "active", source: "subscription", ended: false };
      if (status === "past_due") return { status: "past_due", source: "subscription", ended: false };
      if (status === "unpaid") return { status: "suspended", source: "subscription", ended: false };
      if (status === "canceled" || status === "incomplete_expired") return { status: "suspended", source: "subscription", ended: true };
      return null;
    }
    default:
      return null;
  }
}

export function parseEventBody(rawBody: Buffer | string): BillingEvent {
  let event: unknown;
  try {
    event = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
  } catch {
    throw new WebhookSignatureError("body is not JSON");
  }
  const e = event as { id?: unknown; type?: unknown; created?: unknown; data?: { object?: Record<string, unknown> } };
  if (typeof e.id !== "string" || typeof e.type !== "string") throw new WebhookSignatureError("event has no id or type");
  const object = e.data?.object ?? {};
  const customer = object["customer"];
  const transition = transitionForEvent(e.type, object);
  return {
    id: e.id,
    type: e.type,
    customerId: typeof customer === "string" ? customer : null,
    created: typeof e.created === "number" && Number.isFinite(e.created) ? new Date(e.created * 1000) : null,
    status: transition?.status ?? null,
    source: transition?.source ?? null,
    ended: transition?.ended ?? false,
    object,
  };
}
