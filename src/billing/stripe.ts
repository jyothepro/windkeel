import type { StripeConfig } from "../factory/config/billing.js";
import {
  BillingProviderError,
  parseEventBody,
  verifySignedPayload,
  type BillingCustomerInput,
  type BillingEvent,
  type BillingProvider,
  type CheckoutInput,
  type PlanChangeInput,
  type UsageReportInput,
} from "./provider.js";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

function form(params: Record<string, string | number | undefined>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) out.append(key, String(value));
  return out.toString();
}

export class StripeBillingProvider implements BillingProvider {
  readonly name = "stripe" as const;
  readonly acceptsWebhooks = true;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: StripeConfig,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  private async post(
    path: string,
    params: Record<string, string | number | undefined>,
    idempotencyKey?: string,
    method: "POST" | "GET" = "POST",
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.secretKey}`,
      "stripe-version": "2025-03-31.basil",
    };
    if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let response;
    try {
      response =
        method === "POST"
          ? await this.fetchImpl(`${this.config.apiBase}${path}`, { method, headers, body: form(params) })
          : await this.fetchImpl(`${this.config.apiBase}${path}`, { method, headers });
    } catch {
      throw new BillingProviderError(`Stripe ${path} could not be reached`);
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status >= 200 && response.status < 300) return body;
    const error = (body["error"] ?? {}) as { type?: unknown; code?: unknown };
    const detail = [error.type, error.code].filter((v) => typeof v === "string").join("/");
    throw new BillingProviderError(
      `Stripe ${path} answered ${response.status}${detail ? ` (${detail})` : ""}`,
      response.status >= 500 || response.status === 429,
    );
  }

  async ensureCustomer(input: BillingCustomerInput): Promise<{ customerId: string }> {
    if (input.existingCustomerId) return { customerId: input.existingCustomerId };
    const body = await this.post(
      "/v1/customers",
      { name: input.name, "metadata[windkeel_account_id]": input.accountId },
      `windkeel-customer-${input.accountId}`,
    );
    if (typeof body["id"] !== "string") throw new BillingProviderError("Stripe /v1/customers returned no id", false);
    return { customerId: body["id"] };
  }

  async reportUsage(input: UsageReportInput): Promise<{ ref: string }> {
    if (!Number.isInteger(input.amountMicroUsd) || input.amountMicroUsd <= 0) {
      throw new BillingProviderError("usage amount must be a positive integer of micro-USD", false);
    }
    const body = await this.post(
      "/v1/billing/meter_events",
      {
        event_name: this.config.meterEventName,
        identifier: input.idempotencyKey,
        timestamp: Math.floor(input.timestamp.getTime() / 1000),
        "payload[stripe_customer_id]": input.customerId,
        "payload[value]": input.amountMicroUsd,
        "payload[windkeel_organization_id]": input.organizationId,
      },
      `windkeel-usage-${input.idempotencyKey}`,
    );
    return { ref: typeof body["identifier"] === "string" ? body["identifier"] : input.idempotencyKey };
  }

  async checkoutUrl(input: CheckoutInput): Promise<string> {
    const params: Record<string, string | number | undefined> = {
      customer: input.customerId,
      success_url: input.returnUrl,
      cancel_url: input.returnUrl,
    };
    const purchase = input.purchase;
    if (purchase) {
      params["metadata[windkeel_account_id]"] = input.accountId;
      params["line_items[0][price]"] = purchase.priceId;
      params["line_items[0][quantity]"] = 1;
      if (purchase.kind === "plan") {
        params["mode"] = "subscription";
        params["metadata[windkeel_plan]"] = purchase.plan;
        params["subscription_data[metadata][windkeel_account_id]"] = input.accountId;
        params["line_items[1][price]"] = this.config.priceId;
      } else {
        params["mode"] = "payment";
        params["metadata[windkeel_topup]"] = purchase.pack;
      }
    } else {
      params["mode"] = "subscription";
      params["line_items[0][price]"] = this.config.priceId;
    }
    const body = await this.post("/v1/checkout/sessions", params);
    if (typeof body["url"] !== "string") throw new BillingProviderError("Stripe checkout returned no url", false);
    return body["url"];
  }

  async changePlan(input: PlanChangeInput): Promise<void> {
    const subscription = await this.post(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, {}, undefined, "GET");
    const items = ((subscription["items"] as { data?: unknown } | undefined)?.data ?? []) as Array<Record<string, unknown>>;
    const item = items.find((i) => input.planPriceIds.includes(String((i["price"] as { id?: unknown } | undefined)?.id ?? "")));
    if (!item || typeof item["id"] !== "string") {
      throw new BillingProviderError("the subscription has no plan item to change", false);
    }
    await this.post(
      `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      {
        "items[0][id]": item["id"],
        "items[0][price]": input.priceId,
        proration_behavior: input.when === "now" ? "always_invoice" : "none",
      },
    );
  }

  async portalUrl(input: { customerId: string; returnUrl: string }): Promise<string> {
    const body = await this.post("/v1/billing_portal/sessions", { customer: input.customerId, return_url: input.returnUrl });
    if (typeof body["url"] !== "string") throw new BillingProviderError("Stripe portal returned no url", false);
    return body["url"];
  }

  parseWebhook(rawBody: Buffer | string, signatureHeader: string | undefined, now: Date = new Date()): BillingEvent {
    verifySignedPayload(rawBody, signatureHeader, this.config.webhookSecret, now);
    return parseEventBody(rawBody);
  }
}
