import type { Metadata } from "next";
import { CREDITS_PER_SANDBOX_MINUTE, PLANS, REPOSITORY_URL, TOPUPS, TRIAL_CREDITS, creditCount, inviteRequestUrl, usd } from "../../../lib/site.ts";

export const metadata: Metadata = { title: "Pricing" };

const QUESTIONS = [
  {
    q: "What does a credit buy?",
    a: `One credit is one US cent. Sandbox time costs ${CREDITS_PER_SANDBOX_MINUTE} credits a minute, billed by the second and rounded once per run. Model calls on Windkeel's keys are charged at cost. With your own model keys, you pay for sandbox time only.`,
  },
  {
    q: "Is verification extra?",
    a: "No. Verification is metered like any other sandbox time, and it is never skipped or cut short to save credits.",
  },
  {
    q: "What happens when credits run out?",
    a: "New runs stop. A run in flight finishes its current step and its verification, and a pass still becomes a pull request. An admin can turn on overage with a monthly cap, and you are never billed past it.",
  },
  {
    q: "Do unused credits roll over?",
    a: "Plan credits reset each month. Top-ups and the trial last 12 months, and are spent after plan credits.",
  },
  {
    q: "Is the gate free at work?",
    a: "Not for commercial use. If your company runs the gate on its own repositories, it needs a factory plan, which includes the gate, or a commercial license. Personal projects, research, schools and nonprofits are free.",
  },
  {
    q: "Can I self-host?",
    a: "The source is public. Self-hosting is free for noncommercial use; for commercial use, ask us for a license. The gate runs anywhere with no servers; the factory runs on Vercel and Supabase.",
  },
];

export default function PricingPage() {
  const invite = inviteRequestUrl();
  return (
    <>
      <section className="site-hero site-hero--compact">
        <h1>Pricing</h1>
        <p className="site-lead">
          The gate is free for personal and noncommercial use. Commercial teams use a factory plan or a license. The managed factory runs on monthly credits, with {creditCount(TRIAL_CREDITS)} free credits
          to start and no card required.
        </p>
      </section>

      <section className="site-section">
        <div className="site-card site-card--accent">
          <div className="site-plan-head">
            <h2>Gate</h2>
            <p className="site-price">
              Free <span>noncommercial</span>
            </p>
          </div>
          <p>The CLI and the GitHub Action, in your own CI, on your own model keys. Free for personal, research and other noncommercial use.</p>
          <a className="oq-button" href={REPOSITORY_URL}>
            Get it on GitHub
          </a>
        </div>
      </section>

      <section className="site-section">
        <h2>Factory plans</h2>
        <div className="site-plans">
          {PLANS.map((plan) => (
            <div key={plan.id} className="site-card">
              <h3>{plan.name}</h3>
              <p className="site-price">
                {usd(plan.usdPerMonth)}
                <span>/month</span>
              </p>
              <p className="site-credits">
                {creditCount(plan.credits)} credits
                {plan.bonusPercent > 0 ? <span className="oq-badge oq-badge--sm">+{plan.bonusPercent}%</span> : null}
              </p>
              <p className="oq-muted">{plan.forWhom}</p>
              <a className="oq-button oq-button--primary" href={invite}>
                Request an invite
              </a>
            </div>
          ))}
        </div>
        <p className="oq-muted">
          Top-ups, one time: {TOPUPS.map((t) => `${usd(t.usd)} for ${creditCount(t.credits)}`).join(", ")} credits. Need SSO, a
          custom contract or help self-hosting? <a href={invite}>Talk to us</a>.
        </p>
      </section>

      <section className="site-section">
        <h2>Questions</h2>
        <dl className="site-faq">
          {QUESTIONS.map((item) => (
            <div key={item.q}>
              <dt>{item.q}</dt>
              <dd>{item.a}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
