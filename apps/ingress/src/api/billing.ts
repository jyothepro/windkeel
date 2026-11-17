

import type { InstallationVerifier } from "@windkeel/factory/github";
import type { BillingProvider } from "@windkeel/factory/billing";
import type { CreditPrices, PricingConfig, SelfServeMode, BillingProviderName } from "@windkeel/factory/billing";
import type { CreditBalance } from "@windkeel/factory/billing";
import type { SessionClaims } from "@windkeel/factory/tenancy";
import { badRequest, notFound, ok, type ApiDeps, type ApiResult, type Query, type Scope } from "./handlers.js";
import type { Caller } from "./router.js";

export interface BillingPort {

  provider: BillingProvider | null;
  providerName: BillingProviderName;
  pricing: PricingConfig;

  selfServe: SelfServeMode;

  trialCredits?: number | undefined;

  prices?: CreditPrices | undefined;

  githubAppSlug?: string | undefined;

  installationVerifier?: InstallationVerifier | undefined;
}

function port(deps: ApiDeps): BillingPort | undefined {
  return deps.billing;
}

const pricingOf = (deps: ApiDeps): PricingConfig | undefined => port(deps)?.pricing;

function onboardingFailure(error: unknown): ApiResult | null {
  if (error instanceof Error && error.name === "OnboardingError") {
    const { status, code } = error as Error & { status: number; code: string };
    return { status, body: { error: error.message, code } };
  }
  return null;
}

export async function usage(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  const { getOrganizationUsage, parsePeriod, budgetSpendUsd, InvalidPeriodError } = await import(
    "@windkeel/factory/billing"
  );
  const { getBudget, listBudgetAlerts } = await import("@windkeel/factory/billing");
  const { billingAccountForOrganization } = await import("@windkeel/factory/billing");
  let period;
  try {
    period = parsePeriod(query.get("period"));
  } catch (error) {
    if (error instanceof InvalidPeriodError) return badRequest(error.message, "invalid_period");
    throw error;
  }
  const pricing = pricingOf(deps);
  const [report, budget, account, alerts] = await Promise.all([
    getOrganizationUsage(deps.pool, scope.organizationId, period, pricing ? { pricing } : {}),
    getBudget(deps.pool, scope.organizationId),
    billingAccountForOrganization(deps.pool, scope.organizationId),
    listBudgetAlerts(deps.pool, scope.organizationId, period),
  ]);
  const spent = budgetSpendUsd(report, budget.includeCustomerKeySpend);
  return ok({
    ...report,
    budget: {
      ...budgetView(budget),
      spentUsd: spent,
      remainingUsd: budget.monthlyLimitUsd === null ? null : Math.max(0, Number((budget.monthlyLimitUsd - spent).toFixed(9))),
      exhausted: budget.monthlyLimitUsd !== null && spent >= budget.monthlyLimitUsd,
    },
    plan: account?.billing?.plan ?? null,
    billingStatus: account?.billing?.status ?? null,
    alerts: alerts.map((a) => ({ ...a, sentAt: a.sentAt.toISOString() })),
  });
}

function budgetView(budget: Awaited<ReturnType<typeof import("@windkeel/factory/billing").getBudget>>) {
  return {
    monthlyLimitUsd: budget.monthlyLimitUsd,
    alertThresholdPct: budget.alertThresholdPct,
    defaultRunCapUsd: budget.defaultRunCapUsd,
    includeCustomerKeySpend: budget.includeCustomerKeySpend,
    updatedByPrincipalId: budget.updatedByPrincipalId,
    updatedAt: budget.updatedAt ? budget.updatedAt.toISOString() : null,
  };
}

export async function budget(deps: ApiDeps, scope: Scope): Promise<ApiResult> {
  const { getBudget } = await import("@windkeel/factory/billing");
  const current = await getBudget(deps.pool, scope.organizationId);
  return ok({ organizationId: scope.organizationId, ...budgetView(current), canManage: (scope.permissions ?? []).includes("billing.manage") });
}

export async function setBudget(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  const { parseBudgetInput, setBudget: store, BudgetError } = await import("@windkeel/factory/billing");
  let input;
  try {
    input = parseBudgetInput(body);
  } catch (error) {
    if (error instanceof BudgetError) return badRequest(error.message, "invalid_budget");
    throw error;
  }
  const saved = await store(deps.pool, scope.organizationId, input, scope.principalId);
  return ok({ organizationId: scope.organizationId, ...budgetView(saved), canManage: true });
}

export async function billing(deps: ApiDeps, scope: Scope): Promise<ApiResult> {
  const { billingAccountForOrganization } = await import("@windkeel/factory/billing");
  const account = await billingAccountForOrganization(deps.pool, scope.organizationId);
  if (!account) return notFound("organization");
  const b = account.billing;
  return ok({
    organizationId: scope.organizationId,
    provider: b?.provider ?? "none",
    plan: b?.plan ?? null,
    status: b?.status ?? null,
    statusReason: b?.statusReason ?? null,
    hasCustomer: Boolean(b?.providerCustomerId),

    selfManaged: Boolean(b && b.provider !== "none" && b.plan !== "internal" && port(deps)?.provider?.name === b.provider),
    canManage: (scope.permissions ?? []).includes("billing.manage"),
    pricing: port(deps)?.pricing ?? null,
  });
}

export async function billingLink(deps: ApiDeps, scope: Scope, body: unknown, kind: "checkout" | "portal"): Promise<ApiResult> {
  const billingPort = port(deps);
  if (!billingPort?.provider) {
    return { status: 503, body: { error: "this deployment has no billing provider (WINDKEEL_BILLING_PROVIDER)", code: "billing_unavailable" } };
  }
  const returnUrl = (body as { returnUrl?: unknown } | null)?.returnUrl;
  if (typeof returnUrl !== "string" || !deps.consoleUrl || !sameOrigin(returnUrl, deps.consoleUrl)) {
    return badRequest("returnUrl must be a page of this deployment's console (WINDKEEL_CONSOLE_URL)", "invalid_return_url");
  }
  const { billingAccountForOrganization, ensureBillingCustomer } = await import("@windkeel/factory/billing");
  const account = await billingAccountForOrganization(deps.pool, scope.organizationId);
  if (!account?.billing || account.billing.plan === "internal" || account.billing.provider !== billingPort.provider.name) {
    return { status: 409, body: { error: "this organization is not billed through this deployment's provider", code: "not_billed" } };
  }
  let purchase;
  if (kind === "checkout") {
    const chosen = await purchaseOf(deps, body);
    if ("error" in chosen) return chosen.error;
    purchase = chosen.purchase;
    if (purchase?.kind === "plan") {

      const { getCreditAccount } = await import("@windkeel/factory/billing");
      const credit = await getCreditAccount(deps.pool, account.accountId);
      if (credit?.plan && credit.subscriptionId) {
        return {
          status: 409,
          body: { error: "this organization already has a plan; change it with POST /v1/billing/plan", code: "already_subscribed" },
        };
      }
    }
  }
  const customerId = await ensureBillingCustomer(deps.pool, billingPort.provider, { ...account, billing: account.billing });
  const url =
    kind === "checkout"
      ? await billingPort.provider.checkoutUrl({
          customerId,
          returnUrl,
          accountId: account.accountId,
          ...(purchase ? { purchase } : {}),
        })
      : await billingPort.provider.portalUrl({ customerId, returnUrl });
  return ok({ url });
}

async function pricesOf(deps: ApiDeps): Promise<CreditPrices> {
  const given = port(deps)?.prices;
  if (given) return given;
  const { loadCreditPrices } = await import("@windkeel/factory/billing");
  return loadCreditPrices(process.env, port(deps)?.providerName ?? "fake");
}

async function purchaseOf(
  deps: ApiDeps,
  body: unknown,
): Promise<{ purchase: import("@windkeel/factory/billing").CheckoutPurchase | undefined } | { error: ApiResult }> {
  const input = (body ?? {}) as { plan?: unknown; topup?: unknown };
  if (input.plan === undefined && input.topup === undefined) return { purchase: undefined };
  const { isPlanKey, isTopupKey, PLAN_KEYS, TOPUP_KEYS } = await import("@windkeel/factory/billing");
  const { PLAN_PRICE_VARIABLES, TOPUP_PRICE_VARIABLES } = await import("@windkeel/factory/billing");
  const prices = await pricesOf(deps);
  if (input.plan !== undefined && input.topup !== undefined) {
    return { error: badRequest("choose a plan or a top-up, not both", "invalid_purchase") };
  }
  if (input.plan !== undefined) {
    if (!isPlanKey(input.plan)) return { error: badRequest(`plan must be one of ${PLAN_KEYS.join(", ")}`, "invalid_plan") };
    const priceId = prices.plans[input.plan];
    if (!priceId) return { error: unpriced(PLAN_PRICE_VARIABLES[input.plan]) };
    return { purchase: { kind: "plan", plan: input.plan, priceId } };
  }
  const pack = typeof input.topup === "number" ? `topup_${input.topup}` : input.topup;
  if (!isTopupKey(pack)) {
    return { error: badRequest(`topup must be one of ${TOPUP_KEYS.map((k) => k.replace("topup_", "")).join(", ")}`, "invalid_topup") };
  }
  const priceId = prices.topups[pack];
  if (!priceId) return { error: unpriced(TOPUP_PRICE_VARIABLES[pack]) };
  return { purchase: { kind: "topup", pack, priceId } };
}

const unpriced = (variable: string): ApiResult => ({
  status: 503,
  body: { error: `this deployment has not set ${variable}, so that cannot be bought yet`, code: "price_unset" },
});

const toCredits = (micro: number): number => micro / 1_000_000;

function balanceView(balance: CreditBalance, now: Date) {
  return {
    plan: balance.plan,
    pendingPlan: balance.pendingPlan,
    period: {
      start: balance.period.start.toISOString(),
      end: balance.period.end.toISOString(),
      basis: balance.period.basis,
      daysToReset: Math.max(0, Math.ceil((balance.period.end.getTime() - now.getTime()) / 86_400_000)),
    },
    planCredits: {
      included: toCredits(balance.planMicro.included),
      used: toCredits(balance.planMicro.used),
      left: toCredits(balance.planMicro.left),
    },
    topups: balance.topups.map((t) => ({
      grantId: t.grantId,
      source: t.source,
      product: t.product,
      credits: toCredits(t.grantedMicro),
      left: toCredits(t.leftMicro),
      grantedAt: t.startsAt.toISOString(),
      expiresAt: t.expiresAt.toISOString(),
    })),
    overage: {
      enabled: balance.overage.enabled,
      capCredits: balance.overage.capMicro === null ? null : toCredits(balance.overage.capMicro),
      billedCredits: toCredits(balance.overage.billedMicro),
      unbilledCredits: toCredits(balance.overage.unbilledMicro),
    },
    availableCredits: toCredits(balance.availableMicro),
    admits: balance.admits,
  };
}

async function catalog(deps: ApiDeps) {
  const { PLANS, TOPUP_PACKS, bonusPct, COMPUTE_CREDITS_PER_MINUTE, CREDIT_USD } = await import("@windkeel/factory/billing");
  const prices = await pricesOf(deps);
  return {
    creditUsd: CREDIT_USD,
    computeCreditsPerMinute: COMPUTE_CREDITS_PER_MINUTE,
    plans: Object.values(PLANS).map((p) => ({ ...p, bonusPct: bonusPct(p), purchasable: Boolean(prices.plans[p.key]) })),
    topups: Object.values(TOPUP_PACKS).map((t) => ({ ...t, bonusPct: bonusPct(t), purchasable: Boolean(prices.topups[t.key]) })),
  };
}

export async function balance(deps: ApiDeps, scope: Scope): Promise<ApiResult> {
  const { accountOfOrganization, getCreditBalance, listCreditAlerts } = await import("@windkeel/factory/billing");
  const accountId = await accountOfOrganization(deps.pool, scope.organizationId);
  if (!accountId) return notFound("organization");
  const now = new Date();
  const current = await getCreditBalance(deps.pool, accountId, now);
  const canManage = (scope.permissions ?? []).includes("billing.manage");
  if (!current) return ok({ organizationId: scope.organizationId, onCredits: false, canManage, catalog: await catalog(deps) });
  const alerts = await listCreditAlerts(deps.pool, accountId, current.period.start);
  return ok({
    organizationId: scope.organizationId,
    onCredits: true,
    ...balanceView(current, now),
    alerts: alerts.map((a) => ({
      kind: a.kind,
      usedCredits: toCredits(a.usedMicro),
      limitCredits: toCredits(a.limitMicro),
      raisedAt: a.raisedAt.toISOString(),
    })),
    canManage,
    catalog: await catalog(deps),
  });
}

export async function statement(deps: ApiDeps, scope: Scope, query: Query): Promise<ApiResult> {
  const { parsePeriod, periodLabel, InvalidPeriodError } = await import("@windkeel/factory/billing");
  const { organizationStatement, statementCsv } = await import("@windkeel/factory/billing");
  let period;
  try {
    period = parsePeriod(query.get("period"));
  } catch (error) {
    if (error instanceof InvalidPeriodError) return badRequest(error.message, "invalid_period");
    throw error;
  }
  const format = query.get("format") ?? "json";
  if (format !== "json" && format !== "csv") return badRequest("format is json or csv", "invalid_format");
  const result = await organizationStatement(deps.pool, scope.organizationId, period, periodLabel(period));
  if (format === "json") return ok(result);
  return {
    status: 200,
    body: null,
    raw: statementCsv(result),
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="windkeel-statement-${result.period.label}.csv"`,
    },
  };
}

export async function setOverage(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  const { accountOfOrganization, parseOverageInput, setOverage: store, CreditSettingsError } = await import(
    "@windkeel/factory/billing"
  );
  let input;
  try {
    input = parseOverageInput(body);
  } catch (error) {
    if (error instanceof CreditSettingsError) return badRequest(error.message, "invalid_overage");
    throw error;
  }
  const accountId = await accountOfOrganization(deps.pool, scope.organizationId);
  if (!accountId) return notFound("organization");
  try {
    await store(deps.pool, accountId, input);
  } catch (error) {
    if (error instanceof CreditSettingsError) return { status: 409, body: { error: error.message, code: "not_on_credits" } };
    throw error;
  }
  return balance(deps, scope);
}

export async function changePlan(deps: ApiDeps, scope: Scope, body: unknown): Promise<ApiResult> {
  const billingPort = port(deps);
  if (!billingPort?.provider) {
    return { status: 503, body: { error: "this deployment has no billing provider (WINDKEEL_BILLING_PROVIDER)", code: "billing_unavailable" } };
  }
  const { isPlanKey, PLANS, PLAN_KEYS } = await import("@windkeel/factory/billing");
  const { PLAN_PRICE_VARIABLES } = await import("@windkeel/factory/billing");
  const { accountOfOrganization, getCreditAccount } = await import("@windkeel/factory/billing");
  const plan = (body as { plan?: unknown } | null)?.plan;
  if (!isPlanKey(plan)) return badRequest(`plan must be one of ${PLAN_KEYS.join(", ")}`, "invalid_plan");
  const prices = await pricesOf(deps);
  const priceId = prices.plans[plan];
  if (!priceId) return unpriced(PLAN_PRICE_VARIABLES[plan]);
  const accountId = await accountOfOrganization(deps.pool, scope.organizationId);
  const account = accountId ? await getCreditAccount(deps.pool, accountId) : null;
  if (!account?.subscriptionId || !account.plan) {
    return { status: 409, body: { error: "this organization has no plan subscription yet; subscribe through checkout first", code: "no_subscription" } };
  }
  if (account.plan === plan) return ok({ plan, effective: "unchanged" });
  const when = PLANS[plan].credits > PLANS[account.plan].credits ? "now" : "period_end";
  await billingPort.provider.changePlan({
    subscriptionId: account.subscriptionId,
    priceId,
    planPriceIds: Object.values(prices.plans).filter((p): p is string => Boolean(p)),
    when,
  });
  return { status: 202, body: { plan, from: account.plan, effective: when } };
}

export async function receipt(deps: ApiDeps, scope: Scope, runId: string): Promise<ApiResult> {
  const { runInOrganization } = await import("@windkeel/factory/tenancy");
  const row = await runInOrganization(deps.pool, scope.organizationId, runId);
  if (!row) return notFound("run");
  const { runReceipt } = await import("@windkeel/factory/billing");
  return ok(await runReceipt(deps.pool, runId));
}

function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

export async function billingWebhook(
  deps: ApiDeps,
  pathProvider: string,
  rawBody: Buffer | string | undefined,
  headers: Record<string, string | undefined>,
): Promise<ApiResult> {
  const { handleBillingWebhook } = await import("@windkeel/factory/billing");
  return handleBillingWebhook(deps.pool, port(deps)?.provider ?? null, pathProvider, rawBody, headers["stripe-signature"], new Date(), {
    prices: port(deps)?.prices,
  });
}

export async function signup(deps: ApiDeps, claims: SessionClaims, body: unknown): Promise<ApiResult> {
  const billingPort = port(deps);
  if (!billingPort || billingPort.selfServe === "off") {
    return { status: 404, body: { error: "self-serve signup is not on for this deployment", code: "signup_disabled" } };
  }
  const input = (body ?? {}) as { organizationName?: unknown; inviteCode?: unknown; plan?: unknown };
  const { createSelfServeAccount } = await import("@windkeel/factory/billing");
  try {
    const created = await createSelfServeAccount(deps.pool, {
      claims,
      inviteCode: typeof input.inviteCode === "string" ? input.inviteCode : "",
      organizationName: typeof input.organizationName === "string" ? input.organizationName : "",

      plan: (input.plan ?? "managed") as "byok" | "managed",
      mode: billingPort.selfServe,
      provider: billingPort.providerName,
      ...(billingPort.trialCredits !== undefined ? { trialCredits: billingPort.trialCredits } : {}),
    });
    const { TRIAL_CREDITS } = await import("@windkeel/factory/billing");
    return { status: 201, body: { ...created, trialCredits: billingPort.trialCredits ?? TRIAL_CREDITS } };
  } catch (error) {
    const refused = onboardingFailure(error);
    if (refused) return refused;
    throw error;
  }
}

export async function installLink(deps: ApiDeps, scope: Scope): Promise<ApiResult> {
  const slug = port(deps)?.githubAppSlug;
  if (!slug) {
    return { status: 503, body: { error: "this deployment does not name its GitHub App (WINDKEEL_GITHUB_APP_SLUG)", code: "github_app_unnamed" } };
  }
  const { createInstallState, installUrl } = await import("@windkeel/factory/billing");
  const { state, expiresAt } = await createInstallState(deps.pool, { organizationId: scope.organizationId, principalId: scope.principalId });
  return { status: 201, body: { url: installUrl(slug, state), expiresAt: expiresAt.toISOString() } };
}

export async function linkInstallation(deps: ApiDeps, caller: Caller, body: unknown): Promise<ApiResult> {
  const verifier = port(deps)?.installationVerifier;
  if (!verifier) {
    return {
      status: 503,
      body: { error: "this deployment cannot verify installations (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET)", code: "installations_unverifiable" },
    };
  }
  const input = (body ?? {}) as { installationId?: unknown; state?: unknown; code?: unknown };
  const installationId = typeof input.installationId === "string" ? Number(input.installationId) : input.installationId;
  if (typeof installationId !== "number" || typeof input.state !== "string") {
    return badRequest("installationId and state are required", "missing_field");
  }
  const { linkInstallation: link } = await import("@windkeel/factory/billing");
  try {
    const linked = await link(deps.pool, {
      installationId,
      state: input.state,
      code: typeof input.code === "string" ? input.code : undefined,
      principalId: caller.principal.id,
      verifier,
    });
    return ok(linked);
  } catch (error) {
    const refused = onboardingFailure(error);
    if (refused) return refused;
    throw error;
  }
}
