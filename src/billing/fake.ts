import { randomUUID } from "node:crypto";
import {
  BillingProviderError,
  WebhookSignatureError,
  parseEventBody,
  signPayload,
  verifySignedPayload,
  type BillingCustomerInput,
  type BillingEvent,
  type BillingProvider,
  type CheckoutInput,
  type PlanChangeInput,
  type UsageReportInput,
} from "./provider.js";

export interface FakeUsageRecord extends UsageReportInput {
  ref: string;
}

export class FakeBillingProvider implements BillingProvider {
  readonly name = "fake" as const;
  readonly customers = new Map<string, { customerId: string; name: string }>();
  readonly usage = new Map<string, FakeUsageRecord>();
  readonly calls: Array<{ method: string; input: unknown }> = [];
  failNextReports = 0;

  constructor(readonly webhookSecret?: string) {}

  get acceptsWebhooks(): boolean {
    return typeof this.webhookSecret === "string" && this.webhookSecret.length > 0;
  }

  private secret(): string {
    if (!this.acceptsWebhooks) {
      throw new WebhookSignatureError("the fake billing provider has no webhook secret (WINDKEEL_FAKE_BILLING_WEBHOOK_SECRET)");
    }
    return this.webhookSecret!;
  }

  async ensureCustomer(input: BillingCustomerInput): Promise<{ customerId: string }> {
    this.calls.push({ method: "ensureCustomer", input });
    const existing = this.customers.get(input.accountId);
    if (existing) return { customerId: existing.customerId };
    const customerId = input.existingCustomerId ?? `cus_fake_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    this.customers.set(input.accountId, { customerId, name: input.name });
    return { customerId };
  }

  async reportUsage(input: UsageReportInput): Promise<{ ref: string }> {
    this.calls.push({ method: "reportUsage", input });
    if (this.failNextReports > 0) {
      this.failNextReports -= 1;
      throw new BillingProviderError("fake billing provider: simulated failure");
    }
    if (!Number.isInteger(input.amountMicroUsd) || input.amountMicroUsd <= 0) {
      throw new BillingProviderError("fake billing provider: amount must be a positive integer", false);
    }
    const existing = this.usage.get(input.idempotencyKey);
    if (existing) return { ref: existing.ref };
    const ref = `mtr_fake_${this.usage.size + 1}`;
    this.usage.set(input.idempotencyKey, { ...input, ref });
    return { ref };
  }

  async checkoutUrl(input: CheckoutInput): Promise<string> {
    this.calls.push({ method: "checkoutUrl", input });
    const what = input.purchase ? `&${input.purchase.kind}=${encodeURIComponent(input.purchase.kind === "plan" ? input.purchase.plan : input.purchase.pack)}` : "";
    return `https://billing.fake.invalid/checkout/${encodeURIComponent(input.customerId)}?return=${encodeURIComponent(input.returnUrl)}${what}`;
  }

  readonly planChanges: PlanChangeInput[] = [];

  async changePlan(input: PlanChangeInput): Promise<void> {
    this.calls.push({ method: "changePlan", input });
    this.planChanges.push(input);
  }

  async portalUrl(input: { customerId: string; returnUrl: string }): Promise<string> {
    this.calls.push({ method: "portalUrl", input });
    return `https://billing.fake.invalid/portal/${encodeURIComponent(input.customerId)}?return=${encodeURIComponent(input.returnUrl)}`;
  }

  parseWebhook(rawBody: Buffer | string, signatureHeader: string | undefined, now: Date = new Date()): BillingEvent {
    verifySignedPayload(rawBody, signatureHeader, this.secret(), now);
    return parseEventBody(rawBody);
  }

  totalFor(customerId: string): number {
    let total = 0;
    for (const record of this.usage.values()) if (record.customerId === customerId) total += record.amountMicroUsd;
    return total;
  }

  webhook(
    event: { id: string; type: string; object: Record<string, unknown>;  created?: Date },
    at: Date = new Date(),
  ): { body: string; signature: string } {
    const created = Math.floor((event.created ?? at).getTime() / 1000);
    const body = JSON.stringify({ id: event.id, type: event.type, created, data: { object: event.object } });
    return { body, signature: signPayload(body, this.secret(), at) };
  }
}
