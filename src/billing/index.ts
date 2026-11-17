import type { BillingConfig } from "../factory/config/billing.js";
import { FakeBillingProvider } from "./fake.js";
import type { BillingProvider } from "./provider.js";
import { StripeBillingProvider } from "./stripe.js";

export function billingProviderFromConfig(config: BillingConfig): BillingProvider | null {
  if (config.provider === "none") return null;
  if (config.provider === "stripe") return new StripeBillingProvider(config.stripe!);
  return new FakeBillingProvider(config.fakeWebhookSecret);
}

