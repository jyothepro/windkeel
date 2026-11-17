import { Banner } from "../../../components/banner.tsx";
import { ActionButton } from "../../../components/model-controls.tsx";
import { SimpleForm } from "../../../components/simple-form.tsx";
import { getBilling, getCreditBalance, getUsage } from "../../../lib/api.ts";
import { ALERT_LABEL, PLAN_NAME, balanceSentence, credits, refusalSentence, type CreditBalanceView } from "../../../lib/credits.ts";
import { PLAN_LABEL, barPercent, budgetSentence, usageLines, usd } from "../../../lib/billing.ts";
import type { OrganizationView } from "../../../lib/types.ts";
import { openBilling, saveBudget } from "./actions.ts";

const muted = { margin: 0 } as const;

export async function Billing({ org }: { org: OrganizationView }) {
  const [usage, billing, balance] = await Promise.all([getUsage(org.id), getBilling(org.id), getCreditBalance(org.id)]);
  if (!usage || !billing) {
    return (
      <section className="console-section">
        <p className="oq-muted" style={muted}>
          Usage and budgets are read from a live control plane. This console is showing sample data.
        </p>
      </section>
    );
  }
  const lines = usageLines(usage);
  const { budget } = usage;
  return (
    <>
      {budget.exhausted ? (
        <Banner intent="danger" title="This month's budget is spent">
          <p>New runs are refused until the budget is raised or the month ends. Runs already going finish their verification.</p>
        </Banner>
      ) : null}
      {billing.status === "past_due" || billing.status === "suspended" ? (
        <Banner intent={billing.status === "suspended" ? "danger" : "warning"} title={billing.status === "suspended" ? "Billing suspended" : "Payment past due"}>
          <p>
            {billing.status === "suspended" ? "No new run starts until billing is resolved." : "Runs continue; resolve the payment to avoid suspension."} Use{" "}
            <em>Manage billing</em> below.
          </p>
        </Banner>
      ) : null}

      {balance?.onCredits ? <Credits balance={balance} /> : null}

      <section className="console-section" aria-labelledby="billing-usage" data-section="usage">
        <h2 id="billing-usage">Usage in {usage.period.label}</h2>
        <p className="oq-muted" style={muted}>
          From the cost ledger — every model call and sandbox minute, recorded where Windkeel makes it. Verification is metered like everything else and is
          never waived.
        </p>
        <table className="console-table" aria-label="Usage this month">
          <tbody>
            {lines.map((line) => (
              <tr key={line.key} data-usage-line={line.key}>
                <th scope="row">{line.label}</th>
                <td className="console-mono">{usd(line.usd)}</td>
                <td style={{ width: "30%" }}>
                  <span
                    aria-hidden="true"
                    style={{
                      display: "block",
                      height: 6,
                      borderRadius: 3,
                      width: `${barPercent(line.usd, lines)}%`,
                      background: line.billed ? "var(--accent, currentColor)" : "var(--border, currentColor)",
                    }}
                  />
                </td>
                <td className="console-meta">{line.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p data-billable>
          Billable this month: <strong>{usd(usage.billable.totalUsd)}</strong>
          <span className="console-meta">
            {" "}
            (AI {usd(usage.billable.aiUsd)} + compute fee {usd(usage.billable.computeFeeUsd)} + verification fee {usd(usage.billable.verificationFeeUsd)})
          </span>
        </p>
      </section>

      <section className="console-section" aria-labelledby="billing-budget" data-section="budget">
        <h2 id="billing-budget">Monthly budget</h2>
        <p data-budget-summary style={muted}>
          {budgetSentence(usage)}
        </p>
        <p className="console-guidance-rule">
          When the budget is spent, new runs are refused and a running run stops before its next agent turn. A verification already under way always
          finishes, and its verdict stands — nothing goes out unverified to save money.
        </p>
        {billing.canManage ? (
          <SimpleForm action={saveBudget.bind(null, org.id)} submitLabel="Save budget">
            <div className="console-composer-form__row">
              <div className="oq-field">
                <label className="oq-field__label" htmlFor="budget-limit">
                  Monthly budget (USD)
                </label>
                <input
                  id="budget-limit"
                  name="monthlyLimitUsd"
                  className="oq-input oq-input--mono"
                  inputMode="decimal"
                  defaultValue={budget.monthlyLimitUsd ?? ""}
                  placeholder="Unlimited"
                />
                <p className="oq-field__hint">Blank is unlimited. 0 refuses every new run.</p>
              </div>
              <div className="oq-field">
                <label className="oq-field__label" htmlFor="budget-alert">
                  Alert at (%)
                </label>
                <input id="budget-alert" name="alertThresholdPct" className="oq-input oq-input--mono" inputMode="numeric" defaultValue={budget.alertThresholdPct} />
              </div>
              <div className="oq-field">
                <label className="oq-field__label" htmlFor="budget-cap">
                  Default cap per run (USD)
                </label>
                <input
                  id="budget-cap"
                  name="defaultRunCapUsd"
                  className="oq-input oq-input--mono"
                  inputMode="decimal"
                  defaultValue={budget.defaultRunCapUsd ?? ""}
                  placeholder="$25 (the default)"
                />
              </div>
            </div>
            <label className="oq-row" style={{ ["--gap" as string]: "var(--space-2)" }}>
              <input type="checkbox" name="includeCustomerKeySpend" defaultChecked={budget.includeCustomerKeySpend} />
              Count spend on your own model keys toward the budget (it is never billed)
            </label>
          </SimpleForm>
        ) : null}
        {usage.alerts.length ? (
          <ul className="console-meta">
            {usage.alerts.map((a) => (
              <li key={a.thresholdPct}>
                Crossed {a.thresholdPct}% ({usd(a.spentUsd)} of {usd(a.limitUsd)})
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="console-section" aria-labelledby="billing-plan" data-section="plan">
        <h2 id="billing-plan">Plan</h2>
        <p style={muted} data-plan>
          {billing.plan ? PLAN_LABEL[billing.plan] : "No billing account"} · status <strong>{billing.status ?? "—"}</strong>
        </p>
        {billing.selfManaged && billing.canManage ? (
          <div className="console-actions">
            {!billing.hasCustomer ? <ActionButton label="Add a payment method" run={openBilling.bind(null, org.id, "checkout")} /> : null}
            <ActionButton label="Manage billing" run={openBilling.bind(null, org.id, "portal")} />
          </div>
        ) : (
          <p className="oq-muted" style={muted}>
            This organization is not billed through this deployment.
          </p>
        )}
      </section>
    </>
  );
}

function Credits({ balance }: { balance: CreditBalanceView }) {
  const refusal = refusalSentence(balance);
  return (
    <>
      {refusal ? (
        <Banner intent="danger" title="Out of credits">
          <p>{refusal} Runs already going finish their verification.</p>
        </Banner>
      ) : null}
      <section className="console-section" aria-labelledby="billing-credits" data-section="credits">
        <h2 id="billing-credits">Credits</h2>
        <p style={muted} data-credits-balance>
          {balanceSentence(balance)}
        </p>
        <p className="oq-muted" style={muted}>
          1 credit = $0.01. Compute is 2 credits per sandbox-minute, maker and verifier alike; AI on Windkeel&apos;s models is at cost. Plan credits are
          spent first, then top-ups (oldest expiry first).
        </p>
        <table className="console-table" aria-label="Credits">
          <tbody>
            <tr data-credit-line="plan">
              <th scope="row">{balance.plan ? `${PLAN_NAME[balance.plan]} plan` : "Plan"}</th>
              <td className="console-mono">
                {credits(balance.planCredits?.left ?? 0)} of {credits(balance.planCredits?.included ?? 0)}
              </td>
              <td className="console-meta">
                {balance.pendingPlan ? `changes to ${PLAN_NAME[balance.pendingPlan]} at period end · ` : ""}resets every period, no rollover
              </td>
            </tr>
            {(balance.topups ?? []).map((t) => (
              <tr key={t.grantId} data-credit-line={t.source}>
                <th scope="row">{t.source === "trial" ? "Trial" : "Top-up"}</th>
                <td className="console-mono">
                  {credits(t.left)} of {credits(t.credits)}
                </td>
                <td className="console-meta">expires {t.expiresAt.slice(0, 10)}</td>
              </tr>
            ))}
            <tr data-credit-line="overage">
              <th scope="row">Overage</th>
              <td className="console-mono">
                {balance.overage?.enabled ? `${credits(balance.overage.billedCredits)} of ${credits(balance.overage.capCredits ?? 0)} cap` : "off"}
              </td>
              <td className="console-meta">
                {balance.overage?.enabled ? "billed on your next invoice" : "out of credits stops new runs"}
                {balance.overage && balance.overage.unbilledCredits > 0
                  ? ` · ${credits(balance.overage.unbilledCredits)} past the last credit, not billed`
                  : ""}
              </td>
            </tr>
          </tbody>
        </table>
        {balance.alerts?.length ? (
          <ul className="console-meta" data-credit-alerts>
            {balance.alerts.map((a) => (
              <li key={a.kind}>{ALERT_LABEL[a.kind]}</li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}
