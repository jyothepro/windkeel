import type { Pool } from "pg";
import { applyBillingEvent, type AppliedBillingEvent } from "./accounts.js";
import { loadCreditPrices, type CreditPrices } from "../factory/config/billing.js";
import { applyCreditEvent } from "./credit-events.js";
import { WebhookSignatureError, type BillingProvider } from "./provider.js";
import { claimBillingWebhookEvent } from "./stores/billing-store.js";
import { withTransaction } from "../factory/db/transaction.js";

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export async function handleBillingWebhook(
  pool: Pool,
  provider: BillingProvider | null,
  pathProvider: string,
  rawBody: Buffer | string | undefined,
  signatureHeader: string | undefined,
  now: Date = new Date(),
  options: { prices?: CreditPrices | undefined } = {},
): Promise<WebhookResult> {
  if (!provider || provider.name !== pathProvider) {
    return { status: 404, body: { error: "this deployment does not bill with that provider", code: "no_billing_provider" } };
  }
  if (!provider.acceptsWebhooks) {
    return { status: 503, body: { error: "billing webhooks are not configured on this deployment", code: "webhooks_disabled" } };
  }
  let event;
  try {
    event = provider.parseWebhook(rawBody ?? "", signatureHeader, now);
  } catch (error) {
    if (error instanceof WebhookSignatureError) {
      return { status: 401, body: { error: "signature rejected", code: "bad_signature" } };
    }
    throw error;
  }

  return withTransaction(pool, async (client): Promise<WebhookResult> => {
    const claimed = await claimBillingWebhookEvent(client, provider.name, event.id, event.type);

    if (claimed.rowCount === 0) return { status: 200, body: { ok: true, duplicate: true } };
    let outcome: AppliedBillingEvent = { accountId: null, applied: false };
    if (event.status && event.source && event.customerId) {
      outcome = await applyBillingEvent(
        client,
        { provider: provider.name, customerId: event.customerId },
        {
          status: event.status,
          source: event.source,
          ended: event.ended,
          at: event.created ?? now,
          reason: `${event.type} (${event.id})`,
        },
      );
    }
    const credit = await applyCreditEvent(client, provider.name, event, options.prices ?? loadCreditPrices(process.env, provider.name), {
      stale: outcome.ignored !== undefined,
      now,
    });
    return {
      status: 200,
      body: {
        ok: true,
        type: event.type,
        applied: outcome.applied,
        status: event.status,
        ...(outcome.ignored ? { ignored: outcome.ignored } : {}),
        ...(credit.effect ? { credits: credit } : {}),
      },
    };
  });
}
